#!/usr/bin/env bash
#
# Restore Trip2World from a backup archive.
#
#   ./infrastructure/scripts/restore.sh trip2world-20260807-120000.tar.gz
#
# This OVERWRITES the current database. It refuses to run without an explicit typed
# confirmation, because the most common way to lose production data is a restore aimed
# at the wrong environment.

set -euo pipefail

cd "$(dirname "$0")/../.."

ARCHIVE="${1:-}"
if [[ -z "${ARCHIVE}" ]]; then
  printf '\n  Usage: %s <archive.tar.gz>\n\n' "$0" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  printf '\n  [!] .env not found. Run from the repository root.\n\n' >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

DATA_ROOT="${DATA_ROOT:-/DATA/AppData/Trip2World}"

# Accept a bare filename and look in the usual backups directory.
if [[ ! -f "${ARCHIVE}" && -f "${DATA_ROOT}/backups/${ARCHIVE}" ]]; then
  ARCHIVE="${DATA_ROOT}/backups/${ARCHIVE}"
fi
[[ -f "${ARCHIVE}" ]] || { printf '\n  [!] Not found: %s\n\n' "${ARCHIVE}" >&2; exit 1; }

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT

tar -xzf "${ARCHIVE}" -C "${STAGING}"

[[ -f "${STAGING}/database.sql" ]] || {
  printf '\n  [!] Archive contains no database.sql\n\n' >&2; exit 1;
}

printf '\n  Trip2World - restore\n  --------------------\n\n'
[[ -f "${STAGING}/MANIFEST.txt" ]] && sed 's/^/  /' "${STAGING}/MANIFEST.txt"

printf '\n  This will REPLACE the contents of database "%s".\n' "${POSTGRES_DB}"
printf '  Every account, report and moderation record currently stored will be lost.\n\n'
read -r -p '  Type RESTORE to continue: ' CONFIRM
[[ "${CONFIRM}" == "RESTORE" ]] || { printf '\n  Aborted. Nothing changed.\n\n'; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────

printf '\n  [1/5] Taking a safety dump of the CURRENT database...\n'
SAFETY="${DATA_ROOT}/backups/pre-restore-$(date +%Y%m%d-%H%M%S).sql"
mkdir -p "$(dirname "${SAFETY}")"
# If the restore turns out to be the wrong archive, this is the way back.
docker compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  --clean --if-exists --no-owner --no-privileges > "${SAFETY}" || {
    printf '  (current database could not be dumped - continuing)\n'
  }
chmod 600 "${SAFETY}" 2>/dev/null || true
printf '        %s\n' "${SAFETY}"

# Stop the applications but leave Postgres running: writes during a restore would race
# the import and could leave foreign keys pointing at rows that were just replaced.
printf '  [2/5] Stopping application containers...\n'
docker compose stop api realtime worker web admin >/dev/null 2>&1 || true

printf '  [3/5] Importing database...\n'
docker compose exec -T postgres psql \
  --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  --quiet --set ON_ERROR_STOP=on < "${STAGING}/database.sql"

# Redis is deliberately not restored — but it MUST be cleared. Its contents refer to
# matches and sessions from the pre-restore database; leaving them would occupy accounts
# in conversations that no longer exist and point presence at vanished users.
printf '  [4/5] Flushing Redis (ephemeral state, safe and necessary)...\n'
docker compose exec -T redis redis-cli --no-auth-warning -a "${REDIS_PASSWORD}" FLUSHALL >/dev/null

printf '  [5/5] Starting application containers...\n'
docker compose up -d >/dev/null

printf '\n  Restore complete.\n'
printf '  Rollback dump: %s\n' "${SAFETY}"
printf '  Everyone has been signed out - sessions did not survive the restore.\n\n'
