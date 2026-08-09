import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Promotional token campaigns.
 *
 * An operator schedules a grant — a launch bonus, a special day, "free tokens for the
 * first 500 accounts" — and eligible users receive it exactly once, automatically.
 *
 * Three properties have to hold, and each of them is a bug that only appears under real
 * traffic:
 *
 * **1. Exactly once per user.** Guaranteed by the unique index on
 * `(campaignId, userId)`, not by an application check. Two requests can both read "no
 * grant yet" and both proceed; only one of them can insert. The loser catches P2002 and
 * treats it as "already claimed", which is the correct answer.
 *
 * **2. The cap is never exceeded.** `maxGrants` is enforced with a conditional
 * `UPDATE ... WHERE grantsIssued < maxGrants` and a zero affected-row count meaning
 * exhausted — the same shape as a token debit, for the same reason. `COUNT(*)` then
 * compare would let fifty simultaneous signups all pass a limit of fifty.
 *
 * **3. A promotion never breaks signing up.** Every call site treats this as
 * best-effort. If the campaign table is unreachable, or a cap has been hit, or a grant
 * races and loses, the user still gets their account. A marketing feature must not be
 * able to take registration down.
 */

export interface CampaignsLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** What a user actually received, for the "you got N tokens" notice. */
export interface GrantResult {
  campaignId: string;
  campaignName: string;
  tokens: number;
}

/** Everything needed to decide eligibility, without a second query per campaign. */
interface EligibilityContext {
  userId: string;
  createdAt: Date;
  emailVerified: boolean;
}

