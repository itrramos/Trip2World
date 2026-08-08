#!/usr/bin/env bash
#
# Prepare the host data directories for Trip2World on CasaOS / Ubuntu.
#
#   sudo ./infrastructure/scripts/setup-casaos.sh
#
# Run once, before the first `docker compose up`. Bind-mounted directories are NOT
# created with the right ownership automatically the way named volumes are: Postgres
# refuses to start on a directory it does not own, and the error ("data directory has
# invalid permissions") is easy to misread as a corrupt database.

set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/DATA/AppData/Trip2World}"

# UIDs as used inside the official images. These are fixed by the upstream Dockerfiles.
POSTGRES_UID=999   # postgres:16-alpine
POSTGRES_GID=999
REDIS_UID=999      # redis:7-alpine
REDIS_GID=1000

info()  { printf '  %s\n' "$*"; }
ok()    { printf '  [ok] %s\n' "$*"; }
fatal() { printf '\n  [!] %s\n\n' "$*" >&2; exit 1; }

printf '\n  Trip2World - host setup\n  -----------------------\n\n'

if [[ "$(id -u)" -ne 0 ]]; then
  fatal "Run this with sudo: the data directories need ownership set to the container users."
fi

info "Data root: ${DATA_ROOT}"

mkdir -p \
  "${DATA_ROOT}/postgres" \
  "${DATA_ROOT}/redis" \
  "${DATA_ROOT}/caddy/data" \
  "${DATA_ROOT}/caddy/config" \
  "${DATA_ROOT}/backups"

# Postgres refuses to start unless it owns its data directory, and requires 0700.
chown -R "${POSTGRES_UID}:${POSTGRES_GID}" "${DATA_ROOT}/postgres"
chmod 700 "${DATA_ROOT}/postgres"
ok "postgres data directory"

chown -R "${REDIS_UID}:${REDIS_GID}" "${DATA_ROOT}/redis"
chmod 755 "${DATA_ROOT}/redis"
ok "redis data directory"

# Caddy runs as root in the official image; its data dir holds certificates and keys.
chmod 700 "${DATA_ROOT}/caddy/data"
ok "caddy data directory"

# Backups contain a full database dump — readable only by root.
chmod 700 "${DATA_ROOT}/backups"
ok "backups directory"

# ─────────────────────────────────────────────────────────────────────────────
# Kernel tuning for a WebRTC signaling server
# ─────────────────────────────────────────────────────────────────────────────
#
# The default 128-entry SYN backlog and 1024 file-descriptor limit are sized for a
# handful of connections. A realtime node holds one long-lived socket per online user,
# so both are reached far sooner than on an ordinary web server — and the failure mode
# is silent connection refusal rather than a clear error.

SYSCTL_FILE=/etc/sysctl.d/60-trip2world.conf
if [[ ! -f "${SYSCTL_FILE}" ]]; then
  cat > "${SYSCTL_FILE}" <<'EOF'
# Trip2World: sized for many long-lived WebSocket connections.
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
# coturn relays are short-lived UDP flows; reclaim sockets promptly.
net.ipv4.tcp_fin_timeout = 20
fs.file-max = 200000
EOF
  sysctl -p "${SYSCTL_FILE}" >/dev/null
  ok "kernel tuning applied (${SYSCTL_FILE})"
else
  info "kernel tuning already present, leaving it alone"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Firewall
# ─────────────────────────────────────────────────────────────────────────────
#
# Only opened if ufw is already active — enabling a firewall on a remote VPS from a
# script is an excellent way to lock yourself out of SSH.

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  info "ufw is active; opening the ports Trip2World needs"
  ufw allow 8181/tcp            comment 'Trip2World app' >/dev/null
  ufw allow 3478/udp            comment 'Trip2World TURN' >/dev/null
  ufw allow 3478/tcp            comment 'Trip2World TURN' >/dev/null
  ufw allow 49160:49200/udp     comment 'Trip2World TURN relay' >/dev/null
  ok "firewall rules added"
else
  info "ufw not active - open these ports manually if you use another firewall:"
  info "    8181/tcp, 3478/udp, 3478/tcp, 49160-49200/udp"
fi

printf '\n  Done. Next:\n'
printf '    1. cp .env.example .env\n'
printf '    2. pnpm secrets:generate   (or: docker run --rm -v "$PWD:/w" -w /w node:22-alpine node infrastructure/scripts/generate-secrets.mjs)\n'
printf '    3. edit .env  - TURN_EXTERNAL_IP, SMTP_*, CLOUDFLARE_TUNNEL_TOKEN\n'
printf '    4. docker compose --profile tunnel up -d\n\n'
