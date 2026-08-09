# Trip2World

**Meet the world, one conversation at a time.**

A self-hosted random video-chat and social-discovery platform. A user opens the app, is
paired with a compatible stranger, talks over WebRTC, and can press **Next** at any moment
to meet someone else.

Free to use, with an optional token economy for tipping.

---

## What it is

| | |
| --- | --- |
| **Video** | Peer-to-peer WebRTC. The server relays signaling only and never sees media |
| **Matching** | Preference-based with progressive relaxation, so nobody waits forever |
| **Safety** | 18+ gate, human-reviewed reports, bidirectional blocking, moderation panel |
| **Privacy** | Country-level location at most. No recording, ever |
| **Monetisation** | Buy tokens, tip the person you are talking to |
| **Deployment** | One Docker Compose stack. Postgres, Redis, coturn, Caddy |

---

## Architecture

```
                        ┌──────────────┐
      trip2world.net    │              │ :8181 ─┬─ /        web       (Next.js)
                        │    Caddy     │        ├─ /api/*   api       (Fastify)
admin.trip2world.net    │              │ :8182  └─ /rt      realtime  (Socket.IO)
                        └──────┬───────┘        └─ /        admin     (Next.js)
                               │
                 ┌─────────────┼─────────────┬──────────────┐
                 │             │             │              │
             postgres        redis        worker          coturn
            (durable)     (ephemeral)   (scheduled)    (STUN/TURN)
```

Nine containers. Only Caddy and coturn are reachable from outside; Postgres, Redis and
every application container stay on the internal network.

**The API and the realtime service are separate processes** because they have opposite
performance profiles: one does database-bound request/response work, the other holds tens
of thousands of mostly-idle sockets and must never block its event loop. A slow query in
the same process would add latency to every signaling message.

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Repository layout

```
apps/
  web        Public app — landing, auth, video chat, settings
  admin      Moderation panel (separate origin)
  api        HTTP API — auth, profile, safety, tokens, admin
  realtime   Presence, matchmaking, WebRTC signaling, tipping
  worker     Scheduled maintenance (BullMQ)
packages/
  types      Domain model, realtime protocol contract
  shared     Matchmaking policy, privacy funnel, Redis keys  (isomorphic)
  validation Zod schemas for every HTTP and socket boundary
  database   Prisma schema, queries, token ledger
  auth       Argon2id, JWT, TURN credentials                  (server-only)
  mailer     SMTP                                             (server-only)
  ui         Shared React primitives and API client
  config     Shared tsconfig and eslint presets
infrastructure/
  docker     Multi-stage Dockerfiles
  caddy      Reverse proxy
  coturn     TURN configuration
  scripts    Setup, secrets, backup, restore
```

Dependencies flow one way: `apps/*` → `packages/*`, and packages depend only on packages
below them.

---

## Development

Requires Node 22+, pnpm 9, and Docker.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # postgres, redis, mailpit, coturn
pnpm db:migrate && pnpm db:seed
pnpm dev
```

| | |
| --- | --- |
| Web | http://localhost:3000 |
| Admin | http://localhost:3001 |
| API | http://localhost:4000 |
| Mail | http://localhost:8025 (Mailpit catches every outbound email) |

Create an administrator — there is no default account and no default password anywhere in
this repository:

```bash
pnpm admin:create
```

### Commands

```bash
pnpm dev               # every app in watch mode
pnpm build             # build everything
pnpm typecheck         # tsc --noEmit across the workspace
pnpm lint
pnpm test              # unit tests, no external dependencies
pnpm test:integration  # needs postgres + redis
pnpm --filter @trip2world/web test:e2e   # Playwright

pnpm db:migrate        # create and apply a migration
pnpm db:studio         # browse the database
pnpm db:seed           # interests, feature flags, token packages
```

On Windows, `NEXT_DISABLE_STANDALONE=1` is needed for a local Next.js build — creating
symlinks requires elevated privileges there. Docker builds on Linux are unaffected.

---

## Deployment

Full guide: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

```bash
sudo mkdir -p /DATA/AppData/Trip2World && sudo chown "$USER":"$USER" /DATA/AppData/Trip2World
cd /DATA/AppData/Trip2World && git clone <repo> app && cd app

