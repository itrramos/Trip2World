import { hashIp } from '@trip2world/auth';
import { type RateLimitRule } from '@trip2world/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Errors } from '../errors.js';
import { consumeRateLimit } from '../redis.js';

/**
 * Per-route rate limiting.
 *
 * Two properties matter here:
 *
 * **Keying.** An authenticated request is limited per user; an anonymous one per hashed
 * client IP. Keying purely on IP would let one abusive account hop networks freely, and
 * keying purely on user id would leave the pre-login endpoints — exactly the ones worth
 * attacking — unprotected.
 *
 * **The client IP must be real.** Behind Cloudflare every request arrives from the proxy,
 * so without `TRUST_PROXY` and Fastify's `trustProxy` the limiter would bucket the entire
 * internet into one counter and either throttle everyone or nobody.
 */

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit: (
      bucket: string,
      rule: RateLimitRule,
      options?: { keyBy?: 'ip' | 'user' | 'both'; identity?: (req: FastifyRequest) => string },
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  const { config, redis } = app;

  const clientIdentity = (request: FastifyRequest, keyBy: 'ip' | 'user' | 'both'): string => {
    // `request.ip` already honours X-Forwarded-For when trustProxy is configured.
    const ipKey = hashIp(request.ip, config.IP_HASH_SALT);
    const userId = request.user?.id;

    if (keyBy === 'user') return userId ? `u:${userId}` : `ip:${ipKey}`;
    if (keyBy === 'ip') return `ip:${ipKey}`;
    // 'both': prefer the account when known, since it survives a network change.
    return userId ? `u:${userId}` : `ip:${ipKey}`;
  };

  app.decorate(
    'rateLimit',
    (
      bucket: string,
      rule: RateLimitRule,
      options: { keyBy?: 'ip' | 'user' | 'both'; identity?: (req: FastifyRequest) => string } = {},
    ) => {
      const keyBy = options.keyBy ?? 'both';

      return async (request: FastifyRequest, reply: FastifyReply) => {
        const identity = options.identity
          ? options.identity(request)
          : clientIdentity(request, keyBy);

        const result = await consumeRateLimit(
          redis.client,
          redis.keys.rateLimit(bucket, identity),
          rule.limit,
          rule.windowSeconds,
        );

        // Advertise the budget so a well-behaved client can back off before being told to.
        reply.header('X-RateLimit-Limit', rule.limit);
        reply.header('X-RateLimit-Remaining', result.remaining);

        if (!result.allowed) {
          reply.header('Retry-After', result.retryAfter);
          request.log.warn({ bucket, identity, url: request.url }, 'Rate limit exceeded');
          throw Errors.rateLimited(result.retryAfter);
        }
      };
    },
  );
});
