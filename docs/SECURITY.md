# Security

The threat model Trip2World is built against, the controls that implement it, and the
things that are deliberately *not* protected.

---

## What is actually at stake

This is a product where strangers see each other's faces in real time and some of them
pay money. That produces a specific threat profile:

1. **Account takeover** — an attacker in someone's session can appear as them on camera.
2. **Deanonymisation** — learning a user's identity, location, or IP.
3. **Harassment persistence** — evading a block or a ban.
4. **Moderation subversion** — silencing reports, or compromising a moderator account.
5. **Financial fraud** — minting tokens, double-spending, or charging back after spending.

Controls below are grouped by which of these they address.

---

## Authentication

**Argon2id** for password hashing — memory 19 MiB, time 2, parallelism 1 (the OWASP
baseline). Chosen over bcrypt for GPU/ASIC resistance: bcrypt's 4 KiB working set fits
trivially in on-die memory on modern cracking hardware.

**Login is constant-work.** A request for an address that does not exist still pays the
full Argon2 cost, verifying against a dummy hash. Without this, response time is an
account-enumeration oracle. The error message and status are byte-identical for "no such
account" and "wrong password", and an integration test asserts that.

**Where enumeration is unavoidable, it is confined.** Registration must tell you an email
is taken, or the form is unusable. That single disclosure is the only one: login,
password reset, and verification-resend all respond identically regardless of whether the
account exists.

**Progressive lockout** after five failed attempts, doubling to a 15-minute cap. Bounded
rather than permanent, because a permanent lock on failed passwords is a denial-of-service
primitive — anyone who knows an email could lock its owner out indefinitely.

### Tokens

| | Access token | Refresh token |
| --- | --- | --- |
| Format | Signed JWT (HS256) | Opaque 256-bit random |
| Lifetime | 15 minutes | 30 days, rotating |
| Web storage | Memory only | HttpOnly, Secure, SameSite=Strict cookie |
| Native storage | Memory | Platform keychain |
| Stored server-side | No | SHA-256 hash only |

The access token is **never** written to `localStorage`. Anything there is readable by any
script on the page, so one XSS becomes a full account takeover. The refresh token is a
cookie JavaScript cannot read, so XSS cannot exfiltrate a long-lived credential either.

The cost is that a page reload starts with no access token and must call `/refresh`. That
is one extra request in exchange for a materially smaller blast radius.

**Refresh tokens rotate on every use, with reuse detection.** Presenting an already-revoked
token means it was stolen, and revokes the entire session family.

Only a SHA-256 hash is stored. A slow KDF would be wrong here: the token is already 256
bits of uniform randomness with no brute-forceable structure, and paying Argon2 cost on
every refresh would be a self-inflicted denial of service.

**Three revocation levels**, because they have different scopes:

| Mechanism | Revokes | Latency |
| --- | --- | --- |
| Delete the session row | One device | Next refresh |
| Bump `User.tokenGeneration` | Every token for the account | Immediate |
| Redis session denylist | One session's access token | Immediate |

`tokenGeneration` is what makes a ban take effect *now* rather than whenever the user's
15-minute token happens to expire.

---

## Deanonymisation

**Country is the finest location granularity anywhere in this system.** No city, no region,
no coordinates — not stored, not collected, not derivable.

**Exact birth dates never leave their owner.** Partners receive a bracket (`AGE_25_34`),
computed at read time so a forgotten mapper cannot leak the underlying value.

**IP addresses are never stored.** Only a salted, truncated hash — deliberately short
enough to collide, so it cannot serve as a device identifier. The salt is
deployment-specific; without it the small IPv4 space would be brute-forced back to
plaintext in minutes.

**One privacy funnel.** `toPublicProfile()` in `packages/shared/src/privacy.ts` is the only
path by which one user's data reaches another. It constructs a new object from an
allow-list and never spreads its input, so a column added to the `User` table cannot leak
by being forgotten. A test asserts both the exact key set and that a newly added field does
not pass through.

`assertNoPrivateFields()` walks outbound payloads and throws on any forbidden key at any
depth — defence in depth for the case where someone bypasses the funnel.

**Conversations are not recorded.** No video, no audio, no chat transcripts. `Match` stores
participants, timing, end reason, and connection quality — nothing about content. Text
messages are relayed and never written to the database.

### The residual risk you cannot fully remove

WebRTC exposes IP addresses to the peer through ICE candidates. That is inherent to
peer-to-peer media; the alternative is routing all media through a server, which costs
enormously more and means the operator *can* see every conversation.

`iceTransportPolicy: 'relay'` would hide peer IPs behind TURN at the cost of relaying every
call. It is a defensible choice for a higher-risk deployment and is a one-line change in
`use-conversation.ts`.

---

## Harassment persistence

- Blocks are enforced **bidirectionally** and permanently.
- The blocked list shows only blocks you *created* — revealing who blocked you would tell
  someone exactly whose block to evade.
- Bans revoke sessions, bump the token generation, and purge Redis presence and match keys,
  so a banned user is ejected from a live call rather than continuing until their token
  expires.
- Registration flooding is limited per hashed IP.

