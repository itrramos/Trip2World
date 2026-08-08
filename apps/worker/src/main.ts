import { createPrismaClient, disconnect } from '@trip2world/database';
import { MailService } from '@trip2world/mailer';
import { ACCOUNT_DELETION_GRACE_DAYS, createRedisKeys } from '@trip2world/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { z } from 'zod';
import {
  closeStaleMatches,
  eraseDeletedAccounts,
  expireBans,
  expireSuspensions,
  pruneAuditLog,
  pruneSessions,
  pruneVerificationTokens,
  type JobContext,
  type JobResult,
} from './jobs.js';

/**
 * Maintenance worker.
 *
 * Uses BullMQ repeatable jobs rather than a bare `setInterval`. The difference matters as
 * soon as there is more than one worker container: BullMQ holds the schedule in Redis, so
 * a repeatable job fires once across the whole fleet. Two workers each running their own
 * timer would erase accounts twice and race each other's transactions.
 *
 * A crashed worker also resumes cleanly — the schedule lives in Redis, not in process
 * memory, so nothing is missed and nothing is double-run.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z.string().default('t2w'),

  APP_URL: z.string().url(),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_SECURE: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : v.trim().toLowerCase() === 'true')),
  MAIL_FROM: z.string().default('Trip2World <noreply@localhost>'),
  MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),

  /** How long an audit entry is kept. Long, but finite. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).default(730),
});

const QUEUE_NAME = 'trip2world-maintenance';

/** Each job, its schedule, and what it does. */
const SCHEDULE = [
  { name: 'erase-deleted-accounts', cron: '17 3 * * *' }, // daily, off the hour
  { name: 'expire-suspensions', cron: '*/5 * * * *' },
  { name: 'expire-bans', cron: '*/5 * * * *' },
  { name: 'close-stale-matches', cron: '*/15 * * * *' },
  { name: 'prune-verification-tokens', cron: '31 4 * * *' },
  { name: 'prune-sessions', cron: '41 4 * * *' },
  { name: 'prune-audit-log', cron: '51 4 * * 0' }, // weekly
] as const;

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    process.stderr.write(
      `\nTrip2World worker cannot start — invalid configuration:\n\n${lines.join('\n')}\n\n`,
    );
    process.exit(1);
  }
  const env = parsed.data;

  const logger = pino({
    level: env.LOG_LEVEL,
    base: { service: 'worker' },
    redact: {
      paths: ['*.password', '*.token', '*.SMTP_PASSWORD', '*.DATABASE_URL', '*.REDIS_URL'],
      censor: '[redacted]',
    },
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  const connection = new Redis(env.REDIS_URL, {
    // BullMQ requires this to be null: it uses blocking commands, and a retry limit
    // would abort them.
    maxRetriesPerRequest: null,
  });
  connection.on('error', (error) => logger.error({ err: error }, 'Redis error'));

  const mail = new MailService(
    {
      transport: env.MAIL_TRANSPORT,
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      secure: env.SMTP_SECURE,
      from: env.MAIL_FROM,
      appUrl: env.APP_URL,
    },
    logger,
  );

  const context: JobContext = { prisma, mail, logger };
  const keys = createRedisKeys(env.REDIS_PREFIX);

  /* ---------------------------------------------------------------- */
  /* Schedule                                                          */
  /* ---------------------------------------------------------------- */

  const queue = new Queue(QUEUE_NAME, { connection, prefix: keys.prefix });

  // Remove any repeatable jobs that are no longer in SCHEDULE. Without this, renaming or
  // dropping a job leaves the old schedule running in Redis forever, and it is invisible
  // because nothing in the code references it any more.
  const existing = await queue.getRepeatableJobs();
  const wanted = new Set(SCHEDULE.map((job) => job.name));
  for (const repeatable of existing) {
    if (!wanted.has(repeatable.name as (typeof SCHEDULE)[number]['name'])) {
      await queue.removeRepeatableByKey(repeatable.key);
      logger.info({ name: repeatable.name }, 'Removed obsolete repeatable job');
    }
  }

  for (const job of SCHEDULE) {
    await queue.add(
      job.name,
      {},
      {
        repeat: { pattern: job.cron },
        // A stable jobId keeps re-registration idempotent across restarts.
        jobId: job.name,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Processor                                                         */
  /* ---------------------------------------------------------------- */

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job): Promise<JobResult> => {
      const started = Date.now();

      const result = await (async (): Promise<JobResult> => {
        switch (job.name) {
          case 'erase-deleted-accounts':
            return eraseDeletedAccounts(context, ACCOUNT_DELETION_GRACE_DAYS);
          case 'expire-suspensions':
            return expireSuspensions(context);
          case 'expire-bans':
            return expireBans(context);
          case 'close-stale-matches':
            return closeStaleMatches(context);
          case 'prune-verification-tokens':
            return pruneVerificationTokens(context);
          case 'prune-sessions':
            return pruneSessions(context);
          case 'prune-audit-log':
            return pruneAuditLog(context, env.AUDIT_RETENTION_DAYS);
          default:
            logger.warn({ name: job.name }, 'Unknown job');
            return { processed: 0 };
        }
      })();

      // Only log jobs that did something. Most ticks are no-ops, and logging every one
      // buries the entries that matter.
      if (result.processed > 0) {
        logger.info(
          { job: job.name, processed: result.processed, ms: Date.now() - started },
          'Job completed',
        );
      }

      return result;
    },
    {
      connection,
      prefix: keys.prefix,
      // Maintenance jobs touch overlapping rows; running them one at a time removes a
      // whole class of self-inflicted contention for no meaningful throughput loss.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ err: error, job: job?.name, attempt: job?.attemptsMade }, 'Job failed');
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 30_000);
    force.unref();

    try {
      // `close()` waits for the in-flight job to finish rather than killing it mid
      // transaction — an interrupted erasure batch is exactly what we do not want.
      await worker.close();
      await queue.close();
      await mail.close();
      await connection.quit();
      await disconnect(prisma);
      clearTimeout(force);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });

  logger.info(
    { jobs: SCHEDULE.length, mail: env.MAIL_TRANSPORT },
    'Trip2World worker running',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nFailed to start Trip2World worker: ${error instanceof Error ? error.stack : String(error)}\n\n`,
  );
  process.exit(1);
});
