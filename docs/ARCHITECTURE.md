# Trip2World — Architecture

This document is the reference for how Trip2World is put together and, more importantly,
*why*. Where a decision has a plausible alternative, the alternative and the reason it was
rejected are recorded, so a future change is an informed one rather than a rediscovery.

---

## 1. What Trip2World is

A random one-to-one video chat and social discovery platform. A user opens the app, is
paired with a compatible stranger, talks over WebRTC, and can press **Next** at any moment
to be paired with someone else.

The product is entirely original: its own branding, UX, data model, matchmaking policy,
moderation system, and code. It borrows the *interaction model* of the random-video-chat
category and nothing else.

---

## 2. Services

| Service | Stack | Responsibility |
| --- | --- | --- |
| `apps/web` | Next.js (App Router), React, Tailwind | Marketing site, auth flows, the video chat client, profile & settings. PWA. |
| `apps/admin` | Next.js | Moderation queue, user management, runtime configuration, audit log. Separate origin. |
| `apps/api` | Fastify, Prisma | Stateless HTTP API. Auth, profiles, preferences, social graph, reports, admin operations. |
| `apps/realtime` | Socket.IO, Redis adapter | Presence, matchmaking, match lifecycle, WebRTC signaling relay, ephemeral chat. |
| `apps/worker` | BullMQ | Email delivery, account erasure after the grace period, suspension expiry, retention sweeps, dashboard aggregates. |
| `apps/mobile` | React Native + `react-native-webrtc` | Native iOS/Android client. Not a WebView. |
| `coturn` | — | STUN + TURN. Required in production. |
| `postgres` | PostgreSQL 16 | Durable state. |
| `redis` | Redis 7 | Ephemeral state, pub/sub, rate limits, locks. |
| `caddy` | Caddy 2 | Reverse proxy, automatic HTTPS, WebSocket upgrade. |

### Why the API and the realtime server are separate processes

They have opposite performance profiles. The API does database-bound request/response work
and scales on CPU per request; the realtime server holds tens of thousands of mostly-idle
sockets and must never block its event loop. Co-locating them means one slow Prisma query
adds latency to every signaling message on the same node, which shows up directly as
longer time-to-first-frame. Separating them also lets them scale independently — a
deployment usually needs far more realtime capacity than API capacity.

They share the same JWT signing key and the same Redis, so a socket can be authenticated
without a round trip to the API.

---

## 3. Data placement: Postgres vs Redis

The single most consequential decision in the system.

**Postgres holds durable truth**: accounts, profiles, preferences, the social graph,
reports, moderation history, audit log, subscriptions, and *completed* match metadata.

**Redis holds everything ephemeral**: presence, the matchmaking queue, live match state,
the per-user occupancy lock, skip cooldowns, rate limit counters, and cross-node pub/sub.

The rule of thumb: if losing it on a restart is acceptable because clients simply
re-enter matchmaking, it belongs in Redis.

Presence is the clearest case. With a 30-second heartbeat, 10 000 online users is ~333
writes/second to Postgres for data that is worthless the moment the process restarts. That
is a write-amplification problem with no upside. Presence lives in Redis under a TTL, so a
client that crashes without a clean disconnect simply expires.

Every Redis key is built through `createRedisKeys()` in `@trip2world/shared` —
`packages/shared/src/redis-keys.ts`. Nothing concatenates a key inline. That file also
declares `EPHEMERAL_KEY_PREFIXES`, which is what lets the backup procedure state honestly
that Redis does not need to be backed up.

---

## 4. Matchmaking

The policy is pure, data-only, and lives in `packages/shared/src/matchmaking.ts`. It has no
Redis or database dependency, which is what makes it exhaustively unit-testable — see the
30 cases in `matchmaking.test.ts`.

### Two classes of rule

**Hard rules** are safety and correctness invariants. They are never relaxed and never
merely down-weighted:

- never match a user with themselves
- never match a blocked pair, *in either direction*
- never match a user who is already occupied by another match
- restricted accounts (banned, suspended, deactivated) never enter the queue at all

**Soft rules** are user taste — gender, country, language, age bracket, interests. These
progressively relax the longer someone waits, so a user with narrow preferences ends up in
a conversation rather than staring at a spinner.

### The relaxation ladder

| Waited | Constraints still enforced |
| --- | --- |
| 0–5 s | everything |
| 5–15 s | drop interest matching |
| 15–30 s | also drop age bracket and language |
| 30–60 s | also drop country |
| 60 s+ | any otherwise-compatible user |

Interests never hard-filter even at the strictest stage; they only boost the score. Hard
filtering on interests would fragment the pool badly on a small deployment.

### Each side is evaluated at its own stage

