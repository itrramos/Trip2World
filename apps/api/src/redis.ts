import { createRedisKeys, type RedisKeyBuilder } from '@trip2world/shared';
import { Redis } from 'ioredis';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { TIMEOUTS, withTimeout } from './utils/timeout.js';

/**
 * Redis client and the shared key builder.
 *
 * Note the retry policy: `maxRetriesPerRequest: null` plus a bounded reconnect. The
 * ioredis default of failing a command after 20 retries turns a brief Redis blip into a
 * wave of 500s; queueing until the connection is back means a restart of Redis is a
 * latency spike rather than an outage. Commands still fail fast if the client has given
 * up entirely.
 */

export interface RedisContext {
  client: Redis;
  keys: RedisKeyBuilder;
}

export function createRedis(config: AppConfig, logger: Logger): RedisContext {
  const client = new Redis(config.REDIS_URL, {
    // Let commands wait through a reconnect instead of erroring immediately.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Fail fast on a genuinely unreachable host rather than hanging a request.
    connectTimeout: 5_000,
    lazyConnect: false,

    retryStrategy(attempt) {
      // Exponential-ish with a ceiling, so a long outage does not spin the CPU.
      const delay = Math.min(attempt * 200, 5_000);
      return delay;
    },

    reconnectOnError(error) {
      // READONLY happens on a failover to a replica; reconnecting picks up the new
      // primary rather than serving errors until a restart.
      return error.message.includes('READONLY');
    },
  });

  client.on('error', (error: Error) => {
    // Do not log the URL — it contains the password.
    logger.error({ err: error }, 'Redis connection error');
  });

  client.on('reconnecting', () => logger.warn('Redis reconnecting'));
  client.on('ready', () => logger.info('Redis ready'));

  return { client, keys: createRedisKeys(config.REDIS_PREFIX) };
}

/** Liveness probe for `/ready`. */
export async function checkRedis(client: Redis): Promise<boolean> {
  try {
    const pong = await client.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/**
 * Fixed-window counter.
 *
 * INCR + conditional EXPIRE in a single pipeline so the two cannot interleave with
 * another request and leave a key without a TTL — which would permanently lock out that
 * identity until someone noticed a stuck counter in Redis.
 *
 * A sliding window would be more precise at the boundary, but a fixed window is O(1) in
 * memory and the burst it permits (2x at a window edge) is acceptable for the limits
 * Trip2World enforces. Where burst matters more than throughput — login, registration —
 * the window is deliberately long.
 */
export async function consumeRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const pipeline = redis.multi();
  pipeline.incr(key);
  // NX: only set the TTL when the key was just created, so a burst cannot keep
  // extending the window and lock the identity out indefinitely.
  pipeline.expire(key, windowSeconds, 'NX');
  pipeline.ttl(key);

  /**
   * Fail OPEN, and fail *fast*.
   *
   * The client is configured with `maxRetriesPerRequest: null`, which lets commands ride
   * out a brief reconnect instead of erroring — good for correctness, but it means a
   * genuinely down Redis makes this promise hang forever rather than reject. Without the
   * deadline below, every rate-limited route (login, register, password reset) would
   * block indefinitely and Redis would become a hard dependency of the entire API.
   *
   * Allowing traffic through an unavailable limiter is the right trade: throttling
   * degrades, but authentication and authorization still fail closed independently.
   */
  let results: [Error | null, unknown][] | null = null;
  try {
    results = await withTimeout(pipeline.exec(), TIMEOUTS.redis, 'rate-limit');
  } catch {
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }

  if (!results) {
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }

  const count = Number(results[0]?.[1] ?? 0);
  const ttl = Number(results[2]?.[1] ?? windowSeconds);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: ttl > 0 ? ttl : windowSeconds,
  };
}
