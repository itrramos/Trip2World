import type { PrismaClient } from '@prisma/client';
import type { MailService } from '@trip2world/mailer';
import { AccountStatus } from '@trip2world/types';

/**
 * Scheduled maintenance.
 *
 * Every job here is written to be safe to run twice and safe to interrupt: they operate
 * in bounded batches and are driven by data state rather than by "what happened since
 * last time". A worker that crashes mid-run simply picks the remainder up on the next
 * tick, with no cursor to corrupt and no window to miss.
 */

export interface JobContext {
  prisma: PrismaClient;
  mail: MailService;
  logger: {
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
}

export interface JobResult {
  processed: number;
  details?: Record<string, number>;
}

/** Bound each run so one job cannot monopolise the database. */
const BATCH_SIZE = 200;

/* -------------------------------------------------------------------------- */
/* Account erasure                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Permanently erase accounts whose deletion grace period has elapsed.
 *
 * What survives, and why: reports the user *filed about others* are retained with the
 * reporter detached (`Report.reporterId` is nullable with `onDelete: SetNull`). Dropping
 * abuse history whenever a reporter deletes their account would be trivially exploitable —
 * report someone, delete, and the evidence vanishes. Nothing retained identifies the
 * departed user.
 *
 * Everything genuinely personal — profile, email, sessions, blocks, connections, tokens —
 * goes with the row via `onDelete: Cascade`.
 */
export async function eraseDeletedAccounts(
  { prisma, mail, logger }: JobContext,
  graceDays: number,
): Promise<JobResult> {
  const cutoff = new Date(Date.now() - graceDays * 86_400_000);

  const due = await prisma.user.findMany({
    where: {
      deletionRequestedAt: { not: null, lte: cutoff },
      deletedAt: null,
    },
    select: { id: true, email: true, username: true },
    take: BATCH_SIZE,
  });

  let processed = 0;

  for (const user of due) {
    try {
      // Capture the address before the record goes; afterwards there is nothing to read.
      const email = user.email;

      await prisma.$transaction(async (tx) => {
        // Written before the delete so the audit entry survives it — `AuditLog.actorId`
        // is SetNull, so this becomes an anonymous but permanent record that the erasure
        // happened, which is what a data-protection enquiry actually needs.
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            actorType: 'SYSTEM',
            action: 'account.erased',
            targetType: 'User',
            targetId: user.id,
            metadata: { username: user.username, gracePeriodDays: graceDays },
          },
        });

        await tx.user.delete({ where: { id: user.id } });
      });

      void mail.sendAccountDeletedEmail(email);
      processed += 1;
    } catch (error) {
      // One bad row must not stop the batch.
      logger.error({ err: error, userId: user.id }, 'Failed to erase account');
    }
  }

  if (processed > 0) logger.info({ processed }, 'Erased accounts past their grace period');
  return { processed };
}

/* -------------------------------------------------------------------------- */
/* Suspension expiry                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Restore accounts whose suspension has run out.
 *
 * `getActiveRestriction` already expires suspensions lazily on read, so this is a
 * belt-and-braces sweep. It matters because the lazy path only runs when the user tries
 * to sign in: without this, a suspended account still counts as suspended in the admin
 * dashboard and in matchmaking eligibility long after the punishment ended.
 */
export async function expireSuspensions({ prisma, logger }: JobContext): Promise<JobResult> {
  const now = new Date();

  const suspended = await prisma.user.findMany({
    where: { status: AccountStatus.SUSPENDED, deletedAt: null },
    select: { id: true },
    take: BATCH_SIZE,
  });
  if (suspended.length === 0) return { processed: 0 };

  // A user is still suspended if ANY suspension is open-ended or not yet expired.
  const stillActive = await prisma.moderationAction.findMany({
    where: {
      targetUserId: { in: suspended.map((u) => u.id) },
      type: 'SUSPENSION',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { targetUserId: true },
  });

  const keepSuspended = new Set(stillActive.map((a) => a.targetUserId));
  const toRestore = suspended.filter((u) => !keepSuspended.has(u.id)).map((u) => u.id);

  if (toRestore.length === 0) return { processed: 0 };

  // updateMany with an explicit status guard: if a moderator banned one of these between
  // the read and the write, this must not quietly downgrade the ban to ACTIVE.
  const restored = await prisma.user.updateMany({
    where: { id: { in: toRestore }, status: AccountStatus.SUSPENDED },
    data: { status: AccountStatus.ACTIVE },
  });

  if (restored.count > 0) {
    await prisma.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: 'moderation.suspension.expired',
        targetType: 'User',
        metadata: { count: restored.count },
      },
    });
    logger.info({ count: restored.count }, 'Restored accounts with expired suspensions');
  }

  return { processed: restored.count };
}