A candidate pair is legal only if **both** users' preferences are satisfied, but each is
checked against *its own* relaxation stage. A patient user with broad taste can therefore
be paired with an impatient user with narrow taste as soon as the narrow one's stage
allows — rather than both being held hostage by whichever is stricter. This is the
`selectBestMatch` behaviour pinned by the "requires both sides to be satisfied at their
own stage" test.

### Scoring and the recent-partner penalty

Legal pairs are ranked: shared interests, shared languages, mutual country preference, and
queue age all contribute. A recently-skipped partner gets a **-500** penalty rather than
an absolute exclusion. The distinction is deliberate: on a quiet server, reconnecting to
the one other person online beats being told nobody is available, but whenever any
alternative exists the penalty guarantees it wins.

Ties break on earliest `queuedAt`, then on user id, so two realtime nodes evaluating the
same pool reach the same answer. The Redis lock then only has to settle genuine races
rather than arbitrary disagreement between nodes.

### Preventing double-booking

The invariant is that one account is in at most one conversation. It is enforced with two
Redis keys:

- `t2w:user-match:{userId}` — the occupancy record, set with `NX` so the first writer wins.
- `t2w:match-lock:{userId}` — a short-lived lock held only while a pairing is committed.

A pairing is committed by acquiring locks for both users in a **deterministic order**
(lower user id first). Fixed ordering is what prevents two nodes pairing (A,B) and (B,A)
simultaneously and deadlocking. If either lock cannot be acquired, the candidate is
skipped and the search continues — no waiting, no retry storm.

Both keys carry TTLs, so a realtime node that dies mid-pairing cannot wedge a user out of
matchmaking permanently.

### Queue sharding

Queues are sharded by coarse continental region (`eu`, `na`, `sa`, `as`, `af`, `oc`, plus
`global`), keeping each sorted set small enough to scan cheaply. `shardsToScan()` widens
the search to every region once a user's stage has dropped the country constraint.

---

## 5. Session state machine

The client conversation lifecycle is an explicit machine
(`packages/shared/src/session-machine.ts`) with a declared transition table. The UI renders
exactly one state, so "connected but still searching" or "in a match with no peer" are not
representable.

```
IDLE → REQUESTING_PERMISSIONS → READY → QUEUED → MATCH_FOUND
     → SIGNALING → CONNECTING → CONNECTED
                              ↘ RECONNECTING → CONNECTED | QUEUED
     CONNECTED → SKIPPING → QUEUED        (user pressed Next)
     CONNECTED → PARTNER_LEFT → QUEUED    (partner left)
```

`ERROR` and `IDLE` are reachable from everywhere — a fatal failure or a user closing the
tab can happen at any point. Everything else is explicitly enumerated, and `transition()`
throws on an illegal move rather than silently corrupting state.

---

## 6. WebRTC

Trip2World is peer-to-peer for media. The server never sees or relays video or audio; it
relays only SDP and ICE candidates.

- **Glare avoidance.** The server designates exactly one peer as the offerer
  (`isInitiator` in the `match:found` payload). Both sides never offer simultaneously.
- **STUN + TURN.** coturn is deployed as part of the stack. Public STUN alone is not
  sufficient in production: symmetric NAT and restrictive corporate/mobile networks need a
  relay, and without TURN those users simply never connect.
- **Ephemeral TURN credentials.** Long-lived static TURN credentials in client code are a
  free relay for anyone who opens devtools. Trip2World uses coturn's REST-auth scheme:
  the server derives `username = <expiry-timestamp>:<userId>` and
  `credential = base64(HMAC-SHA1(TURN_SECRET, username))`. The shared secret never leaves
  the server, and credentials expire in two hours.
- **Negotiation deadline.** If signaling does not complete within
  `negotiationTimeoutMs` (default 20 s), the server tears the match down and requeues both
  users, so a client that fails silently cannot hold a partner hostage.
- **Bounded reconnect.** A dropped connection attempts recovery for a bounded window
  before returning the user to matchmaking, rather than retrying forever.

SDP payloads are size-capped and required to begin with `v=0`. Without that check the
signaling channel is a general-purpose text relay between two strangers — i.e. an
unmoderated chat that bypasses every safety control.

---

## 7. Authentication

- **Argon2id** for password hashing (memory 19 MiB, time 2, parallelism 1 — the OWASP
  baseline). Chosen over bcrypt for GPU resistance and over scrypt for its better-analysed
  side-channel properties.
- **Short access tokens** (15 min) + **long refresh tokens** (30 days). Access tokens are
  stateless so the realtime server can authenticate a socket without a database round trip.
- **Refresh token rotation with reuse detection.** Only a SHA-256 hash of the current
  refresh token is stored, so a database leak cannot be replayed as a login. Each refresh
  rotates the token; presenting an already-consumed token means it was stolen, which
  revokes the entire session family.
