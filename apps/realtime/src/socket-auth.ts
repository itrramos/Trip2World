import type { PrismaClient } from '@prisma/client';
import { verifyAccessToken } from '@trip2world/auth';
import type { RedisKeyBuilder } from '@trip2world/shared';
import { RealtimeErrorCode, type SocketData } from '@trip2world/types';
import type { Redis } from 'ioredis';
import type { Socket } from 'socket.io';
import type { RealtimeConfig } from './config.js';

/**
 * WebSocket authentication.
 *
 * Applied as a connection-time middleware, so an unauthenticated socket is rejected
 * during the handshake and never reaches an event handler. The alternative — accepting
 * the connection and checking on the first event — leaves an open socket that can be used
 * to consume memory and connection slots without any credential at all.
 *
 * The token is read from the handshake `auth` payload rather than a query string:
 * query strings are logged by proxies and appear in browser history, and an access token
 * in either place is a credential leak.
 *
 * The same three post-signature checks the HTTP API performs apply here — generation,
 * revocation, and account status — because a socket may live far longer than the token
 * that opened it.
 */

export class SocketAuthError extends Error {
  constructor(
    public readonly code: RealtimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SocketAuthError';
  }
}

export interface SocketAuthDeps {
  config: RealtimeConfig;
  prisma: PrismaClient;
  redis: Redis;
  keys: RedisKeyBuilder;
  nodeId: string;
}

export async function authenticateSocket(
  socket: Socket,
  deps: SocketAuthDeps,
): Promise<SocketData> {
  const { config, prisma, redis, keys, nodeId } = deps;

  const handshakeAuth = socket.handshake.auth as { token?: unknown } | undefined;
  const token = typeof handshakeAuth?.token === 'string' ? handshakeAuth.token : null;

  if (!token) {
    throw new SocketAuthError(RealtimeErrorCode.UNAUTHENTICATED, 'Missing access token');
  }

  const result = await verifyAccessToken(token, { secret: config.JWT_SECRET });
  if (!result.valid) {
    throw new SocketAuthError(
      RealtimeErrorCode.UNAUTHENTICATED,
      result.reason === 'EXPIRED' ? 'Access token expired' : 'Invalid access token',
    );
  }

  const claims = result.claims;

  // Forced logout inside the token's remaining lifetime.
  if (await redis.exists(keys.revokedSession(claims.sid))) {
    throw new SocketAuthError(RealtimeErrorCode.UNAUTHENTICATED, 'Session revoked');
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      username: true,
      role: true,
      plan: true,
      status: true,
      emailVerified: true,
      tokenGeneration: true,
      deletedAt: true,
    },
  });

  if (!user || user.deletedAt) {
    throw new SocketAuthError(RealtimeErrorCode.UNAUTHENTICATED, 'Account not found');
  }

  // Token predates a password change or a forced logout.
  if (user.tokenGeneration !== claims.gen) {
    throw new SocketAuthError(RealtimeErrorCode.UNAUTHENTICATED, 'Session is no longer valid');
  }

  if (user.status === 'BANNED' || user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
    throw new SocketAuthError(
      RealtimeErrorCode.ACCOUNT_RESTRICTED,
      'Your account is currently restricted.',
    );
  }

  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    plan: user.plan,
    matchId: null,
    nodeId,
    connectedAt: Date.now(),
  };
}

/**
 * Re-check an established socket's account status.
 *
 * A socket can outlive the moderation action that should have ended it — someone banned
 * mid-conversation would otherwise keep talking until they happened to disconnect. This
 * runs periodically and on entry to matchmaking, which are the two moments where letting
 * a restricted account continue actually causes harm.
 */
export async function revalidateSocket(
  userId: string,
  prisma: PrismaClient,
): Promise<{ ok: true } | { ok: false; status: 'SUSPENDED' | 'BANNED'; reason: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, deletedAt: true },
  });

  if (!user || user.deletedAt) {
    return { ok: false, status: 'BANNED', reason: 'Account no longer exists.' };
  }

  if (user.status === 'BANNED') {
    return { ok: false, status: 'BANNED', reason: 'Your account has been restricted.' };
  }
  if (user.status === 'SUSPENDED') {
    return { ok: false, status: 'SUSPENDED', reason: 'Your account is temporarily restricted.' };
  }

  return { ok: true };
}
