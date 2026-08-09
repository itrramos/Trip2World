import { createServer, type Server as HttpServer } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { createAdapter } from '@socket.io/redis-adapter';
import { buildIceServers } from '@trip2world/auth';
import {
  getBlockedUserIds,
  loadMatchCandidate,
  toPublicProfileFromRow,
  TokensService,
} from '@trip2world/database';
import {
  createRedisKeys,
  MAX_SOCKET_PAYLOAD_BYTES,
  PRESENCE_HEARTBEAT_MS,
  RATE_LIMITS,
  ageBracketFor,
  DEFAULT_PRIVACY_SETTINGS,
  relaxationStageFor,
  toPublicProfile,
} from '@trip2world/shared';
import {
  MatchEndReason,
  REALTIME_NAMESPACE,
  RealtimeErrorCode,
  type ClientToServerEvents,
  type InterServerEvents,
  type MatchmakingSettings,
  type RealtimeError,
  type ServerToClientEvents,
  type SocketData,
} from '@trip2world/types';
import {
  chatMessageSchema,
  matchConnectedSchema,
  matchEndSchema,
  matchSkipSchema,
  queueJoinSchema,
  socketBlockSchema,
  sendTipSocketSchema,
  socketReportSchema,
  tipRespondSocketSchema,
  webrtcAnswerSchema,
  webrtcIceSchema,
  webrtcOfferSchema,
} from '@trip2world/validation';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import type { z } from 'zod';
import type { RealtimeConfig } from './config.js';
import { Matchmaker } from './matchmaker.js';
import { PresenceService } from './presence.js';
import { QueueRepository } from './queue.repository.js';
import { authenticateSocket, revalidateSocket, SocketAuthError } from './socket-auth.js';

type T2WSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type T2WServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface RealtimeServerDeps {
  config: RealtimeConfig;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  /** Separate connections: the Redis adapter puts its subscriber into subscribe mode,
   *  which cannot then issue normal commands. */
  pubClient: Redis;
  subClient: Redis;
  settings: () => Promise<MatchmakingSettings>;
}

export interface RealtimeServer {
  httpServer: HttpServer;
  io: T2WServer;
  shutdown: () => Promise<void>;
}

