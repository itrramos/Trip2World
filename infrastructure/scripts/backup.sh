#!/usr/bin/env bash
#
# Back up Trip2World.
#
#   ./infrastructure/scripts/backup.sh
#   ./infrastructure/scripts/backup.sh --output /mnt/external/trip2world
#
# What is backed up:
#   * PostgreSQL  — the entire durable state of the product.
#   * .env        — the secrets. Without JWT_SECRET the database is still readable, but
#                   without POSTGRES_PASSWORD the dump cannot be restored into a new
#                   stack, so it is included and the archive is mode 0600.
#
# What is NOT backed up, deliberately:
#   * Redis. Every key it holds is ephemeral by design — matchmaking queues, presence,
#     match locks. Restoring stale queue state would be actively harmful: it would
#     resurrect matches whose participants are long gone and occupy accounts that are
#     not in a conversation. See EPHEMERAL_KEY_PREFIXES in packages/shared.

set -euo pipefail

cd "$(dirname "$0")/../.."

OUTPUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

if [[ ! -f .env ]]; then
  printf '\n  [!] .env not found. Run this from the repository root.\n\n' >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

DATA_ROOT="${DATA_ROOT:-/DATA/AppData/Trip2World}"
OUTPUT_DIR="${OUTPUT_DIR:-${DATA_ROOT}/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${OUTPUT_DIR}/trip2world-${TIMESTAMP}.tar.gz"
STAGING="$(mktemp -d)"

# Never leave a partial dump or a decrypted secret behind on failure.
trap 'rm -rf "${STAGING}"' EXIT

mkdir -p "${OUTPUT_DIR}"

printf '\n  Trip2World - backup\n  -------------------\n\n'
printf '  Target: %s\n\n' "${ARCHIVE}"

# ─────────────────────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────────────────────
#
# pg_dump runs INSIDE the container, so the host needs no postgres client and the
# version always matches the server. --clean --if-exists makes the dump restorable
# over an existing database without a manual drop first.

printf '  [1/3] Dumping PostgreSQL...\n'
docker compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --clean --if-exists --no-owner --no-privileges \
  > "${STAGING}/database.sql"

DB_SIZE="$(du -h "${STAGING}/database.sql" | cut -f1)"
printf '        %s\n' "${DB_SIZE}"

# A dump that is suspiciously small usually means the command failed but the pipeline
# still produced a file. Catching it here beats discovering it during a restore.
if [[ ! -s "${STAGING}/database.sql" ]]; then
  printf '\n  [!] Database dump is empty. Aborting.\n\n' >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

printf '  [2/3] Copying configuration...\n'
cp .env "${STAGING}/env"
cp docker-compose.yml "${STAGING}/docker-compose.yml"

cat > "${STAGING}/MANIFEST.txt" <<EOF
Trip2World backup
Created:     $(date -Iseconds)
Host:        $(hostname)
Data root:   ${DATA_ROOT}
Database:    ${POSTGRES_DB}
Dump size:   ${DB_SIZE}

Contents:
  database.sql        pg_dump --clean --if-exists
  env                 the .env in force at backup time (CONTAINS SECRETS)
  docker-compose.yml  the stack definition

Redis is intentionally excluded: it holds only ephemeral matchmaking state.

Restore with:
  ./infrastructure/scripts/restore.sh $(basename "${ARCHIVE}")
EOF

# ─────────────────────────────────────────────────────────────────────────────
# Archive
# ─────────────────────────────────────────────────────────────────────────────

printf '  [3/3] Creating archive...\n'
tar -czf "${ARCHIVE}" -C "${STAGING}" .

# The archive contains every secret for this deployment.
chmod 600 "${ARCHIVE}"

# Retain 14 days. Deleting by mtime rather than by count so a burst of manual backups
# cannot push out the scheduled ones.
find "${OUTPUT_DIR}" -name 'trip2world-*.tar.gz' -mtime +14 -delete 2>/dev/null || true

printf '\n  Done: %s (%s)\n' "${ARCHIVE}" "$(du -h "${ARCHIVE}" | cut -f1)"
printf '  Mode 0600 - this archive contains your secrets.\n'
printf '  Copy it off this machine: a backup on the same disk is not a backup.\n\n'
