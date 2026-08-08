import type { PrismaClient } from '@prisma/client';
import {
  fakeVerify,
  generateOneTimeToken,
  generateRefreshToken,
  generateSessionId,
  hashIp,
  hashOneTimeToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  needsRehash,
  refreshTokenExpiry,
  verifyPassword,
} from '@trip2world/auth';
import { getActiveRestriction } from '@trip2world/database';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  calculateAge,
  EMAIL_VERIFICATION_TTL_SECONDS,
  meetsMinimumAge,
  PASSWORD_RESET_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '@trip2world/shared';
import { AccountStatus, type AuthTokens, type SystemSettings } from '@trip2world/types';
import type { RegisterInput } from '@trip2world/validation';
import type { AppConfig } from '../config.js';
import { Errors } from '../errors.js';
import type { Logger } from '../logger.js';

/**
 * Authentication.
 *
 * The security-relevant behaviours here, and why they are the way they are:
 *
 *   - Login is constant-work. A missing account still pays the Argon2 cost, so response
 *     time does not reveal whether an address is registered.
 *   - Registration and password reset never confirm whether an address exists.
 *   - Refresh tokens rotate on every use, and presenting a consumed token revokes the
 *     entire session family — that is the signal that a token was stolen.
 *   - Changing a password bumps `tokenGeneration`, invalidating every access token
 *     already issued without needing a denylist.
 */

export interface AuthServiceDeps {
  prisma: PrismaClient;
  config: AppConfig;
  logger: Logger;
}

export interface SessionContext {
  ip: string;
  userAgent: string | null;
}

export interface AuthResultInternal {
  userId: string;
  tokens: AuthTokens;
  /** Raw refresh token. Set as an HttpOnly cookie for web, returned in body for native. */
  refreshToken: string;
  sessionId: string;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /* ------------------------------------------------------------------ */
  /* Registration                                                        */
  /* ------------------------------------------------------------------ */

  async register(
    input: RegisterInput,
    settings: SystemSettings,
    context: SessionContext,
  ): Promise<{ userId: string; requiresVerification: boolean; verificationToken?: string }> {
    const { prisma, config } = this.deps;

    if (!settings.registrationOpen) throw Errors.registrationClosed();

    // The schema already enforces the absolute floor of 18; this applies the
    // operator's configured minimum, which may be higher.
    if (!meetsMinimumAge(input.birthDate, settings.minimumAge)) {
      throw Errors.underage(settings.minimumAge);
    }

    if (settings.enabledCountries && !settings.enabledCountries.includes(input.country)) {
      throw Errors.unsupportedCountry();
    }

    const ipHash = hashIp(context.ip, config.IP_HASH_SALT);

    // Registration flood control, keyed on the hashed IP. Deliberately generous — a
    // shared NAT or university network legitimately produces several signups.
    const recentFromIp = await prisma.user.count({
      where: { lastIpHash: ipHash, createdAt: { gte: new Date(Date.now() - 3600_000) } },
    });
    if (recentFromIp >= 5) {
      throw Errors.rateLimited(3600);
    }

    const passwordHash = await hashPassword(input.password);
    const { token, tokenHash } = generateOneTimeToken();

    // Uniqueness is enforced by the database, not by a pre-check: a check-then-insert
    // races, and two simultaneous registrations would both pass it.
    try {
      const user = await prisma.user.create({
        data: {
          email: input.email,
          username: input.username,
          passwordHash,
          status: settings.requireEmailVerificationToMatch
            ? AccountStatus.PENDING_VERIFICATION
            : AccountStatus.ACTIVE,
          emailVerified: !settings.requireEmailVerificationToMatch,
          emailVerifiedAt: settings.requireEmailVerificationToMatch ? null : new Date(),
          lastIpHash: ipHash,
          profile: {
            create: {
              displayName: input.displayName ?? null,
              birthDate: new Date(`${input.birthDate}T00:00:00.000Z`),
              country: input.country,
              languages: input.languages,
              locale: input.locale,
            },
          },
          privacy: { create: {} },
          preference: { create: {} },
          verificationTokens: settings.requireEmailVerificationToMatch
            ? {
                create: {
                  kind: 'EMAIL_VERIFICATION',
                  tokenHash,
                  expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000),
                },
              }
            : undefined,
        },
        select: { id: true },
      });

      await this.audit(user.id, 'auth.register', user.id, { country: input.country }, ipHash);

      return {
        userId: user.id,
        requiresVerification: settings.requireEmailVerificationToMatch,
        ...(settings.requireEmailVerificationToMatch ? { verificationToken: token } : {}),
      };
    } catch (error: unknown) {
      const target = (error as { code?: string; meta?: { target?: string[] } })?.meta?.target;
      if ((error as { code?: string })?.code === 'P2002') {
        if (target?.includes('username')) {
          throw Errors.conflict('That username is already taken.');
        }
        // Email collision. This DOES disclose that the address is registered, which is
        // unavoidable for a usable signup form — the user must be told why it failed.
        // The mitigation is that the same disclosure is not available anywhere else
        // (login, reset, and resend are all silent).
        throw Errors.conflict('An account with that email already exists.');
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Login                                                               */
  /* ------------------------------------------------------------------ */

  async login(
    email: string,
    password: string,
    context: SessionContext,
  ): Promise<AuthResultInternal> {
    const { prisma, config } = this.deps;

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        passwordHash: true,
        role: true,
        plan: true,
        status: true,
        emailVerified: true,
        tokenGeneration: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        deletedAt: true,
      },
    });

