import { TokensService } from '@trip2world/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  createUser,
  dependenciesAvailable,
  resetTestData,
  type TestContext,
} from './integration-setup.js';

/**
 * Blocking, reporting, and the token ledger — against real Postgres.
 *
 * The concurrency test at the bottom is the reason this file exists. The unit tests use a
 * fake that implements the conditional-update contract *as I understand it*; only real
 * Postgres can prove that understanding is correct under genuine parallel transactions.
 * If the double-spend guard is wrong, this is what catches it.
 */

const available = await dependenciesAvailable();
const describeIntegration = available ? describe : describe.skip;

describeIntegration('safety and tokens (integration)', () => {
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

  /* ------------------------------------------------------------------ */
  /* Blocking                                                            */
  /* ------------------------------------------------------------------ */

  describe('blocking', () => {
    it('creates, lists and removes a block', async () => {
      const alice = await createUser(ctx.app, 'blk-a');
      const bob = await createUser(ctx.app, 'blk-b');

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/blocks',
        headers: auth(alice.token),
        payload: { userId: bob.id },
      });
      expect(created.statusCode).toBe(201);

      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/blocks',
        headers: auth(alice.token),
      });
      expect(list.json().data.items).toHaveLength(1);
      expect(list.json().data.items[0].user.id).toBe(bob.id);

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: '/api/v1/blocks',
        headers: auth(alice.token),
        payload: { userId: bob.id },
      });
      expect(removed.statusCode).toBe(200);

      const after = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/blocks',
        headers: auth(alice.token),
      });
      expect(after.json().data.items).toHaveLength(0);
    });

    /**
     * The matchmaking-critical property. A block created in one direction must exclude
     * the pair in BOTH directions, or the person who blocked someone gets matched with
     * them again from the other side.
     */
    it('excludes the pair in both directions', async () => {
      const { getBlockedUserIds } = await import('@trip2world/database');

      const alice = await createUser(ctx.app, 'bidi-a');
      const bob = await createUser(ctx.app, 'bidi-b');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/blocks',
        headers: auth(alice.token),
        payload: { userId: bob.id },
      });

      expect(await getBlockedUserIds(alice.id, ctx.prisma)).toContain(bob.id);
      // Bob never blocked anyone, but must still be kept away from Alice.
      expect(await getBlockedUserIds(bob.id, ctx.prisma)).toContain(alice.id);
    });

    it('is idempotent — blocking twice is not an error', async () => {
      const alice = await createUser(ctx.app, 'idem-a');
      const bob = await createUser(ctx.app, 'idem-b');

      for (let i = 0; i < 2; i += 1) {
        const response = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/blocks',
          headers: auth(alice.token),
          payload: { userId: bob.id },
        });
        expect(response.statusCode).toBe(201);
      }

      expect(await ctx.prisma.block.count({ where: { blockerId: alice.id } })).toBe(1);
    });

    it('refuses self-blocking', async () => {
      const alice = await createUser(ctx.app, 'self-blk');
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/blocks',
        headers: auth(alice.token),
        payload: { userId: alice.id },
      });
      expect(response.statusCode).toBe(409);
    });

    it('never reveals who blocked you', async () => {
      const alice = await createUser(ctx.app, 'hidden-a');
      const bob = await createUser(ctx.app, 'hidden-b');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/blocks',
        headers: auth(alice.token),
        payload: { userId: bob.id },
      });

      // Bob was blocked, but his own list must stay empty — otherwise the endpoint tells
      // him exactly whose block to evade.
      const bobsList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/blocks',
        headers: auth(bob.token),
      });
      expect(bobsList.json().data.items).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Reporting                                                           */
  /* ------------------------------------------------------------------ */

  describe('reporting', () => {
    it('files a report and blocks by default', async () => {
      const alice = await createUser(ctx.app, 'rep-a');
      const bob = await createUser(ctx.app, 'rep-b');

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: auth(alice.token),
        payload: { reportedUserId: bob.id, category: 'HARASSMENT', alsoBlock: true },
      });

      expect(response.statusCode).toBe(201);
      expect(await ctx.prisma.report.count({ where: { reportedUserId: bob.id } })).toBe(1);
      expect(
        await ctx.prisma.block.count({ where: { blockerId: alice.id, blockedUserId: bob.id } }),
      ).toBe(1);
    });

    it('does not leak moderator-only fields to the reporter', async () => {
      const alice = await createUser(ctx.app, 'leak-a');
      const bob = await createUser(ctx.app, 'leak-b');

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: auth(alice.token),
        payload: { reportedUserId: bob.id, category: 'SPAM' },
      });

      const body = created.body;
      expect(body).not.toContain('moderatorNotes');
      expect(body).not.toContain('priorUpheldReports');
      expect(body).not.toContain('safetyScore');
    });

    it('refuses self-reporting', async () => {
      const alice = await createUser(ctx.app, 'self-rep');
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: auth(alice.token),
        payload: { reportedUserId: alice.id, category: 'SPAM' },
      });
      expect(response.statusCode).toBe(409);
    });

    /**
     * Reports survive the reporter deleting their account. Without this, anyone could
     * report someone and then delete to erase the evidence.
     */
    it('keeps the report when the reporter is erased', async () => {
      const alice = await createUser(ctx.app, 'gone-a');
      const bob = await createUser(ctx.app, 'gone-b');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: auth(alice.token),
        payload: { reportedUserId: bob.id, category: 'HATE' },
      });

      await ctx.prisma.user.delete({ where: { id: alice.id } });

      const report = await ctx.prisma.report.findFirst({ where: { reportedUserId: bob.id } });
      expect(report).not.toBeNull();
      // Detached, not deleted.
      expect(report?.reporterId).toBeNull();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Token ledger                                                        */
  /* ------------------------------------------------------------------ */

  describe('token ledger', () => {
    async function grant(userId: string, amount: number) {
      await ctx.prisma.tokenAccount.upsert({
        where: { userId },
        create: { userId, balance: amount },
        update: { balance: amount },
      });
    }

    it('moves tokens and writes a balanced pair of ledger rows', async () => {
      const alice = await createUser(ctx.app, 'tok-a');
      const bob = await createUser(ctx.app, 'tok-b');
      await grant(alice.id, 500);

      const tokens = new TokensService(ctx.prisma, ctx.app.log);
      await tokens.sendTip({
        fromUserId: alice.id,
        toUserId: bob.id,
        tokens: 200,
        matchId: null,
      });

      const [aliceAccount, bobAccount] = await Promise.all([
        ctx.prisma.tokenAccount.findUnique({ where: { userId: alice.id } }),
        ctx.prisma.tokenAccount.findUnique({ where: { userId: bob.id } }),
      ]);

      expect(aliceAccount?.balance).toBe(300);
      expect(bobAccount?.balance).toBe(200);

      const rows = await ctx.prisma.tokenLedger.findMany({
        where: { userId: { in: [alice.id, bob.id] } },
      });
      expect(rows).toHaveLength(2);
      // A transfer must conserve tokens exactly.
      expect(rows.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
    });

    it('refuses a tip larger than the balance and writes nothing', async () => {
      const alice = await createUser(ctx.app, 'tok-poor');
      const bob = await createUser(ctx.app, 'tok-rich');
      await grant(alice.id, 10);

      const tokens = new TokensService(ctx.prisma, ctx.app.log);
      await expect(
        tokens.sendTip({ fromUserId: alice.id, toUserId: bob.id, tokens: 5000, matchId: null }),
      ).rejects.toThrow();

      const account = await ctx.prisma.tokenAccount.findUnique({ where: { userId: alice.id } });
      expect(account?.balance).toBe(10);
      expect(await ctx.prisma.tokenLedger.count({ where: { userId: alice.id } })).toBe(0);
    });

    /**
     * THE test. Ten simultaneous tips of 100 against a balance of 500.
     *
     * A read-then-write implementation lets most of them through and drives the balance
     * negative. The conditional `UPDATE ... WHERE balance >= n` makes Postgres serialise
     * the row, so exactly five succeed and the balance lands on zero — never below.
     */
    it('cannot be overdrawn by concurrent tips', async () => {
      const alice = await createUser(ctx.app, 'race-a');
      const bob = await createUser(ctx.app, 'race-b');
      await grant(alice.id, 500);

      const tokens = new TokensService(ctx.prisma, ctx.app.log);

      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          tokens.sendTip({ fromUserId: alice.id, toUserId: bob.id, tokens: 100, matchId: null }),
        ),
      );

      const succeeded = attempts.filter((a) => a.status === 'fulfilled').length;

      expect(succeeded).toBe(5);

      const [aliceAccount, bobAccount] = await Promise.all([
        ctx.prisma.tokenAccount.findUnique({ where: { userId: alice.id } }),
        ctx.prisma.tokenAccount.findUnique({ where: { userId: bob.id } }),
      ]);

      expect(aliceAccount?.balance).toBe(0);
      expect(aliceAccount?.balance).toBeGreaterThanOrEqual(0);
      expect(bobAccount?.balance).toBe(500);

      // Ledger and cached balances must agree.
      const rows = await ctx.prisma.tokenLedger.findMany({ where: { userId: alice.id } });
      expect(rows.reduce((sum, row) => sum + row.delta, 0)).toBe(-500);
    });

    it('credits a purchase exactly once even if the webhook is replayed', async () => {
      const alice = await createUser(ctx.app, 'buy-a');
      const tokens = new TokensService(ctx.prisma, ctx.app.log);

      const pkg = await ctx.prisma.tokenPackage.upsert({
        where: { slug: 'integration-pack' },
        create: {
          slug: 'integration-pack',
          tokens: 750,
          priceCents: 500,
          currency: 'EUR',
          sortOrder: 999,
          active: true,
        },
        update: {},
      });

      await tokens.createPurchase(alice.id, pkg.id, 'cs_test_integration_1');

      const first = await tokens.fulfilPurchase('cs_test_integration_1', 'evt_1');
      const replay = await tokens.fulfilPurchase('cs_test_integration_1', 'evt_1');
      const differentEvent = await tokens.fulfilPurchase('cs_test_integration_1', 'evt_2');

      expect(first).toBe(true);
      // Stripe retries; neither repeat may credit again.
      expect(replay).toBe(false);
      expect(differentEvent).toBe(false);

      const account = await ctx.prisma.tokenAccount.findUnique({ where: { userId: alice.id } });
      expect(account?.balance).toBe(750);

      await ctx.prisma.tokenPurchase.deleteMany({ where: { userId: alice.id } });
      await ctx.prisma.tokenPackage.delete({ where: { id: pkg.id } });
    });
  });
});
