import {
  GLOBAL_SHARD,
  type QueueCandidate,
  REDIS_TTL,
  type RedisKeyBuilder,
  shardFor,
} from '@trip2world/shared';
import type { Redis } from 'ioredis';

/**
 * Redis-backed matchmaking queue.
 *
 * Layout:
 *   t2w:queue:{shard}      sorted set, member = userId, score = queuedAt (epoch ms)
 *   t2w:queue-entry:{id}   JSON snapshot of the user's matching criteria, with a TTL
 *   t2w:queue-shards       set of shards that currently hold at least one waiter
 *   t2w:user-match:{id}    occupancy record; its existence means "in a conversation"
 *   t2w:match-lock:{id}    short-lived lock held only while a pairing is committed
 *
 * The criteria snapshot is written once at join rather than re-read from Postgres on
 * every scan. Matchmaking evaluates every waiting user against every candidate, so a
 * database read per comparison would put the queue's cost at O(n²) database round trips.
 */

/** Cap on how many candidates a single scan considers, per shard. */
const SCAN_LIMIT = 250;

/**
 * Release a lock only if we still hold it.
 *
 * A plain DEL would let a slow node delete a lock that had already expired and been
 * re-acquired by someone else, which would let two nodes commit conflicting pairings.
 * Comparing the token before deleting makes release safe; it must be atomic, hence Lua.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class QueueRepository {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeyBuilder,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Membership                                                          */
  /* ------------------------------------------------------------------ */

  async join(candidate: QueueCandidate): Promise<void> {
    const shard = shardFor(candidate.country);

    const pipeline = this.redis.multi();
    pipeline.set(
      this.keys.queueEntry(candidate.userId),
      JSON.stringify(candidate),
      'EX',
      REDIS_TTL.queueEntry,
    );
    pipeline.zadd(this.keys.queue(shard), candidate.queuedAt, candidate.userId);
    // Also index into the global shard so a fully-relaxed search finds everyone without
    // having to scan every regional shard.
    if (shard !== GLOBAL_SHARD) {
      pipeline.zadd(this.keys.queue(GLOBAL_SHARD), candidate.queuedAt, candidate.userId);
    }
    pipeline.sadd(this.keys.activeShards(), shard, GLOBAL_SHARD);

    await pipeline.exec();
  }

  async leave(userId: string, country: string | null): Promise<void> {
    const shard = shardFor(country);

    const pipeline = this.redis.multi();
    pipeline.del(this.keys.queueEntry(userId));
    pipeline.zrem(this.keys.queue(shard), userId);
    pipeline.zrem(this.keys.queue(GLOBAL_SHARD), userId);
    await pipeline.exec();
  }

  async isQueued(userId: string): Promise<boolean> {
    return (await this.redis.exists(this.keys.queueEntry(userId))) === 1;
  }

  async getEntry(userId: string): Promise<QueueCandidate | null> {
    const raw = await this.redis.get(this.keys.queueEntry(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as QueueCandidate;
    } catch {
      // Corrupt entry — drop it rather than letting it poison every scan.
      await this.redis.del(this.keys.queueEntry(userId));
      return null;
    }
  }

  /**
   * Load candidate snapshots from the given shards, oldest first.
   *
   * Ordering by queue age means the longest-waiting users are always considered, which
   * is what stops someone starving at the back of a busy queue. Entries whose TTL has
   * expired out from under the sorted set are skipped and cleaned up lazily.
   */
  async loadCandidates(shards: string[], excludeUserId: string): Promise<QueueCandidate[]> {
    const uniqueShards = [...new Set(shards)];

    const idLists = await Promise.all(
      uniqueShards.map((shard) => this.redis.zrange(this.keys.queue(shard), 0, SCAN_LIMIT - 1)),
    );

    const ids = [...new Set(idLists.flat())].filter((id) => id !== excludeUserId);
    if (ids.length === 0) return [];

    const raws = await this.redis.mget(ids.map((id) => this.keys.queueEntry(id)));

    const candidates: QueueCandidate[] = [];
    const stale: string[] = [];

    for (let i = 0; i < ids.length; i += 1) {
      const raw = raws[i];
      const id = ids[i]!;

      if (!raw) {
        stale.push(id);
        continue;
      }
      try {
        candidates.push(JSON.parse(raw) as QueueCandidate);
      } catch {
        stale.push(id);
      }
    }

    // A sorted-set member whose entry has expired would otherwise be re-read on every
    // scan forever, since nothing else removes it.
    if (stale.length > 0) {
      const pipeline = this.redis.multi();
      for (const shard of uniqueShards) pipeline.zrem(this.keys.queue(shard), ...stale);
      await pipeline.exec();
    }

    return candidates;
  }

  /** Users waiting in a shard. Used for the "N searching now" affordance and metrics. */
  async size(shard = GLOBAL_SHARD): Promise<number> {
    return this.redis.zcard(this.keys.queue(shard));
  }

  /** Position of a user in their shard, 1-based, or null if not queued. */
  async position(userId: string, country: string | null): Promise<number | null> {
    const rank = await this.redis.zrank(this.keys.queue(shardFor(country)), userId);
    return rank === null ? null : rank + 1;
  }

  /* ------------------------------------------------------------------ */
  /* Occupancy                                                           */
  /* ------------------------------------------------------------------ */

  /** The match a user is currently in, if any. */
  async currentMatch(userId: string): Promise<string | null> {
    return this.redis.get(this.keys.userMatch(userId));
  }

  /**
   * Claim a user for a match. Returns false if they were already claimed.
   *
   * `NX` makes this the atomic commit point for occupancy: the first writer wins and any
   * concurrent attempt on another node fails cleanly instead of overwriting.
   */
  async claimForMatch(userId: string, matchId: string): Promise<boolean> {
    const result = await this.redis.set(
      this.keys.userMatch(userId),
      matchId,
      'EX',
      REDIS_TTL.userMatch,
      'NX',
    );
    return result === 'OK';
  }

  /**
   * Release a user's occupancy, but only if they are still in the match we think they
   * are. Guards against a late teardown from an old match evicting the user from a new
   * one they have already been paired into.
   */
  async releaseMatch(userId: string, matchId: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.keys.userMatch(userId), matchId);
  }

  /* ------------------------------------------------------------------ */
  /* Live match registry                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Record who is in a match.
   *
   * This is the authority the signaling relay consults on every frame. Without it, a
   * client could send an offer or ICE candidate with an arbitrary `matchId` and have it
   * delivered into someone else's conversation — so membership is never taken from the
   * client's word, only from here.
   */
  async saveMatch(matchId: string, userA: string, userB: string): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.hset(this.keys.match(matchId), {
      userA,
      userB,
      startedAt: Date.now().toString(),
    });
    pipeline.expire(this.keys.match(matchId), REDIS_TTL.match);
    await pipeline.exec();
  }

  async getMatchParticipants(matchId: string): Promise<{ userA: string; userB: string } | null> {
    const data = await this.redis.hmget(this.keys.match(matchId), 'userA', 'userB');
    const [userA, userB] = data;
    if (!userA || !userB) return null;
    return { userA, userB };
  }

  /**
   * Resolve the other participant, returning null when `userId` is not in this match.
   * A null result is a security event, not a lookup miss — see the signaling handlers.
   */
  async resolvePeer(matchId: string, userId: string): Promise<string | null> {
    const participants = await this.getMatchParticipants(matchId);
    if (!participants) return null;
    if (participants.userA === userId) return participants.userB;
    if (participants.userB === userId) return participants.userA;
    return null;
  }

  async deleteMatch(matchId: string): Promise<void> {
    await this.redis.del(this.keys.match(matchId));
  }

  /* ------------------------------------------------------------------ */
  /* Pairing locks                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Acquire pairing locks for both users.
   *
   * Locks are always taken in ascending user-id order. Fixed ordering is what prevents
   * the classic deadlock where node A holds (user1) and wants (user2) while node B holds
   * (user2) and wants (user1) — with a consistent order, one of them simply fails to
   * take the first lock and moves on.
   *
   * Failure is not retried: another node is mid-pairing with this candidate, so the
   * right move is to try a different candidate rather than wait.
   */
  async acquirePairLocks(
    userA: string,
    userB: string,
    token: string,
  ): Promise<{ acquired: boolean; release: () => Promise<void> }> {
    const [first, second] = userA < userB ? [userA, userB] : [userB, userA];

    const acquire = async (userId: string): Promise<boolean> => {
      const result = await this.redis.set(
        this.keys.matchLock(userId),
        token,
        'EX',
        REDIS_TTL.matchLock,
        'NX',
      );
      return result === 'OK';
    };

    const releaseOne = async (userId: string): Promise<void> => {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.keys.matchLock(userId), token);
    };

    if (!(await acquire(first))) {
      return { acquired: false, release: async () => undefined };
    }

    if (!(await acquire(second))) {
      await releaseOne(first);
      return { acquired: false, release: async () => undefined };
    }

    return {
      acquired: true,
      release: async () => {
        await Promise.all([releaseOne(first), releaseOne(second)]);
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Skip cooldown                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Remember that two users have just been in a match together, so the scorer can avoid
   * pairing them again while alternatives exist. Stored as a sorted set scored by expiry
   * so old entries can be trimmed in one range delete.
   */
  async recordRecentPartner(userId: string, partnerId: string, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const key = this.keys.recentPartners(userId);

    const pipeline = this.redis.multi();
    pipeline.zadd(key, expiresAt, partnerId);
    pipeline.zremrangebyscore(key, 0, Date.now());
    pipeline.expire(key, ttlSeconds);
    await pipeline.exec();
  }

  async recentPartners(userId: string): Promise<string[]> {
    const key = this.keys.recentPartners(userId);
    // Anything scored below "now" has expired.
    await this.redis.zremrangebyscore(key, 0, Date.now());
    return this.redis.zrange(key, 0, -1);
  }

  /** Per-user spacing between Next presses. Returns seconds remaining, or 0 if allowed. */
  async checkSkipCooldown(userId: string, minSeconds: number): Promise<number> {
    if (minSeconds <= 0) return 0;

    const key = this.keys.skipCooldown(userId);
    const set = await this.redis.set(key, '1', 'EX', Math.ceil(minSeconds), 'NX');
    if (set === 'OK') return 0;

    const ttl = await this.redis.ttl(key);
    return ttl > 0 ? ttl : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Block cache                                                         */
  /* ------------------------------------------------------------------ */

  async cacheBlocks(userId: string, blockedIds: string[]): Promise<void> {
    const key = this.keys.blockCache(userId);
    const pipeline = this.redis.multi();
    pipeline.del(key);
    // A sentinel keeps an empty block list cached; without it, every user with no
    // blocks would miss the cache and hit Postgres on every queue join.
    pipeline.sadd(key, '__none__', ...blockedIds);
    pipeline.expire(key, REDIS_TTL.blockCache);
    await pipeline.exec();
  }

  async getCachedBlocks(userId: string): Promise<string[] | null> {
    const members = await this.redis.smembers(this.keys.blockCache(userId));
    if (members.length === 0) return null;
    return members.filter((m) => m !== '__none__');
  }

  async invalidateBlocks(userId: string): Promise<void> {
    await this.redis.del(this.keys.blockCache(userId));
  }
}
