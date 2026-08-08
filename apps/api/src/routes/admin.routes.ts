import { UserRole } from '@trip2world/types';
import {
  adminAuditQuerySchema,
  adminBanUserSchema,
  adminSetRoleSchema,
  adminSuspendUserSchema,
  adminUnbanUserSchema,
  adminUserQuerySchema,
  adminWarnUserSchema,
  moderationQueueQuerySchema,
  parseInput,
  resolveReportRefinedSchema,
} from '@trip2world/validation';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError, Errors } from '../errors.js';
import { ModerationService } from '../services/moderation.service.js';

/**
 * Administration and moderation endpoints.
 *
 * Every route here sits behind `authenticate` plus a role guard, and the guards are
 * applied per-route rather than once for the whole prefix because the required role
 * differs. A MODERATOR handles reports; only a SUPER_ADMIN may change someone's role,
 * since privilege escalation is the highest-value target on this surface and deserves
 * the narrowest gate.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, redis, services } = app;
  const moderation = new ModerationService({ prisma, redis, logger: app.log });

  const requireModerator = app.requireRole(UserRole.MODERATOR);
  const requireAdmin = app.requireRole(UserRole.ADMIN);
  const requireSuperAdmin = app.requireRole(UserRole.SUPER_ADMIN);

  /** Parse untrusted input or throw a properly-shaped API error. */
  function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, requestId: string): z.infer<S> {
    const result = parseInput(schema, input, requestId);
    if (!result.success) {
      throw new AppError(result.error.code, result.error.message, { details: result.error.details });
    }
    return result.data;
  }

  /* ------------------------------------------------------------------ */
  /* Dashboard                                                           */
  /* ------------------------------------------------------------------ */

  app.get('/stats', { onRequest: [app.authenticate, requireModerator] }, async (_request, reply) =>
    reply.send({ ok: true, data: await moderation.stats() }),
  );

  /* ------------------------------------------------------------------ */
  /* Moderation queue                                                    */
  /* ------------------------------------------------------------------ */

  app.get('/reports', { onRequest: [app.authenticate, requireModerator] }, async (request, reply) => {
    const query = parse(moderationQueueQuerySchema, request.query, request.id);
    return reply.send({ ok: true, data: await moderation.queue(query) });
  });

  app.post(
    '/reports/:id/claim',
    { onRequest: [app.authenticate, requireModerator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await moderation.claim(id, request.user!.id);
      return reply.send({ ok: true, data: { claimed: true } });
    },
  );

  app.post(
    '/reports/resolve',
    { onRequest: [app.authenticate, requireModerator] },
    async (request, reply) => {
      const input = parse(resolveReportRefinedSchema, request.body, request.id);
      await moderation.resolve(input, request.user!.id);
      return reply.send({ ok: true, data: { resolved: true } });
    },
  );

  /* ------------------------------------------------------------------ */
  /* Users                                                               */
  /* ------------------------------------------------------------------ */

  app.get('/users', { onRequest: [app.authenticate, requireModerator] }, async (request, reply) => {
    const query = parse(adminUserQuerySchema, request.query, request.id);

    const where = {
      deletedAt: null,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.role ? { role: query.role as never } : {}),
      ...(query.country ? { profile: { country: query.country } } : {}),
      ...(query.q
        ? {
            OR: [
              { username: { contains: query.q, mode: 'insensitive' as const } },
              { email: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: query.direction },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        // Explicit select. `passwordHash` and `lastIpHash` must never leave the server,
        // and only a select guarantees a newly added column does not start appearing
        // here the moment someone extends the schema.
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          status: true,
          plan: true,
          emailVerified: true,
          createdAt: true,
          lastLoginAt: true,
          safetyScore: true,
          profile: { select: { displayName: true, country: true } },
          _count: { select: { reportsAgainst: true } },
        },
      }),
    ]);

    return reply.send({
      ok: true,
      data: {
        items: users,
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: query.page * query.pageSize < total,
      },
    });
  });

  app.get('/users/:id', { onRequest: [app.authenticate, requireModerator] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        plan: true,
        emailVerified: true,
        createdAt: true,
        lastLoginAt: true,
        safetyScore: true,
        profile: true,
        moderationActionsReceived: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            type: true,
            reason: true,
            notes: true,
            expiresAt: true,
            createdAt: true,
            moderator: { select: { id: true, username: true } },
          },
        },
        reportsAgainst: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, category: true, status: true, createdAt: true },
        },
      },
    });

    if (!user) throw Errors.notFound('That user');
    return reply.send({ ok: true, data: user });
  });

  app.post('/users/warn', { onRequest: [app.authenticate, requireModerator] }, async (request, reply) => {
    const input = parse(adminWarnUserSchema, request.body, request.id);

    await prisma.moderationAction.create({
      data: {
        targetUserId: input.userId,
        moderatorId: request.user!.id,
        type: 'WARNING',
        reason: input.reason,
        notes: input.notes ?? null,
      },
    });

    return reply.send({ ok: true, data: { warned: true } });
  });

  app.post(
    '/users/suspend',
    { onRequest: [app.authenticate, requireModerator] },
    async (request, reply) => {
      const input = parse(adminSuspendUserSchema, request.body, request.id);

      await moderation.resolveDirect(
        {
          targetUserId: input.userId,
          action: 'SUSPEND',
          reason: input.reason,
          notes: input.notes,
          hours: input.hours,
        },
        request.user!.id,
      );

      return reply.send({ ok: true, data: { suspended: true } });
    },
  );

  app.post('/users/ban', { onRequest: [app.authenticate, requireAdmin] }, async (request, reply) => {
    const input = parse(adminBanUserSchema, request.body, request.id);

    await moderation.resolveDirect(
      { targetUserId: input.userId, action: 'BAN', reason: input.reason, notes: input.notes },
      request.user!.id,
    );

    return reply.send({ ok: true, data: { banned: true } });
  });

  app.post('/users/unban', { onRequest: [app.authenticate, requireAdmin] }, async (request, reply) => {
    const input = parse(adminUnbanUserSchema, request.body, request.id);
    await moderation.reinstate(input.userId, request.user!.id, input.reason);
    return reply.send({ ok: true, data: { reinstated: true } });
  });

  /**
   * Role changes: SUPER_ADMIN only, and nobody may change their own role.
   *
   * Self-service escalation would make every other guard on this surface decorative.
   */
  app.post('/users/role', { onRequest: [app.authenticate, requireSuperAdmin] }, async (request, reply) => {
    const input = parse(adminSetRoleSchema, request.body, request.id);

    if (input.userId === request.user!.id) {
      throw Errors.forbidden('You cannot change your own role.');
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: input.userId },
        // Role is embedded in the access token, so bump the generation to force a
        // re-issue. Without this the change only takes effect at the next refresh.
        data: { role: input.role as never, tokenGeneration: { increment: 1 } },
      }),
      prisma.auditLog.create({
        data: {
          actorId: request.user!.id,
          actorType: 'ADMIN',
          action: 'admin.user.role',
          targetType: 'User',
          targetId: input.userId,
          metadata: { role: input.role, reason: input.reason },
        },
      }),
    ]);

    return reply.send({ ok: true, data: { updated: true } });
  });

  /* ------------------------------------------------------------------ */
  /* Configuration and audit                                             */
  /* ------------------------------------------------------------------ */

  app.get('/settings', { onRequest: [app.authenticate, requireAdmin] }, async (_request, reply) =>
    reply.send({ ok: true, data: await services.settings.get() }),
  );

  app.get('/audit', { onRequest: [app.authenticate, requireAdmin] }, async (request, reply) => {
    const query = parse(adminAuditQuerySchema, request.query, request.id);

    const where = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: { contains: query.action } } : {}),
    };

    const [total, entries] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          action: true,
          actorType: true,
          targetType: true,
          targetId: true,
          metadata: true,
          createdAt: true,
          actor: { select: { id: true, username: true } },
        },
      }),
    ]);

    return reply.send({
      ok: true,
      data: {
        items: entries,
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: query.page * query.pageSize < total,
      },
    });
  });
}
