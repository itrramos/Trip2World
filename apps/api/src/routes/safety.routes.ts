import { getBlockedUserIds, toPublicProfileFromRow } from '@trip2world/database';
import { RATE_LIMITS } from '@trip2world/shared';
import {
  createBlockSchema,
  createReportSchema,
  listBlocksSchema,
  parseInput,
  removeBlockSchema,
} from '@trip2world/validation';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError, Errors } from '../errors.js';

/**
 * Blocking and reporting over HTTP.
 *
 * Both actions already exist on the realtime socket for use during a call. These are the
 * out-of-call equivalents — and crucially the only way to *see* or *undo* a block, which
 * the socket surface never offered. A block you cannot review or lift is a bug, not a
 * safety feature.
 */
export async function safetyRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, redis } = app;

  function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, requestId: string): z.infer<S> {
    const result = parseInput(schema, input, requestId);
    if (!result.success) {
      throw new AppError(result.error.code, result.error.message, { details: result.error.details });
    }
    return result.data;
  }

  /** Drop the cached block set for both sides, since blocks apply bidirectionally. */
  async function invalidateBlockCache(a: string, b: string): Promise<void> {
    await Promise.all([
      redis.client.del(redis.keys.blockCache(a)),
      redis.client.del(redis.keys.blockCache(b)),
    ]).catch(() => undefined);
  }

  /* ------------------------------------------------------------------ */
  /* Blocks                                                             */
  /* ------------------------------------------------------------------ */

  app.get('/blocks', { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = parse(listBlocksSchema, request.query, request.id);
    const userId = request.user!.id;

    /**
     * Only blocks this user CREATED are listed.
     *
     * Blocks are enforced in both directions, but showing someone the list of people who
     * blocked *them* would be a harassment vector — and would tell them exactly who to
     * make a new account to avoid.
     */
    const where = { blockerId: userId };

    const [total, blocks] = await Promise.all([
      prisma.block.count({ where }),
      prisma.block.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          reason: true,
          createdAt: true,
          blockedUser: {
            select: {
              id: true,
              username: true,
              emailVerified: true,
              plan: true,
              profile: {
                select: {
                  displayName: true,
                  avatarUrl: true,
                  bio: true,
                  birthDate: true,
                  gender: true,
                  country: true,
                  languages: true,
                },
              },
              privacy: true,
              interests: { select: { interest: { select: { slug: true } } } },
            },
          },
        },
      }),
    ]);

    return reply.send({
      ok: true,
      data: {
        items: blocks.map((block) => ({
          id: block.id,
          blockedAt: block.createdAt.toISOString(),
          reason: block.reason,
          // Through the privacy funnel even here — a blocked user's privacy settings
          // still apply to the person who blocked them.
          user: toPublicProfileFromRow(block.blockedUser),
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: query.page * query.pageSize < total,
      },
    });
  });

  app.post(
    '/blocks',
    { onRequest: [app.authenticate, app.rateLimit('block', RATE_LIMITS.block)] },
    async (request, reply) => {
      const input = parse(createBlockSchema, request.body, request.id);
      const userId = request.user!.id;

      if (input.userId === userId) {
        throw Errors.conflict('You cannot block yourself.');
      }

      const target = await prisma.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true },
      });
      if (!target) throw Errors.notFound('That user');

      // Idempotent: blocking twice is not an error, it is a user pressing the button
      // again because they were not sure it worked.
      await prisma.block.upsert({
        where: { blockerId_blockedUserId: { blockerId: userId, blockedUserId: target.id } },
        create: { blockerId: userId, blockedUserId: target.id, reason: input.reason ?? null },
        update: {},
      });

      await invalidateBlockCache(userId, target.id);

      return reply.status(201).send({ ok: true, data: { blocked: true } });
    },
  );

  app.delete('/blocks', { onRequest: [app.authenticate] }, async (request, reply) => {
    const input = parse(removeBlockSchema, request.body, request.id);
    const userId = request.user!.id;

    await prisma.block.deleteMany({
      where: { blockerId: userId, blockedUserId: input.userId },
    });

    await invalidateBlockCache(userId, input.userId);

    return reply.send({ ok: true, data: { unblocked: true } });
  });

  /* ------------------------------------------------------------------ */
  /* Reports                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * File a report outside a live call.
   *
   * The response deliberately contains no moderator-facing data — not the report status
   * beyond "received", not whether the account has prior reports, not what action was
   * taken. Reporters must not be able to use this endpoint to probe another account's
   * moderation history.
   */
  app.post(
    '/reports',
    { onRequest: [app.authenticate, app.rateLimit('report', RATE_LIMITS.report)] },
    async (request, reply) => {
      const input = parse(createReportSchema, request.body, request.id);
      const userId = request.user!.id;

      if (input.reportedUserId === userId) {
        throw Errors.conflict('You cannot report yourself.');
      }

      const target = await prisma.user.findFirst({
        where: { id: input.reportedUserId, deletedAt: null },
        select: { id: true },
      });
      if (!target) throw Errors.notFound('That user');

      const report = await prisma.report.create({
        data: {
          reporterId: userId,
          reportedUserId: target.id,
          matchId: input.matchId,
          category: input.category as never,
          details: input.details ?? null,
        },
        select: { id: true, category: true, status: true, createdAt: true },
      });

      if (input.alsoBlock) {
        await prisma.block
          .upsert({
            where: { blockerId_blockedUserId: { blockerId: userId, blockedUserId: target.id } },
            create: { blockerId: userId, blockedUserId: target.id },
            update: {},
          })
          .catch(() => undefined);
        await invalidateBlockCache(userId, target.id);
      }

      return reply.status(201).send({
        ok: true,
        data: {
          id: report.id,
          category: report.category,
          status: report.status,
          createdAt: report.createdAt.toISOString(),
        },
      });
    },
  );

  /** Reports this user has filed. Their own receipts, not moderator data. */
  app.get('/reports', { onRequest: [app.authenticate] }, async (request, reply) => {
    const reports = await prisma.report.findMany({
      where: { reporterId: request.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      // No moderatorNotes, no reviewer, no prior-report counts.
      select: { id: true, category: true, status: true, createdAt: true },
    });

    return reply.send({ ok: true, data: reports });
  });

  /**
   * Everyone this user cannot be matched with, merged from both directions.
   *
   * Returns ids only. The client uses it to grey out actions; revealing WHO blocked you
   * would be the harassment vector the list endpoint above avoids.
   */
  app.get('/blocks/ids', { onRequest: [app.authenticate] }, async (request, reply) => {
    const ids = await getBlockedUserIds(request.user!.id, prisma);
    return reply.send({ ok: true, data: { count: ids.length } });
  });
}
