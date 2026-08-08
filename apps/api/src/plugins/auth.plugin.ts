import { verifyAccessToken } from '@trip2world/auth';
import { REDIS_TTL } from '@trip2world/shared';
import { ROLE_HIERARCHY, type UserRole } from '@trip2world/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Errors } from '../errors.js';

/**
 * Request authentication and authorization.
 *
 * An access token is stateless, so verifying the signature is not enough on its own —
 * three additional checks close the gap between "this token was validly issued" and
 * "this token should still work right now":
 *
 *   1. `gen` must match the user's current `tokenGeneration`. A password change bumps
 *      the counter and instantly invalidates every token issued before it.
 *   2. The session id must not be in the Redis revocation set, which covers a forced
 *      logout inside the token's remaining lifetime.
 *   3. The account must not be banned or suspended.
 *
 * Checks 1 and 3 need one indexed lookup by user id. That is the price of being able to
 * revoke access in under 15 minutes, and it is deliberate: a purely stateless check
 * would mean a banned user keeps full access until their token happens to expire.
 */

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  plan: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
  interface FastifyInstance {
    /** Rejects unauthenticated requests. Use as an `onRequest` hook. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Populates `request.user` when a valid token is present, but never rejects. */
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Rejects anyone below `role` in the privilege ladder. */
    requireRole: (
      role: UserRole,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  // Case-insensitive scheme, exactly one space, non-empty credential.
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  const { config, prisma, redis } = app;

  async function resolveUser(token: string): Promise<AuthenticatedUser> {
    const result = await verifyAccessToken(token, { secret: config.JWT_SECRET });

    if (!result.valid) {
      throw result.reason === 'EXPIRED'
        ? Errors.tokenExpired('Your session has expired.')
        : Errors.unauthenticated({ reason: result.reason });
    }

    const claims = result.claims;

    // Forced-logout denylist. Checked before the database so a revoked session is
    // rejected without a query.
    const revoked = await redis.client.exists(redis.keys.revokedSession(claims.sid));
    if (revoked) throw Errors.unauthenticated({ reason: 'SESSION_REVOKED' });

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        role: true,
        plan: true,
        status: true,
        tokenGeneration: true,
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt) throw Errors.unauthenticated({ reason: 'NO_USER' });

    // Token predates a password change or forced logout.
    if (user.tokenGeneration !== claims.gen) {
      throw Errors.unauthenticated({ reason: 'STALE_GENERATION' });
    }

    if (user.status === 'BANNED') {
      throw Errors.accountBanned('Contact support if you believe this is a mistake.');
    }
    if (user.status === 'SUSPENDED') {
      throw Errors.accountSuspended('Your account is temporarily restricted.', null);
    }
    if (user.status === 'DEACTIVATED') {
      throw Errors.unauthenticated({ reason: 'DEACTIVATED' });
    }

    return {
      id: user.id,
      role: user.role as UserRole,
      plan: user.plan,
      sessionId: claims.sid,
    };
  }

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = extractBearerToken(request);
    if (!token) throw Errors.unauthenticated({ reason: 'NO_TOKEN' });
    request.user = await resolveUser(token);
  });

  /**
   * Best-effort authentication for endpoints that behave differently when signed in
   * (the landing page, public profile lookups). A malformed or expired token is treated
   * as "not signed in" rather than an error, because the endpoint is valid either way.
   */
  app.decorate('optionalAuth', async (request: FastifyRequest) => {
    const token = extractBearerToken(request);
    if (!token) return;
    try {
      request.user = await resolveUser(token);
    } catch {
      request.user = undefined;
    }
  });

  app.decorate('requireRole', (role: UserRole) => {
    const requiredRank = ROLE_HIERARCHY.indexOf(role);

    return async (request: FastifyRequest) => {
      if (!request.user) throw Errors.unauthenticated({ reason: 'NO_TOKEN' });

      const actualRank = ROLE_HIERARCHY.indexOf(request.user.role);
      if (actualRank < 0 || actualRank < requiredRank) {
        // Log the attempt: a non-admin reaching an admin route is either a bug or
        // probing, and both are worth seeing.
        request.log.warn(
          { userId: request.user.id, role: request.user.role, required: role, url: request.url },
          'Authorization denied',
        );
        throw Errors.forbidden();
      }
    };
  });

  /** Revoke a session immediately, for the remainder of its access token's lifetime. */
  app.decorate('revokeSession', async (sessionId: string) => {
    await redis.client.set(redis.keys.revokedSession(sessionId), '1', 'EX', REDIS_TTL.revokedSession);
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    revokeSession: (sessionId: string) => Promise<void>;
  }
}
