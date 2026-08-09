#!/usr/bin/env bash
#
# Print a TURN credential for testing, without signing in to anything.
#
# `GET /api/v1/ice/servers` needs a bearer token, and that token lives in memory inside
# the running web app — it is deliberately never in a cookie, so a `fetch()` typed into
# the browser console has no way to send it and always comes back unauthorised. That is
# the auth design working correctly, and it makes the endpoint useless for a manual test.
#
# coturn credentials are derived, not stored, so they can be computed from the shared
# secret directly:
#
#   username   = "<unix-expiry>:<user>"
#   credential = base64( HMAC-SHA1( secret, username ) )
#
# Identical to packages/auth/src/turn.ts. Anything this prints, coturn will accept.
#
# Usage:  ./infrastructure/scripts/turn-credential.sh [ttl-seconds]

set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ ! -f .env ]]; then
  echo "No .env found in $(pwd)." >&2
  exit 1
fi

# Read without sourcing: .env legitimately contains values with spaces and characters a
# shell would try to interpret.
get() { grep -E "^$1=" .env | head -n1 | cut -d= -f2- ; }

TURN_SECRET="$(get TURN_SECRET)"
TURN_DOMAIN="$(get TURN_DOMAIN)"
TURN_PORT="$(get TURN_PORT)"
TURN_PORT="${TURN_PORT:-3478}"

if [[ -z "$TURN_SECRET" || "$TURN_SECRET" == "CHANGE_ME" ]]; then
  echo "TURN_SECRET is unset or still CHANGE_ME. Run: node infrastructure/scripts/generate-secrets.mjs" >&2
  exit 1
fi
if [[ -z "$TURN_DOMAIN" ]]; then
  echo "TURN_DOMAIN is unset in .env." >&2
  exit 1
fi

TTL="${1:-3600}"
EXPIRY=$(( $(date +%s) + TTL ))
USERNAME="${EXPIRY}:turn-test"

# -hmac uses the key as-is. `binary` then base64, matching Node's digest('base64').
CREDENTIAL="$(printf '%s' "$USERNAME" \
  | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary \
  | openssl base64)"

cat <<EOF

Paste these into https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

  STUN or TURN URI   turn:${TURN_DOMAIN}:${TURN_PORT}
  TURN username      ${USERNAME}
  TURN password      ${CREDENTIAL}

Valid for ${TTL} seconds. Click "Add Server", then "Gather candidates".

A row of Type "relay" means TURN works. Only "host" and "srflx" means it does not —
srflx proves STUN is reachable and says nothing about the relay.

EOF
