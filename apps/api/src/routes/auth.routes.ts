import { RATE_LIMITS, REFRESH_TOKEN_TTL_SECONDS } from '@trip2world/shared';
import {
  changePasswordSchema,
  deleteAccountSchema,
  loginSchema,
  parseInput,
  registerSchema,
  requestPasswordResetSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@trip2world/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, Errors } from '../errors.js';

/**
 * Authentication endpoints.
 *
 * Cookie strategy: the refresh token goes to web clients as an HttpOnly, Secure,
 * SameSite=Strict cookie scoped to `/api/v1/auth`, so JavaScript can never read it and
 * XSS cannot exfiltrate a long-lived credential. Native clients have no cookie jar and
 * receive it in the response body instead, identified by an explicit `client=native`
 * query parameter rather than by sniffing the User-Agent.
 */

const REFRESH_COOKIE = 't2w_rt';

function isNativeClient(request: FastifyRequest): boolean {
  return (request.query as { client?: string } | undefined)?.client === 'native';
}

function setRefreshCookie(reply: FastifyReply, token: string, isProduction: boolean): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
    signed: false,
  });
}

function clearRefreshCookie(reply: FastifyReply, isProduction: boolean): void {
  reply.setCookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: 0,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { config, services, prisma } = app;

  const sessionContext = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  });

  /* ------------------------------------------------------------------ */
  /* Register                                                            */
  /* ------------------------------------------------------------------ */

  app.post(
    '/register',
    { onRequest: [app.rateLimit('register', RATE_LIMITS.register, { keyBy: 'ip' })] },
    async (request, reply) => {
      const parsed = parseInput(registerSchema, request.body, request.id);
      if (!parsed.success) throw new AppError(parsed.error.code, parsed.error.message, {
        details: parsed.error.details,
      });

      const settings = await services.settings.get();
      const result = await services.auth.register(parsed.data, settings, sessionContext(request));

      if (result.verificationToken) {
        // Fire and forget — a slow SMTP handshake must not delay the response.
        void services.mail.sendVerificationEmail(parsed.data.email, result.verificationToken);
      }

      /**
       * Promotional grants, when there is nothing left to wait for.
       *
       * On a deployment with verification enabled this does nothing — every campaign
       * defaults to `requiresVerifiedEmail`, so the grant happens at /verify-email
       * instead. With verification disabled the account is usable immediately and this
       * is the only moment it becomes eligible.
       *
       * `applyEligible` never throws. A promotion must not be able to fail a signup.
       */
      const granted = await services.campaigns.applyEligible(result.userId);

      return reply.status(201).send({
        ok: true,
        data: {
          userId: result.userId,
          requiresVerification: result.requiresVerification,
          message: result.requiresVerification
            ? 'Account created. Check your email to confirm your address.'
            : 'Account created.',
          grants: granted,
        },
      });
    },
  );

  /* ------------------------------------------------------------------ */
  /* Login                                                               */
  /* ------------------------------------------------------------------ */

  app.post(
    '/login',
    { onRequest: [app.rateLimit('login', RATE_LIMITS.login, { keyBy: 'ip' })] },
    async (request, reply) => {
      const parsed = parseInput(loginSchema, request.body, request.id);
      if (!parsed.success) throw Errors.invalidCredentials();

      const result = await services.auth.login(
        parsed.data.email,
        parsed.data.password,
        sessionContext(request),
      );

      /**
       * Sign-in is where an ALL_USERS campaign reaches an existing account.
       *
       * The alternative — a worker that backfills every user the moment a campaign goes
       * live — would write to hundreds of thousands of rows for people who may never
       * come back. Granting lazily costs one indexed lookup per login and only pays out
       * to accounts that actually return, which is also the behaviour an operator
       * running a "come back" promotion actually wants.
       */
      const granted = await services.campaigns.applyEligible(result.userId);
      const user = await loadSelf(app, result.userId);

      if (isNativeClient(request)) {
        return reply.send({
          ok: true,
          data: {
            user,
            tokens: { ...result.tokens, refreshToken: result.refreshToken },
            grants: granted,
          },
        });
      }

      setRefreshCookie(reply, result.refreshToken, config.isProduction);
      return reply.send({ ok: true, data: { user, tokens: result.tokens, grants: granted } });
    },
  );

  /* ------------------------------------------------------------------ */
  /* Refresh                                                             */
  /* ------------------------------------------------------------------ */

  app.post('/refresh', async (request, reply) => {
    const fromCookie = request.cookies[REFRESH_COOKIE];
    const fromBody = (request.body as { refreshToken?: string } | undefined)?.refreshToken;
    const token = fromCookie ?? fromBody;

    if (!token) throw Errors.unauthenticated({ reason: 'NO_REFRESH_TOKEN' });

    try {
      const result = await services.auth.refresh(token, sessionContext(request));

      if (isNativeClient(request) || (!fromCookie && fromBody)) {
        return reply.send({
          ok: true,
          data: { tokens: { ...result.tokens, refreshToken: result.refreshToken } },
        });
      }

      setRefreshCookie(reply, result.refreshToken, config.isProduction);
      return reply.send({ ok: true, data: { tokens: result.tokens } });
    } catch (error) {
      // A rejected refresh means the cookie is worthless; clearing it stops the client
      // retrying with it forever.
      clearRefreshCookie(reply, config.isProduction);
      throw error;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Logout                                                              */
  /* ------------------------------------------------------------------ */

  app.post('/logout', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user!;

    await services.auth.logout(user.sessionId);
    // Also deny the still-valid access token for its remaining lifetime.
    await app.revokeSession(user.sessionId);

    clearRefreshCookie(reply, config.isProduction);
    return reply.send({ ok: true, data: { loggedOut: true } });
  });

  app.post('/logout-all', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = request.user!;

    await services.auth.revokeAllSessions(user.id, 'user-logout-all');
    // Bumping the generation invalidates every outstanding access token at once.
    await prisma.user.update({
      where: { id: user.id },
      data: { tokenGeneration: { increment: 1 } },
    });

    clearRefreshCookie(reply, config.isProduction);
    return reply.send({ ok: true, data: { loggedOut: true } });
  });

  /* ------------------------------------------------------------------ */
  /* Email verification                                                  */
  /* ------------------------------------------------------------------ */

  app.post('/verify-email', async (request, reply) => {
    const parsed = parseInput(verifyEmailSchema, request.body, request.id);
    if (!parsed.success) throw Errors.tokenInvalid();

    const { userId } = await services.auth.verifyEmail(parsed.data.token);

    /**
     * The normal moment a signup promotion pays out.
     *
     * Campaigns require a confirmed address by default, so this — not registration — is
     * where a new account becomes eligible on any deployment with verification enabled.
     * It is also the point at which the incentive works as intended: free tokens are
     * worth a real mailbox, which is the cheapest brake on bulk account creation that
     * does not involve collecting more personal data.
     */
    const granted = await services.campaigns.applyEligible(userId);

    return reply.send({ ok: true, data: { verified: true, grants: granted } });
  });

  app.post(
    '/resend-verification',
    {
      onRequest: [
        app.rateLimit('verify-resend', RATE_LIMITS.emailVerificationResend, { keyBy: 'ip' }),
      ],
    },
    async (request, reply) => {
      const parsed = parseInput(resendVerificationSchema, request.body, request.id);

      // Always the same response, whether or not the address exists — otherwise this
      // endpoint becomes the account-enumeration oracle that /login is not.
      const generic = {
        ok: true,
        data: { message: 'If that address needs confirming, we have sent a new link.' },
      };
      if (!parsed.success) return reply.send(generic);

      const user = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true, emailVerified: true },
      });

      if (user && !user.emailVerified) {
        const { generateOneTimeToken } = await import('@trip2world/auth');
        const { token, tokenHash } = generateOneTimeToken();

        await prisma.verificationToken.create({
          data: {
            userId: user.id,
            kind: 'EMAIL_VERIFICATION',
            tokenHash,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        });

        void services.mail.sendVerificationEmail(parsed.data.email, token);
      }

      return reply.send(generic);
    },
  );

  /* ------------------------------------------------------------------ */
  /* Password reset                                                      */
  /* ------------------------------------------------------------------ */

  app.post(
    '/forgot-password',
    { onRequest: [app.rateLimit('password-reset', RATE_LIMITS.passwordReset, { keyBy: 'ip' })] },
    async (request, reply) => {
      const parsed = parseInput(requestPasswordResetSchema, request.body, request.id);

      const generic = {
        ok: true,
        data: { message: 'If an account exists for that address, we have sent a reset link.' },
      };
      if (!parsed.success) return reply.send(generic);

      const result = await services.auth.createPasswordResetToken(parsed.data.email);
      if (result) void services.mail.sendPasswordResetEmail(parsed.data.email, result.token);

      return reply.send(generic);
    },
  );

  app.post(
    '/reset-password',
    { onRequest: [app.rateLimit('password-reset', RATE_LIMITS.passwordReset, { keyBy: 'ip' })] },
    async (request, reply) => {
      const parsed = parseInput(resetPasswordSchema, request.body, request.id);
      if (!parsed.success) {
        throw new AppError(parsed.error.code, parsed.error.message, {
          details: parsed.error.details,
        });
      }

      await services.auth.resetPassword(parsed.data.token, parsed.data.password);
      clearRefreshCookie(reply, config.isProduction);

      return reply.send({
        ok: true,
        data: { message: 'Your password has been changed. Please sign in.' },
      });
    },
  );

  app.post('/change-password', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = parseInput(changePasswordSchema, request.body, request.id);
    if (!parsed.success) {
      throw new AppError(parsed.error.code, parsed.error.message, {
        details: parsed.error.details,
      });
    }

    const user = request.user!;
    await services.auth.changePassword(
      user.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      user.sessionId,
    );

    return reply.send({ ok: true, data: { message: 'Your password has been changed.' } });
  });

  /* ------------------------------------------------------------------ */
  /* Session / account                                                   */
  /* ------------------------------------------------------------------ */

  app.get('/me', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = await loadSelf(app, request.user!.id);
    return reply.send({ ok: true, data: user });
  });

  app.post('/delete-account', { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = parseInput(deleteAccountSchema, request.body, request.id);
    if (!parsed.success) {
      throw new AppError(parsed.error.code, parsed.error.message, {
        details: parsed.error.details,
      });
    }

    const result = await services.auth.requestDeletion(request.user!.id, parsed.data.password);
    clearRefreshCookie(reply, config.isProduction);

    return reply.send({
      ok: true,
      data: {
        scheduledFor: result.scheduledFor.toISOString(),
        message: 'Your account is scheduled for deletion. Sign in again to cancel.',
      },
    });
  });
}

