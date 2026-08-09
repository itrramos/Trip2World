# Moderation

How reports are handled, what evidence exists, and what deliberately does not.

---

## The central decision: conversations are not recorded

`Match` stores participants, start and end times, how it ended, and connection quality.
It stores **nothing about content** — no video, no audio, no transcript. Text messages sent
during a call are relayed and never written to the database.

This is a deliberate trade, and it has a real cost: a moderator reviewing a nudity report
cannot see what happened. They are working from the reporter's account, the reported
account's history, and pattern.

It is still the right call. Silently recording every private video conversation between
strangers would be a far larger harm than the abuse it helps investigate, and a recording
archive is a catastrophic breach waiting to happen — it is the single most damaging thing
this system could hold.

A deployment under a legal obligation to retain evidence must implement that explicitly and
say so in its user-facing policy. Do not add it quietly.

---

## What a moderator actually sees

| Available | Not available |
| --- | --- |
| Reporter and reported account | What was said or shown |
| Category and free-text detail | Video or audio |
| That a conversation occurred, and when | Chat transcript |
| Prior report count, split upheld/total | Reporter's IP |
| Full moderation history | Precise location |
| Account age, status, country | Exact date of birth |

**Prior report counts are usually the whole decision.** One complaint is noise; three
upheld reports in a week is a pattern. The queue surfaces both totals on every row for
exactly that reason.

---

## The queue

Reports arrive `PENDING`. The queue is ordered by age with one exception: **`UNDERAGE` and
`VIOLENCE` are surfaced first regardless of when they arrived.**

In a strictly chronological queue, a child-safety report can sit behind fifty spam reports.
That is the one category where delay causes irreversible harm, so it does not queue
normally.

A moderator can claim a report (`PENDING` → `UNDER_REVIEW`) so two people do not act on the
same one. Claiming is a conditional update — the second claimant gets a conflict, not a
silent overwrite.

---

## Outcomes

| Action | Effect | Minimum role |
| --- | --- | --- |
| Dismiss | Report closed, no action. Recorded | MODERATOR |
| Warn | `ModerationAction` recorded. No restriction | MODERATOR |
| Suspend | Account restricted until an expiry. Sessions revoked | MODERATOR |
| Ban | Permanent. Sessions revoked, `Ban` row created | ADMIN |
| Reinstate | Lifts a ban or suspension | ADMIN |

**The minimum role is enforced on the action, not on the route.** Banning is reachable two
ways — directly, and by resolving a report — and only one of those is an ADMIN-only
endpoint. Checking the role where the ban is applied means the queue cannot be used as a
way around the stricter gate.

Reinstating is scoped to accounts that are actually `BANNED` or `SUSPENDED`. Pressing it on
any other account is a conflict rather than a silent promotion to `ACTIVE`, which would
otherwise complete an unverified account's email verification for it.

Everything runs in **one transaction** — report status, moderation action, ban row, and
account status. A partial apply (a report marked `ACTIONED` against an account that was
never actually suspended) is a silent moderation failure nobody notices until the person
reoffends.

### Restrictions take effect immediately

Applying a restriction also:

- bumps `User.tokenGeneration`, invalidating every issued access token at once;
- revokes all sessions;
- purges Redis presence, match, and queue keys.

Without the last step a banned user stays in their current call until their 15-minute token
expires. A ban has to be immediate or it is not a ban.

### Reason and notes are always separate

`reason` is shown to the user. `notes` is moderator-only and is never returned by any
endpoint a non-moderator can reach. The API refuses a restriction without a user-facing
reason, and the admin UI disables Confirm until one is written — someone whose account is
restricted is entitled to know why.

---

## Guards on moderator power

- **Moderators cannot act on staff accounts.** A compromised moderator account would
  otherwise be able to disable the people who would notice.
- **Nobody can act on their own account**, including role changes — and including
  *dismissing* a report filed against themselves, which is the quiet version of the same
  problem: nothing looks wrong, but the complaint is gone and the moderator who buried it
  is the one it was about.
- **Both guards apply to every path.** A report is not a licence to act on an account a
  moderator could not otherwise touch. Filing a report against an administrator and then
  resolving it was a genuine bypass of both rules until the checks moved out of the direct
  endpoints and into the moderation service itself.
- **Role changes are SUPER_ADMIN-only**, on their own endpoint with its own audit action.
  Privilege escalation is the highest-value target on this surface.
- **Every action is audit-logged**, append-only. No endpoint updates or deletes audit rows
  and the admin UI has no control that could. An audit log a moderator can alter is not an
  audit log — it exists as much to protect a moderator accused of acting badly as to catch
  one who did.

---

## Automatic expiry

Suspensions expire two ways, deliberately redundant:

- **On read** — `getActiveRestriction` lifts an elapsed suspension when the user next
  touches the API, so nobody is locked out longer than intended because the worker is down.
- **On a sweep** — the worker restores expired suspensions every five minutes, so the admin
  dashboard and matchmaking eligibility are correct even if the user never returns.

The sweep uses an explicit status guard: if a moderator banned the account between the read
and the write, it must not quietly downgrade that ban to `ACTIVE`.

Temporary bans (`permanent: false` with an `expiresAt`) are lifted the same way. A permanent
ban has no expiry and is never lifted automatically.

---

## Reports and account deletion

`Report.reporterId` is nullable with `onDelete: SetNull`. When a reporter deletes their
account, reports they filed **about others survive, detached**.

Otherwise report-then-delete erases the evidence, which is trivially exploitable: harass
someone, get reported, report them back, delete, and the record is gone. Nothing retained
identifies the departed user.

---

## What is not built

Named explicitly so nobody assumes otherwise:

- **No automated content moderation.** No nudity classifier, no ML triage. Every report is
  reviewed by a person. On a small deployment that is workable; it does not scale, and
  adding classification would require rethinking the no-recording decision.
- **No proactive scanning.** Nothing looks at a conversation unless someone reports it.
- **No appeals workflow.** `AccountRestriction.appealUrl` exists in the type but is always
  null. A banned user has no in-product route to contest it.
- **No moderator performance metrics**, and no queue SLA tracking.
- **No bulk actions.** Each report is resolved individually.

---

## Operational guidance

**Reports to prioritise regardless of queue position:** `UNDERAGE`, `VIOLENCE`. These
already sort first, but if the queue is deep, work them exclusively until it is clear.

**When a report has no corroboration**, which is common given no recording exists, weigh
the reported account's history. A first report with no prior history and no detail is
usually a dismiss or a warning. The same category arriving repeatedly from unrelated
reporters is the signal that matters.

**Be wary of retaliatory reports.** Someone who has just been reported often reports back.
The timestamps make this visible — check whether a report arrived within seconds of one
against the reporter.

**Suspend before you ban** unless the category is `UNDERAGE` or `VIOLENCE`. Suspensions are
reversible and expire on their own; bans require an admin to undo.

---

## Related

- `apps/api/src/services/moderation.service.ts` — queue, resolution, direct actions
- `apps/api/src/routes/admin.routes.ts` — endpoints and role guards
- `apps/admin/src/app/reports/page.tsx` — the moderator interface
- `apps/worker/src/jobs.ts` — suspension and ban expiry sweeps
- `docs/SECURITY.md` — the wider threat model
