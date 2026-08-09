import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Token ledger.
 *
 * Lives in the database package because both the API (purchases, history) and the
 * realtime server (tipping during a call) need it. Duplicating money-handling logic
 * across two services would mean two places for a rounding or concurrency bug to hide.
 *
 * Two correctness rules govern everything here, and both exist because this is real
 * money:
 *
 * **1. Debits are a single conditional statement.** Reading a balance and then writing
 * `balance - n` is a lost-update bug: two concurrent tips both read 100, both write 50,
 * and 100 tokens buy 200 tokens' worth of tips. Instead every debit is
 * `UPDATE ... SET balance = balance - n WHERE userId = ? AND balance >= n`, and an
 * affected-row count of zero *is* the insufficient-funds signal. Postgres serialises the
 * row lock, so no amount of concurrency can overdraw.
 *
 * **2. The ledger is the truth.** `TokenAccount.balance` is a cache written in the same
 * transaction as its ledger row. Any disagreement is settled by replaying the ledger,
 * which is why nothing here ever updates or deletes a ledger row.
 */

export const TokenErrorCode = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  SELF_TIP: 'SELF_TIP',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  ALREADY_ANSWERED: 'ALREADY_ANSWERED',
  NO_OFFER: 'NO_OFFER',
} as const;
export type TokenErrorCode = (typeof TokenErrorCode)[keyof typeof TokenErrorCode];

/** Transport-agnostic so the API can map it to HTTP and realtime to a socket frame. */
export class TokenError extends Error {
  constructor(
    public readonly code: TokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export interface TokensLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface Balance {
  balance: number;
  lifetimeEarned: number;
  lifetimePurchased: number;
}

export class TokensService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: TokensLogger,
  ) {}