/**
 * Lift temporary bans whose expiry has passed.
 *
 * Only non-permanent bans with an expiry are touched; a permanent ban has no `expiresAt`
 * and is never lifted automatically.
 */
export async function expireBans({ prisma, logger }: JobContext): Promise<JobResult> {
  const now = new Date();

  const expired = await prisma.ban.findMany({
    where: { liftedAt: null, permanent: false, expiresAt: { not: null, lte: now } },
    select: { id: true, userId: true },
    take: BATCH_SIZE,
  });
  if (expired.length === 0) return { processed: 0 };

  const userIds = expired.map((ban) => ban.userId);

  await prisma.$transaction([
    prisma.ban.updateMany({
      where: { id: { in: expired.map((ban) => ban.id) } },
      data: { liftedAt: now },
    }),
    // Restore only accounts with no OTHER open ban.
    prisma.user.updateMany({
      where: {
        id: { in: userIds },
        status: AccountStatus.BANNED,
        bans: { none: { liftedAt: null, id: { notIn: expired.map((b) => b.id) } } },
      },
      data: { status: AccountStatus.ACTIVE },
    }),
  ]);

  logger.info({ count: expired.length }, 'Lifted expired temporary bans');
  return { processed: expired.length };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Delete consumed and expired one-time tokens.
 *
 * These are single-use credentials. Keeping them after they are spent adds risk with no
 * benefit — a database leak should not include a pile of password-reset tokens, even
 * expired ones.
 */
export async function pruneVerificationTokens({ prisma, logger }: JobContext): Promise<JobResult> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);

  const { count } = await prisma.verificationToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { not: null, lt: cutoff } }],
    },
  });

  if (count > 0) logger.info({ count }, 'Pruned spent verification tokens');
  return { processed: count };
}

/** Remove revoked and long-expired sessions. */
export async function pruneSessions({ prisma, logger }: JobContext): Promise<JobResult> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);

  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { not: null, lt: cutoff } }],
    },
  });

  if (count > 0) logger.info({ count }, 'Pruned expired sessions');
  return { processed: count };
}

/**
 * Trim the audit log.
 *
 * Retention is deliberately long (2 years) and deliberately finite. Moderation and
 * security enquiries routinely reach back months, but an unbounded append-only table
 * eventually dominates the database and every backup taken of it.
 */
export async function pruneAuditLog(
  { prisma, logger }: JobContext,
  retentionDays: number,
): Promise<JobResult> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  const { count } = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });

  if (count > 0) logger.info({ count, retentionDays }, 'Pruned old audit log entries');
  return { processed: count };
}

/**
 * Close out matches that were never torn down.
 *
 * A realtime node killed with SIGKILL leaves rows with `endedAt` null forever, which
 * inflates the "active matches" figure on the admin dashboard indefinitely. Anything
 * still open after 6 hours is not a real conversation.
 */
export async function closeStaleMatches({ prisma, logger }: JobContext): Promise<JobResult> {
  const cutoff = new Date(Date.now() - 6 * 3_600_000);

  const { count } = await prisma.match.updateMany({
    where: { endedAt: null, startedAt: { lt: cutoff } },
    data: { endedAt: new Date(), endReason: 'ERROR' },
  });

  if (count > 0) logger.warn({ count }, 'Closed matches that were never torn down');
  return { processed: count };
}
