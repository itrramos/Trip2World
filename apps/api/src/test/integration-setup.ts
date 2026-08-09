import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { createRedisKeys } from '@trip2world/shared';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { buildServer } from '../server.js';

/**
 * Harness for tests that run against a REAL Postgres and Redis.
 *
 * These exist because the unit tests cannot prove the things that actually break in
 * production: that a conditional UPDATE really is atomic under concurrent transactions,
 * that a unique constraint really does reject a duplicate, that a cascade really deletes
 * what we think it does. A mock will agree with whatever the code assumes; Postgres will
 * not.
 *
 * Requests go through `app.inject()` rather than a socket, so the full Fastify pipeline —
 * content parsing, auth plugin, rate limits, error serialisation — is exercised without
 * binding a port.
 *
 * Start the dependencies with:
 *   docker compose -f docker-compose.dev.yml up -d
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://trip2world:trip2world_dev@localhost:5432/trip2world?schema=public';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Whether the dependencies are reachable.
 *
 * Checked once so the suite can skip loudly rather than failing with a connection error
 * that looks like a broken test. A skipped integration suite must be obvious — silently
 * passing would be worse than failing.
 */
export async function dependenciesAvailable(): Promise<boolean> {
  const redis = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await redis.connect();
    await redis.ping();
    await redis.quit();
  } catch {
    redis.disconnect();
    return false;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  redis: Redis;
  close(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    APP_URL: 'http://localhost:3000',
    APP_DOMAIN: 'localhost',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    // Distinct, valid secrets — the config validator rejects reuse and short values.
    JWT_SECRET: 'test-jwt-secret-'.padEnd(48, 'a'),
    SESSION_SECRET: 'test-session-secret-'.padEnd(48, 'b'),
    IP_HASH_SALT: 'test-ip-salt-'.padEnd(48, 'c'),
    TURN_SECRET: 'test-turn-secret-'.padEnd(48, 'd'),
    MAIL_TRANSPORT: 'log',
    // Keeps registration usable without an SMTP server.
    REQUIRE_EMAIL_VERIFICATION: 'false',
  });

  const logger = createLogger(config);
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const redisClient = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });

  const app = await buildServer({
    config,
    logger,
    prisma,
    redis: { client: redisClient, keys: createRedisKeys('t2w-test') },
  });
  await app.ready();

  return {
    app,
    prisma,
    redis: redisClient,
    async close() {
      await app.close();
      await redisClient.quit();
      await prisma.$disconnect();
    },
  };
}

/**
 * Remove everything this suite created.
 *
 * Deletes by pattern rather than truncating: a developer running these against their dev
 * database should not lose their own account. Ordered so foreign keys are satisfied
 * without relying on cascade behaviour we might later change.
 */
export async function resetTestData(prisma: PrismaClient, redis: Redis): Promise<void> {
  const testUsers = await prisma.user.findMany({
    where: { email: { endsWith: '@integration.test' } },
    select: { id: true },
  });
  const ids = testUsers.map((u) => u.id);

  if (ids.length > 0) {
    await prisma.tokenLedger.deleteMany({ where: { userId: { in: ids } } });
    await prisma.tokenAccount.deleteMany({ where: { userId: { in: ids } } });
    await prisma.tip.deleteMany({ where: { OR: [{ fromUserId: { in: ids } }, { toUserId: { in: ids } }] } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: ids } }, { reportedUserId: { in: ids } }] } });
    await prisma.block.deleteMany({ where: { OR: [{ blockerId: { in: ids } }, { blockedUserId: { in: ids } }] } });
    await prisma.ban.deleteMany({ where: { OR: [{ userId: { in: ids } }, { issuedById: { in: ids } }] } });
    await prisma.moderationAction.deleteMany({
      where: { OR: [{ targetUserId: { in: ids } }, { moderatorId: { in: ids } }] },
    });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  // Rate-limit counters persist between tests and would make later runs fail with 429.
  const keys = await redis.keys('t2w-test:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** A registration payload that satisfies every validation rule. */
export function registration(suffix: string) {
  return {
    email: `user-${suffix}@integration.test`,
    username: `user_${suffix}`.toLowerCase().slice(0, 24),
    password: 'a-perfectly-fine-passphrase',
    confirmPassword: 'a-perfectly-fine-passphrase',
    birthDate: '1995-06-15',
    country: 'PT',
    locale: 'en',
    languages: ['pt', 'en'],
    acceptedTerms: true,
    acceptedGuidelines: true,
  };
}

/** Register and sign in, returning the bearer token and user id. */
export async function createUser(
  app: FastifyInstance,
  suffix: string,
): Promise<{ id: string; token: string; email: string }> {
  const payload = registration(suffix);

  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload,
  });
  if (registered.statusCode !== 201) {
    throw new Error(`Registration failed: ${registered.statusCode} ${registered.body}`);
  }

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: payload.email, password: payload.password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`Login failed: ${login.statusCode} ${login.body}`);
  }

  const body = login.json() as { data: { user: { id: string }; tokens: { accessToken: string } } };
  return { id: body.data.user.id, token: body.data.tokens.accessToken, email: payload.email };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * Register a user, give them a staff role, then sign in.
 *
 * The role is embedded in the access token, so the promotion has to happen before the
 * login that mints it — a token issued as USER stays a USER token no matter what the
 * database says afterwards.
 */
export async function createStaffUser(
  app: FastifyInstance,
  prisma: PrismaClient,
  suffix: string,
  role: 'MODERATOR' | 'ADMIN' | 'SUPER_ADMIN',
): Promise<{ id: string; token: string; email: string }> {
  const payload = registration(suffix);

  const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });
  if (registered.statusCode !== 201) {
    throw new Error(`Registration failed: ${registered.statusCode} ${registered.body}`);
  }

  await prisma.user.update({ where: { email: payload.email }, data: { role } });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: payload.email, password: payload.password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`Login failed: ${login.statusCode} ${login.body}`);
  }

  const body = login.json() as { data: { user: { id: string }; tokens: { accessToken: string } } };
  return { id: body.data.user.id, token: body.data.tokens.accessToken, email: payload.email };
}