chmod +x infrastructure/scripts/*.sh
sudo ./infrastructure/scripts/setup-casaos.sh

cp .env.example .env
node infrastructure/scripts/generate-secrets.mjs
nano .env        # TURN_EXTERNAL_IP, SMTP_*, domains

docker compose up -d
docker compose exec api pnpm admin:create
```

### Three things that will silently break a deployment

**1. TURN must bypass Cloudflare.** It is UDP; the proxy carries HTTP and WebSocket only.
Use a DNS-only (grey cloud) record and forward 3478/udp+tcp and 49160–49200/udp. Without a
reachable relay, users behind symmetric NAT — most mobile carriers — never connect, while
everything looks healthy.

**2. `TURN_EXTERNAL_IP` must be the public address.** Behind NAT, coturn otherwise
advertises the container's private address in relay candidates, which are unroutable.

**3. `APP_URL` must be `https://` in production.** Secure cookies are dropped over plain
HTTP, which presents as login succeeding and then immediately failing. The API refuses to
start otherwise.

### Backups

```bash
./infrastructure/scripts/backup.sh
./infrastructure/scripts/restore.sh trip2world-<timestamp>.tar.gz
```

Postgres only. Redis holds exclusively ephemeral state and must **not** be restored — see
[`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

---

## Safety

Safety is architectural here, not a feature bolted on:

- **18+ floor** an operator can raise but never lower.
- **Next, Report and Block are never disabled** — not by a tip, not by an offer of extra
  time, not by anything. A paid way to hold someone in a call would be a harassment tool.
- **Conversations are not recorded.** `Match` stores metadata only.
- **Child-safety and threat reports jump the moderation queue** regardless of age.
- **Blocks are bidirectional and permanent.**
- **Every moderator action is written to an append-only audit log.**

[`docs/MODERATION.md`](docs/MODERATION.md) · [`docs/SECURITY.md`](docs/SECURITY.md)

---

## Tokens

Users buy tokens and tip the person they are talking to. A tip may carry an **offer** of
extra call time, which the recipient accepts or declines — the tokens transfer either way,
and declining costs nothing.

The ledger is append-only; `TokenAccount.balance` is a cache written in the same
transaction. Debits are a single conditional `UPDATE … WHERE balance >= n`, so concurrent
tips cannot overdraw. Stripe webhooks are idempotent on the event id, and nothing credits
from the success redirect.

An administrator can also schedule **promotions** — free tokens for new accounts, for a
given day, or for the first N registrations. Grants are once per user, capped atomically,
and require a confirmed email address by default. See [PROMOTIONS](docs/PROMOTIONS.md).

Tokens have no cash value and cannot be withdrawn. Enabling real payouts would likely make
the operator a money transmitter — and would turn every promotional token into money, which
is why payouts and unlimited promotions cannot both exist.

Works with no Stripe keys configured — the catalogue renders as unavailable.

---

## Documentation

| | |
| --- | --- |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Services, data placement, scaling path |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | DNS, tunnel, Gmail SMTP, first run |
| [WEBRTC](docs/WEBRTC.md) | Signaling, TURN, device matrix, troubleshooting |
| [MATCHMAKING](docs/MATCHMAKING.md) | Rules, relaxation, double-booking prevention |
| [SECURITY](docs/SECURITY.md) | Threat model, controls, known gaps |
| [MODERATION](docs/MODERATION.md) | Queue, outcomes, operational guidance |
| [PROMOTIONS](docs/PROMOTIONS.md) | Scheduled free-token campaigns, and the abuse limits |
| [I18N](docs/I18N.md) | Adding a language, translator rules, what stays English |
| [MOBILE](docs/MOBILE.md) | PWA state, and what native would require |
| [BACKUP_RESTORE](docs/BACKUP_RESTORE.md) | Procedures and verification |

---

## Status

Working and deployed: registration, email verification, password reset, matchmaking,
two-way WebRTC video, skip/rematch, text chat, reporting, blocking, the moderation panel,
the token economy and tipping, profile and privacy settings.

The interface is translatable and ships in English and Portuguese; four more locales route
but are untranslated. See [I18N](docs/I18N.md).

Not built: native mobile apps, OAuth sign-in, connections/friends, creator payouts.

The legal pages in `apps/web/src/app/{terms,privacy,guidelines,safety}` accurately describe
how the software behaves but **have not been reviewed by a lawyer**. Each carries a visible
notice to that effect. Have them reviewed before launch.
