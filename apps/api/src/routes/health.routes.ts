import { checkDatabase } from '@trip2world/database';
import type { HealthReport } from '@trip2world/types';
import type { FastifyInstance } from 'fastify';
import { checkRedis } from '../redis.js';
import { TIMEOUTS, withTimeoutOr } from '../utils/timeout.js';

const startedAt = Date.now();

/**
 * Health and readiness.
 *
 * `/health` is liveness: is this process running and able to serve? It touches nothing
 * external, so a database outage does not cause the orchestrator to kill and restart an
 * otherwise healthy API — restarting would not fix the database and would drop every
 * in-flight request.
 *
 * `/ready` is readiness: can this process do useful work right now? It checks the
 * dependencies, and a failure means "stop sending me traffic", not "restart me".
 *
 * Neither endpoint reveals versions, hostnames, connection strings, or error text — they
 * are unauthenticated and reachable from the edge.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, redis } = app;

  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      service: 'api',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  app.get('/ready', async (_request, reply) => {
    const checks: HealthReport['checks'] = {};

    // Both probes carry a deadline and run concurrently. A readiness check that hangs
    // is worse than one that fails: the container healthcheck waits, times out with no
    // verdict, and the orchestrator never learns the instance should be drained.
    const dbStart = Date.now();
    const redisStart = Date.now();

    const [dbOk, redisOk] = await Promise.all([
      withTimeoutOr(checkDatabase(prisma), TIMEOUTS.healthCheck, false),
      withTimeoutOr(checkRedis(redis.client), TIMEOUTS.healthCheck, false),
    ]);

    checks.database = dbOk
      ? { status: 'ok', latencyMs: Date.now() - dbStart }
      : { status: 'error', message: 'unreachable' };

    checks.redis = redisOk
      ? { status: 'ok', latencyMs: Date.now() - redisStart }
      : { status: 'error', message: 'unreachable' };

    const healthy = dbOk && redisOk;

    const report: HealthReport = {
      status: healthy ? 'ok' : 'error',
      service: 'api',
      // Deliberately not the real version — it is a free fingerprint for anyone
      // scanning for known-vulnerable builds.
      version: 'n/a',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    };

    return reply.status(healthy ? 200 : 503).send(report);
  });

  /**
   * Prometheus-style metrics.
   *
   * Bound to the internal network only — it is never routed through Caddy (see the
   * Caddyfile: only /api, /rt and / are proxied), so it is reachable from other
   * containers and from the host, but not from the internet.
   */
  app.get('/metrics', async (_request, reply) => {
    const [users, activeSessions, pendingReports] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      prisma.report.count({ where: { status: 'PENDING' } }),
    ]);

    const online = await redis.client.scard(redis.keys.onlineSet()).catch(() => 0);

    const lines = [
      '# HELP trip2world_users_total Registered users',
      '# TYPE trip2world_users_total gauge',
      `trip2world_users_total ${users}`,
      '# HELP trip2world_sessions_active Active (non-revoked, unexpired) sessions',
      '# TYPE trip2world_sessions_active gauge',
      `trip2world_sessions_active ${activeSessions}`,
      '# HELP trip2world_users_online Users currently connected to a realtime node',
      '# TYPE trip2world_users_online gauge',
      `trip2world_users_online ${online}`,
      '# HELP trip2world_reports_pending Reports awaiting moderator review',
      '# TYPE trip2world_reports_pending gauge',
      `trip2world_reports_pending ${pendingReports}`,
      '# HELP trip2world_uptime_seconds Process uptime',
      '# TYPE trip2world_uptime_seconds counter',
      `trip2world_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    ];

    return reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });
}
