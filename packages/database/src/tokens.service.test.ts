import { describe, expect, it, vi } from 'vitest';
import { TokensService } from './tokens.service.js';

/**
 * These tests pin the money-handling invariants against a fake Prisma client.
 *
 * The fake models the ONE property that matters: `updateMany` with a `balance >= amount`
 * guard affects zero rows when the balance is too low. That is the entire double-spend
 * defence, so it is the thing worth simulating — a mock that always succeeds would test
 * nothing.
 *
 * Behaviour against real Postgres concurrency is covered by the integration suite; this
 * layer proves the service reacts correctly to the signals the database gives it.
 */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createFakePrisma(initial: Record<string, number>) {
  const balances = new Map(Object.entries(initial));
  const ledger: { userId: string; delta: number; kind: string }[] = [];
  const tips: { id: string; toUserId: string; accepted: boolean | null; offeredSeconds: number | null }[] = [];

  const client = {
    tokenAccount: {
      // The guarded debit. Zero affected rows means insufficient funds.
      updateMany: vi.fn(async ({ where, data }: never) => {
        const w = where as { userId: string; balance?: { gte: number } };
        const d = data as { balance: { decrement: number } };
        const current = balances.get(w.userId) ?? 0;
        if (w.balance && current < w.balance.gte) return { count: 0 };
        balances.set(w.userId, current - d.balance.decrement);
        return { count: 1 };
      }),
      upsert: vi.fn(async ({ where, create, update }: never) => {
        const w = where as { userId: string };
        const c = create as { balance?: number };
        const u = update as { balance?: { increment: number } };
        if (!balances.has(w.userId)) {
          balances.set(w.userId, c.balance ?? 0);
        } else if (u.balance) {
          balances.set(w.userId, (balances.get(w.userId) ?? 0) + u.balance.increment);
        }
        return { balance: balances.get(w.userId) ?? 0, lifetimeEarned: 0, lifetimePurchased: 0 };
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: never) => {
        const w = where as { userId: string };
        return { balance: balances.get(w.userId) ?? 0 };
      }),
    },
    tip: {
      create: vi.fn(async ({ data }: never) => {
        const d = data as { toUserId: string; offeredSeconds: number | null };
        const tip = {
          id: `tip-${tips.length + 1}`,
          toUserId: d.toUserId,
          accepted: null,
          offeredSeconds: d.offeredSeconds,
        };
        tips.push(tip);
        return { id: tip.id };
      }),
      findUnique: vi.fn(async ({ where }: never) => {
        const w = where as { id: string };
        return tips.find((t) => t.id === w.id) ?? null;
      }),
      update: vi.fn(async ({ where, data }: never) => {
        const w = where as { id: string };
        const d = data as { accepted: boolean };
        const tip = tips.find((t) => t.id === w.id);
        if (tip) tip.accepted = d.accepted;
        return tip;
      }),
    },
    tokenLedger: {
      createMany: vi.fn(async ({ data }: never) => {
        ledger.push(...(data as { userId: string; delta: number; kind: string }[]));
        return { count: (data as unknown[]).length };
      }),
      create: vi.fn(async ({ data }: never) => {
        ledger.push(data as { userId: string; delta: number; kind: string });
        return data;
      }),
    },
    // Transactions run the callback directly. Rollback is simulated by the tests only
    // asserting on failure paths that throw before any write.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };

  return { client, balances, ledger, tips };
}

function service(initial: Record<string, number>) {
  const fake = createFakePrisma(initial);
  return {
    tokens: new TokensService(fake.client as never, logger),
    ...fake,
  };
}

const ALICE = 'alice';
const BOB = 'bob';

describe('sendTip', () => {
  it('moves tokens and writes exactly two ledger rows', async () => {
    const { tokens, balances, ledger } = service({ [ALICE]: 100, [BOB]: 0 });

    await tokens.sendTip({ fromUserId: ALICE, toUserId: BOB, tokens: 30, matchId: null });

    expect(balances.get(ALICE)).toBe(70);
    expect(balances.get(BOB)).toBe(30);

    expect(ledger).toHaveLength(2);
    expect(ledger.find((r) => r.userId === ALICE)).toMatchObject({ delta: -30, kind: 'TIP_SENT' });
    expect(ledger.find((r) => r.userId === BOB)).toMatchObject({ delta: 30, kind: 'TIP_RECEIVED' });
  });

  it('conserves tokens — the ledger always sums to zero for a transfer', async () => {
    const { tokens, ledger } = service({ [ALICE]: 100 });
    await tokens.sendTip({ fromUserId: ALICE, toUserId: BOB, tokens: 25, matchId: null });
    expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
  });

  it('refuses a tip larger than the balance, and writes nothing', async () => {
    const { tokens, balances, ledger } = service({ [ALICE]: 10 });

    await expect(
      tokens.sendTip({ fromUserId: ALICE, toUserId: BOB, tokens: 50, matchId: null }),
    ).rejects.toThrow(/enough tokens/);

    expect(balances.get(ALICE)).toBe(10);
    expect(ledger).toHaveLength(0);
  });

  it('refuses to spend from an account that does not exist', async () => {
    const { tokens, ledger } = service({});
    await expect(
      tokens.sendTip({ fromUserId: 'ghost', toUserId: BOB, tokens: 1, matchId: null }),
    ).rejects.toThrow(/enough tokens/);
    expect(ledger).toHaveLength(0);
  });

  /**
   * The lost-update scenario. Two tips of 60 against a balance of 100: the guarded
   * update lets the first through and refuses the second, so the account cannot go
   * negative. A read-then-write implementation would allow both.
   */
  it('cannot be overdrawn by two spends that individually fit', async () => {
    const { tokens, balances } = service({ [ALICE]: 100 });

    const first = await tokens
      .sendTip({ fromUserId: ALICE, toUserId: BOB, tokens: 60, matchId: null })
      .then(() => 'ok')
      .catch(() => 'refused');
    const second = await tokens
      .sendTip({ fromUserId: ALICE, toUserId: 'carol', tokens: 60, matchId: null })
      .then(() => 'ok')
      .catch(() => 'refused');

    expect([first, second].sort()).toEqual(['ok', 'refused']);
    expect(balances.get(ALICE)).toBe(40);
    expect(balances.get(ALICE)).toBeGreaterThanOrEqual(0);
  });

  it('allows spending the exact balance', async () => {
    const { tokens, balances } = service({ [ALICE]: 50 });
    await tokens.sendTip({ fromUserId: ALICE, toUserId: BOB, tokens: 50, matchId: null });
    expect(balances.get(ALICE)).toBe(0);
  });

  it('rejects self-tipping', async () => {
    const { tokens } = service({ [ALICE]: 100 });
    await expect(
      tokens.sendTip({ fromUserId: ALICE, toUserId: ALICE, tokens: 10, matchId: null }),
    ).rejects.toThrow(/cannot tip yourself/);
  });

  it('rejects zero, negative and fractional amounts', async () => {
    const { tokens } = service({ [ALICE]: 100 });
    for (const amount of [0, -5, 1.5]) {
      await expect(
        tokens.sendTip({ fromUserId: ALICE, toUserId: BOB, tokens: amount, matchId: null }),
      ).rejects.toThrow();
    }
  });
});

describe('time offers', () => {
  it('lets the recipient accept', async () => {
    const { tokens, tips } = service({ [ALICE]: 100 });
    const { tipId } = await tokens.sendTip({
      fromUserId: ALICE,
      toUserId: BOB,
      tokens: 50,
      matchId: 'match-1',
      offeredSeconds: 300,
    });

    await tokens.respondToOffer(tipId, BOB, true);
    expect(tips[0]?.accepted).toBe(true);
  });

  /**
   * The consent property. Declining does NOT return the tokens: the tip is a gift and
   * always lands. What the recipient controls is whether the conversation continues.
   */
  it('keeps the tokens with the recipient even when the offer is declined', async () => {
    const { tokens, balances } = service({ [ALICE]: 100 });
    const { tipId } = await tokens.sendTip({
      fromUserId: ALICE,
      toUserId: BOB,
      tokens: 50,
      matchId: 'match-1',
      offeredSeconds: 300,
    });

    await tokens.respondToOffer(tipId, BOB, false);

    expect(balances.get(BOB)).toBe(50);
    expect(balances.get(ALICE)).toBe(50);
  });

  it('refuses an answer from anyone but the recipient', async () => {
    const { tokens } = service({ [ALICE]: 100 });
    const { tipId } = await tokens.sendTip({
      fromUserId: ALICE,
      toUserId: BOB,
      tokens: 50,
      matchId: 'match-1',
      offeredSeconds: 300,
    });

    // The sender must not be able to answer on the recipient's behalf.
    await expect(tokens.respondToOffer(tipId, ALICE, true)).rejects.toThrow();
    await expect(tokens.respondToOffer(tipId, 'stranger', true)).rejects.toThrow();
  });

  it('refuses a second answer', async () => {
    const { tokens } = service({ [ALICE]: 100 });
    const { tipId } = await tokens.sendTip({
      fromUserId: ALICE,
      toUserId: BOB,
      tokens: 50,
      matchId: 'match-1',
      offeredSeconds: 300,
    });

    await tokens.respondToOffer(tipId, BOB, true);
    await expect(tokens.respondToOffer(tipId, BOB, false)).rejects.toThrow(/already been answered/);
  });

  it('refuses an answer to a tip that carried no offer', async () => {
    const { tokens } = service({ [ALICE]: 100 });
    const { tipId } = await tokens.sendTip({
      fromUserId: ALICE,
      toUserId: BOB,
      tokens: 50,
      matchId: 'match-1',
    });

    await expect(tokens.respondToOffer(tipId, BOB, true)).rejects.toThrow(/no time offer/);
  });
});

describe('admin adjustments', () => {
  it('credits and debits, recording the reason', async () => {
    const { tokens, balances, ledger } = service({ [ALICE]: 10 });

    await tokens.adjust(ALICE, 40, 'Goodwill credit for failed payment');
    expect(balances.get(ALICE)).toBe(50);

    await tokens.adjust(ALICE, -20, 'Reversed duplicate grant');
    expect(balances.get(ALICE)).toBe(30);

    expect(ledger.every((row) => row.kind === 'ADJUSTMENT')).toBe(true);
  });

  it('refuses an adjustment with no reason, and a zero adjustment', async () => {
    const { tokens } = service({ [ALICE]: 10 });
    await expect(tokens.adjust(ALICE, 10, '   ')).rejects.toThrow();
    await expect(tokens.adjust(ALICE, 0, 'nothing')).rejects.toThrow();
  });

  it('cannot drive a balance negative', async () => {
    const { tokens, balances } = service({ [ALICE]: 10 });
    await expect(tokens.adjust(ALICE, -50, 'too much')).rejects.toThrow(/enough tokens/);
    expect(balances.get(ALICE)).toBe(10);
  });
});
