import { Prisma, type PrismaClient } from '@prisma/client';
import { Errors } from '../errors.js';

/**
 * Token ledger.
 *
 * Two correctness rules govern everything here, and both exist because this is real
 * money:
 *
 * **1. Debits are a single conditional statement.** Reading a balance and then writing
 * `balance - n` is a lost-update bug: two concurrent tips both read 100, both write 50,
 * and 100 tokens buy 100 tokens' worth of tips twice. Instead every debit is
 * `UPDATE ... SET balance = balance - n WHERE userId = ? AND balance >= n`, and an
 * affected-row count of zero *is* the insufficient-funds signal. Postgres serialises the
 * row lock for us, so no amount of concurrency can overdraw.
 *
 * **2. The ledger is the truth.** `TokenAccount.balance` is a cache written in the same
 * transaction as its ledger row. Any disagreement is resolved by replaying the ledger,
 * which is why nothing here ever updates or deletes a ledger row.
 */

export interface TokensDeps {
  prisma: PrismaClient;
  logger: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

export interface Balance {
  balance: number;
  lifetimeEarned: number;
  lifetimePurchased: number;
}

export class TokensService {
  constructor(private readonly deps: TokensDeps) {}

  /** Fetch a balance, creating the account row on first access. */
  async getBalance(userId: string): Promise<Balance> {
    const account = await this.deps.prisma.tokenAccount.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { balance: true, lifetimeEarned: true, lifetimePurchased: true },
    });
    return account;
  }

  /**
   * Atomically remove tokens.
   *
   * Returns the new balance, or throws when funds are insufficient. The conditional
   * update is the entire safety mechanism — see the class comment.
   */
  private async debit(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
  ): Promise<number> {
    // `updateMany` because Prisma's `update` requires a unique where-clause and cannot
    // express the `balance >= amount` guard. The guard is the point.
    const result = await tx.tokenAccount.updateMany({
      where: { userId, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });

    if (result.count === 0) {
      // Either the account does not exist or the balance is too low. Both are the same
      // thing to the caller, and neither should disclose the actual balance.
      throw Errors.conflict('You do not have enough tokens.');
    }

    const account = await tx.tokenAccount.findUniqueOrThrow({
      where: { userId },
      select: { balance: true },
    });
    return account.balance;
  }

  /** Atomically add tokens, creating the account if needed. */
  private async credit(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
    counters: { earned?: number; purchased?: number } = {},
  ): Promise<number> {
    const account = await tx.tokenAccount.upsert({
      where: { userId },
      create: {
        userId,
        balance: amount,
        lifetimeEarned: counters.earned ?? 0,
        lifetimePurchased: counters.purchased ?? 0,
      },
      update: {
        balance: { increment: amount },
        ...(counters.earned ? { lifetimeEarned: { increment: counters.earned } } : {}),
        ...(counters.purchased ? { lifetimePurchased: { increment: counters.purchased } } : {}),
      },
      select: { balance: true },
    });
    return account.balance;
  }

  /* ------------------------------------------------------------------ */
  /* Tipping                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Transfer tokens from one user to another.
   *
   * Debit, credit, both ledger rows and the Tip record all happen in one transaction.
   * A partial apply here would either destroy tokens or create them from nothing.
   */
  async sendTip(input: {
    fromUserId: string;
    toUserId: string;
    tokens: number;
    matchId: string | null;
    message?: string;
    offeredSeconds?: number;
  }): Promise<{ tipId: string; senderBalance: number }> {
    const { prisma, logger } = this.deps;

    if (input.fromUserId === input.toUserId) {
      throw Errors.conflict('You cannot tip yourself.');
    }
    if (!Number.isInteger(input.tokens) || input.tokens <= 0) {
      throw Errors.validation({ tokens: ['Tip must be a positive whole number of tokens.'] });
    }

    const result = await prisma.$transaction(async (tx) => {
      const senderBalance = await this.debit(tx, input.fromUserId, input.tokens);

      const tip = await tx.tip.create({
        data: {
          matchId: input.matchId,
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          tokens: input.tokens,
          message: input.message ?? null,
          offeredSeconds: input.offeredSeconds ?? null,
        },
        select: { id: true },
      });

      // Received tokens count toward lifetimeEarned, which is what a future payout
      // system would settle against.
      const recipientBalance = await this.credit(tx, input.toUserId, input.tokens, {
        earned: input.tokens,
      });

      await tx.tokenLedger.createMany({
        data: [
          {
            userId: input.fromUserId,
            delta: -input.tokens,
            kind: 'TIP_SENT',
            balanceAfter: senderBalance,
            counterpartyId: input.toUserId,
            matchId: input.matchId,
            tipId: tip.id,
          },
          {
            userId: input.toUserId,
            delta: input.tokens,
            kind: 'TIP_RECEIVED',
            balanceAfter: recipientBalance,
            counterpartyId: input.fromUserId,
            matchId: input.matchId,
            tipId: tip.id,
          },
        ],
      });

      return { tipId: tip.id, senderBalance };
    });

    logger.info(
      { tipId: result.tipId, tokens: input.tokens, matchId: input.matchId },
      'Tip sent',
    );
    return result;
  }

  /**
   * Record the recipient's answer to a time offer.
   *
   * The tokens have already moved and are not returned on a decline. That is deliberate
   * and is stated in the UI: a tip is a gift, and making it refundable would turn every
   * decline into a dispute. What the recipient controls is whether the call continues —
   * never whether they are paid.
   */
  async respondToOffer(tipId: string, userId: string, accepted: boolean): Promise<void> {
    const tip = await this.deps.prisma.tip.findUnique({
      where: { id: tipId },
      select: { id: true, toUserId: true, accepted: true, offeredSeconds: true },
    });

    if (!tip) throw Errors.notFound('That tip');
    // Only the recipient may answer, and only once.
    if (tip.toUserId !== userId) throw Errors.forbidden();
    if (tip.accepted !== null) throw Errors.conflict('That offer has already been answered.');
    if (tip.offeredSeconds === null) throw Errors.conflict('That tip carried no time offer.');

    await this.deps.prisma.tip.update({
      where: { id: tipId },
      data: { accepted, respondedAt: new Date() },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Purchases                                                           */
  /* ------------------------------------------------------------------ */

  async listPackages() {
    return this.deps.prisma.tokenPackage.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        slug: true,
        tokens: true,
        priceCents: true,
        currency: true,
        label: true,
      },
    });
  }

  async createPurchase(userId: string, packageId: string, providerRef: string) {
    const pkg = await this.deps.prisma.tokenPackage.findFirst({
      where: { id: packageId, active: true },
    });
    if (!pkg) throw Errors.notFound('That package');

    return this.deps.prisma.tokenPurchase.create({
      data: {
        userId,
        packageId: pkg.id,
        providerRef,
        tokens: pkg.tokens,
        amountCents: pkg.priceCents,
        currency: pkg.currency,
        status: 'PENDING',
      },
      select: { id: true },
    });
  }

  /**
   * Credit a completed purchase.
   *
   * Idempotent on `providerEventId`. Stripe retries webhook delivery on any non-2xx and
   * on timeouts, so this WILL be called more than once for the same payment — crediting
   * twice is money lost. The unique constraint plus the status guard make a repeat
   * delivery a no-op rather than a second grant.
   */
  async fulfilPurchase(providerRef: string, providerEventId: string): Promise<boolean> {
    const { prisma, logger } = this.deps;

    try {
      return await prisma.$transaction(async (tx) => {
        const purchase = await tx.tokenPurchase.findUnique({
          where: { providerRef },
          select: { id: true, userId: true, tokens: true, status: true },
        });

        if (!purchase) {
          logger.warn({ providerRef }, 'Webhook for an unknown purchase');
          return false;
        }
        if (purchase.status === 'COMPLETED') {
          // Already fulfilled — a retry, not a second payment.
          return false;
        }

        // Claim the event id. If a concurrent delivery already claimed it, the unique
        // constraint aborts this transaction and nothing is credited twice.
        await tx.tokenPurchase.update({
          where: { id: purchase.id },
          data: { status: 'COMPLETED', providerEventId },
        });

        const balance = await this.credit(tx, purchase.userId, purchase.tokens, {
          purchased: purchase.tokens,
        });

        await tx.tokenLedger.create({
          data: {
            userId: purchase.userId,
            delta: purchase.tokens,
            kind: 'PURCHASE',
            balanceAfter: balance,
            purchaseId: purchase.id,
          },
        });

        logger.info(
          { purchaseId: purchase.id, tokens: purchase.tokens },
          'Token purchase fulfilled',
        );
        return true;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Duplicate providerEventId: another delivery of the same event won the race.
        logger.info({ providerEventId }, 'Duplicate webhook ignored');
        return false;
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* History and administration                                          */
  /* ------------------------------------------------------------------ */

  async history(userId: string, page: number, pageSize: number) {
    const [total, items] = await Promise.all([
      this.deps.prisma.tokenLedger.count({ where: { userId } }),
      this.deps.prisma.tokenLedger.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          delta: true,
          kind: true,
          balanceAfter: true,
          note: true,
          createdAt: true,
        },
      }),
    ]);

    return { items, page, pageSize, total, hasMore: page * pageSize < total };
  }

  /**
   * Manual balance correction by an administrator.
   *
   * Recorded as an ADJUSTMENT with a mandatory note, and audit-logged by the caller.
   * Support cases genuinely need this — a failed payment that took the money, a
   * goodwill credit — but an unexplained balance change is indistinguishable from theft.
   */
  async adjust(userId: string, delta: number, note: string): Promise<number> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw Errors.validation({ delta: ['Adjustment must be a non-zero whole number.'] });
    }
    if (!note.trim()) {
      throw Errors.validation({ note: ['An adjustment requires a reason.'] });
    }

    return this.deps.prisma.$transaction(async (tx) => {
      const balance =
        delta > 0
          ? await this.credit(tx, userId, delta)
          : await this.debit(tx, userId, Math.abs(delta));

      await tx.tokenLedger.create({
        data: { userId, delta, kind: 'ADJUSTMENT', balanceAfter: balance, note: note.slice(0, 200) },
      });

      return balance;
    });
  }
}
