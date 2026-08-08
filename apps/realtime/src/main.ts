import { createPrismaClient, disconnect, loadSystemSettings } from '@trip2world/database';
import { DEFAULT_RELAXATION_STAGES, MAX_QUEUE_SECONDS, MIN_SECONDS_BETWEEN_SKIPS, NEGOTIATION_TIMEOUT_MS, SKIP_COOLDOWN_SECONDS } from '@trip2world/shared';
import type { MatchmakingSettings } from '@trip2world/types';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildRealtimeServer } from './server.js';

/**
 * Realtime service entry point.
 *
 * Three Redis connections are required, not one. The Socket.IO Redis adapter puts its
 * subscriber into subscribe mode, after which that connection cannot issue ordinary
 * commands — so the adapter gets its own pub/sub pair and the application keeps a third
 * for queue, presence and lock operations.
 */

const DEFAULT_MATCHMAKING: MatchmakingSettings = {
  relaxationStages: DEFAULT_RELAXATION_STAGES,
  maxQueueSeconds: MAX_QUEUE_SECONDS,
  skipCooldownSeconds: SKIP_COOLDOWN_SECONDS,
  minSecondsBetweenSkips: MIN_SECONDS_BETWEEN_SKIPS,
  negotiationTimeoutMs: NEGOTIATION_TIMEOUT_MS,
};

async function main(): Promise<void> {
  const config = loadConfig();

  const logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'realtime', node: config.REALTIME_NODE_ID },
    redact: {
      paths: ['*.token', '*.accessToken', '*.credential', '*.sdp', 'req.headers.authorization'],
      censor: '[redacted]',
    },
    ...(config.isDevelopment
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL });

  const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  } as const;

  const redis = new Redis(config.REDIS_URL, redisOptions);
  const pubClient = new Redis(config.REDIS_URL, redisOptions);
  const subClient = pubClient.duplicate();

  for (const [name, client] of [
    ['redis', redis],
    ['pub', pubClient],
    ['sub', subClient],
  ] as const) {
    // Never log the URL — it contains the password.
    client.on('error', (error: Error) => logger.error({ err: error, client: name }, 'Redis error'));
  }

  /**
   * Matchmaking settings, cached briefly.
   *
   * Read on every tick and every pairing attempt, so it must not hit Postgres each time.
   * A short window bounds how long an operator's change takes to apply while keeping the
   * hot path free of database round trips. Falls back to compiled-in defaults so a
   * settings outage degrades matchmaking policy rather than stopping matchmaking.
   */
  let settingsCache: { value: MatchmakingSettings; expiresAt: number } | null = null;

  const settings = async (): Promise<MatchmakingSettings> => {
    if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;

    try {
      const loaded = await loadSystemSettings(prisma);
      settingsCache = { value: loaded.matchmaking, expiresAt: Date.now() + 30_000 };
      return loaded.matchmaking;
    } catch (error) {
      logger.warn({ err: error }, 'Falling back to default matchmaking settings');
      settingsCache = { value: DEFAULT_MATCHMAKING, expiresAt: Date.now() + 10_000 };
      return DEFAULT_MATCHMAKING;
    }
  };

  const { httpServer, shutdown } = buildRealtimeServer({
    config,
    logger,
    prisma,
    redis,
    pubClient,
    subClient,
    settings,
  });

  let shuttingDown = false;

  const stop = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    force.unref();

    try {
      // Order matters: release matches and presence FIRST, while Redis is still
      // connected. Closing Redis before draining would strand every match lock until its
      // TTL expired, leaving those users unable to match for up to an hour.
      await shutdown();

      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.all([redis.quit(), pubClient.quit(), subClient.quit()]);
      await disconnect(prisma);

      logger.info('Shutdown complete');
      clearTimeout(force);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void stop('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void stop('uncaughtException');
  });

  httpServer.listen(config.PORT, config.HOST, () => {
    logger.info(
      {
        port: config.PORT,
        path: config.REALTIME_PATH,
        node: config.REALTIME_NODE_ID,
        turn: config.turnConfigured ? 'configured' : 'MISSING',
      },
      'Trip2World realtime listening',
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nFailed to start Trip2World realtime: ${error instanceof Error ? error.stack : String(error)}\n\n`,
  );
  process.exit(1);
});
