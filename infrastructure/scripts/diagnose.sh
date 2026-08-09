#!/usr/bin/env bash
#
# Walk the request path from the inside out and report the first layer that breaks.
#
# Written after a session spent trading one command at a time over chat. Every check
# here answers a question that "it doesn't work" cannot: is the container up, does the
# proxy reach it, does the tunnel reach the proxy, and is the browser bundle even
# pointing at the right hostname.
#
# Read-only. Nothing here changes state.
#
# Usage:  ./infrastructure/scripts/diagnose.sh

set -uo pipefail
cd "$(dirname "$0")/../.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

FAILED=0

if [[ ! -f .env ]]; then
  echo "No .env in $(pwd)." >&2
  exit 1
fi

get() { grep -E "^$1=" .env | head -n1 | cut -d= -f2- ; }

APP_URL="$(get APP_URL)"
APP_DOMAIN="$(get APP_DOMAIN)"
TURN_DOMAIN="$(get TURN_DOMAIN)"
TURN_EXTERNAL_IP="$(get TURN_EXTERNAL_IP)"
TURN_PORT="$(get TURN_PORT)"; TURN_PORT="${TURN_PORT:-3478}"
TURN_MIN="$(get TURN_MIN_PORT)"; TURN_MIN="${TURN_MIN:-49160}"
TURN_MAX="$(get TURN_MAX_PORT)"; TURN_MAX="${TURN_MAX:-49200}"
PUBLIC_PORT="$(get PUBLIC_PORT)"; PUBLIC_PORT="${PUBLIC_PORT:-8181}"

# ─────────────────────────────────────────────────────────────────────────────
head_ "Containers"

for svc in postgres redis api realtime web admin caddy coturn worker; do
  state="$(docker compose ps --format '{{.State}}' "$svc" 2>/dev/null | head -n1)"
  if [[ "$state" == running ]]; then ok "$svc"
  elif [[ -z "$state" ]]; then bad "$svc is not created"
  else bad "$svc is $state"; fi
done

# ─────────────────────────────────────────────────────────────────────────────
head_ "Realtime, from the inside out"

# The Socket.IO handshake. A healthy engine.io reply starts with `0{"sid":`. Anything
# else — empty, HTML, a 502 — means the request never arrived at the Node process.
HANDSHAKE='/rt/?EIO=4&transport=polling'

direct="$(docker compose exec -T caddy wget -qO- "http://realtime:4001${HANDSHAKE}" 2>/dev/null | head -c 60)"
if [[ "$direct" == 0\{\"sid\":* ]]; then
  ok "caddy → realtime:4001 (Socket.IO answered)"
else
  bad "caddy → realtime:4001 failed. Got: ${direct:-<nothing>}"
  warn "The proxy cannot reach the realtime container. Check 'docker compose logs realtime'."
fi

viacaddy="$(curl -sS --max-time 5 "http://127.0.0.1:${PUBLIC_PORT}${HANDSHAKE}" 2>/dev/null | head -c 60)"
if [[ "$viacaddy" == 0\{\"sid\":* ]]; then
  ok "host → caddy:${PUBLIC_PORT}${HANDSHAKE}"
else
  bad "host → caddy:${PUBLIC_PORT} failed. Got: ${viacaddy:-<nothing>}"
  warn "Caddy is not routing /rt. It does NOT reload a changed Caddyfile on its own:"
  warn "  docker compose restart caddy"
fi

if [[ -n "$APP_URL" ]]; then
  public="$(curl -sS --max-time 10 "${APP_URL}${HANDSHAKE}" 2>/dev/null | head -c 60)"
  if [[ "$public" == 0\{\"sid\":* ]]; then
    ok "internet → ${APP_URL}${HANDSHAKE}"
  else
    bad "internet → ${APP_URL} failed. Got: ${public:-<nothing>}"
    warn "Caddy answers locally but the tunnel does not carry it. Check the tunnel's"
    warn "service target and that WebSockets are not disabled for the hostname."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head_ "What the browser bundle was built with"

# NEXT_PUBLIC_* are inlined at BUILD time. Changing .env and restarting does nothing —
# the old value is already compiled into the JavaScript being served. This is the single
# most common cause of "the config is right but the app disagrees".
baked="$(docker compose exec -T web sh -c \
  "grep -rhoE 'https://[a-zA-Z0-9.-]+' .next/static 2>/dev/null | sort -u | head -20" 2>/dev/null)"

if [[ -z "$baked" ]]; then
  warn "Could not read the built bundle."
else
  echo "$baked" | sed 's/^/      /'
  if [[ -n "$APP_DOMAIN" ]] && ! grep -q "$APP_DOMAIN" <<<"$baked"; then
    bad "$APP_DOMAIN does not appear in the bundle — it was built with a different .env"
    warn "  docker compose build --no-cache web && docker compose up -d web"
  else
    ok "$APP_DOMAIN is present in the bundle"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head_ "TURN"

if [[ -z "$TURN_EXTERNAL_IP" ]]; then
  bad "TURN_EXTERNAL_IP is empty — coturn will advertise an unroutable address"
else
  ok "TURN_EXTERNAL_IP=$TURN_EXTERNAL_IP"
fi

# coturn runs with network_mode: host, so it binds host ports directly.
if ss -ulnp 2>/dev/null | grep -q ":${TURN_PORT}\b"; then
  ok "something is listening on ${TURN_PORT}/udp"
else
  bad "nothing is listening on ${TURN_PORT}/udp — coturn is not bound"
  warn "  docker compose logs coturn --tail 40"
fi

if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    for rule in "${TURN_PORT}/udp" "${TURN_MIN}:${TURN_MAX}/udp"; do
      if ufw status 2>/dev/null | grep -q "$rule"; then ok "ufw allows $rule"
      else bad "ufw does NOT allow $rule"; fi
    done
  else
    ok "ufw is inactive (not blocking anything)"
  fi
fi

if [[ -n "$TURN_DOMAIN" ]]; then
  resolved="$(getent hosts "$TURN_DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1)"
  if [[ -z "$resolved" ]]; then
    bad "$TURN_DOMAIN does not resolve"
  elif [[ -n "$TURN_EXTERNAL_IP" && "$resolved" != "$TURN_EXTERNAL_IP" ]]; then
    bad "$TURN_DOMAIN resolves to $resolved, but TURN_EXTERNAL_IP is $TURN_EXTERNAL_IP"
    warn "If it resolves to a Cloudflare address the record is proxied. TURN is UDP and"
    warn "cannot go through the proxy — set that DNS record to grey cloud (DNS only)."
  else
    ok "$TURN_DOMAIN resolves to $resolved"
  fi
fi

warn "Reachability from OUTSIDE cannot be tested from this machine — a UDP port that is"
warn "blocked at the provider's edge looks identical from here to one that is open."
warn "Use ./infrastructure/scripts/turn-credential.sh with the Trickle ICE page."

# ─────────────────────────────────────────────────────────────────────────────
head_ "Result"
if [[ "$FAILED" -eq 0 ]]; then
  echo "  No problems found on this host."
else
  echo "  Failures above, in order. Fix the FIRST one — the later checks depend on it."
fi
exit "$FAILED"
