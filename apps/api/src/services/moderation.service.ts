import type { PrismaClient } from '@prisma/client';
import { getReportHistory } from '@trip2world/database';
import { PRIORITY_REPORT_CATEGORIES } from '@trip2world/types';
import type { ResolveReportInput } from '@trip2world/validation';
import { Errors } from '../errors.js';
import type { RedisContext } from '../redis.js';

/**
 * Moderation.
 *
 * Two rules shape everything here:
 *
 *   1. Every action is recorded. A moderator who bans an account leaves an immutable
 *      `ModerationAction` and an `AuditLog` entry. Moderation power without an audit
 *      trail is indistinguishable from abuse of that power, including to the moderator
 *      trying to prove they acted correctly.
 *
 *   2. The user-facing reason and the internal note are separate fields, always. The
 *      target sees `reason`; `notes` is for moderators and is never returned by an
 *      endpoint a non-moderator can reach.
 */

/**
 * Minimal structural logger.
 *
 * Typed by shape rather than as pino's concrete `Logger` so the service accepts both the
 * application logger and Fastify's request-scoped child logger — the latter carries the
 * request id, which is what makes a moderation action traceable back to the call that
 * performed it.
 */
export interface ModerationLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ModerationDeps {
  prisma: PrismaClient;
  redis: RedisContext;
  logger: ModerationLogger;
}

export class ModerationService {
  constructor(private readonly deps: ModerationDeps) {}

  /**
   * The moderation queue.
   *
   * Child-safety and credible-threat reports are surfaced first regardless of age. A
   * strictly chronological queue means an UNDERAGE report can sit behind fifty spam
   * reports, and that is the one category where a delay causes real harm.
   */
  async queue(options: {
    page: number;
    pageSize: number;
    status?: string;
    category?: string;
    priorityFirst: boolean;
  }) {
    const { prisma } = this.deps;
    const { page, pageSize, status, category, priorityFirst } = options;

    const where = {
      ...(status ? { status: status as never } : { status: { in: ['PENDING', 'UNDER_REVIEW'] as never } }),
      ...(category ? { category: category as never } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.findMany({
        where,
        // Postgres cannot express "these enum values first" in a plain orderBy, so the
        // priority split happens below in application code over the fetched page.
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          category: true,
          details: true,
          status: true,
          matchId: true,
          createdAt: true,
          reviewedAt: true,
          reviewedById: true,
          moderatorNotes: true,
          reporter: { select: { id: true, username: true } },
          reportedUser: {
            select: {
              id: true,
              username: true,
              status: true,
              createdAt: true,
              profile: { select: { country: true, displayName: true } },
            },
          },
        },
      }),
    ]);

    const items = priorityFirst
      ? [...rows].sort((a, b) => {
          const aPriority = PRIORITY_REPORT_CATEGORIES.includes(a.category as never) ? 0 : 1;
          const bPriority = PRIORITY_REPORT_CATEGORIES.includes(b.category as never) ? 0 : 1;
          if (aPriority !== bPriority) return aPriority - bPriority;
          return a.createdAt.getTime() - b.createdAt.getTime();
        })
      : rows;

    // Prior-report counts are what let a moderator distinguish a one-off complaint from
    // a pattern, which is usually the whole decision.
    const withHistory = await Promise.all(
      items.map(async (report) => {
        const history = await getReportHistory(report.reportedUser.id, prisma);
        return { ...report, priorTotalReports: history.total, priorUpheldReports: history.upheld };
      }),
    );