export function buildRealtimeServer(deps: RealtimeServerDeps): RealtimeServer {
  const { config, logger, prisma, redis, pubClient, subClient, settings } = deps;

  const keys = createRedisKeys(config.REDIS_PREFIX);
  const queue = new QueueRepository(redis, keys);
  const presence = new PresenceService(redis, keys, config.REALTIME_NODE_ID);
  const matchmaker = new Matchmaker({
    prisma,
    queue,
    logger,
    nodeId: config.REALTIME_NODE_ID,
  });

  // Tipping happens during a call, so the ledger is needed here as well as in the API.
  // Shared implementation, so there is one place money can go wrong.
  const tokens = new TokensService(prisma, logger);

  /* ---------------------------------------------------------------- */
  /* HTTP surface (health only)                                        */
  /* ---------------------------------------------------------------- */

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'realtime', node: config.REALTIME_NODE_ID }));
      return;
    }
    if (req.url === '/ready') {
      // Socket.IO is ready as soon as the adapter's Redis connections are up.
      const ready = redis.status === 'ready' && pubClient.status === 'ready';
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'error', service: 'realtime' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io: T2WServer = new Server(httpServer, {
    path: config.REALTIME_PATH,
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
    // Cap inbound frames. SDP is the legitimate worst case at a few KB; anything larger
    // is either a bug or an attempt to exhaust memory across many sockets.
    maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
    // Prefer a real WebSocket. Long-polling still works behind an awkward proxy, but it
    // adds a full request/response round trip to every signaling message.
    transports: ['websocket', 'polling'],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectionStateRecovery: {
      // A brief network blip should not tear down a live call.
      maxDisconnectionDuration: 30_000,
      skipMiddlewares: false,
    },
  });

  // Redis adapter: lets any node deliver a message to a socket owned by any other node,
  // which is what makes horizontal scaling of the realtime tier possible at all.
  io.adapter(createAdapter(pubClient, subClient));

  const nsp = io.of(REALTIME_NAMESPACE);

  /* ---------------------------------------------------------------- */
  /* Authentication                                                    */
  /* ---------------------------------------------------------------- */

  nsp.use(async (socket, next) => {
    try {
      const data = await authenticateSocket(socket as T2WSocket, {
        config,
        prisma,
        redis,
        keys,
        nodeId: config.REALTIME_NODE_ID,
      });
      Object.assign(socket.data, data);
      next();
    } catch (error) {
      if (error instanceof SocketAuthError) {
        logger.debug({ code: error.code }, 'Socket authentication rejected');
        next(new Error(error.code));
        return;
      }
      logger.error({ err: error }, 'Socket authentication failed unexpectedly');
      next(new Error(RealtimeErrorCode.INTERNAL));
    }
  });

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  const fail = (socket: T2WSocket, code: RealtimeErrorCode, message: string, extra = {}) => {
    const error: RealtimeError = { code, message, ...extra };
    socket.emit('error', error);
  };

  /** Room name for a user, so any node can address them. */
  const userRoom = (userId: string) => `user:${userId}`;

  /**
   * Per-socket, per-event token bucket.
   *
   * Held in memory rather than Redis on purpose: this is a flood guard against a single
   * misbehaving socket, and the socket only exists on this node. A Redis round trip per
   * event would add latency to signaling for no security benefit.
   */
  const buckets = new WeakMap<T2WSocket, Map<string, { count: number; resetAt: number }>>();

  const allow = (socket: T2WSocket, event: string, limit: number, windowMs: number): boolean => {
    let map = buckets.get(socket);
    if (!map) {
      map = new Map();
      buckets.set(socket, map);
    }
    const now = Date.now();
    const bucket = map.get(event);

    if (!bucket || bucket.resetAt <= now) {
      map.set(event, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };

  /**
   * Validate an inbound payload. Every client event goes through this — the TypeScript
   * types describe the contract, but a WebSocket frame is attacker-controlled input
   * exactly like an HTTP body.
   */
  function parse<S extends z.ZodTypeAny>(
    socket: T2WSocket,
    event: string,
    schema: S,
    payload: unknown,
  ): z.infer<S> | null {
    const result = schema.safeParse(payload);
    if (result.success) return result.data;

    fail(socket, RealtimeErrorCode.INVALID_PAYLOAD, 'That request was not valid.', { event });
    logger.debug({ event, issues: result.error.issues.length }, 'Rejected invalid socket payload');
    return null;
  }

  /**
   * Announce a match to both participants.
   *
   * Each side receives its own payload: a distinct `isInitiator` flag and ICE credentials
   * derived for that specific user. The partner profile is built through the privacy
   * funnel, so a partner never receives more than the owner's settings permit.
   */
  async function announceMatch(
    matchId: string,
    a: { userId: string; isInitiator: boolean },
    b: { userId: string; isInitiator: boolean },
    sharedInterestIds: string[],
    negotiationTimeoutMs: number,
  ): Promise<void> {
    await queue.saveMatch(matchId, a.userId, b.userId);

    const [rowA, rowB] = await Promise.all([
      loadMatchCandidate(a.userId, prisma),
      loadMatchCandidate(b.userId, prisma),
    ]);
    if (!rowA || !rowB) {
      logger.error({ matchId }, 'Match participant vanished before announcement');
      return;
    }

    const profileA = toPublicProfileFromRow(rowA);
    const profileB = toPublicProfileFromRow(rowB);
    const startedAt = new Date().toISOString();

    const iceFor = (userId: string) =>
      config.turnConfigured
        ? buildIceServers(userId, {
            secret: config.TURN_SECRET,
            host: config.TURN_DOMAIN!,
            port: config.TURN_PORT,
            tlsPort: config.TURN_TLS_PORT,
            enableTcp: config.TURN_ENABLE_TCP,
            enableTls: config.TURN_ENABLE_TLS,
          })
        : [];

    nsp.to(userRoom(a.userId)).emit('match:found', {
      matchId,
      partner: profileB,
      isInitiator: a.isInitiator,
      iceServers: iceFor(a.userId),
      sharedInterests: sharedInterestIds,
      negotiationTimeoutMs,
      startedAt,
    });

    nsp.to(userRoom(b.userId)).emit('match:found', {
      matchId,
      partner: profileA,
      isInitiator: b.isInitiator,
      iceServers: iceFor(b.userId),
      sharedInterests: sharedInterestIds,
      negotiationTimeoutMs,
      startedAt,
    });
  }

  /** Attempt a pairing for a queued user and announce it if one is found. */
  async function attemptMatch(userId: string): Promise<boolean> {
    const matchSettings = await settings();
    const result = await matchmaker.tryMatch(userId, matchSettings);
    if (!result) return false;

    await announceMatch(
      result.matchId,
      result.seeker,
      result.partner,
      result.sharedInterestIds,
      matchSettings.negotiationTimeoutMs,
    );
    return true;
  }

  /**
   * Tear a match down and notify the peer.
   *
   * `requeueInitiator` distinguishes Next (the presser goes straight back to searching)
   * from End (they return to idle). The peer is always told, and is requeued according to
   * their own autoRequeue preference rather than the other side's action.
   */
  async function teardownMatch(
    matchId: string,
    actorId: string | null,
    reason: MatchEndReason,
  ): Promise<{ peerId: string | null }> {
    const participants = await queue.getMatchParticipants(matchId);
    if (!participants) return { peerId: null };

    const { userA, userB } = participants;
    const peerId = actorId === userA ? userB : actorId === userB ? userA : null;

    await matchmaker.endMatch(matchId, [userA, userB], reason, actorId);
    await queue.deleteMatch(matchId);

    if (peerId) {
      nsp.to(userRoom(peerId)).emit('match:partner-left', { matchId, reason });
    }

    return { peerId };
  }

  /* ---------------------------------------------------------------- */
  /* Connection                                                        */
  /* ---------------------------------------------------------------- */

  nsp.on('connection', (socket: T2WSocket) => {
    const { userId } = socket.data;

    void (async () => {
      await socket.join(userRoom(userId));
      await presence.connect(userId, socket.id);

      socket.emit('ready', {
        userId,
        nodeId: config.REALTIME_NODE_ID,
        serverTime: new Date().toISOString(),
      });
    })();

    logger.debug({ userId, socketId: socket.id }, 'Socket connected');

    /* --- Presence ------------------------------------------------- */

    socket.on('presence:heartbeat', () => {
      void presence.heartbeat(userId);
    });

    /* --- Queue ---------------------------------------------------- */

    socket.on('queue:join', (payload, ack) => {
      void (async () => {
        if (!allow(socket, 'queue:join', RATE_LIMITS.queueJoin.limit, 60_000)) {
          return fail(socket, RealtimeErrorCode.RATE_LIMITED, 'Slow down a moment.');
        }

        const data = parse(socket, 'queue:join', queueJoinSchema, payload);
        if (!data) return;

        // Re-check account standing on entry to matchmaking. A socket can outlive the
        // ban that should have ended it, and matchmaking is where that actually harms
        // someone.
        const standing = await revalidateSocket(userId, prisma);
        if (!standing.ok) {
          socket.emit('account:restricted', { status: standing.status, reason: standing.reason });
          return fail(socket, RealtimeErrorCode.ACCOUNT_RESTRICTED, standing.reason);
        }

        if (await queue.currentMatch(userId)) {
          return fail(socket, RealtimeErrorCode.ALREADY_MATCHED, 'You are already in a chat.');
        }

        if (!data.hasCamera && !data.hasMicrophone) {
          return fail(
            socket,
            RealtimeErrorCode.INVALID_PAYLOAD,
            'A camera or microphone is required to start matching.',
          );
        }

        if (await queue.isQueued(userId)) {
          ack?.({ ok: true, data: { queued: true } });
          return;
        }

        const row = await loadMatchCandidate(userId, prisma);
        if (!row) return fail(socket, RealtimeErrorCode.INTERNAL, 'Could not load your profile.');

        // Blocks are read through a short cache; they change rarely but are consulted on
        // every queue join and every scan.
        let blocked = await queue.getCachedBlocks(userId);
        if (blocked === null) {
          blocked = await getBlockedUserIds(userId, prisma);
          await queue.cacheBlocks(userId, blocked);
        }

        const profile = toPublicProfile(
          {
            id: row.id,
            username: row.username,
            displayName: row.profile?.displayName ?? null,
            avatarUrl: row.profile?.avatarUrl ?? null,
            country: row.profile?.country ?? null,
            birthDate: row.profile?.birthDate ?? null,
            languages: row.profile?.languages ?? [],
            gender: (row.profile?.gender ?? null) as never,
            interests: row.interests.map((i) => i.interest.slug),
            bio: row.profile?.bio ?? null,
            emailVerified: row.emailVerified,
            plan: row.plan as never,
          },
          DEFAULT_PRIVACY_SETTINGS,
        );

        // Matching uses the true attributes, not the privacy-filtered view — hiding your
        // country from partners should not exclude you from country-based matching.
        const trueProfile = {
          ...profile,
          country: row.profile?.country ?? null,
          gender: (row.profile?.gender ?? null) as never,
          ageBracket: ageBracketFor(row.profile?.birthDate ?? null),
          languages: row.profile?.languages ?? [],
        };

        const overrides = data.preferences ?? {};
        const candidate = Matchmaker.buildCandidate({
          userId,
          plan: row.plan as never,
          profile: trueProfile,
          preferences: {
            preferredGender: overrides.preferredGender ?? row.preference?.preferredGender ?? 'ANY',
            preferredCountries:
              overrides.preferredCountries ?? row.preference?.preferredCountries ?? [],
            preferredLanguages:
              overrides.preferredLanguages ?? row.preference?.preferredLanguages ?? [],
            preferredAgeBrackets:
              overrides.preferredAgeBrackets ?? row.preference?.preferredAgeBrackets ?? [],
          },
          interestIds: overrides.interestIds ?? row.interests.map((i) => i.interest.slug),
          excludedUserIds: blocked,
          recentPartnerIds: await queue.recentPartners(userId),
          priorityQueueEnabled: false,
        });

        await queue.join(candidate);
        await presence.setState(userId, 'MATCHING');

        socket.emit('queue:joined', { joinedAt: new Date().toISOString() });
        ack?.({ ok: true, data: { queued: true } });

        // Try immediately — on a busy server most users match on this first attempt and
        // never see the searching state at all.
        await attemptMatch(userId);
      })().catch((error: unknown) => {
        logger.error({ err: error, userId }, 'queue:join failed');
        fail(socket, RealtimeErrorCode.INTERNAL, 'Could not start matching.');
      });
    });

    socket.on('queue:leave', (ack) => {
      void (async () => {
        const row = await loadMatchCandidate(userId, prisma);
        await queue.leave(userId, row?.profile?.country ?? null);
        await presence.setState(userId, 'ONLINE');
        socket.emit('queue:left');
        ack?.({ ok: true, data: { left: true } });
      })().catch(() => fail(socket, RealtimeErrorCode.INTERNAL, 'Could not leave the queue.'));
    });

    /* --- Match lifecycle ------------------------------------------ */

    socket.on('match:skip', (payload, ack) => {
      void (async () => {
        const data = parse(socket, 'match:skip', matchSkipSchema, payload);
        if (!data) return;

        const matchSettings = await settings();

        // Spacing between Next presses. Blunts skip-spam without hurting a real user who
        // is genuinely cycling quickly.
        const cooldown = await queue.checkSkipCooldown(
          userId,
          matchSettings.minSecondsBetweenSkips,
        );
        if (cooldown > 0) {
          return fail(socket, RealtimeErrorCode.SKIP_COOLDOWN, 'One moment before skipping again.', {
            retryAfterMs: cooldown * 1000,
          });
        }

        // Membership is verified from Redis, never from the client's claim.
        const peer = await queue.resolvePeer(data.matchId, userId);
        if (peer === null) {
          return fail(socket, RealtimeErrorCode.NOT_IN_MATCH, 'That conversation has ended.');
        }

        await teardownMatch(data.matchId, userId, MatchEndReason.SKIPPED);

        socket.emit('match:ended', {
          matchId: data.matchId,
          reason: MatchEndReason.SKIPPED,
          requeued: data.requeue,
        });
        ack?.({ ok: true, data: { skipped: true } });

        if (data.requeue) {
          socket.emit('queue:joined', { joinedAt: new Date().toISOString() });
        }
      })().catch((error: unknown) => {
        logger.error({ err: error, userId }, 'match:skip failed');
        fail(socket, RealtimeErrorCode.INTERNAL, 'Could not skip.');
      });
    });

    socket.on('match:end', (payload, ack) => {
      void (async () => {
        const data = parse(socket, 'match:end', matchEndSchema, payload);
        if (!data) return;

        const peer = await queue.resolvePeer(data.matchId, userId);
        if (peer === null) {
          return fail(socket, RealtimeErrorCode.NOT_IN_MATCH, 'That conversation has ended.');
        }

        await teardownMatch(data.matchId, userId, MatchEndReason.ENDED);
        await presence.setState(userId, 'ONLINE');

        socket.emit('match:ended', {
          matchId: data.matchId,
          reason: MatchEndReason.ENDED,
          requeued: false,
        });
        ack?.({ ok: true, data: { ended: true } });
      })().catch(() => fail(socket, RealtimeErrorCode.INTERNAL, 'Could not end the conversation.'));
    });

    socket.on('match:connected', (payload) => {
      void (async () => {
        const data = parse(socket, 'match:connected', matchConnectedSchema, payload);
        if (!data) return;
        if ((await queue.resolvePeer(data.matchId, userId)) === null) return;
        await presence.setState(userId, 'CONNECTED');
      })().catch(() => undefined);
    });

    /* --- WebRTC signaling ----------------------------------------- */

    /**
     * Signaling relay.
     *
     * Every frame is authorised the same way: resolve the peer from the Redis match
     * registry and refuse if the sender is not a participant. Trusting the client's
     * `matchId` would let anyone inject SDP or ICE into a stranger's conversation, which
     * is both a hijack primitive and a way to leak the target's IP via candidates.
     *
     * Delivery is addressed to the peer's user room, so it works regardless of which
     * node owns their socket.
     */
    const relay = <S extends z.ZodTypeAny>(
      event: 'webrtc:offer' | 'webrtc:answer' | 'webrtc:ice',
      schema: S,
    ) => {
      socket.on(event, (payload: unknown) => {
        void (async () => {
          if (!allow(socket, event, RATE_LIMITS.socketEvent.limit, 60_000)) {
            return fail(socket, RealtimeErrorCode.RATE_LIMITED, 'Too many signaling messages.');
          }

          const data = parse(socket, event, schema, payload);
          if (!data) return;

          const peerId = await queue.resolvePeer(data.matchId, userId);
          if (peerId === null) {
            logger.warn(
              { userId, matchId: data.matchId, event },
              'Signaling frame for a match the sender is not in',
            );
            return fail(socket, RealtimeErrorCode.NOT_IN_MATCH, 'That conversation has ended.');
          }

          nsp.to(userRoom(peerId)).emit(event, data as never);
        })().catch(() => undefined);
      });
    };

    relay('webrtc:offer', webrtcOfferSchema);
    relay('webrtc:answer', webrtcAnswerSchema);
    relay('webrtc:ice', webrtcIceSchema);

    /* --- Chat ----------------------------------------------------- */

    socket.on('chat:message', (payload, ack) => {
      void (async () => {
        if (!allow(socket, 'chat:message', RATE_LIMITS.chatMessage.limit, 15_000)) {
          return fail(socket, RealtimeErrorCode.RATE_LIMITED, 'You are sending messages too fast.');
        }

        const data = parse(socket, 'chat:message', chatMessageSchema, payload);
        if (!data) return;

        const peerId = await queue.resolvePeer(data.matchId, userId);
        if (peerId === null) {
          return fail(socket, RealtimeErrorCode.NOT_IN_MATCH, 'That conversation has ended.');
        }

        /**
         * Ephemeral by design: the message is relayed and never written to Postgres.
         * Retaining private conversation content by default would be a far larger harm
         * than the abuse it might help investigate — see docs/MODERATION.md.
         */
        const message = {
          id: randomUUID(),
          matchId: data.matchId,
          senderId: userId,
          body: data.body,
          sentAt: new Date().toISOString(),
        };

        nsp.to(userRoom(peerId)).emit('chat:message', message);
        socket.emit('chat:message', { ...message, clientId: data.clientId });
        ack?.({ ok: true, data: { id: message.id, sentAt: message.sentAt } });
      })().catch(() => fail(socket, RealtimeErrorCode.INTERNAL, 'Could not send that message.'));
    });

    /* --- Safety --------------------------------------------------- */

    socket.on('user:block', (payload, ack) => {
      void (async () => {
        const data = parse(socket, 'user:block', socketBlockSchema, payload);
        if (!data) return;
        if (data.userId === userId) {
          return fail(socket, RealtimeErrorCode.INVALID_PAYLOAD, 'You cannot block yourself.');
        }

        await prisma.block.upsert({
          where: { blockerId_blockedUserId: { blockerId: userId, blockedUserId: data.userId } },
          create: { blockerId: userId, blockedUserId: data.userId },
          update: {},
        });

        // Both sides' caches must go: blocks are enforced bidirectionally, so a stale
        // cache on either user would let the pair be matched again.
        await Promise.all([queue.invalidateBlocks(userId), queue.invalidateBlocks(data.userId)]);

        if (data.matchId) {
          await teardownMatch(data.matchId, userId, MatchEndReason.BLOCKED);
          socket.emit('match:ended', {
            matchId: data.matchId,
            reason: MatchEndReason.BLOCKED,
            requeued: false,
          });
        }

        ack?.({ ok: true, data: { blocked: true } });
      })().catch(() => fail(socket, RealtimeErrorCode.INTERNAL, 'Could not block that user.'));
    });

    socket.on('user:report', (payload, ack) => {
      void (async () => {
        if (!allow(socket, 'user:report', RATE_LIMITS.report.limit, 3_600_000)) {
          return fail(socket, RealtimeErrorCode.RATE_LIMITED, 'Too many reports.');
        }

        const data = parse(socket, 'user:report', socketReportSchema, payload);
        if (!data) return;
        if (data.reportedUserId === userId) {
          return fail(socket, RealtimeErrorCode.INVALID_PAYLOAD, 'You cannot report yourself.');
        }

        const report = await prisma.report.create({
          data: {
            reporterId: userId,
            reportedUserId: data.reportedUserId,
            matchId: data.matchId,
            category: data.category as never,
            details: data.details ?? null,
          },
          select: { id: true },
        });

        if (data.alsoBlock) {
          await prisma.block
            .upsert({
              where: {
                blockerId_blockedUserId: {
                  blockerId: userId,
                  blockedUserId: data.reportedUserId,
                },
              },
              create: { blockerId: userId, blockedUserId: data.reportedUserId },
              update: {},
            })
            .catch(() => undefined);

          await Promise.all([
            queue.invalidateBlocks(userId),
            queue.invalidateBlocks(data.reportedUserId),
          ]);
        }

        if (data.matchId) {
          await teardownMatch(data.matchId, userId, MatchEndReason.REPORTED);
          socket.emit('match:ended', {
            matchId: data.matchId,
            reason: MatchEndReason.REPORTED,
            requeued: false,
          });
        }

        ack?.({ ok: true, data: { reportId: report.id } });
      })().catch((error: unknown) => {
        logger.error({ err: error, userId }, 'user:report failed');
        fail(socket, RealtimeErrorCode.INTERNAL, 'Could not file that report.');
      });
    });

    /* --- Tipping -------------------------------------------------- */

    /**
     * Send a tip to the person you are talking to.
     *
     * The token transfer is atomic and happens before anything is announced, so a failed
     * debit never produces a visible tip. A tip may carry an offer of extra call time —
     * but that is an OFFER: the recipient accepts or declines, the tokens move either
     * way, and Next / report / block are never affected by any of this. A paid way to
     * hold someone in a call would be a harassment tool, so it does not exist.
     */
    socket.on('tip:send', (payload, ack) => {
      void (async () => {
        if (!allow(socket, 'tip:send', 30, 60_000)) {
          return fail(socket, RealtimeErrorCode.RATE_LIMITED, 'Slow down a moment.');
        }

        const data = parse(socket, 'tip:send', sendTipSocketSchema, payload);
        if (!data) return;

        const peerId = await queue.resolvePeer(data.matchId, userId);
        if (peerId === null) {
          return fail(socket, RealtimeErrorCode.NOT_IN_MATCH, 'That conversation has ended.');
        }

        try {
          const result = await tokens.sendTip({
            fromUserId: userId,
            toUserId: peerId,
            tokens: data.tokens,
            matchId: data.matchId,
            message: data.message,
            offeredSeconds: data.offeredSeconds,
          });

          const sentAt = new Date().toISOString();

          // Prefer the display name the partner is already seeing on screen. Using the
          // raw username here would name a different person to the one in the header.
          const senderRow = await loadMatchCandidate(userId, prisma).catch(() => null);
          const senderName =
            senderRow?.profile?.displayName?.trim() || socket.data.username;

          const base = {
            tipId: result.tipId,
            matchId: data.matchId,
            fromUserId: userId,
            fromName: senderName,
            tokens: data.tokens,
            message: data.message ?? null,
            offeredSeconds: data.offeredSeconds ?? null,
            sentAt,
          };

          nsp.to(userRoom(peerId)).emit('tip:received', { ...base, isOwn: false });
          socket.emit('tip:received', { ...base, isOwn: true });

          // Both balances changed; push each so neither header goes stale.
          socket.emit('tokens:balance', { balance: result.senderBalance });
          const recipientBalance = await tokens.getBalance(peerId);
          nsp.to(userRoom(peerId)).emit('tokens:balance', { balance: recipientBalance.balance });

          ack?.({ ok: true, data: { tipId: result.tipId, balance: result.senderBalance } });
        } catch (error) {
          const message =
            error instanceof Error && /enough tokens/i.test(error.message)
              ? 'You do not have enough tokens.'
              : 'Could not send that tip.';
          fail(socket, RealtimeErrorCode.INVALID_PAYLOAD, message);
        }
      })().catch((error: unknown) => {
        logger.error({ err: error, userId }, 'tip:send failed');
        fail(socket, RealtimeErrorCode.INTERNAL, 'Could not send that tip.');
      });
    });

    /**
     * Answer a time offer.
     *
     * Only the recipient may answer, enforced in the service. Declining costs nothing —
     * the tokens have already landed — so the choice is genuinely free.
     */
    socket.on('tip:respond', (payload, ack) => {
      void (async () => {
        const data = parse(socket, 'tip:respond', tipRespondSocketSchema, payload);
        if (!data) return;

        try {
          const tip = await tokens.respondToOffer(data.tipId, userId, data.accepted);

          const resolved = {
            tipId: data.tipId,
            accepted: data.accepted,
            extendedBySeconds: data.accepted ? tip.offeredSeconds : null,
          };

          socket.emit('tip:offer-resolved', resolved);
          if (tip.fromUserId) {
            nsp.to(userRoom(tip.fromUserId)).emit('tip:offer-resolved', resolved);
          }

          ack?.({ ok: true, data: { ok: true } });
        } catch {
          fail(socket, RealtimeErrorCode.INVALID_PAYLOAD, 'Could not record that response.');
        }
      })().catch(() => undefined);
    });

    /* --- Telemetry ------------------------------------------------ */

    socket.on('stats:report', (payload) => {
      void (async () => {
        const data = parse(socket, 'stats:report', (await import('@trip2world/validation')).connectionStatsSchema, payload);
        if (!data) return;

        await prisma.matchParticipant
          .updateMany({
            where: { matchId: data.matchId, userId },
            data: {
              connectionQuality: data.stats.quality,
              candidateType: data.stats.candidateType,
            },
          })
          .catch(() => undefined);
      })().catch(() => undefined);
    });

    /* --- Disconnect ----------------------------------------------- */

    socket.on('disconnect', (reason) => {
      void (async () => {
        const wasLast = await presence.disconnect(userId, socket.id);

        // Only tear the conversation down when the user's LAST socket goes. Refreshing
        // one of two tabs must not end a call in the other.
        if (!wasLast) return;

        const matchId = await queue.currentMatch(userId);
        if (matchId) {
          await teardownMatch(matchId, userId, MatchEndReason.DISCONNECTED);
        }

        const row = await loadMatchCandidate(userId, prisma).catch(() => null);
        await queue.leave(userId, row?.profile?.country ?? null);

        logger.debug({ userId, reason }, 'Socket disconnected');
      })().catch((error: unknown) => {
        logger.error({ err: error, userId }, 'Disconnect cleanup failed');
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /* Matchmaking tick                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Periodic sweep over the queue.
   *
   * A user who finds nobody on join stays queued; this is what eventually pairs them as
   * their relaxation stage widens or as new people arrive. Each node sweeps its own
   * connected users only — the Redis locks make concurrent sweeps across nodes safe, and
   * scanning only local sockets keeps the work proportional to the node's own load.
   */
  const tick = setInterval(() => {
    void (async () => {
      const sockets = await nsp.local.fetchSockets();

      // Total waiting across every node, so the client can tell the difference between
      // "still looking" and "nobody else is here". Without this the searching screen is
      // indistinguishable from a broken matchmaker — which is exactly the confusion an
      // empty queue produces.
      const searchingNow = await queue.size().catch(() => 0);
      const matchSettings = await settings();

      for (const socket of sockets) {
        const { userId } = socket.data as SocketData;
        try {
          if (!(await queue.isQueued(userId))) continue;
          if (await queue.currentMatch(userId)) continue;

          const matched = await attemptMatch(userId);
          if (matched) continue;

          const entry = await queue.getEntry(userId);
          if (!entry) continue;

          const waitingSeconds = Math.floor((Date.now() - entry.queuedAt) / 1000);
          const relaxationStage = relaxationStageFor(
            entry,
            Date.now(),
            matchSettings.relaxationStages,
          );

          nsp.to(userRoom(userId)).emit('queue:waiting', {
            position: await queue.position(userId, entry.country).catch(() => null),
            waitingSeconds,
            relaxationStage,
            hint: null,
            searchingNow,
          });
        } catch (error) {
          logger.error({ err: error, userId }, 'Matchmaking tick failed for user');
        }
      }
    })().catch((error: unknown) => logger.error({ err: error }, 'Matchmaking tick failed'));
  }, 1_000);
  tick.unref();

  /* ---------------------------------------------------------------- */
  /* Shutdown                                                          */
  /* ---------------------------------------------------------------- */

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);

    // Tell clients to expect a reconnect. Socket.IO reconnects with backoff, and the
    // jittered delay stops every client from returning at the same instant.
    nsp.emit('server:draining', { retryAfterMs: 2_000 });

    // Release every match this node was brokering, so nobody is left occupied by a
    // conversation that no longer exists. Their keys carry TTLs as a backstop, but
    // waiting an hour to be matchable again would be a terrible experience.
    const sockets = await nsp.local.fetchSockets().catch(() => []);
    await Promise.all(
      sockets.map(async (socket) => {
        const { userId } = socket.data as SocketData;
        const matchId = await queue.currentMatch(userId).catch(() => null);
        if (matchId) {
          await teardownMatch(matchId, null, MatchEndReason.SERVER_SHUTDOWN).catch(() => undefined);
        }
        await queue.leave(userId, null).catch(() => undefined);
      }),
    );

    await presence.clearNode().catch(() => undefined);
    io.close();
  };

  return { httpServer, io, shutdown };
}

export { PRESENCE_HEARTBEAT_MS };
