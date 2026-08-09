#!/usr/bin/env bash
#
# Pull, build, start, verify. One command, in the right order, every time.
#
# This exists because "did that need a rebuild?" has been answered wrongly twice, in both
# directions, and each time it cost an evening:
#
#   - A `.env` change was made and the stack restarted. NEXT_PUBLIC_* are compiled into
#     the JavaScript at BUILD time, so the browser kept using the old hostname while every
#     server-side check reported the new one. The configuration was right and the running
#     app disagreed.
#   - A client fix was pulled and the script re-run without a rebuild. The repository was
#     correct, the deployment was not, and nothing said so.
#
# So this always builds, and stamps every image with the commit it came from. Building
# when nothing changed costs a cached no-op; not building when something did costs hours.
#
# Usage:  ./infrastructure/scripts/deploy.sh [--no-pull]

set -euo pipefail
cd "$(dirname "$0")/../.."

PULL=1
[[ "${1:-}" == "--no-pull" ]] && PULL=0

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

if [[ $PULL -eq 1 ]]; then
  step "Pulling"
  git pull --ff-only
fi

# Stamped into every image so `diagnose.sh` can prove what is running.
GIT_SHA="$(git rev-parse --short HEAD)"
export GIT_SHA
echo "  commit ${GIT_SHA}"

if ! git diff --quiet HEAD -- . ':!*.env'; then
  echo "  note: the working tree has uncommitted changes; they WILL be built"
fi

step "Building"
docker compose build

step "Starting"
# `migrate` runs and exits before the applications start; a failed migration stops the
# deploy here rather than leaving services running against a schema they were not built
# for.
docker compose up -d

step "Waiting for containers to settle"
sleep 8

step "Verifying"
./infrastructure/scripts/diagnose.sh