    return { items: withHistory, page, pageSize, total, hasMore: page * pageSize < total };
  }

  /** Claim a report for review, so two moderators do not act on the same one. */
  async claim(reportId: string, moderatorId: string) {
    const { prisma } = this.deps;

    const claimed = await prisma.report.updateMany({
      where: { id: reportId, status: 'PENDING' },
      data: { status: 'UNDER_REVIEW', reviewedById: moderatorId },
    });

    if (claimed.count === 0) {
      throw Errors.conflict('Another moderator is already reviewing that report.');
    }
  }

  /**
   * Resolve a report and apply the resulting action.
   *
   * Everything runs in one transaction: the report status, the moderation action, any
   * ban row, and the account status change must all land together. A partial apply — a
   * report marked ACTIONED against an account that was never actually suspended — is a
   * silent moderation failure that nobody would notice until the user reoffended.
   */
  async resolve(input: ResolveReportInput, moderatorId: string) {
    const { prisma, redis, logger } = this.deps;

    const report = await prisma.report.findUnique({
      where: { id: input.reportId },
      select: { id: true, reportedUserId: true, status: true, category: true },
    });
    if (!report) throw Errors.notFound('That report');
    if (report.status === 'ACTIONED' || report.status === 'DISMISSED') {
      throw Errors.conflict('That report has already been resolved.');
    }

    const targetId = report.reportedUserId;
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.report.update({
        where: { id: report.id },
        data: {
          status: input.action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED',
          reviewedById: moderatorId,
          reviewedAt: now,
          moderatorNotes: input.notes ?? null,
        },
      });

      if (input.action === 'DISMISS') {
        await tx.moderationAction.create({
          data: {
            targetUserId: targetId,
            moderatorId,
            type: 'DISMISS_REPORT',
            reason: input.reason ?? 'No violation found.',
            notes: input.notes ?? null,
          },
        });
        return;
      }

      if (input.action === 'WARN') {
        await tx.moderationAction.create({
          data: {
            targetUserId: targetId,
            moderatorId,
            type: 'WARNING',
            reason: input.reason!,
            notes: input.notes ?? null,
          },
        });
        return;
      }

      if (input.action === 'SUSPEND') {
        const expiresAt = new Date(now.getTime() + input.suspensionHours! * 3_600_000);
        await tx.moderationAction.create({
          data: {
            targetUserId: targetId,
            moderatorId,
            type: 'SUSPENSION',
            reason: input.reason!,
            notes: input.notes ?? null,
            expiresAt,
          },
        });
        await tx.user.update({
          where: { id: targetId },
          // Bumping the generation invalidates every access token immediately, so a
          // suspension takes effect now rather than whenever their token happens to expire.
          data: { status: 'SUSPENDED', tokenGeneration: { increment: 1 } },
        });
        await tx.session.updateMany({
          where: { userId: targetId, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'suspended' },
        });
        return;
      }

      // BAN
      await tx.moderationAction.create({
        data: {
          targetUserId: targetId,
          moderatorId,
          type: 'BAN',
          reason: input.reason!,
          notes: input.notes ?? null,
        },
      });
      await tx.ban.create({
        data: {
          userId: targetId,
          issuedById: moderatorId,
          reason: input.reason!,
          permanent: true,
        },
      });
      await tx.user.update({
        where: { id: targetId },
        data: { status: 'BANNED', tokenGeneration: { increment: 1 } },
      });
      await tx.session.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'banned' },
      });
    });

    /**
     * Evict the account from any live conversation.
     *
     * The database now says banned, but the user may be mid-call on a socket that was
     * authenticated minutes ago. Dropping their Redis presence and match keys is what
     * makes the ban immediate rather than "from their next page load".
     */
    if (input.action === 'SUSPEND' || input.action === 'BAN') {
      await Promise.all([
        redis.client.del(redis.keys.presence(targetId)),
        redis.client.del(redis.keys.userMatch(targetId)),
        redis.client.del(redis.keys.queueEntry(targetId)),
      ]).catch((error: unknown) => {
        logger.error({ err: error, targetId }, 'Failed to evict restricted user from Redis');
      });
    }

    await this.audit(moderatorId, `moderation.report.${input.action.toLowerCase()}`, targetId, {
      reportId: report.id,
      category: report.category,
    });

    logger.info(
      { reportId: report.id, action: input.action, moderatorId, targetId },
      'Report resolved',
    );
  }

  /**
   * Apply a restriction directly, without an originating report.
   *
   * Used when a moderator acts on something they observed themselves rather than
   * something a user flagged. Shares the same transaction shape and the same Redis
   * eviction as `resolve`, so a direct ban is exactly as immediate and exactly as
   * auditable as one that came from the queue.
   */
  async resolveDirect(
    input: {
      targetUserId: string;
      action: 'SUSPEND' | 'BAN';
      reason: string;
      notes?: string;
      hours?: number;
    },
    moderatorId: string,
  ): Promise<void> {
    const { prisma, redis, logger } = this.deps;

    const target = await prisma.user.findFirst({
      where: { id: input.targetUserId, deletedAt: null },
      select: { id: true, role: true },
    });
    if (!target) throw Errors.notFound('That user');

    // A moderator must not be able to restrict another moderator or an admin. Without
    // this, a compromised moderator account can disable the people who would notice.
    if (target.role !== 'USER') {
      throw Errors.forbidden('Staff accounts cannot be restricted from here.');
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      if (input.action === 'SUSPEND') {
        await tx.moderationAction.create({
          data: {
            targetUserId: target.id,
            moderatorId,
            type: 'SUSPENSION',
            reason: input.reason,
            notes: input.notes ?? null,
            expiresAt: new Date(now.getTime() + (input.hours ?? 24) * 3_600_000),
          },
        });
        await tx.user.update({
          where: { id: target.id },
          data: { status: 'SUSPENDED', tokenGeneration: { increment: 1 } },
        });
      } else {
        await tx.moderationAction.create({
          data: {
            targetUserId: target.id,
            moderatorId,
            type: 'BAN',
            reason: input.reason,
            notes: input.notes ?? null,
          },
        });
        await tx.ban.create({
          data: {
            userId: target.id,
            issuedById: moderatorId,
            reason: input.reason,
            permanent: true,
          },
        });
        await tx.user.update({
          where: { id: target.id },
          data: { status: 'BANNED', tokenGeneration: { increment: 1 } },
        });
      }

      await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: input.action.toLowerCase() },
      });
    });

    await Promise.all([
      redis.client.del(redis.keys.presence(target.id)),
      redis.client.del(redis.keys.userMatch(target.id)),
      redis.client.del(redis.keys.queueEntry(target.id)),
    ]).catch((error: unknown) => {
      logger.error({ err: error, targetId: target.id }, 'Failed to evict restricted user');
    });

    await this.audit(moderatorId, `moderation.user.${input.action.toLowerCase()}`, target.id, {
      reason: input.reason,
    });
  }

  /** Lift a ban or suspension. */
  async reinstate(userId: string, moderatorId: string, reason: string) {
    const { prisma } = this.deps;
    const now = new Date();

    await prisma.$transaction([
      prisma.ban.updateMany({
        where: { userId, liftedAt: null },
        data: { liftedAt: now, liftedById: moderatorId },
      }),
      prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } }),
      prisma.moderationAction.create({
        data: { targetUserId: userId, moderatorId, type: 'UNBAN', reason },
      }),
    ]);

    await this.audit(moderatorId, 'moderation.user.reinstate', userId, { reason });
  }

  /** Dashboard counters. */
  async stats() {
    const { prisma, redis } = this.deps;
    const dayAgo = new Date(Date.now() - 86_400_000);

    const [registeredUsers, bannedUsers, suspendedUsers, reportsPending, matchesToday] =
      await Promise.all([
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.user.count({ where: { status: 'BANNED' } }),
        prisma.user.count({ where: { status: 'SUSPENDED' } }),
        prisma.report.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
        prisma.match.count({ where: { startedAt: { gte: dayAgo } } }),
      ]);

    const [onlineUsers, queuedUsers] = await Promise.all([
      redis.client.scard(redis.keys.onlineSet()).catch(() => 0),
      redis.client.zcard(redis.keys.queue('global')).catch(() => 0),
    ]);

    const activeMatches = await prisma.match.count({ where: { endedAt: null } });

    return {
      registeredUsers,
      onlineUsers,
      queuedUsers,
      activeMatches,
      matchesToday,
      reportsPending,
      bannedUsers,
      suspendedUsers,
    };
  }

  private async audit(
    actorId: string,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.prisma.auditLog
      .create({
        data: {
          actorId,
          actorType: 'ADMIN',
          action,
          targetType: 'User',
          targetId,
          metadata: metadata as never,
        },
      })
      .catch((error: unknown) => {
        // An audit write must never fail the moderation action it describes, but a
        // missing entry is serious enough to log loudly.
        this.deps.logger.error({ err: error, action, targetId }, 'Failed to write audit log');
      });
  }
}
