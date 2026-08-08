import { createPrismaClient, disconnect } from '@trip2world/database';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRedis } from './redis.js';
import { buildServer } from './server.js';

/**
 * API entry point.
 *
 * Graceful shutdown is the part worth reading. On SIGTERM the server stops accepting new
 * connections, drains in-flight requests, then closes Redis and Postgres. Without this,
 * `docker compose down` or a rolling update would sever live requests mid-transaction and
 * — more importantly for this product — leave Redis match locks held until their TTL,
 * during which the affected users cannot be matched at all.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const prisma = createPrismaClient({
    databaseUrl: config.DATABASE_URL,
    logQueries: config.isDevelopment,
  });
  const redis = createRedis(config, logger);

  const app = await buildServer({ config, logger, prisma, redis });

  // Surface a bad SMTP configuration at boot rather than on the first registration.
  void app.services.mail.verifyConnection();

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down');

    // Hard deadline. If draining hangs — a stuck query, a wedged socket — exit anyway
    // rather than waiting for the orchestrator's SIGKILL, which skips cleanup entirely.
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    try {
      await app.close();
      await redis.client.quit();
      await disconnect(prisma);
      logger.info('Shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /**
   * An unhandled rejection leaves the process in an unknown state. Logging and
   * continuing risks serving requests from a half-broken process — which is harder to
   * diagnose than a clean restart, and the orchestrator will restart us.
   */
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });

  await app.listen({ port: config.PORT, host: config.HOST });

  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      turn: config.turnConfigured ? 'configured' : 'MISSING',
      smtp: config.smtpConfigured ? 'configured' : 'log-only',
    },
    'Trip2World API listening',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nFailed to start Trip2World API: ${error instanceof Error ? error.stack : String(error)}\n\n`,
  );
  process.exit(1);
});
