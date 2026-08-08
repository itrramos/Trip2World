import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, safeCompare, verifyPassword } from './password.js';
import {
  AccessTokenError,
  generateOneTimeToken,
  generateRefreshToken,
  hashOneTimeToken,
  hashIp,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
} from './tokens.js';
import { buildIceServers, createTurnCredential } from './turn.js';

const SECRET = 'a'.repeat(48);
const CONFIG = { secret: SECRET };

describe('password hashing', () => {
  it('produces a verifiable argon2id hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('salts, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('flags a legacy hash for upgrade but not a current one', async () => {
    expect(needsRehash(await hashPassword('x'.repeat(12)))).toBe(false);
    // A bcrypt hash from a hypothetical migration is unparseable by argon2 -> rehash.
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });
});

describe('safeCompare', () => {
  it('matches identical strings and rejects others', () => {
    expect(safeCompare('token-abc', 'token-abc')).toBe(true);
    expect(safeCompare('token-abc', 'token-abd')).toBe(false);
  });

  it('returns false on length mismatch without throwing', () => {
    expect(safeCompare('short', 'much-longer-value')).toBe(false);
  });

  it('handles empty input', () => {
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('', 'x')).toBe(false);
  });
});

describe('access tokens', () => {
  const claims = {
    userId: '11111111-1111-4111-8111-111111111111',
    role: 'USER',
    plan: 'FREE',
    sessionId: '22222222-2222-4222-8222-222222222222',
    tokenGeneration: 3,
  };

  it('round-trips the claims it was issued with', async () => {
    const { token, expiresIn } = await issueAccessToken(claims, CONFIG);
    expect(expiresIn).toBe(15 * 60);

    const result = await verifyAccessToken(token, CONFIG);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.claims.sub).toBe(claims.userId);
    expect(result.claims.sid).toBe(claims.sessionId);
    expect(result.claims.gen).toBe(3);
    expect(result.claims.role).toBe('USER');
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await issueAccessToken(claims, CONFIG);
    const result = await verifyAccessToken(token, { secret: 'b'.repeat(48) });
    expect(result).toEqual({ valid: false, reason: AccessTokenError.INVALID });
  });

  it('rejects a tampered payload', async () => {
    const { token } = await issueAccessToken(claims, CONFIG);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    decoded.role = 'SUPER_ADMIN';
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    const result = await verifyAccessToken(forged, CONFIG);
    expect(result.valid).toBe(false);
  });

  it('reports expiry distinctly from other failures, so clients refresh instead of re-logging in', async () => {
    const { token } = await issueAccessToken(claims, { ...CONFIG, accessTtlSeconds: -10 });
    const result = await verifyAccessToken(token, CONFIG);
    expect(result).toEqual({ valid: false, reason: AccessTokenError.EXPIRED });
  });

  it('rejects a token issued for a different audience or issuer', async () => {
    const { token } = await issueAccessToken(claims, { ...CONFIG, audience: 'somewhere-else' });
    expect((await verifyAccessToken(token, CONFIG)).valid).toBe(false);
  });

  it('refuses to sign with a weak secret', async () => {
    await expect(issueAccessToken(claims, { secret: 'too-short' })).rejects.toThrow(/at least 32/);
  });

  it('rejects the "alg: none" downgrade', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: claims.userId,
        sid: claims.sessionId,
        gen: 0,
        role: 'SUPER_ADMIN',
        iss: 'trip2world',
        aud: 'trip2world-app',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    expect((await verifyAccessToken(`${header}.${payload}.`, CONFIG)).valid).toBe(false);
  });
});

describe('refresh tokens', () => {
  it('generates high-entropy, non-repeating values', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateRefreshToken()));
    expect(tokens.size).toBe(500);
    expect(generateRefreshToken().length).toBeGreaterThanOrEqual(42);
  });

  it('hashes deterministically, and the hash does not contain the token', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toContain(token);
    expect(hashRefreshToken(token)).toHaveLength(64);
  });

  it('gives different hashes to different tokens', () => {
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(
      hashRefreshToken(generateRefreshToken()),
    );
  });
});

describe('one-time tokens', () => {
  it('returns a raw token plus its stored hash, and rehashing the raw value matches', () => {
    const { token, tokenHash } = generateOneTimeToken();
    expect(hashOneTimeToken(token)).toBe(tokenHash);
    expect(tokenHash).not.toBe(token);
  });
});

describe('hashIp', () => {
  it('is stable for the same address and salt', () => {
    expect(hashIp('203.0.113.7', 'salt')).toBe(hashIp('203.0.113.7', 'salt'));
  });

  it('is unlinkable across deployments with different salts', () => {
    expect(hashIp('203.0.113.7', 'salt-a')).not.toBe(hashIp('203.0.113.7', 'salt-b'));
  });

  it('is truncated, so it cannot serve as a precise device identifier', () => {
    expect(hashIp('203.0.113.7', 'salt')).toHaveLength(16);
  });

  it('does not contain the original address', () => {
    expect(hashIp('203.0.113.7', 'salt')).not.toContain('203');
  });
});

describe('TURN credentials', () => {
  const turnConfig = {
    secret: 's'.repeat(48),
    host: 'turn.trip2fun.com',
    port: 3478,
    tlsPort: 5349,
  };

  it('derives the credential exactly as coturn recomputes it', () => {
    const { username, credential } = createTurnCredential('user-1', turnConfig);

    // This is coturn's own verification, reimplemented: HMAC-SHA1 over the username.
    const expected = createHmac('sha1', turnConfig.secret).update(username).digest('base64');
    expect(credential).toBe(expected);
  });

  it('embeds an expiry timestamp and the user id in the username', () => {
    const { username, expiresAt } = createTurnCredential('user-1', turnConfig);
    const [expiry, userId] = username.split(':');

    expect(userId).toBe('user-1');
    expect(Number(expiry) * 1000).toBe(expiresAt.getTime());
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('expires within the documented two-hour window', () => {
    const { expiresAt } = createTurnCredential('user-1', turnConfig);
    const hoursOut = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(1.9);
    expect(hoursOut).toBeLessThanOrEqual(2.01);
  });

  it('never returns the shared secret to the caller', () => {
    const credential = createTurnCredential('user-1', turnConfig);
    expect(JSON.stringify(credential)).not.toContain(turnConfig.secret);
  });

  it('refuses a weak TURN secret', () => {
    expect(() => createTurnCredential('user-1', { ...turnConfig, secret: 'short' })).toThrow(
      /at least 32/,
    );
  });

  it('offers STUN before TURN, and TCP alongside UDP for UDP-blocked networks', () => {
    const servers = buildIceServers('user-1', { ...turnConfig, enableTcp: true, enableTls: true });

    expect(String(servers[0]!.urls)).toContain('stun:');
    const turnUrls = servers[1]!.urls as string[];
    expect(turnUrls.some((u) => u.includes('transport=udp'))).toBe(true);
    expect(turnUrls.some((u) => u.includes('transport=tcp'))).toBe(true);
    expect(turnUrls.some((u) => u.startsWith('turns:'))).toBe(true);
  });

  it('attaches credentials to the TURN entry but not to STUN', () => {
    const servers = buildIceServers('user-1', turnConfig);
    expect(servers[0]!.username).toBeUndefined();
    expect(servers[1]!.username).toBeDefined();
    expect(servers[1]!.credential).toBeDefined();
  });
});
