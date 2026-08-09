import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  createUser,
  dependenciesAvailable,
  registration,
  resetTestData,
  type TestContext,
} from './integration-setup.js';

/**
 * Authentication against a real database.
 *
 * The value over the unit tests is that these exercise the parts that only exist in
 * Postgres: unique constraints, transactional session revocation, and the token
 * generation counter actually invalidating previously-issued tokens.
 */

const available = await dependenciesAvailable();
const describeIntegration = available ? describe : describe.skip;

if (!available) {
  // Loud, so a green run is never mistaken for coverage that did not happen. This is the
  // one place a bare console call is the right tool: it has to reach the terminal even
  // when the whole suite is skipped and no logger exists yet.
  // eslint-disable-next-line no-console
  console.warn(
    '\n  [!] Integration tests SKIPPED — Postgres/Redis unreachable.' +
      '\n      Start them with: docker compose -f docker-compose.dev.yml up -d\n',
  );
}

describeIntegration('auth (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await resetTestData(ctx.prisma, ctx.redis);
    await ctx.close();
  });

  beforeEach(async () => {
    await resetTestData(ctx.prisma, ctx.redis);
  });

  describe('registration', () => {
    it('creates an account with profile, privacy and preference rows', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registration('reg1'),
      });

      expect(response.statusCode).toBe(201);

      const user = await ctx.prisma.user.findUnique({
        where: { email: 'user-reg1@integration.test' },
        include: { profile: true, privacy: true, preference: true },
      });

      // All three are created in the same transaction as the user; a missing one would
      // break matchmaking later with a confusing null error.
      expect(user?.profile).not.toBeNull();
      expect(user?.privacy).not.toBeNull();
      expect(user?.preference).not.toBeNull();
    });

    it('never stores the password in plaintext', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registration('reg2'),
      });

      const user = await ctx.prisma.user.findUnique({
        where: { email: 'user-reg2@integration.test' },
        select: { passwordHash: true },
      });

      expect(user?.passwordHash).toBeTruthy();
      expect(user?.passwordHash).not.toContain('a-perfectly-fine-passphrase');
      expect(user?.passwordHash?.startsWith('$argon2id$')).toBe(true);
    });

    it('rejects a duplicate email at the database level', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registration('dupe'),
      });

      const second = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { ...registration('dupe'), username: 'different_name' },
      });

      expect(second.statusCode).toBe(409);
      expect(await ctx.prisma.user.count({ where: { email: 'user-dupe@integration.test' } })).toBe(1);
    });

    it('rejects a duplicate username', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: registration('name1'),
      });

      const second = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          ...registration('name2'),
          username: registration('name1').username,
        },
      });

      expect(second.statusCode).toBe(409);
      expect(second.json().error.message).toMatch(/username/i);
    });

    it('refuses anyone under 18', async () => {
      const under = new Date();
      under.setUTCFullYear(under.getUTCFullYear() - 17);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { ...registration('minor'), birthDate: under.toISOString().slice(0, 10) },
      });

      expect(response.statusCode).toBe(400);
      expect(await ctx.prisma.user.count({ where: { email: 'user-minor@integration.test' } })).toBe(0);
    });

    it('refuses registration without accepting the terms', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { ...registration('noterms'), acceptedTerms: false },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('login', () => {
    it('returns a usable access token', async () => {
      const user = await createUser(ctx.app, 'login1');

      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: auth(user.token),
      });

      expect(me.statusCode).toBe(200);
      expect(me.json().data.email).toBe(user.email);
    });

    it('gives the same error for a wrong password and an unknown account', async () => {
      await createUser(ctx.app, 'enum1');

      const wrongPassword = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'user-enum1@integration.test', password: 'wrong-password-here' },
      });

      const unknownAccount = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nobody@integration.test', password: 'wrong-password-here' },
      });

      // Identical status AND identical message: anything else is an account-enumeration
      // oracle.
      expect(wrongPassword.statusCode).toBe(unknownAccount.statusCode);
      expect(wrongPassword.json().error.message).toBe(unknownAccount.json().error.message);
    });

    it('never returns the password hash', async () => {
      const user = await createUser(ctx.app, 'nohash');
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: auth(user.token),
      });

      expect(me.body).not.toContain('argon2');
      expect(me.body).not.toContain('passwordHash');
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new refresh token and invalidates the old one', async () => {
      const payload = registration('rot1');
      await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });

      // `client=native` returns the refresh token in the body rather than as a cookie,
      // which is what makes rotation observable here.
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login?client=native',
        payload: { email: payload.email, password: payload.password },
      });

      const first = login.json().data.tokens.refreshToken as string;
      expect(first).toBeTruthy();

      const refreshed = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh?client=native',
        payload: { refreshToken: first },
      });

      expect(refreshed.statusCode).toBe(200);
      const second = refreshed.json().data.tokens.refreshToken as string;
      expect(second).not.toBe(first);

      // The consumed token must no longer work.
      const replay = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh?client=native',
        payload: { refreshToken: first },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('revokes every session when a password is reset', async () => {
      const user = await createUser(ctx.app, 'revoke1');

      const sessionsBefore = await ctx.prisma.session.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(sessionsBefore).toBeGreaterThan(0);

      // Simulate a reset by bumping the generation the way the service does.
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { tokenGeneration: { increment: 1 } },
      });

      // The old access token carries a stale generation and must now be rejected.
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: auth(user.token),
      });
      expect(me.statusCode).toBe(401);
    });
  });

  describe('authorization', () => {
    it('refuses an unauthenticated request', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a forged token', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: auth('not.a.real.token'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('keeps a regular user out of every admin endpoint', async () => {
      const user = await createUser(ctx.app, 'notadmin');

      for (const url of [
        '/api/v1/admin/stats',
        '/api/v1/admin/reports',
        '/api/v1/admin/users',
        '/api/v1/admin/audit',
      ]) {
        const response = await ctx.app.inject({ method: 'GET', url, headers: auth(user.token) });
        expect(response.statusCode, `${url} should be forbidden`).toBe(403);
      }
    });

    it('refuses a banned account even with a valid token', async () => {
      const user = await createUser(ctx.app, 'banned1');

      await ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'BANNED' } });

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: auth(user.token),
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
