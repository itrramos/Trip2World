import { CampaignsService } from '@trip2world/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  dependenciesAvailable,
  resetTestData,
  type TestContext,
} from './integration-setup.js';

/**
 * Promotional grants, against real Postgres.
 *
 * Two of these tests are the reason the file exists, and neither can be written against
 * a mock: a fake will happily agree that a conditional UPDATE is atomic and that a
 * unique index rejects a duplicate. Only the database can prove it.
 *
 *   - Fifty concurrent claims against a cap of five must grant exactly five.
 *   - Ten concurrent claims by the SAME user must grant exactly one.
 *
 * Both are the same class of bug as double-spending tokens, and both are invisible until
 * a promotion is announced and several hundred people click at once.
 */

const available = await dependenciesAvailable();
const describeIntegration = available ? describe : describe.skip;

describeIntegration('token campaigns (integration)', () => {
  let ctx: TestContext;
  let campaigns: CampaignsService;

  const silent = { info: () => {}, warn: () => {}, error: () => {} };

  beforeAll(async () => {
    ctx = await createTestContext();
    campaigns = new CampaignsService(ctx.prisma, silent);
  });

  afterAll(async () => {
    await cleanup();
    await ctx.close();
  });

  beforeEach(async () => {
    await cleanup();
    await resetTestData(ctx.prisma, ctx.redis);
  });

  /** Campaigns are not tied to a test user, so resetTestData does not reach them. */
  async function cleanup() {
    await ctx.prisma.tokenGrant.deleteMany({
      where: { campaign: { name: { startsWith: 'itest-' } } },
    });
    await ctx.prisma.tokenCampaign.deleteMany({ where: { name: { startsWith: 'itest-' } } });
  }

  async function makeCampaign(overrides: Record<string, unknown> = {}) {
    return ctx.prisma.tokenCampaign.create({
      data: {
        name: 'itest-launch',
        tokens: 50,
        audience: 'NEW_USERS',
        status: 'ACTIVE',
        requiresVerifiedEmail: false,
        ...overrides,
      },
      select: { id: true },
    });
  }

  /* ------------------------------------------------------------------ */

  it('grants tokens once and records a ledger row', async () => {
    const campaign = await makeCampaign();
    const user = await createUser(ctx.app, 'promo-a');

    const result = await campaigns.claim(campaign.id, user.id);
    expect(result).toMatchObject({ tokens: 50, campaignName: 'itest-launch' });

    const account = await ctx.prisma.tokenAccount.findUnique({ where: { userId: user.id } });
    expect(account?.balance).toBe(50);
    // A promotion is earned, not purchased — it must not inflate the purchased total,
    // which is what a support enquiry about a refund would look at.
    expect(account?.lifetimeEarned).toBe(50);
    expect(account?.lifetimePurchased).toBe(0);

    const ledger = await ctx.prisma.tokenLedger.findFirst({
      where: { userId: user.id, kind: 'PROMO' },
    });
    expect(ledger?.delta).toBe(50);
    expect(ledger?.balanceAfter).toBe(50);
    expect(ledger?.campaignId).toBe(campaign.id);
  });

  it('refuses a second claim by the same user', async () => {
    const campaign = await makeCampaign();
    const user = await createUser(ctx.app, 'promo-b');

    expect(await campaigns.claim(campaign.id, user.id)).not.toBeNull();
    expect(await campaigns.claim(campaign.id, user.id)).toBeNull();

    const account = await ctx.prisma.tokenAccount.findUnique({ where: { userId: user.id } });
    expect(account?.balance).toBe(50);

    // The counter must not have advanced for the refused attempt.
    const after = await ctx.prisma.tokenCampaign.findUnique({ where: { id: campaign.id } });
    expect(after?.grantsIssued).toBe(1);
  });

  /**
   * The test that matters most.
   *
   * The early "already claimed?" read is not atomic with the insert, so ten parallel
   * requests can all see "no grant yet". Only the unique index stops all ten from
   * paying out — and if the loser's reserved slot is not released, the counter drifts
   * upward and the cap starts refusing legitimate users.
   */
  it('grants exactly once under concurrent claims by one user', async () => {
    const campaign = await makeCampaign();
    const user = await createUser(ctx.app, 'promo-c');

    const results = await Promise.all(
      Array.from({ length: 10 }, () => campaigns.claim(campaign.id, user.id)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    const account = await ctx.prisma.tokenAccount.findUnique({ where: { userId: user.id } });
    expect(account?.balance).toBe(50);

    const grants = await ctx.prisma.tokenGrant.count({ where: { campaignId: campaign.id } });
    expect(grants).toBe(1);

    const after = await ctx.prisma.tokenCampaign.findUnique({ where: { id: campaign.id } });
    expect(after?.grantsIssued).toBe(1);

    const ledgerRows = await ctx.prisma.tokenLedger.count({
      where: { userId: user.id, kind: 'PROMO' },
    });
    expect(ledgerRows).toBe(1);
  });

  /**
   * "First N accounts", under the traffic a launch announcement actually produces.
   *
   * Read-then-compare would let all eight through: every request reads grantsIssued = 0
   * before any of them writes.
   */
  it('never exceeds maxGrants under concurrency', async () => {
    const campaign = await makeCampaign({ name: 'itest-first-three', maxGrants: 3 });

    const users = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createUser(ctx.app, `promo-race-${index}`)),
    );

    const results = await Promise.all(users.map((user) => campaigns.claim(campaign.id, user.id)));

    expect(results.filter(Boolean)).toHaveLength(3);

    const granted = await ctx.prisma.tokenGrant.count({ where: { campaignId: campaign.id } });
    expect(granted).toBe(3);

    const after = await ctx.prisma.tokenCampaign.findUnique({ where: { id: campaign.id } });
    expect(after?.grantsIssued).toBe(3);
  });

  /* ------------------------------------------------------------------ */
  /* Eligibility                                                         */
  /* ------------------------------------------------------------------ */

  describe('eligibility', () => {
    it('skips a campaign that is not ACTIVE', async () => {
      await makeCampaign({ status: 'PAUSED' });
      const user = await createUser(ctx.app, 'promo-paused');

      expect(await campaigns.applyEligible(user.id)).toHaveLength(0);

      const account = await ctx.prisma.tokenAccount.findUnique({ where: { userId: user.id } });
      expect(account?.balance ?? 0).toBe(0);
    });

    it('skips a campaign whose window has not opened', async () => {
      await makeCampaign({ startsAt: new Date(Date.now() + 86_400_000) });
      const user = await createUser(ctx.app, 'promo-future');

      expect(await campaigns.applyEligible(user.id)).toHaveLength(0);
    });

    it('skips a campaign whose window has closed', async () => {
      await makeCampaign({
        startsAt: new Date(Date.now() - 172_800_000),
        endsAt: new Date(Date.now() - 86_400_000),
      });
      const user = await createUser(ctx.app, 'promo-past');

      expect(await campaigns.applyEligible(user.id)).toHaveLength(0);
    });

    it('withholds from an unverified account, then grants once it is verified', async () => {
      await makeCampaign({ requiresVerifiedEmail: true });
      const user = await createUser(ctx.app, 'promo-unverified');

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: false },
      });

      expect(await campaigns.applyEligible(user.id)).toHaveLength(0);

      // The incentive: confirming the address is what releases the tokens.
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });

      const granted = await campaigns.applyEligible(user.id);
      expect(granted).toHaveLength(1);
      expect(granted[0]?.tokens).toBe(50);
    });

    /**
     * Switching on a launch promotion must not retroactively pay every account that has
     * ever registered. NEW_USERS means "created while this was running".
     */
    it('does not pay a NEW_USERS campaign to accounts that predate it', async () => {
      const user = await createUser(ctx.app, 'promo-existing');

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { createdAt: new Date(Date.now() - 30 * 86_400_000) },
      });

      await makeCampaign({ audience: 'NEW_USERS', startsAt: new Date(Date.now() - 3_600_000) });

      expect(await campaigns.applyEligible(user.id)).toHaveLength(0);
    });

    it('pays an ALL_USERS campaign to an account that predates it', async () => {
      const user = await createUser(ctx.app, 'promo-returning');

      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { createdAt: new Date(Date.now() - 30 * 86_400_000) },
      });

      await makeCampaign({ audience: 'ALL_USERS', startsAt: new Date(Date.now() - 3_600_000) });

      expect(await campaigns.applyEligible(user.id)).toHaveLength(1);
    });

    it('applies several live campaigns in one pass', async () => {
      await makeCampaign({ name: 'itest-launch', tokens: 50, audience: 'ALL_USERS' });
      await makeCampaign({ name: 'itest-birthday', tokens: 25, audience: 'ALL_USERS' });

      const user = await createUser(ctx.app, 'promo-both');
      const granted = await campaigns.applyEligible(user.id);

      expect(granted).toHaveLength(2);

      const account = await ctx.prisma.tokenAccount.findUnique({ where: { userId: user.id } });
      expect(account?.balance).toBe(75);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Administration guards                                               */
  /* ------------------------------------------------------------------ */

  describe('administration', () => {
    it('creates campaigns stopped, never running', async () => {
      const admin = await createUser(ctx.app, 'promo-admin');
      const created = await campaigns.create(
        { name: 'itest-new', tokens: 10, audience: 'NEW_USERS' },
        admin.id,
      );

      // Saving a campaign and spending money are two separate decisions.
      expect(created.status).toBe('DRAFT');
    });

    it('refuses to change the amount once anyone has received it', async () => {
      const campaign = await makeCampaign();
      const user = await createUser(ctx.app, 'promo-locked');
      await campaigns.claim(campaign.id, user.id);

      await expect(campaigns.update(campaign.id, { tokens: 999 })).rejects.toThrow();

      // Everything else is still editable.
      const renamed = await campaigns.update(campaign.id, { name: 'itest-renamed' });
      expect(renamed?.name).toBe('itest-renamed');
    });

    it('refuses to restart an ended campaign', async () => {
      const campaign = await makeCampaign();
      await campaigns.setStatus(campaign.id, 'ENDED');

      await expect(campaigns.setStatus(campaign.id, 'ACTIVE')).rejects.toThrow();
    });
  });
});
