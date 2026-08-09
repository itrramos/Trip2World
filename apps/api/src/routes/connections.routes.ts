import {
  isBlockedBetween,
  orderConnectionPair,
  toPublicProfileFromRow,
} from '@trip2world/database';
import { CONNECTION_REQUEST_TTL_DAYS, RATE_LIMITS } from '@trip2world/shared';
import {
  listBlocksSchema,
  parseInput,
  respondToConnectionRequestSchema,
  sendConnectionRequestSchema,
} from '@trip2world/validation';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError, Errors } from '../errors.js';

/**
 * Staying in touch after a conversation.
 *
 * Trip2World is built around talking to strangers, and this is the one place that
 * deliberately works against that — so it is gated more carefully than anything else on
 * the user-facing API:
 *
 *   - The recipient must have `allowConnectionRequests` on. It defaults to on, but a user
 *     who turns it off becomes unreachable, permanently and silently. There is no
 *     "request anyway".
 *   - A block in either direction makes a request impossible, and the sender is told the
 *     same thing they would be told about a user who does not exist.
 *   - Requests expire. An unanswered request is not a permanent claim on someone's
 *     attention, and an inbox that only grows is one people stop opening.
 *
 * The profile shape returned everywhere here goes through `toPublicProfileFromRow`, so a
 * connection reveals exactly what a match does — accepting one is not consent to be
 * identified.
 */