/* -------------------------------------------------------------------------- */

/**
 * Build the authenticated user's own view of themselves.
 *
 * This is the ONE place a user sees their own private fields (email, exact birth date,
 * restriction). It is never used to describe anyone else — partner-facing data goes
 * through `toPublicProfile` instead.
 */
async function loadSelf(app: FastifyInstance, userId: string) {
  const { prisma } = app;
  const { calculateAge, ageBracketFor, DEFAULT_PRIVACY_SETTINGS } = await import(
    '@trip2world/shared'
  );
  const { getActiveRestriction } = await import('@trip2world/database');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      role: true,
      status: true,
      plan: true,
      emailVerified: true,
      createdAt: true,
      profile: true,
      privacy: true,
      interests: { select: { interest: { select: { slug: true } } } },
    },
  });

  if (!user) throw Errors.notFound('Your account');

  const restriction = await getActiveRestriction(userId, prisma);

  return {
    id: user.id,
    username: user.username,
    displayName: user.profile?.displayName ?? null,
    avatarUrl: user.profile?.avatarUrl ?? null,
    country: user.profile?.country ?? null,
    ageBracket: ageBracketFor(user.profile?.birthDate ?? null),
    languages: user.profile?.languages ?? [],
    gender: user.profile?.gender ?? null,
    interests: user.interests.map((i) => i.interest.slug),
    bio: user.profile?.bio ?? null,
    verified: user.emailVerified,
    plan: user.plan,

    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    status: user.status,
    birthDate: user.profile?.birthDate?.toISOString() ?? null,
    age: calculateAge(user.profile?.birthDate ?? null),
    locale: user.profile?.locale ?? 'en',
    createdAt: user.createdAt.toISOString(),
    privacy: user.privacy
      ? { ...DEFAULT_PRIVACY_SETTINGS, ...user.privacy, fieldOverrides: {} }
      : DEFAULT_PRIVACY_SETTINGS,
    restriction: restriction
      ? {
          status: restriction.status,
          reason: restriction.reason,
          expiresAt: restriction.expiresAt?.toISOString() ?? null,
          appealUrl: null,
        }
      : null,
  };
}