**Honest limitation:** account-level bans are evadable with a new email address. Meaningful
ban evasion resistance requires device fingerprinting or identity verification, both of
which carry significant privacy costs. That trade has not been made here; `BanScope` exists
in the schema (`ACCOUNT`, `DEVICE`, `NETWORK`) but only `ACCOUNT` is implemented.

---

## Moderation subversion

- Every moderation action writes an immutable `ModerationAction` **and** an `AuditLog` entry.
- The audit log is append-only. No endpoint updates or deletes it, and the admin UI has no
  control that could.
- **Moderators cannot act on staff accounts, and nobody can act on their own** — enforced
  in the moderation service rather than at each endpoint, so both the direct actions and
  the report queue are covered. Filing a report against an administrator and resolving it
  with a ban was a real bypass of both rules while the checks lived on only one path.
- **Banning requires ADMIN wherever it is applied**, including through the MODERATOR-level
  report queue.
- **Nobody can change their own role**, and role changes are SUPER_ADMIN-only with their
  own narrow endpoint and audit action.
- **Reinstatement only lifts an actual restriction.** An unscoped `status: 'ACTIVE'` write
  would have completed an unverified account's email verification, or reactivated an
  account its owner had deactivated.
- **A report can only cite a conversation the reporter was in.** An unchecked match id lets
  someone put two uninvolved accounts in front of a moderator as the apparent subject.
- Reports survive the reporter deleting their account, detached rather than deleted —
  otherwise report-then-delete erases the evidence.
- The admin panel is on its own origin, so its session cookie is host-scoped and never
  attached to a request made by the public web app.

---

## Financial

- **Debits are a single conditional statement** (`UPDATE … WHERE balance >= n`), with zero
  affected rows meaning insufficient funds. Read-then-write is a lost-update bug that lets
  concurrent tips spend the same tokens twice. An integration test fires ten simultaneous
  tips at a balance that covers five.
- **The ledger is append-only** and is the source of truth; `TokenAccount.balance` is a
  cache written in the same transaction.
- **Webhooks are idempotent** on `providerEventId`. Stripe retries on any non-2xx and on
  timeouts; crediting twice is money lost.
- **Nothing credits from the success redirect** — the browser can reach it without paying.
  Only a signature-verified webhook credits.
- The webhook route receives the **raw body**, because a re-serialised body produces a
  different signature and every legitimate event would be rejected.
- Card details never touch this system.

---

## Transport and platform

- HTTPS everywhere; secure cookies are refused over plain HTTP and the config validator
  refuses to boot on an `http://` `APP_URL` in production.
- HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, a restrictive `Referrer-Policy`,
  and a `Permissions-Policy` that grants only camera and microphone.
- CORS uses an explicit allow-list, never a reflected origin. With `credentials: true`,
  reflecting the request's `Origin` is equivalent to `Access-Control-Allow-Origin: *` with
  cookies.
- Postgres and Redis are **never published to the host** in the production compose file.
- Containers run unprivileged; images are multi-stage with dev dependencies pruned.
- The API refuses to start on a placeholder secret, a secret under 32 characters, or the
  same secret reused across two purposes.

---

## Input handling

- Every HTTP body and **every WebSocket frame** is parsed by a Zod schema. A socket frame is
  attacker-controlled input exactly like an HTTP body; there is no "trusted because
  authenticated" path.
- Mass assignment is blocked structurally: profile schemas are `.strict()` and simply have
  no `role`, `plan`, or `status` field.
- No "me" endpoint accepts a user id from the client — everything is scoped to
  `request.user.id`, which removes IDOR from that surface rather than relying on per-handler
  checks.
- Avatar URLs reject non-https, embedded credentials, `169.254.169.254`, RFC1918 ranges, and
  `.internal`/`.local` hosts (SSRF).
- Invisible characters — bidi overrides, zero-width padding, C0 controls — are stripped from
  all user-authored text.
- coturn denies relaying to private ranges, so TURN cannot be used as an SSRF pivot.

---

## Rate limiting

Keyed per user when authenticated, per hashed IP otherwise. Behind Cloudflare this requires
`TRUST_PROXY=true`, or every request appears to come from the proxy and the limiter buckets
the entire internet together.

The limiter **fails open**: if Redis is unavailable, requests are allowed. Refusing all
traffic because the limiter is down converts a Redis blip into a full outage. Throttling
degrades; authentication and authorization still fail closed, independently.

---

## Known gaps

Stated plainly rather than left implicit:

| Gap | Status |
| --- | --- |
| Ban evasion via new account | Accepted. Mitigating it requires fingerprinting or ID verification |
| Peer IP visible via ICE | Inherent to P2P. `relay`-only mode available at a cost |
| No 2FA | Not implemented. Worth adding for moderator and admin accounts first |
| No automated content moderation | Reports are human-reviewed only |
| Legal documents unreviewed | Templates describing actual behaviour; need a lawyer before launch |
| No breach-corpus password check | Only a small common-password denylist |
| Admin ports internet-facing | Depends on deployment. Restrict to the tunnel host and add Cloudflare Access |

---

## Reporting a vulnerability

Contact the operator of the deployment directly. Do not open a public issue for anything
affecting user safety or account security.