  /** Fetch a balance, creating the account row on first access. */
  async getBalance(userId: string): Promise<Balance> {
    return this.prisma.tokenAccount.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { balance: true, lifetimeEarned: true, lifetimePurchased: true },
    });
  }

  /** Atomically remove tokens. The conditional update is the whole safety mechanism. */
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
      // Missing account and insufficient balance are the same thing to the caller, and
      // neither should disclose the actual balance.
      throw new TokenError(TokenErrorCode.INSUFFICIENT_FUNDS, 'You do not have enough tokens.');
    }

    const account = await tx.tokenAccount.findUniqueOrThrow({
      where: { userId },
      select: { balance: true },
    });
    return account.balance;
  }

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
   * Transfer tokens between two users.
   *
   * Debit, credit, both ledger rows and the Tip record happen in one transaction. A
   * partial apply would either destroy tokens or create them from nothing.
   */
  async sendTip(input: {
    fromUserId: string;
    toUserId: string;
    tokens: number;
    matchId: string | null;
    message?: string;
    offeredSeconds?: number;
  }): Promise<{ tipId: string; senderBalance: number }> {
    if (input.fromUserId === input.toUserId) {
      throw new TokenError(TokenErrorCode.SELF_TIP, 'You cannot tip yourself.');
    }
    if (!Number.isInteger(input.tokens) || input.tokens <= 0) {
      throw new TokenError(
        TokenErrorCode.INVALID_AMOUNT,
        'A tip must be a positive whole number of tokens.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
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

      // Received tokens count toward lifetimeEarned, which a future payout system would
      // settle against.
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

    this.logger.info({ tipId: result.tipId, tokens: input.tokens }, 'Tip sent');
    return result;
  }

  /**
   * Record the recipient's answer to a time offer.
   *
   * The tokens have already moved and are NOT returned on a decline. That is deliberate
   * and is stated in the UI: a tip is a gift, and making it refundable would turn every
   * decline into a dispute. What the recipient controls is whether the conversation
   * continues — never whether they are paid, and never whether they can leave.
   */
  async respondToOffer(
    tipId: string,
    userId: string,
    accepted: boolean,
  ): Promise<{ fromUserId: string; offeredSeconds: number }> {
    const tip = await this.prisma.tip.findUnique({
      where: { id: tipId },
      select: {
        id: true,
        fromUserId: true,
        toUserId: true,
        accepted: true,
        offeredSeconds: true,
      },
    });

    if (!tip) throw new TokenError(TokenErrorCode.NOT_FOUND, 'That tip no longer exists.');
    // Only the recipient may answer, and only once.
    if (tip.toUserId !== userId) {
      throw new TokenError(TokenErrorCode.FORBIDDEN, 'Only the recipient can answer an offer.');
    }
    if (tip.accepted !== null) {
      throw new TokenError(TokenErrorCode.ALREADY_ANSWERED, 'That offer has already been answered.');
    }
    if (tip.offeredSeconds === null) {
      throw new TokenError(TokenErrorCode.NO_OFFER, 'That tip carried no time offer.');
    }

    await this.prisma.tip.update({
      where: { id: tipId },
      data: { accepted, respondedAt: new Date() },
    });

    return { fromUserId: tip.fromUserId, offeredSeconds: tip.offeredSeconds };
  }

  /* ------------------------------------------------------------------ */
  /* Purchases                                                           */
  /* ------------------------------------------------------------------ */

  async listPackages() {
    return this.prisma.tokenPackage.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, slug: true, tokens: true, priceCents: true, currency: true, label: true },
    });
  }

  async createPurchase(userId: string, packageId: string, providerRef: string) {
    const pkg = await this.prisma.tokenPackage.findFirst({ where: { id: packageId, active: true } });
    if (!pkg) throw new TokenError(TokenErrorCode.NOT_FOUND, 'That package is not available.');

    return this.prisma.tokenPurchase.create({
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
   * Credit a completed purchase. Idempotent on `providerEventId`.
   *
   * Stripe retries webhook delivery on any non-2xx and on timeouts, so this WILL be
   * called more than once for the same payment — crediting twice is money lost. The
   * unique constraint plus the status guard make a repeat delivery a no-op.
   */
  async fulfilPurchase(providerRef: string, providerEventId: string): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const purchase = await tx.tokenPurchase.findUnique({
          where: { providerRef },
          select: { id: true, userId: true, tokens: true, status: true },
        });

        if (!purchase) {
          this.logger.warn({ providerRef }, 'Webhook for an unknown purchase');
          return false;
        }
        // Already fulfilled — a retry, not a second payment.
        if (purchase.status === 'COMPLETED') return false;

        // Claim the event id. A concurrent delivery hits the unique constraint and
        // aborts, so nothing is credited twice.
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

        this.logger.info({ purchaseId: purchase.id, tokens: purchase.tokens }, 'Purchase fulfilled');
        return true;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.info({ providerEventId }, 'Duplicate webhook ignored');
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
      this.prisma.tokenLedger.count({ where: { userId } }),
      this.prisma.tokenLedger.findMany({
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
   * Manual correction by an administrator.
   *
   * Recorded as an ADJUSTMENT with a mandatory note, and audit-logged by the caller.
   * Support cases genuinely need this — a payment that took the money without crediting,
   * a goodwill grant — but an unexplained balance change is indistinguishable from theft.
   */
  async adjust(userId: string, delta: number, note: string): Promise<number> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new TokenError(
        TokenErrorCode.INVALID_AMOUNT,
        'An adjustment must be a non-zero whole number.',
      );
    }
    if (!note.trim()) {
      throw new TokenError(TokenErrorCode.INVALID_AMOUNT, 'An adjustment requires a reason.');
    }

    return this.prisma.$transaction(async (tx) => {
      const balance =
        delta > 0
          ? await this.credit(tx, userId, delta)
          : await this.debit(tx, userId, Math.abs(delta));

      await tx.tokenLedger.create({
        data: {
          userId,
          delta,
          kind: 'ADJUSTMENT',
          balanceAfter: balance,
          note: note.slice(0, 200),
        },
      });

      return balance;
    });
  }
}
