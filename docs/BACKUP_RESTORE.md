# Backup and restore

---

## What must be backed up, and what must not

**PostgreSQL is the only thing that needs backing up.** It holds every durable fact:
accounts, profiles, the social graph, reports, moderation history, the audit log, and the
token ledger.

**Redis must NOT be restored.** Every key it holds is ephemeral by design — matchmaking
queues, presence, live match locks, rate-limit counters. The full list is
`EPHEMERAL_KEY_PREFIXES` in `packages/shared/src/redis-keys.ts`.

Restoring stale Redis state is not merely useless, it is actively harmful: it resurrects
matches whose participants are long gone and marks accounts as occupied in conversations
that do not exist. Losing Redis on a restart is expected and safe — clients simply re-enter
matchmaking.

**`.env` is included in the archive** because without `POSTGRES_PASSWORD` the dump cannot be
restored into a fresh stack. That makes the archive as sensitive as the database itself,
which is why it is written mode 0600.

---

## Taking a backup

```bash
cd /DATA/AppData/Trip2World/app
./infrastructure/scripts/backup.sh
```

Writes `${DATA_ROOT}/backups/trip2world-<timestamp>.tar.gz` containing:

| File | Contents |
| --- | --- |
| `database.sql` | `pg_dump --clean --if-exists` |
| `env` | The `.env` in force at backup time — **contains secrets** |
| `docker-compose.yml` | The stack definition |
| `MANIFEST.txt` | Timestamp, host, database name, dump size |

`pg_dump` runs **inside** the container, so the host needs no Postgres client and the dump
version always matches the server. The script aborts if the dump is empty — a failed
command that still produces a file is exactly the failure you do not want to discover
during a restore.

Backups older than 14 days are removed. Deletion is by age rather than count, so a burst of
manual backups cannot push out the scheduled ones.

### Scheduling

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * cd /DATA/AppData/Trip2World/app && ./infrastructure/scripts/backup.sh >> /DATA/AppData/Trip2World/backups/cron.log 2>&1") | crontab -
```

### Copy it off the machine

A backup on the same disk is not a backup. It survives a bad migration; it does not survive
a failed disk, a deleted VPS, or ransomware.

```bash
rsync -avz --remove-source-files \
  /DATA/AppData/Trip2World/backups/ \
  backup-host:/backups/trip2world/
```

Encrypt before sending anywhere you do not control — the archive contains your secrets and
every user's personal data:

```bash
gpg --symmetric --cipher-algo AES256 trip2world-20260809-030000.tar.gz
```

---

## Restoring

```bash
./infrastructure/scripts/restore.sh trip2world-20260809-030000.tar.gz
```

The script:

1. Prints the manifest so you can confirm you have the right archive.
2. **Requires you to type `RESTORE`.** The most common way to lose production data is a
   restore aimed at the wrong environment.
3. Takes a safety dump of the *current* database first — your way back if the archive turns
   out to be wrong.
4. Stops the application containers, leaving Postgres running. Writes during an import race
   the restore and can leave foreign keys pointing at rows that were just replaced.
5. Imports with `ON_ERROR_STOP=on`, so a partial import fails loudly.
6. **Flushes Redis.** Not optional: its contents refer to matches and sessions from the
   pre-restore database.
7. Restarts the applications.

Everyone is signed out afterwards — sessions do not survive a restore, since the session
rows come from the archive.

---

## Verifying a backup

An untested backup is a hope. Test quarterly, on a machine that is not production:

```bash
# Fresh stack elsewhere
git clone <repo> t2w-restore-test && cd t2w-restore-test
cp .env.example .env && node infrastructure/scripts/generate-secrets.mjs
docker compose up -d postgres

# Import
tar -xzf trip2world-20260809-030000.tar.gz -C /tmp/verify
docker compose exec -T postgres psql -U trip2world -d trip2world \
  --set ON_ERROR_STOP=on < /tmp/verify/database.sql

# Sanity-check
docker compose exec -T postgres psql -U trip2world -d trip2world -c \
  "SELECT (SELECT count(*) FROM users) AS users,
          (SELECT count(*) FROM reports) AS reports,
          (SELECT count(*) FROM token_ledger) AS ledger;"
```

Confirm the counts match production. If the ledger is present, also confirm it reconciles —
the sum of `delta` per user must equal that user's `TokenAccount.balance`:

```sql
SELECT a."userId", a.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
FROM token_accounts a
LEFT JOIN token_ledger l ON l."userId" = a."userId"
GROUP BY a."userId", a.balance
HAVING a.balance <> COALESCE(SUM(l.delta), 0);
```

**Zero rows is the expected result.** Any row means the cached balance has diverged from the
ledger, which is a bug worth investigating before it becomes a financial dispute.

---

## Before a risky change

Migrations are additive by convention, but take a backup before any deploy that includes
one:

```bash
./infrastructure/scripts/backup.sh && docker compose build && docker compose up -d
```

The `migrate` service runs `prisma migrate deploy` and exits before the applications start,
so a failed migration halts the deploy rather than leaving services running against a schema
they were not built for.

---

## Disaster recovery

Rebuilding from nothing but an archive:

```bash
# 1. Host
sudo mkdir -p /DATA/AppData/Trip2World
sudo chown "$USER":"$USER" /DATA/AppData/Trip2World
cd /DATA/AppData/Trip2World && git clone <repo> app && cd app
chmod +x infrastructure/scripts/*.sh
sudo ./infrastructure/scripts/setup-casaos.sh

# 2. Configuration, from the archive
tar -xzf trip2world-<timestamp>.tar.gz -C /tmp/recover
cp /tmp/recover/env .env && chmod 600 .env

# 3. Database only
docker compose up -d postgres
docker compose exec -T postgres psql -U trip2world -d trip2world \
  --set ON_ERROR_STOP=on < /tmp/recover/database.sql

# 4. Everything else
docker compose up -d
```

Then re-point DNS and the tunnel at the new host, and re-verify TURN — `TURN_EXTERNAL_IP`
in the restored `.env` is the **old** machine's address and will be wrong.

That last point is the one most likely to be missed: calls will appear to work for anyone
on the same network and fail silently for everyone who needs a relay.

---

## Retention and erasure

Backups contain personal data, so retention interacts with deletion requests. A user erased
from the live database still exists in archives taken before their request.

The 14-day rotation bounds this: an erased account disappears from all backups within two
weeks. If you extend retention, extend it knowing that is the trade you are making, and say
so in your privacy policy.

---

## Related

- `infrastructure/scripts/backup.sh`, `restore.sh`
- `packages/shared/src/redis-keys.ts` — what is ephemeral and why
- `docs/DEPLOYMENT.md` — first-run setup
