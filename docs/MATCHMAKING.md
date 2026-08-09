# Matchmaking

How Trip2World decides who talks to whom, and why it is built this way.

---

## Where the logic lives

The selection policy is a set of **pure functions over plain data** in
`packages/shared/src/matchmaking.ts`. It has no Redis, database, or socket dependency.

That separation is deliberate and load-bearing: pairing rules are the part of this system
where a subtle mistake causes real harm — matching a blocked pair, matching someone with
themselves, starving a user forever — and pure functions can be tested exhaustively
without infrastructure. There are 30 unit tests over that file alone.

The realtime service supplies candidate snapshots from Redis and commits whatever the
policy returns (`apps/realtime/src/matchmaker.ts`).

---

## Two classes of rule

### Hard rules — never relaxed

These are safety and correctness invariants. They are not scored, weighted, or traded off:

- Never match a user with themselves.
- Never match a blocked pair, **in either direction**.
- Never match someone already occupied by another conversation.
- Restricted accounts (banned, suspended, deactivated) never enter the queue at all.

Blocks are stored directionally but merged bidirectionally by `getBlockedUserIds`, which
exists exactly once so no call site can get the direction wrong.

### Soft rules — progressively relaxed

Gender, country, language, age bracket, interests. These express taste, and holding them
rigidly means a user with narrow preferences waits forever while people they would happily
have talked to pass by.

| Waited | Constraints still enforced |
| --- | --- |
| 0–5 s | everything |
| 5–15 s | drop interest matching |
| 15–30 s | also drop age bracket and language |
| 30–60 s | also drop country |
| 60 s+ | any otherwise-compatible user |

Interests never hard-filter, even at the strictest stage — they only boost the score.
Hard-filtering on interests fragments the pool badly on a small deployment, which is
precisely when the pool can least afford it.

Operators can replace this ladder from the admin panel; the schema requires strictly
increasing `afterSeconds`, because an out-of-order stage is silently unreachable.

---

## Each side is evaluated at its own stage

A pairing is legal only when **both** users' preferences are satisfied — but each is
checked against *its own* relaxation stage.

This means a patient user with broad taste can be paired with an impatient user with
narrow taste as soon as the narrow one's stage permits, rather than both being held
hostage by whichever is stricter. It is the behaviour pinned by the test *"requires both
sides to be satisfied at their own stage."*

---

## Scoring

Legal pairs are ranked; the highest score wins.

| Signal | Weight |
| --- | --- |
| Shared interests | 12 each, capped at 48 |
| Shared languages | 8 each, capped at 16 |
| Mutual country preference | 15 |
| One-sided country preference | 7 |
| Queue age (longest-waiting side) | 1.5/second, capped at 60 |
| Plan priority | 10/level, **only when priority queueing is enabled** |
| Recently matched together | **−500** |

### The recent-partner penalty is not an exclusion

−500 is large enough that any alternative wins, but it is finite. On a quiet server,
reconnecting to the one other person online beats being told nobody is available. An
absolute exclusion would produce an empty room where a conversation was possible.

### Ties break deterministically

Earliest `queuedAt`, then user id. Two realtime nodes evaluating the same pool therefore
reach the same answer, so the Redis lock only has to settle genuine races rather than
arbitrary disagreement between nodes.

---

## Committing a pairing without double-booking

The invariant is that one account is in at most one conversation. Selection is only a
proposal; Redis decides.

```
1. Acquire pairing locks for both users, in ascending user-id order
2. Re-verify both are still queued and unoccupied
3. Claim occupancy with SET NX for each user
4. If either claim fails, roll back the other and abandon
5. Remove both from the queue, then announce
```

**Fixed lock ordering** is what prevents deadlock. Without it, node A can hold *user-a*
while wanting *user-b* exactly as node B holds *user-b* while wanting *user-a*. With a
consistent order, one node simply fails on the first lock and moves on — no waiting, no
retry storm.

Lock acquisition failure is never retried. Another node is mid-commit with that candidate,
so the right move is to try a different one.

Every key carries a TTL. A node that dies mid-commit leaves keys that expire, rather than
wedging a user out of matchmaking permanently.

Relevant keys:

| Key | Purpose |
| --- | --- |
| `t2w:user-match:{userId}` | Occupancy record. Its existence means "in a conversation" |
| `t2w:match-lock:{userId}` | Held only while a pairing is committed |
| `t2w:match:{matchId}` | Participants, consulted by the signaling relay on every frame |

---

## Queue sharding

Queues are sharded by coarse continental region — `eu`, `na`, `sa`, `as`, `af`, `oc`, plus
`global`. Every user is indexed into both their region and `global`.

This keeps each sorted set small enough to scan cheaply. `shardsToScan()` widens the search
to every region once a user's stage has dropped the country constraint, and always includes
shards for any explicitly preferred country.

Sharding is by **region, never by city or coordinates** — country is the finest location
granularity anywhere in this system.

---

## Matching uses true attributes, not the privacy-filtered view

A user who hides their country from partners is still matched on it. Those are different
concerns, and conflating them produces a subtle bug where privacy settings silently
degrade match quality.

The privacy funnel applies only to what the *partner receives* in `match:found`.

---

## The tick

Joining the queue attempts a match immediately — on a busy server most users pair on that
first attempt and never see the searching screen at all.

A user who finds nobody stays queued, and a per-node tick retries every second. Each node
sweeps only its own connected sockets: the Redis locks make concurrent sweeps safe, and
scanning locally keeps the work proportional to the node's own load rather than the whole
fleet's.

The tick also emits `queue:waiting` with `searchingNow`, so the client can distinguish
"still looking" from "nobody else is here". Without that, an empty room is
indistinguishable from a broken matchmaker — a real source of confusion during development.

---

## Tuning

Operator-adjustable from the admin panel, stored in `SystemSetting`:

| Setting | Default | Effect |
| --- | --- | --- |
| `relaxationStages` | see table above | How quickly preferences loosen |
| `maxQueueSeconds` | 180 | When the client is told to try again |
| `skipCooldownSeconds` | 1800 | How long a skipped pair is kept apart |
| `minSecondsBetweenSkips` | 1 | Spacing between Next presses |
| `negotiationTimeoutMs` | 20000 | Deadline for completing signaling |

If users complain about long waits, lengthen the ladder's early stages *less*, not more —
the fix for a thin pool is faster relaxation, not stricter matching.

---

## Related

- `packages/shared/src/matchmaking.ts` — the policy, and its tests
- `apps/realtime/src/matchmaker.ts` — commit protocol
- `apps/realtime/src/queue.repository.ts` — Redis layout, locks, cooldowns
- `packages/shared/src/redis-keys.ts` — the full key registry