export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, requestId: string): z.infer<S> {
    const result = parseInput(schema, input, requestId);
    if (!result.success) {
      throw new AppError(result.error.code, result.error.message, { details: result.error.details });
    }
    return result.data;
  }

  /** Everything the client needs to render a person, and nothing more. */
  const PROFILE_SELECT = {
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
  } as const;

  /* ------------------------------------------------------------------ */
  /* Requests                                                            */
  /* ------------------------------------------------------------------ */

  app.post(
    '/connections/requests',
    { onRequest: [app.authenticate, app.rateLimit('connection-request', RATE_LIMITS.apiWrite)] },
    async (request, reply) => {
      const input = parse(sendConnectionRequestSchema, request.body, request.id);
      const userId = request.user!.id;

      if (input.userId === userId) {
        throw Errors.conflict('You cannot connect with yourself.');
      }

      const target = await prisma.user.findFirst({
        where: { id: input.userId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true, privacy: { select: { allowConnectionRequests: true } } },
      });

      /**
       * A blocked user and a nonexistent one get the same answer.
       *
       * Distinguishing them would turn this endpoint into a way to discover that someone
       * has blocked you — which is precisely the information a block exists to withhold,
       * and the thing that makes people escalate.
       */
      if (!target || (await isBlockedBetween(userId, input.userId, prisma))) {
        throw Errors.notFound('That user');
      }

      // Defaults to true when no row exists yet, matching DEFAULT_PRIVACY_SETTINGS.
      if (target.privacy && !target.privacy.allowConnectionRequests) {
        throw Errors.forbidden('That person is not accepting connection requests.');
      }

      const [userAId, userBId] = orderConnectionPair(userId, target.id);
      const existing = await prisma.connection.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
        select: { id: true },
      });
      if (existing) throw Errors.conflict('You are already connected.');

      /**
       * They asked first: accept instead of queueing a second request.
       *
       * Two people who each sent a request obviously both want this, and making the
       * second one wait for an answer that has already been given is a pointless step.
       */
      const reciprocal = await prisma.connectionRequest.findUnique({
        where: { fromUserId_toUserId: { fromUserId: target.id, toUserId: userId } },
        select: { id: true, status: true },
      });

      if (reciprocal && reciprocal.status === 'PENDING') {
        await prisma.$transaction([
          prisma.connectionRequest.update({
            where: { id: reciprocal.id },
            data: { status: 'ACCEPTED', respondedAt: new Date() },
          }),
          prisma.connection.create({
            data: { userAId, userBId, originMatchId: input.matchId },
          }),
        ]);

        return reply.status(201).send({ ok: true, data: { status: 'CONNECTED' } });
      }

      const expiresAt = new Date(Date.now() + CONNECTION_REQUEST_TTL_DAYS * 86_400_000);

      // Upsert rather than create: re-sending after a decline is allowed, and the unique
      // constraint on (fromUserId, toUserId) would otherwise make that a 500.
      await prisma.connectionRequest.upsert({
        where: { fromUserId_toUserId: { fromUserId: userId, toUserId: target.id } },
        create: {
          fromUserId: userId,
          toUserId: target.id,
          message: input.message ?? null,
          matchId: input.matchId,
          expiresAt,
        },
        update: {
          status: 'PENDING',
          message: input.message ?? null,
          matchId: input.matchId,
          respondedAt: null,
          expiresAt,
        },
      });

      return reply.status(201).send({ ok: true, data: { status: 'PENDING' } });
    },
  );

  /** Requests waiting on this user. Never reveals requests they have already answered. */
  app.get('/connections/requests', { onRequest: [app.authenticate] }, async (request, reply) => {
    const now = new Date();

    const rows = await prisma.connectionRequest.findMany({
      where: {
        toUserId: request.user!.id,
        status: 'PENDING',
        // Expiry is enforced on read as well as by the worker sweep, so a lapsed request
        // never appears even if the worker is down.
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        message: true,
        createdAt: true,
        expiresAt: true,
        fromUser: { select: PROFILE_SELECT },
      },
    });

    return reply.send({
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        message: row.message,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        user: toPublicProfileFromRow(row.fromUser),
      })),
    });
  });

  app.post(
    '/connections/requests/respond',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const input = parse(respondToConnectionRequestSchema, request.body, request.id);
      const userId = request.user!.id;

      const pending = await prisma.connectionRequest.findFirst({
        // Scoped to the recipient: only the person asked may answer.
        where: { id: input.requestId, toUserId: userId, status: 'PENDING' },
        select: { id: true, fromUserId: true, matchId: true },
      });
      if (!pending) throw Errors.notFound('That request');

      if (!input.accept) {
        await prisma.connectionRequest.update({
          where: { id: pending.id },
          data: { status: 'DECLINED', respondedAt: new Date() },
        });
        // Declining is deliberately not reported to the sender. "They said no" is an
        // invitation to ask again by other means.
        return reply.send({ ok: true, data: { status: 'DECLINED' } });
      }

      // A block placed between the request and the answer must win.
      if (await isBlockedBetween(userId, pending.fromUserId, prisma)) {
        await prisma.connectionRequest.update({
          where: { id: pending.id },
          data: { status: 'DECLINED', respondedAt: new Date() },
        });
        throw Errors.notFound('That request');
      }

      const [userAId, userBId] = orderConnectionPair(userId, pending.fromUserId);

      await prisma.$transaction([
        prisma.connectionRequest.update({
          where: { id: pending.id },
          data: { status: 'ACCEPTED', respondedAt: new Date() },
        }),
        prisma.connection.upsert({
          where: { userAId_userBId: { userAId, userBId } },
          create: { userAId, userBId, originMatchId: pending.matchId },
          update: {},
        }),
      ]);

      return reply.send({ ok: true, data: { status: 'CONNECTED' } });
    },
  );

  /* ------------------------------------------------------------------ */
  /* Connections                                                         */
  /* ------------------------------------------------------------------ */

  app.get('/connections', { onRequest: [app.authenticate] }, async (request, reply) => {
    const query = parse(listBlocksSchema, request.query, request.id);
    const userId = request.user!.id;

    const where = { OR: [{ userAId: userId }, { userBId: userId }] };

    const [total, rows] = await Promise.all([
      prisma.connection.count({ where }),
      prisma.connection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          createdAt: true,
          userAId: true,
          userA: { select: PROFILE_SELECT },
          userB: { select: PROFILE_SELECT },
        },
      }),
    ]);

    return reply.send({
      ok: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          connectedAt: row.createdAt.toISOString(),
          // The pair is stored in canonical order, so which column holds the other
          // person depends on how the two ids sort — not on who sent the request.
          user: toPublicProfileFromRow(row.userAId === userId ? row.userB : row.userA),
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        hasMore: query.page * query.pageSize < total,
      },
    });
  });

  /**
   * Remove a connection.
   *
   * Deletes for both sides, because a one-sided connection is not a thing this model can
   * represent and pretending otherwise would leave the other person believing they are
   * still connected.
   */
  app.delete('/connections/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    // Read first: the partner's id is needed to clean up, and it is only derivable from
    // the row. Scoped to connections this user is part of, so the id alone is not enough
    // to remove someone else's.
    const connection = await prisma.connection.findFirst({
      where: { id, OR: [{ userAId: userId }, { userBId: userId }] },
      select: { id: true, userAId: true, userBId: true },
    });
    if (!connection) throw Errors.notFound('That connection');

    const partnerId = connection.userAId === userId ? connection.userBId : connection.userAId;

    /**
     * Clear the request rows for THIS PAIR only.
     *
     * Left behind, an accepted request makes a later re-request hit the
     * already-answered branch and silently do nothing — so removing someone would
     * quietly prevent ever reconnecting with them.
     *
     * The pair scoping matters: an earlier draft matched on this user alone and would
     * have deleted their request history with everybody.
     */
    await prisma.$transaction([
      prisma.connection.delete({ where: { id: connection.id } }),
      prisma.connectionRequest.deleteMany({
        where: {
          OR: [
            { fromUserId: userId, toUserId: partnerId },
            { fromUserId: partnerId, toUserId: userId },
          ],
        },
      }),
    ]);

    return reply.send({ ok: true, data: { removed: true } });
  });
}