- **Token generation counter.** `User.tokenGeneration` is bumped on password change and on
  forced logout. Every previously issued access token is rejected immediately, without
  maintaining a per-token denylist.
- **Web vs native token storage.** Web clients receive the refresh token as an HttpOnly,
  `SameSite=Strict`, Secure cookie — never readable by JavaScript, so XSS cannot exfiltrate
  it. Native clients have no cookie jar and receive it in the response body for storage in
  the platform keychain. This is why `AuthTokens.refreshToken` is optional in the contract.

---

## 8. Privacy

There is exactly one funnel through which user data reaches another user:
`toPublicProfile()` in `packages/shared/src/privacy.ts`.

It constructs a new object from an allow-list; it never spreads its input. That property is
what makes it safe to add a column to the `User` table — a new field cannot leak by being
forgotten, because nothing is copied unless it is named. `privacy.test.ts` asserts both the
exact key set and that a newly added field does not pass through.

Partners receive: id, username, display name, avatar, country, **age bracket** (never an
exact birthday), languages, gender, interests, bio, verified flag, plan.

Partners never receive: email, password hash, IP, exact date of birth, city, coordinates,
role, account status, internal safety score, moderator notes, or tokens.

Location granularity is **country only**, everywhere in the product.

`assertNoPrivateFields()` walks an outbound payload and throws on any forbidden key at any
depth — defence in depth, used in tests and in development builds of the realtime server.

---

## 9. Safety and moderation

Safety is architectural, not a feature bolted on:

- Configurable minimum age with an **absolute floor of 18** that an operator can raise but
  never lower.
- Report system with nine categories. `UNDERAGE` and `VIOLENCE` are escalated to the top of
  the moderation queue regardless of queue age.
- Blocking is enforced bidirectionally by `getBlockedUserIds()` — the single place block
  direction is resolved.
- Warnings, suspensions (with expiry) and permanent bans, each recorded as an immutable
  `ModerationAction`.
- Expired suspensions are lifted **on read**, so a user is never locked out longer than
  intended because the worker is down.
- Every sensitive admin action writes to an append-only `AuditLog`.

**Conversations are not recorded.** The `Match` table stores metadata only — participants,
timing, end reason, connection quality. Silently recording every private video call would
be a far larger harm than the abuse it mitigates. Deployments with a legal obligation to
retain evidence must enable that explicitly and reflect it in their user-facing policy.

Reports survive the reporter deleting their account (`Report.reporterId` is nullable with
`onDelete: SetNull`) — dropping abuse history whenever a reporter leaves would be trivially
exploitable.

---

## 10. Scaling path

The stack is designed to grow from one home server to a distributed deployment without a
rewrite:

1. **Single host.** Everything in one Docker Compose stack.
2. **Multiple app containers.** The API is stateless; scale it horizontally behind Caddy.
3. **Multiple realtime nodes.** Socket.IO uses the Redis adapter, so a message can reach a
   socket owned by any node. Presence records the owning `nodeId`; matchmaking commits
   through Redis locks and is therefore already correct across nodes — this is why the
   selection function is deterministic.
4. **Distributed.** Postgres read replicas, Redis cluster, geographically distributed
   coturn.

Nothing in the design assumes a single application server. In particular there is no
in-process match registry and no sticky-session requirement for correctness.

---

## 11. Repository layout

```
apps/       web, admin, api, realtime, worker, mobile
packages/   types, validation, shared, database, auth, ui, analytics, config
infrastructure/  docker, coturn, caddy, scripts
docs/
```

Dependency direction is strictly one-way: `apps/*` depend on `packages/*`, and packages
depend only on packages lower in the stack.

```
types  ←  shared  ←  validation
                  ←  database
                  ←  auth
```

`packages/shared` is **isomorphic** — no Node built-ins, no DOM globals — because it is
imported by the React Native bundler as well as by the Node services. Anything requiring
`node:crypto` (password hashing, TURN credential derivation, token signing) lives in
`packages/auth`, which is server-only.

---

## 12. Testing strategy

| Layer | Tool | Covers |
| --- | --- | --- |
| Unit | Vitest | Matchmaking rules, session machine, privacy funnel, validation, sanitisation |
| Integration | Vitest + real Postgres/Redis | Registration, login, queue entry/exit, report, block, admin authorization |
| E2E | Playwright | register → match → skip → report → block; admin investigates → bans |

WebRTC media itself is mocked in E2E (Chromium's `--use-fake-device-for-media-stream`);
genuine peer connectivity, TURN relay, and mobile behaviour are verified by the documented
manual device matrix in `docs/WEBRTC.md`.
