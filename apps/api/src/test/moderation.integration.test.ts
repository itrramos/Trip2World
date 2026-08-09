import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  createStaffUser,
  createTestContext,
  createUser,
  dependenciesAvailable,
  resetTestData,
  type TestContext,
} from './integration-setup.js';

/**
 * The guards on moderator power.
 *
 * Every test here corresponds to a claim made in `docs/MODERATION.md`. That document
 * states that staff cannot be moderated, that nobody acts on their own account, that
 * banning needs an administrator, and that every action is audit-logged. Those were
 * enforced on one code path and not the other — a report was a way around all four,
 * because `resolve()` acted on `report.reportedUserId` without asking who it belonged to.
 *
 * These are integration tests rather than unit tests because the guard has to hold
 * against a real role column and a real audit table, not against a mock that agrees with
 * whatever the caller assumed.
 */

const available = await dependenciesAvailable();
const describeIntegration = available ? describe : describe.skip;

describeIntegration('moderation guards (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await resetTestData(ctx.prisma, ctx.redis);
    await ctx.close();
  });

  beforeEach(async () => {
    await resetTestData(ctx.prisma, ctx.redis);
  });

  /** File a report and return its id, so tests can drive the queue path. */
  async function report(
    reporterToken: string,
    reportedUserId: string,
    category = 'HARASSMENT',
  ): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: auth(reporterToken),
      payload: { reportedUserId, category, alsoBlock: false },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { data: { id: string } }).data.id;
  }

  /* ------------------------------------------------------------------ */
  /* Staff protection                                                    */
  /* ------------------------------------------------------------------ */

  describe('staff accounts', () => {
    it('cannot be suspended directly', async () => {
      const moderator = await createStaffUser(ctx.app, ctx.prisma, 'mod-a', 'MODERATOR');
      const otherModerator = await createStaffUser(ctx.app, ctx.prisma, 'mod-b', 'MODERATOR');

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/users/suspend',
        headers: auth(moderator.token),
        payload: { userId: otherModerator.id, reason: 'Testing the guard.', hours: 24 },
      });

      expect(response.statusCode).toBe(403);

      const after = await ctx.prisma.user.findUnique({ where: { id: otherModerator.id } });
      expect(after?.status).toBe('ACTIVE');
    });

    /**
     * The bypass this whole file exists for.
     *
     * A moderator files a report against an administrator, then resolves their own
     * report with a suspension. Both endpoints are MODERATOR-level, so nothing in the
     * route guards stops it — only the check inside `resolve` does.
     */
    it('cannot be suspended by laundering the action through a report', async () => {
      const moderator = await createStaffUser(ctx.app, ctx.prisma, 'mod-c', 'MODERATOR');
      const admin = await createStaffUser(ctx.app, ctx.prisma, 'admin-a', 'ADMIN');

      const reportId = await report(moderator.token, admin.id);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/resolve',
        headers: auth(moderator.token),
        payload: { reportId, action: 'SUSPEND', reason: 'Fabricated.', suspensionHours: 720 },
      });

      expect(response.statusCode).toBe(403);

      const after = await ctx.prisma.user.findUnique({ where: { id: admin.id } });
      expect(after?.status).toBe('ACTIVE');
    });

    it('cannot be warned', async () => {
      const moderator = await createStaffUser(ctx.app, ctx.prisma, 'mod-d', 'MODERATOR');
      const admin = await createStaffUser(ctx.app, ctx.prisma, 'admin-b', 'ADMIN');

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/users/warn',
        headers: auth(moderator.token),
        payload: { userId: admin.id, reason: 'Testing the guard.' },
      });

      expect(response.statusCode).toBe(403);

      const actions = await ctx.prisma.moderationAction.count({
        where: { targetUserId: admin.id },
      });
      expect(actions).toBe(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Self-action                                                         */
  /* ------------------------------------------------------------------ */

  describe('acting on your own account', () => {
    /**
     * Dismissing a report filed against yourself is the quiet version of this problem:
     * no restriction is applied, so nothing looks wrong, but the complaint is gone and
     * the moderator who buried it is the one it was about.
     */
    it('is refused when dismissing a report about yourself', async () => {
      const moderator = await createStaffUser(ctx.app, ctx.prisma, 'mod-e', 'MODERATOR');
      const reporter = await createUser(ctx.app, 'victim-a');

      const reportId = await report(reporter.token, moderator.id);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/resolve',
        headers: auth(moderator.token),
        payload: { reportId, action: 'DISMISS', reason: 'Nothing to see here.' },
      });

      expect(response.statusCode).toBe(403);

      const after = await ctx.prisma.report.findUnique({ where: { id: reportId } });
      expect(after?.status).toBe('PENDING');
    });

    it('is refused when warning yourself', async () => {
      const moderator = await createStaffUser(ctx.app, ctx.prisma, 'mod-f', 'MODERATOR');

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/users/warn',
        headers: auth(moderator.token),
        payload: { userId: moderator.id, reason: 'Self-inflicted.' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Ban requires ADMIN, on every path                                   */
  /* ------------------------------------------------------------------ */

  describe('banning', () => {
    it('is refused to a moderator through the report queue', async () => {
      const moderator = await createStaffUser(ctx.app, ctx.prisma, 'mod-g', 'MODERATOR');
      const reporter = await createUser(ctx.app, 'reporter-a');
      const offender = await createUser(ctx.app, 'offender-a');

      const reportId = await report(reporter.token, offender.id);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/resolve',
        headers: auth(moderator.token),
        payload: { reportId, action: 'BAN', reason: 'Repeated harassment.' },
      });

      expect(response.statusCode).toBe(403);

      const after = await ctx.prisma.user.findUnique({ where: { id: offender.id } });
      expect(after?.status).toBe('ACTIVE');
    });

    it('succeeds for an admin, revokes sessions, and writes an audit entry', async () => {
      const admin = await createStaffUser(ctx.app, ctx.prisma, 'admin-c', 'ADMIN');
      const reporter = await createUser(ctx.app, 'reporter-b');
      const offender = await createUser(ctx.app, 'offender-b');

      const reportId = await report(reporter.token, offender.id);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/reports/resolve',
        headers: auth(admin.token),
        payload: { reportId, action: 'BAN', reason: 'Repeated harassment.' },
      });

      expect(response.statusCode).toBe(200);

      const after = await ctx.prisma.user.findUnique({ where: { id: offender.id } });
      expect(after?.status).toBe('BANNED');

      // The ban has to bite immediately, not when their access token happens to expire.
      const denied = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/profile',
        headers: auth(offender.token),
      });
      expect(denied.statusCode).toBe(403);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { actorId: admin.id, targetId: offender.id },
      });
      expect(audit?.action).toBe('moderation.report.ban');
    });
  });

  /* ------------------------------------------------------------------ */
  /* Warnings leave a trail                                              */
  /* ------------------------------------------------------------------ */

  it('records a warning in both the moderation history and the audit log', async () => {
    const moderator = await createStaffUser(ctx.app, ctx.prisma, 'mod-h', 'MODERATOR');
    const offender = await createUser(ctx.app, 'offender-c');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/warn',
      headers: auth(moderator.token),
      payload: { userId: offender.id, reason: 'Please read the guidelines.' },
    });
    expect(response.statusCode).toBe(200);

    const action = await ctx.prisma.moderationAction.findFirst({
      where: { targetUserId: offender.id },
    });
    expect(action?.type).toBe('WARNING');

    // The route used to write the action directly and skip this entirely.
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { actorId: moderator.id, targetId: offender.id },
    });
    expect(audit?.action).toBe('moderation.user.warn');

    // A warning restricts nothing.
    const stillWorks = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/profile',
      headers: auth(offender.token),
    });
    expect(stillWorks.statusCode).toBe(200);
  });

  /* ------------------------------------------------------------------ */
  /* Reinstatement                                                       */
  /* ------------------------------------------------------------------ */

  describe('reinstating', () => {
    it('lifts a ban', async () => {
      const admin = await createStaffUser(ctx.app, ctx.prisma, 'admin-d', 'ADMIN');
      const offender = await createUser(ctx.app, 'offender-d');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/users/ban',
        headers: auth(admin.token),
        payload: { userId: offender.id, reason: 'Repeated harassment.' },
      });

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/users/unban',
        headers: auth(admin.token),
        payload: { userId: offender.id, reason: 'Appeal upheld.' },
      });
      expect(response.statusCode).toBe(200);

      const after = await ctx.prisma.user.findUnique({ where: { id: offender.id } });
      expect(after?.status).toBe('ACTIVE');

      const ban = await ctx.prisma.ban.findFirst({ where: { userId: offender.id } });
      expect(ban?.liftedAt).not.toBeNull();
    });

    /**
     * Reinstatement used to write `status: 'ACTIVE'` unconditionally, so pressing unban
     * on an unverified account silently completed its email verification — the same
     * class of bug as an un-scoped status write anywhere else in this codebase.
     */
    it('does not activate an account that was never restricted', async () => {
      const admin = await createStaffUser(ctx.app, ctx.prisma, 'admin-e', 'ADMIN');
      const pending = await createUser(ctx.app, 'pending-a');

      await ctx.prisma.user.update({
        where: { id: pending.id },
        data: { status: 'PENDING_VERIFICATION', emailVerified: false },
      });

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/users/unban',
        headers: auth(admin.token),
        payload: { userId: pending.id, reason: 'Wrong row.' },
      });
      expect(response.statusCode).toBe(409);

      const after = await ctx.prisma.user.findUnique({ where: { id: pending.id } });
      expect(after?.status).toBe('PENDING_VERIFICATION');
      expect(after?.emailVerified).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Reports cannot cite someone else's conversation                     */
  /* ------------------------------------------------------------------ */

  it('drops a match id the reporter was not part of', async () => {
    const reporter = await createUser(ctx.app, 'reporter-c');
    const offender = await createUser(ctx.app, 'offender-e');
    const strangerA = await createUser(ctx.app, 'stranger-a');
    const strangerB = await createUser(ctx.app, 'stranger-b');

    // A conversation between two people the reporter has never met.
    const foreign = await ctx.prisma.match.create({
      data: {
        participants: {
          create: [{ userId: strangerA.id }, { userId: strangerB.id }],
        },
      },
      select: { id: true },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: auth(reporter.token),
      payload: {
        reportedUserId: offender.id,
        matchId: foreign.id,
        category: 'HARASSMENT',
        alsoBlock: false,
      },
    });

    // The report is still filed — it is worth having. The false citation is not.
    expect(response.statusCode).toBe(201);

    const stored = await ctx.prisma.report.findFirst({
      where: { reporterId: reporter.id },
      select: { matchId: true },
    });
    expect(stored?.matchId).toBeNull();

    await ctx.prisma.matchParticipant.deleteMany({ where: { matchId: foreign.id } });
    await ctx.prisma.match.delete({ where: { id: foreign.id } });
  });
});
