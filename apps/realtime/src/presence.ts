import { REDIS_TTL, type RedisKeyBuilder } from '@trip2world/shared';
import type { PresenceState } from '@trip2world/types';
import type { Redis } from 'ioredis';

/**
 * Presence tracking.
 *
 * Entirely in Redis, under a TTL. Two consequences worth stating explicitly:
 *
 *   - No Postgres write per heartbeat. At a 30-second heartbeat, 10 000 online users
 *     would be ~333 writes/second to durable storage for data that is worthless the
 *     instant the process restarts.
 *   - A client that dies without a clean disconnect simply expires. There is no sweeper
 *     job to fall behind and no ghost-user cleanup to get wrong.
 *
 * Multi-tab is handled by tracking socket ids in a set per user: presence only clears
 * when the last socket goes away, so closing one of three tabs does not mark the user
 * offline.
 */
export class PresenceService {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeyBuilder,
    private readonly nodeId: string,
  ) {}

  async connect(userId: string, socketId: string): Promise<void> {
    const pipeline = this.redis.multi();

    pipeline.hset(this.keys.presence(userId), {
      state: 'ONLINE',
      nodeId: this.nodeId,
      lastSeenAt: Date.now().toString(),
    });
    pipeline.expire(this.keys.presence(userId), REDIS_TTL.presence);

    pipeline.sadd(this.keys.userSockets(userId), socketId);
    pipeline.expire(this.keys.userSockets(userId), REDIS_TTL.presence);

    pipeline.sadd(this.keys.onlineSet(), userId);

    await pipeline.exec();
  }

  /** Refresh the TTL. Called on the client's heartbeat. */
  async heartbeat(userId: string): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.hset(this.keys.presence(userId), 'lastSeenAt', Date.now().toString());
    pipeline.expire(this.keys.presence(userId), REDIS_TTL.presence);
    pipeline.expire(this.keys.userSockets(userId), REDIS_TTL.presence);
    await pipeline.exec();
  }

  async setState(userId: string, state: PresenceState): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.hset(this.keys.presence(userId), {
      state,
      lastSeenAt: Date.now().toString(),
    });
    pipeline.expire(this.keys.presence(userId), REDIS_TTL.presence);
    await pipeline.exec();
  }

  /**
   * Remove one socket. Returns true when that was the user's last connection.
   *
   * The caller uses the return value to decide whether to tear down a match — a user
   * refreshing one of two tabs should not end their conversation.
   */
  async disconnect(userId: string, socketId: string): Promise<boolean> {
    await this.redis.srem(this.keys.userSockets(userId), socketId);
    const remaining = await this.redis.scard(this.keys.userSockets(userId));

    if (remaining > 0) return false;

    const pipeline = this.redis.multi();
    pipeline.del(this.keys.presence(userId));
    pipeline.del(this.keys.userSockets(userId));
    pipeline.srem(this.keys.onlineSet(), userId);
    await pipeline.exec();

    return true;
  }

  async getState(userId: string): Promise<PresenceState> {
    const state = await this.redis.hget(this.keys.presence(userId), 'state');
    return (state as PresenceState | null) ?? 'OFFLINE';
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.exists(this.keys.presence(userId))) === 1;
  }

  async onlineCount(): Promise<number> {
    return this.redis.scard(this.keys.onlineSet());
  }

  /**
   * Drop this node's presence records on shutdown.
   *
   * Without it, every user connected to a restarting node appears online for up to the
   * presence TTL, inflating the "searching now" count and letting matchmaking consider
   * users whose sockets are already gone.
   */
  async clearNode(): Promise<void> {
    const online = await this.redis.smembers(this.keys.onlineSet());
    if (online.length === 0) return;

    const pipeline = this.redis.multi();
    for (const userId of online) {
      pipeline.hget(this.keys.presence(userId), 'nodeId');
    }
    const results = await pipeline.exec();
    if (!results) return;

    const cleanup = this.redis.multi();
    online.forEach((userId, index) => {
      if (results[index]?.[1] === this.nodeId) {
        cleanup.del(this.keys.presence(userId));
        cleanup.del(this.keys.userSockets(userId));
        cleanup.srem(this.keys.onlineSet(), userId);
      }
    });
    await cleanup.exec();
  }
}