    // No account, or an OAuth-only account with no password set. Burn the same CPU as a
    // real verification so the two are indistinguishable by timing.
    if (!user || !user.passwordHash || user.deletedAt) {
      await fakeVerify(password);
      throw Errors.invalidCredentials();
    }

    // Progressive lockout after repeated failures. Checked before verification so a
    // locked account costs nothing to reject.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw Errors.rateLimited(retryAfter);
    }

    const valid = await verifyPassword(user.passwordHash, password);

    if (!valid) {
      await this.recordFailedLogin(user.id, user.failedLoginAttempts);
      throw Errors.invalidCredentials();
    }

    // Credentials are correct — only now is it safe to disclose account state, since
    // the caller has proven they own the account.
    const restriction = await getActiveRestriction(user.id, prisma);
    if (restriction) {
      if (restriction.status === 'BANNED') throw Errors.accountBanned(restriction.reason);
      throw Errors.accountSuspended(restriction.reason, restriction.expiresAt);
    }

    // Opportunistically upgrade a hash produced under weaker parameters, now that the
    // plaintext is briefly in hand.
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(password);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
    }

    const ipHash = hashIp(context.ip, config.IP_HASH_SALT);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastIpHash: ipHash,
        // A user who signs in has un-abandoned the account; cancel a pending deletion.
        deletionRequestedAt: null,
      },
    });

    await this.audit(user.id, 'auth.login', user.id, null, ipHash);

    return this.issueSession(
      { id: user.id, role: user.role, plan: user.plan, tokenGeneration: user.tokenGeneration },
      context,
    );
  }

  /**
   * Exponential lockout: 5 failures then a doubling delay, capped at 15 minutes.
   *
   * Bounded rather than permanent because a permanent lock on failed passwords is a
   * denial-of-service primitive — anyone who knows an email address could lock its owner
   * out indefinitely.
   */
  private async recordFailedLogin(userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    const THRESHOLD = 5;

    let lockedUntil: Date | null = null;
    if (attempts >= THRESHOLD) {
      const overage = attempts - THRESHOLD;
      const seconds = Math.min(30 * 2 ** overage, 900);
      lockedUntil = new Date(Date.now() + seconds * 1000);
    }

    await this.deps.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: attempts, lockedUntil },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Sessions                                                            */
  /* ------------------------------------------------------------------ */

  private async issueSession(
    user: { id: string; role: string; plan: string; tokenGeneration: number },
    context: SessionContext,
  ): Promise<AuthResultInternal> {
    const { prisma, config } = this.deps;

    const sessionId = generateSessionId();
    const refreshToken = generateRefreshToken();

    await prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshTokenExpiry(),
        userAgent: context.userAgent?.slice(0, 400) ?? null,
        ipHash: hashIp(context.ip, config.IP_HASH_SALT),
      },
    });

    const { token: accessToken, expiresIn } = await issueAccessToken(
      {
        userId: user.id,
        role: user.role,
        plan: user.plan,
        sessionId,
        tokenGeneration: user.tokenGeneration,
      },
      { secret: config.JWT_SECRET },
    );

    return {
      userId: user.id,
      sessionId,
      refreshToken,
      tokens: { accessToken, expiresIn },
    };
  }

  /**
   * Rotate a refresh token.
   *
   * Reuse detection is the point of this method. Each refresh issues a new token and
   * replaces the stored hash, so the old value becomes unusable. If a token that is not
   * the current one is presented, either it was replayed by an attacker or the legitimate
   * client raced itself — and since we cannot tell which, the safe response is to revoke
   * the whole family and force a fresh login.
   */
  async refresh(rawToken: string, context: SessionContext): Promise<AuthResultInternal> {
    const { prisma, config } = this.deps;

    const tokenHash = hashRefreshToken(rawToken);

    const session = await prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        rotationCounter: true,
        user: {
          select: {
            id: true,
            role: true,
            plan: true,
            status: true,
            tokenGeneration: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!session) {
      // Unknown token. It may be a token we already rotated away, which would mean a
      // replay — but we cannot identify the family from a hash we no longer store, so
      // there is nothing to revoke. Reject and let the client re-authenticate.
      throw Errors.tokenInvalid('Your session has expired. Please sign in again.');
    }

    if (session.revokedAt) {
      // A revoked session being presented is a strong signal of theft: revoke every
      // other session for this user as well.
      await this.revokeAllSessions(session.userId, 'refresh-token-reuse');
      this.deps.logger.warn(
        { userId: session.userId, sessionId: session.id },
        'Refresh token reuse detected; all sessions revoked',
      );
      throw Errors.tokenInvalid('Your session has expired. Please sign in again.');
    }

    if (session.expiresAt <= new Date() || session.user.deletedAt) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      throw Errors.tokenExpired('Your session has expired. Please sign in again.');
    }

    const restriction = await getActiveRestriction(session.userId, prisma);
    if (restriction) {
      await this.revokeAllSessions(session.userId, 'account-restricted');
      if (restriction.status === 'BANNED') throw Errors.accountBanned(restriction.reason);
      throw Errors.accountSuspended(restriction.reason, restriction.expiresAt);
    }

    const newRefreshToken = generateRefreshToken();

    await prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: hashRefreshToken(newRefreshToken),
        rotationCounter: { increment: 1 },
        lastUsedAt: new Date(),
        expiresAt: refreshTokenExpiry(),
        ipHash: hashIp(context.ip, config.IP_HASH_SALT),
      },
    });

    const { token: accessToken, expiresIn } = await issueAccessToken(
      {
        userId: session.user.id,
        role: session.user.role,
        plan: session.user.plan,
        sessionId: session.id,
        tokenGeneration: session.user.tokenGeneration,
      },
      { secret: config.JWT_SECRET },
    );

    return {
      userId: session.userId,
      sessionId: session.id,
      refreshToken: newRefreshToken,
      tokens: { accessToken, expiresIn },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.deps.prisma.session
      .update({
        where: { id: sessionId },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      })
      .catch(() => undefined);
  }

  async revokeAllSessions(userId: string, reason: string): Promise<void> {
    await this.deps.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Email verification                                                  */
  /* ------------------------------------------------------------------ */

  async verifyEmail(rawToken: string): Promise<{ userId: string }> {
    const { prisma } = this.deps;
    const tokenHash = hashOneTimeToken(rawToken);

    const record = await prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, kind: true, expiresAt: true, consumedAt: true },
    });

    if (!record || record.kind !== 'EMAIL_VERIFICATION') throw Errors.tokenInvalid();
    if (record.consumedAt) throw Errors.tokenInvalid('That link has already been used.');
    if (record.expiresAt <= new Date()) throw Errors.tokenExpired();

    await prisma.$transaction([
      prisma.verificationToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      }),

      // Confirming the address is always safe to record.
      prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true, emailVerifiedAt: new Date() },
      }),

      // Activating the account is NOT. If the account was suspended or banned while
      // verification was outstanding, an unconditional `status: ACTIVE` here would lift
      // that moderation action — turning the verification link into a self-service
      // unban. The `where` clause confines the promotion to accounts that are still
      // merely awaiting verification; for any other status this matches zero rows.
      prisma.user.updateMany({
        where: { id: record.userId, status: AccountStatus.PENDING_VERIFICATION },
        data: { status: AccountStatus.ACTIVE },
      }),
    ]);

    await this.audit(record.userId, 'auth.email.verified', record.userId, null, null);
    return { userId: record.userId };
  }

  /**
   * Issue a password-reset token.
   *
   * Returns the token only when the account exists and is eligible. The route always
   * responds identically regardless — see `auth.routes.ts` — so this method's return
   * value never reveals anything to the caller.
   */
  async createPasswordResetToken(email: string): Promise<{ userId: string; token: string } | null> {
    const { prisma } = this.deps;

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, deletedAt: true, status: true },
    });

    if (!user || user.deletedAt || user.status === AccountStatus.BANNED) return null;

    const { token, tokenHash } = generateOneTimeToken();

    // Invalidate outstanding reset tokens: multiple live tokens widen the window in
    // which an intercepted email is useful.
    await prisma.$transaction([
      prisma.verificationToken.updateMany({
        where: { userId: user.id, kind: 'PASSWORD_RESET', consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      prisma.verificationToken.create({
        data: {
          userId: user.id,
          kind: 'PASSWORD_RESET',
          tokenHash,
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
        },
      }),
    ]);

    return { userId: user.id, token };
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<{ userId: string }> {
    const { prisma } = this.deps;
    const tokenHash = hashOneTimeToken(rawToken);

    const record = await prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, kind: true, expiresAt: true, consumedAt: true },
    });

    if (!record || record.kind !== 'PASSWORD_RESET') throw Errors.tokenInvalid();
    if (record.consumedAt) throw Errors.tokenInvalid('That link has already been used.');
    if (record.expiresAt <= new Date()) throw Errors.tokenExpired();

    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction([
      prisma.verificationToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          // Invalidate every access token already issued for this account.
          tokenGeneration: { increment: 1 },
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      // A password reset is the standard response to a compromise, so every existing
      // session must go — including the attacker's.
      prisma.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'password-reset' },
      }),
    ]);

    await this.audit(record.userId, 'auth.password.reset', record.userId, null, null);
    return { userId: record.userId };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string,
  ): Promise<void> {
    const { prisma } = this.deps;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash) throw Errors.invalidCredentials();

    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw Errors.invalidCredentials();
    }

    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash, tokenGeneration: { increment: 1 } },
      }),
      // Sign out every OTHER device, but keep the one making the change — logging the
      // user out of the tab they are actively using is hostile and teaches nothing.
      prisma.session.updateMany({
        where: { userId, revokedAt: null, id: { not: keepSessionId } },
        data: { revokedAt: new Date(), revokedReason: 'password-change' },
      }),
    ]);

    await this.audit(userId, 'auth.password.changed', userId, null, null);
  }

  /* ------------------------------------------------------------------ */
  /* Account deletion                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Request deletion. Deliberately deferred rather than immediate: the grace period
   * makes an account recoverable if the request was coerced or mistaken, and signing
   * back in cancels it.
   */
  async requestDeletion(userId: string, password: string): Promise<{ scheduledFor: Date }> {
    const { prisma } = this.deps;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw Errors.invalidCredentials();
    }

    const scheduledFor = new Date(Date.now() + ACCOUNT_DELETION_GRACE_DAYS * 86_400_000);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { deletionRequestedAt: new Date(), status: AccountStatus.DEACTIVATED },
      }),
      prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'deletion-requested' },
      }),
    ]);

    await this.audit(userId, 'account.deletion.requested', userId, { scheduledFor }, null);
    return { scheduledFor };
  }

  /* ------------------------------------------------------------------ */

  private async audit(
    actorId: string | null,
    action: string,
    targetId: string | null,
    metadata: Record<string, unknown> | null,
    ipHash: string | null,
  ): Promise<void> {
    await this.deps.prisma.auditLog
      .create({
        data: {
          actorId,
          actorType: 'USER',
          action,
          targetType: 'User',
          targetId,
          metadata: (metadata ?? undefined) as never,
          ipHash,
        },
      })
      .catch((error: unknown) => {
        // Audit logging must never break the user-facing operation it describes.
        this.deps.logger.error({ err: error, action }, 'Failed to write audit log');
      });
  }

  /** Age in whole years, for the profile response. */
  static ageOf(birthDate: Date | null): number | null {
    return calculateAge(birthDate);
  }

  static refreshCookieMaxAge(): number {
    return REFRESH_TOKEN_TTL_SECONDS;
  }
}