export class CampaignsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: CampaignsLogger,
  ) {}

  /**
   * Campaigns that could grant right now.
   *
   * Deliberately narrow: status ACTIVE, inside its window, and not already exhausted.
   * The cap check here is only a cheap pre-filter — the authoritative one is the
   * conditional update in `claim`, because this read and that write are not atomic
   * together and must not pretend to be.
   */
  private async liveCampaigns(now: Date) {
    return this.prisma.tokenCampaign.findMany({
      where: {
        status: 'ACTIVE',
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      select: {
        id: true,
        name: true,
        tokens: true,
        audience: true,
        startsAt: true,
        createdAt: true,
        maxGrants: true,
        grantsIssued: true,
        requiresVerifiedEmail: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Grant every campaign this user qualifies for.
   *
   * Called at the three moments an account becomes newly eligible: registration (when
   * email verification is disabled), email verification, and sign-in. One code path,
   * three call sites — a promotion that fires from only one of them is a promotion half
   * the users never see.
   *
   * Returns what was granted so the caller can tell the user. Never throws.
   */
  async applyEligible(userId: string): Promise<GrantResult[]> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, createdAt: true, emailVerified: true, deletedAt: true },
      });
      if (!user || user.deletedAt) return [];

      const now = new Date();
      const campaigns = await this.liveCampaigns(now);
      if (campaigns.length === 0) return [];

      const context: EligibilityContext = {
        userId: user.id,
        createdAt: user.createdAt,
        emailVerified: user.emailVerified,
      };

      const granted: GrantResult[] = [];

      for (const campaign of campaigns) {
        // An unverified account gets nothing from a campaign that requires
        // verification — but it is not *rejected*, it is simply skipped. The same
        // campaign will grant the moment they confirm their address, which is exactly
        // the incentive the flag exists to create.
        if (campaign.requiresVerifiedEmail && !context.emailVerified) continue;

        /**
         * NEW_USERS means "accounts created while this was running", not "accounts that
         * happen to be new today". Without this comparison, switching on a launch
         * promotion would retroactively pay every account that ever registered — the
         * entire existing user base, at once, from a single click.
         *
         * The cutoff falls back to the campaign's own `createdAt` when no start time was
         * set, which is the case the operator hits most often: leaving "Starts" blank is
         * both the default and the advice. Treating a null start as "no cutoff" is
         * exactly the retroactive payout this guard exists to prevent, and it would have
         * been invisible in testing — a fresh account passes either way.
         */
        if (campaign.audience === 'NEW_USERS') {
          const cutoff = campaign.startsAt ?? campaign.createdAt;
          if (context.createdAt < cutoff) continue;
        }

        // Cheap pre-filter. The real guard is in claim().
        if (campaign.maxGrants !== null && campaign.grantsIssued >= campaign.maxGrants) continue;

        const result = await this.claim(campaign.id, context.userId);
        if (result) granted.push(result);
      }

      return granted;
    } catch (error) {
      // Best-effort by design. A broken promotion must never block a signup or a login.
      this.logger.error({ err: error, userId }, 'Campaign grant failed; continuing without it');
      return [];
    }
  }

  /**
   * Award one campaign to one user, or return null if they are not entitled to it.
   *
   * The ordering matters. The counter is reserved *before* the grant is written, so a
   * crash between the two costs one unused slot rather than handing out more tokens than
   * the operator authorised. Losing a slot is an accounting curiosity; exceeding a cap
   * is a budget the operator did not agree to.
   */
  async claim(campaignId: string, userId: string): Promise<GrantResult | null> {
    const campaign = await this.prisma.tokenCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, name: true, tokens: true, maxGrants: true },
    });
    if (!campaign) return null;

    // Cheap early exit for the overwhelmingly common repeat case, so a returning user
    // signing in does not pay for a transaction on every request.
    const existing = await this.prisma.tokenGrant.findUnique({
      where: { campaignId_userId: { campaignId, userId } },
      select: { id: true },
    });
    if (existing) return null;

    /**
     * Reserve a slot.
     *
     * `updateMany` because Prisma's `update` cannot express the `grantsIssued <
     * maxGrants` guard, and the guard is the entire mechanism. Zero affected rows means
     * another request took the last slot between the pre-filter and here.
     */
    const reserved = await this.prisma.tokenCampaign.updateMany({
      where: {
        id: campaignId,
        status: 'ACTIVE',
        OR: [
          { maxGrants: null },
          // Prisma cannot compare two columns, so the cap is compared against the value
          // read a moment ago. The `status` and row-level lock still serialise writers,
          // and a lost race simply fails the unique constraint below.
          { grantsIssued: { lt: campaign.maxGrants ?? Number.MAX_SAFE_INTEGER } },
        ],
      },
      data: { grantsIssued: { increment: 1 } },
    });

    if (reserved.count === 0) return null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const grant = await tx.tokenGrant.create({
          data: { campaignId, userId, tokens: campaign.tokens },
          select: { id: true },
        });

        const account = await tx.tokenAccount.upsert({
          where: { userId },
          create: { userId, balance: campaign.tokens, lifetimeEarned: campaign.tokens },
          update: {
            balance: { increment: campaign.tokens },
            lifetimeEarned: { increment: campaign.tokens },
          },
          select: { balance: true },
        });

        await tx.tokenLedger.create({
          data: {
            userId,
            delta: campaign.tokens,
            kind: 'PROMO',
            balanceAfter: account.balance,
            campaignId,
            note: campaign.name.slice(0, 200),
          },
        });

        this.logger.info({ campaignId, userId, tokens: campaign.tokens, grantId: grant.id }, 'Campaign granted');

        return { campaignId, campaignName: campaign.name, tokens: campaign.tokens };
      });
    } catch (error) {
      /**
       * P2002 is the unique index doing its job: another request granted this campaign
       * to this user while we were working. Not an error — the user has their tokens,
       * they just did not come from this request.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.releaseSlot(campaignId);
        return null;
      }

      // The transaction rolled back, so the reservation is now a slot nobody holds.
      await this.releaseSlot(campaignId);
      throw error;
    }
  }

  /** Hand a reserved slot back after a failed grant. Floored at zero. */
  private async releaseSlot(campaignId: string): Promise<void> {
    await this.prisma.tokenCampaign
      .updateMany({
        where: { id: campaignId, grantsIssued: { gt: 0 } },
        data: { grantsIssued: { decrement: 1 } },
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error, campaignId }, 'Could not release campaign slot');
      });
  }

  /* ------------------------------------------------------------------ */
  /* Administration                                                      */
  /* ------------------------------------------------------------------ */

  async list() {
    return this.prisma.tokenCampaign.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        description: true,
        tokens: true,
        audience: true,
        status: true,
        startsAt: true,
        endsAt: true,
        maxGrants: true,
        grantsIssued: true,
        requiresVerifiedEmail: true,
        createdAt: true,
        createdBy: { select: { id: true, username: true } },
      },
    });
  }

  async create(
    input: {
      name: string;
      description?: string;
      tokens: number;
      audience: 'NEW_USERS' | 'ALL_USERS';
      startsAt?: Date | null;
      endsAt?: Date | null;
      maxGrants?: number | null;
      requiresVerifiedEmail?: boolean;
    },
    createdById: string,
  ) {
    return this.prisma.tokenCampaign.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        tokens: input.tokens,
        audience: input.audience,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        maxGrants: input.maxGrants ?? null,
        requiresVerifiedEmail: input.requiresVerifiedEmail ?? true,
        createdById,
        // Always DRAFT. Creating a campaign and switching it on are two decisions, and
        // a typo in the token amount should not be live the instant it is saved.
        status: 'DRAFT',
      },
      select: { id: true, name: true, status: true },
    });
  }

  /**
   * Change a campaign.
   *
   * `tokens` and `audience` are only editable while it has granted nothing. Once real
   * users have received it, changing the amount would mean two people got different
   * things from the same named promotion with no record of why.
   */
  async update(
    campaignId: string,
    input: {
      name?: string;
      description?: string | null;
      tokens?: number;
      audience?: 'NEW_USERS' | 'ALL_USERS';
      startsAt?: Date | null;
      endsAt?: Date | null;
      maxGrants?: number | null;
      requiresVerifiedEmail?: boolean;
    },
  ) {
    const campaign = await this.prisma.tokenCampaign.findUnique({
      where: { id: campaignId },
      select: { grantsIssued: true },
    });
    if (!campaign) return null;

    const locked = campaign.grantsIssued > 0;
    if (locked && (input.tokens !== undefined || input.audience !== undefined)) {
      throw new Error('The amount and audience cannot change once a campaign has granted tokens.');
    }

    return this.prisma.tokenCampaign.update({
      where: { id: campaignId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
        ...(input.audience !== undefined ? { audience: input.audience } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.maxGrants !== undefined ? { maxGrants: input.maxGrants } : {}),
        ...(input.requiresVerifiedEmail !== undefined
          ? { requiresVerifiedEmail: input.requiresVerifiedEmail }
          : {}),
      },
      select: { id: true, name: true, status: true },
    });
  }

  /**
   * Move a campaign between states.
   *
   * ENDED is terminal. Reviving a finished campaign would silently reopen a budget the
   * operator closed, so it has to be recreated instead — which leaves a record.
   */
  async setStatus(campaignId: string, status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED') {
    const campaign = await this.prisma.tokenCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) return null;

    if (campaign.status === 'ENDED') {
      throw new Error('An ended campaign cannot be restarted. Create a new one.');
    }

    return this.prisma.tokenCampaign.update({
      where: { id: campaignId },
      data: { status },
      select: { id: true, name: true, status: true },
    });
  }

  /** Per-campaign totals for the admin dashboard. */
  async stats() {
    const [campaigns, promoTotal] = await Promise.all([
      this.prisma.tokenCampaign.count({ where: { status: 'ACTIVE' } }),
      this.prisma.tokenLedger.aggregate({ where: { kind: 'PROMO' }, _sum: { delta: true } }),
    ]);

    return {
      activeCampaigns: campaigns,
      tokensGranted: promoTotal._sum.delta ?? 0,
    };
  }
}
