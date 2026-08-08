import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '@trip2world/shared';
import type { AccessTokenClaims, RefreshTokenClaims } from '@trip2world/types';
import { errors, jwtVerify, SignJWT } from 'jose';

/**
 * Token issuing and verification.
 *
 * Access tokens are stateless and short-lived (15 min) so the realtime server can
 * authenticate a socket without a database round trip. Refresh tokens are long-lived,
 * stored only as a SHA-256 hash, and rotate on every use.
 *
 * Revocation works on three levels, deliberately:
 *   1. Session delete   — logs out one device.
 *   2. tokenGeneration  — bumped on password change; invalidates every access token for
 *                         the account at once, with no per-token denylist to maintain.
 *   3. Redis denylist   — covers the < 15 min window between a forced logout and natural
 *                         access-token expiry.
 */

export const TOKEN_ISSUER = 'trip2world';
export const TOKEN_AUDIENCE = 'trip2world-app';

export interface TokenConfig {
  /** Signing secret. Must be at least 32 bytes of entropy. */
  secret: string;
  issuer?: string;
  audience?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}

function keyFrom(secret: string): Uint8Array {
  if (secret.length < 32) {
    throw new Error('JWT secret must be at least 32 characters. Generate one with `pnpm secrets:generate`.');
  }
  return new TextEncoder().encode(secret);
}

export interface IssueAccessTokenInput {
  userId: string;
  role: string;
  plan: string;
  sessionId: string;
  tokenGeneration: number;
}

export async function issueAccessToken(
  input: IssueAccessTokenInput,
  config: TokenConfig,
): Promise<{ token: string; expiresIn: number }> {
  const ttl = config.accessTtlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    role: input.role,
    plan: input.plan,
    sid: input.sessionId,
    gen: input.tokenGeneration,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setIssuer(config.issuer ?? TOKEN_ISSUER)
    .setAudience(config.audience ?? TOKEN_AUDIENCE)
    .sign(keyFrom(config.secret));

  return { token, expiresIn: ttl };
}

export const AccessTokenError = {
  EXPIRED: 'EXPIRED',
  INVALID: 'INVALID',
} as const;
export type AccessTokenError = (typeof AccessTokenError)[keyof typeof AccessTokenError];

export type VerifyResult<T> =
  | { valid: true; claims: T }
  | { valid: false; reason: AccessTokenError };

/**
 * Verify an access token's signature, issuer, audience and expiry.
 *
 * Expiry is reported separately from every other failure because the client's reaction
 * differs: an expired token should trigger a silent refresh, anything else should force a
 * re-login. Conflating them causes refresh loops.
 */
export async function verifyAccessToken(
  token: string,
  config: TokenConfig,
): Promise<VerifyResult<AccessTokenClaims>> {
  try {
    const { payload } = await jwtVerify(token, keyFrom(config.secret), {
      issuer: config.issuer ?? TOKEN_ISSUER,
      audience: config.audience ?? TOKEN_AUDIENCE,
      algorithms: ['HS256'],
    });

    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.gen !== 'number'
    ) {
      return { valid: false, reason: AccessTokenError.INVALID };
    }

    return { valid: true, claims: payload as unknown as AccessTokenClaims };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { valid: false, reason: AccessTokenError.EXPIRED };
    }
    return { valid: false, reason: AccessTokenError.INVALID };
  }
}

/* -------------------------------------------------------------------------- */
/* Refresh tokens                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Refresh tokens are opaque random strings, not JWTs.
 *
 * They are only ever presented to our own token endpoint, so there is nothing to gain
 * from making them self-describing — and a JWT would leak the user id and session id to
 * anyone who reads the cookie. 32 bytes of CSPRNG output, base64url-encoded.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 of the token, which is what goes in the database.
 *
 * A slow KDF is unnecessary here and would be actively harmful: the token is already
 * 256 bits of uniform randomness, so there is no brute-forceable structure, and refresh
 * happens on every session — paying Argon2 cost per refresh would be a self-inflicted DoS.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateSessionId(): string {
  return randomUUID();
}

export function refreshTokenExpiry(ttlSeconds = REFRESH_TOKEN_TTL_SECONDS): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}

/* -------------------------------------------------------------------------- */
/* Single-use tokens (email verification, password reset)                      */
/* -------------------------------------------------------------------------- */

/**
 * Generate a one-time token: the raw value is emailed to the user, only its hash is
 * stored. A database leak therefore cannot be used to mint a password reset.
 */
export function generateOneTimeToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

export function hashOneTimeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* IP hashing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Salted, truncated hash of a client IP.
 *
 * Trip2World never stores raw IP addresses. The hash is enough to correlate abuse
 * (registration flooding, ban evasion) but is not reversible to an address, and
 * truncating to 16 hex characters deliberately allows collisions so it cannot be used as
 * a unique device identifier. The salt must be deployment-specific and secret; without
 * it, the small IPv4 space would be trivially brute-forced back to plaintext.
 */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}
