# Promotions

Scheduled grants of free tokens — a launch bonus, a special day, "the first 500 accounts".
Administrators create and switch them on from **Promotions** in the admin panel.

---

## The model

One `TokenCampaign` covers every case, because promotions only differ in three things:
who qualifies, when, and how many.

| Field | |
| --- | --- |
| `tokens` | Granted per user. Fixed |
| `audience` | `NEW_USERS` — accounts created while it runs. `ALL_USERS` — everyone, on next sign-in |
| `startsAt` / `endsAt` | Optional. Null means "from when I switch it on" / "until I switch it off" |
| `maxGrants` | The "first N accounts" cap. Null is unlimited |
| `requiresVerifiedEmail` | Default true. See below |
| `status` | `DRAFT` → `ACTIVE` ⇄ `PAUSED` → `ENDED` |

A campaign is **created stopped**. Saving one and spending money are two separate
decisions, and a typo in the token amount should not be live the instant it is saved.

`ENDED` is terminal. Reviving a finished campaign would silently reopen a budget the
operator closed, so it has to be recreated — which leaves a record of who did it.

Once a campaign has granted anything, its **amount and audience are frozen**. Otherwise
two people would have received different things from the same named promotion, with
nothing to explain why.

---

## Where grants happen

`CampaignsService.applyEligible(userId)` runs at exactly three points:

| | |
| --- | --- |
| Registration | Only when email verification is disabled — otherwise nothing is eligible yet |
| Email verification | The normal payout moment |
| Sign-in | How an `ALL_USERS` campaign reaches an existing account |

One function, three call sites. A promotion that fired from only one of them would be a
promotion half the users never received.

Sign-in is used for `ALL_USERS` rather than a worker that backfills everyone the moment a
campaign goes live. Backfilling writes to every row in the users table for people who may
never come back; granting lazily costs one indexed lookup per login and only pays out to
accounts that actually return — which is also what an operator running a "come back"
promotion wants.

**A promotion can never break signing up.** `applyEligible` catches everything and returns
an empty array. A marketing feature must not be able to take registration down.

---

## The two things that had to be correct

Both are the same class of bug as double-spending tokens, and both are invisible until a
promotion is announced and several hundred people click at once.

**Exactly once per user.** Guaranteed by the unique index on `(campaignId, userId)`, not
by an application check. Two requests can both read "no grant yet" and both proceed; only
one can insert. The loser catches `P2002`, releases its reserved slot, and returns "already
claimed" — which is the correct answer.

**The cap is never exceeded.** `maxGrants` is enforced with a conditional
`UPDATE … WHERE grantsIssued < maxGrants`, with zero affected rows meaning exhausted. A
`COUNT(*)`-then-compare would let fifty simultaneous signups all pass a limit of fifty,
because they all read the same number before any of them wrote.

The counter is reserved **before** the grant is written. A crash between the two costs one
unused slot rather than handing out more tokens than the operator authorised — losing a
slot is an accounting curiosity, exceeding a cap is a budget nobody agreed to.

Four integration tests cover this against real Postgres, including 50 concurrent claims
against a cap and 10 concurrent claims by one user. A mock would agree with whatever the
code assumed.

---

## Abuse

Free tokens on signup are an incentive to create accounts in bulk. Three things limit it:

1. **`requiresVerifiedEmail` defaults to true.** Each farmed account then costs a working
   mailbox. It is the cheapest meaningful brake available without collecting more personal
   data than this product is willing to hold.
2. **Registration is rate-limited per hashed IP**, which is already in place for other
   reasons.
3. **Tokens cannot be withdrawn.** Farmed tokens can be tipped to another account and
   nothing more; there is no cash out, so there is nothing to extract.

That third point is doing most of the work, and it is worth being explicit about what
happens if it ever changes: **enabling creator payouts would turn every promotional token
into money, and this feature into a way to mint it.** Payouts and unlimited promotions
cannot both exist. Whoever builds Stripe Connect has to revisit this — see
`docs/SECURITY.md`.

Turning `requiresVerifiedEmail` off is supported and the admin form warns about it. It is
reasonable for a closed beta and unreasonable for a public launch.

---

## Operating one

**Launch bonus, capped.** 100 tokens, `NEW_USERS`, `maxGrants` 500. The form shows the
worst case — 50 000 tokens — before you commit, because the number that matters is
amount × cap and that is easy to get wrong by a factor of ten across two fields.

**A special day.** 25 tokens, `ALL_USERS`, `startsAt` and `endsAt` covering the day.
Switch to `ACTIVE` in advance; the window does the rest.

**Reaching a user milestone.** There is no automatic "when we hit 10 000 users" trigger.
Watch the count on the dashboard and press Start. A trigger that fires on a moving
threshold is a scheduler and a race condition in exchange for saving one click.

### Watching the spend

The dashboard shows **active campaigns** and **tokens granted** — the second is the sum of
every `PROMO` ledger row. A live campaign is the one thing on the panel that costs money
while nobody is looking at it.

Per campaign, the Promotions page shows claims against the cap and the total granted.

### Audit

Every mutation writes an `AuditLog` entry: `campaign.create`, `campaign.update`,
`campaign.active`, `campaign.paused`, `campaign.ended`. Switching one on has its own action
rather than being buried in an update's metadata, so "who started this" is one query.

Promotions are **ADMIN**, not MODERATOR. A campaign spends real money, so it is a budget
decision, not a moderation one.

---

## Related

- `packages/database/src/campaigns.service.ts` — grant logic and the concurrency guards
- `apps/api/src/routes/admin.routes.ts` — endpoints and audit entries
- `apps/admin/src/app/campaigns/page.tsx` — the operator interface
- `apps/api/src/test/campaigns.integration.test.ts` — the concurrency proofs
- `docs/SECURITY.md` — the payouts interaction
