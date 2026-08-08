import { createRedisKeys } from '@trip2world/shared';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it } from 'vitest';
import { QueueRepository } from './queue.repository.js';

/**
 * Tests for the concurrency-critical parts of the queue: occupancy claims and pairing
 * locks. These are what stop one account being placed in two conversations at once, and
 * they are the pieces the pure matchmaking tests in `@trip2world/shared` cannot cover
 * because the behaviour only exists in the interaction with Redis.
 *
 * A minimal in-memory Redis stands in for the real thing. It implements only the commands
 * the repository uses, and — critically — implements `SET NX` and the compare-and-delete
 * Lua script with the same semantics, since those are the exact primitives being relied
 * on for mutual exclusion.
 */
class FakeRedis {
  private store = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private ttls = new Map<string, number>();

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    const flags = args.map((a) => String(a).toUpperCase());

    if (flags.includes('NX') && this.store.has(key)) return null;

    this.store.set(key, value);

    const exIndex = flags.indexOf('EX');
    if (exIndex >= 0) this.ttls.set(key, Number(args[exIndex + 1]));

    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    this.ttls.delete(key);
    this.hashes.delete(key);
    return this.store.delete(key) ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) || this.hashes.has(key) ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -1;
  }

  async hset(key: string, value: Record<string, string>): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, fieldValue] of Object.entries(value)) hash.set(field, fieldValue);
    this.hashes.set(key, hash);
    return Object.keys(value).length;
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    const hash = this.hashes.get(key);
    return fields.map((field) => hash?.get(field) ?? null);
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);
    return 1;
  }

  /** Only the compare-and-delete script is used; replicate its exact semantics. */
  async eval(_script: string, _numKeys: number, key: string, token: string): Promise<number> {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  /**
   * Minimal MULTI: record the calls, apply them on exec. Sufficient because the
   * repository only uses pipelines for grouping, never for optimistic locking (WATCH) —
   * the mutual exclusion that matters is done with SET NX, which is tested directly.
   */
  multi(): { exec: () => Promise<unknown[]> } & Record<string, (...args: never[]) => unknown> {
    const queued: (() => Promise<unknown>)[] = [];

    const proxy = new Proxy(
      {
        exec: async () => {
          const results: unknown[] = [];
          for (const thunk of queued) results.push([null, await thunk()]);
          return results;
        },
      },
      {
        get: (target, prop: string) => {
          if (prop === 'exec') return target.exec;
          return (...args: unknown[]) => {
            queued.push(async () =>
              (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[prop]?.(
                ...args,
              ),
            );
            return proxy;
          };
        },
      },
    );

    return proxy as never;
  }

  /** Visible for assertions. */
  peek(key: string): string | undefined {
    return this.store.get(key);
  }

  size(): number {
    return this.store.size;
  }
}

const keys = createRedisKeys('test');
let fake: FakeRedis;
let repo: QueueRepository;

beforeEach(() => {
  fake = new FakeRedis();
  repo = new QueueRepository(fake as unknown as Redis, keys);
});

describe('occupancy claims', () => {
  it('lets the first claimant win and refuses the second', async () => {
    expect(await repo.claimForMatch('user-a', 'match-1')).toBe(true);
    // A second node trying to place the same user into a different match must fail.
    expect(await repo.claimForMatch('user-a', 'match-2')).toBe(false);
  });

  it('keeps the original match id after a losing claim', async () => {
    await repo.claimForMatch('user-a', 'match-1');
    await repo.claimForMatch('user-a', 'match-2');
    expect(await repo.currentMatch('user-a')).toBe('match-1');
  });

  it('reports no match for an unoccupied user', async () => {
    expect(await repo.currentMatch('user-a')).toBeNull();
  });

  it('releases occupancy so the user can be matched again', async () => {
    await repo.claimForMatch('user-a', 'match-1');
    await repo.releaseMatch('user-a', 'match-1');

    expect(await repo.currentMatch('user-a')).toBeNull();
    expect(await repo.claimForMatch('user-a', 'match-2')).toBe(true);
  });

  /**
   * The dangerous case: a teardown from an OLD match arriving after the user has already
   * been paired into a new one. A plain DEL would evict them from the live conversation.
   */
  it('ignores a stale release from a previous match', async () => {
    await repo.claimForMatch('user-a', 'match-1');
    await repo.releaseMatch('user-a', 'match-1');
    await repo.claimForMatch('user-a', 'match-2');

    // Late teardown for the old match must not touch the new claim.
    await repo.releaseMatch('user-a', 'match-1');

    expect(await repo.currentMatch('user-a')).toBe('match-2');
  });
});

describe('pairing locks', () => {
  it('acquires both locks when neither is held', async () => {
    const { acquired, release } = await repo.acquirePairLocks('user-a', 'user-b', 'token-1');
    expect(acquired).toBe(true);
    await release();
  });

  it('refuses when the other user is already locked by another node', async () => {
    const first = await repo.acquirePairLocks('user-a', 'user-b', 'node-1');
    expect(first.acquired).toBe(true);

    const second = await repo.acquirePairLocks('user-b', 'user-c', 'node-2');
    expect(second.acquired).toBe(false);

    await first.release();
  });

  /**
   * Locks are always taken in ascending user-id order. Without that, node A holding
   * (user-a) while wanting (user-b) and node B holding (user-b) while wanting (user-a)
   * would deadlock. With it, one node simply fails on the first lock and moves on.
   */
  it('takes locks in a fixed order regardless of argument order', async () => {
    const forward = await repo.acquirePairLocks('user-a', 'user-b', 'node-1');
    expect(forward.acquired).toBe(true);

    // Reversed arguments describe the same pair and must therefore collide.
    const reversed = await repo.acquirePairLocks('user-b', 'user-a', 'node-2');
    expect(reversed.acquired).toBe(false);

    await forward.release();
  });

  /**
   * The rollback path. `user-a` sorts first, so it is locked before the attempt on
   * `user-z` fails. If that first lock were not released, `user-a` would be unable to
   * match with anyone until the lock TTL expired — a user-visible stall caused purely
   * by having been considered for a pairing that lost a race.
   */
  it('does not leak the first lock when the second cannot be taken', async () => {
    const blocker = await repo.acquirePairLocks('user-y', 'user-z', 'blocker');
    expect(blocker.acquired).toBe(true);

    const attempt = await repo.acquirePairLocks('user-a', 'user-z', 'node-2');
    expect(attempt.acquired).toBe(false);

    const retry = await repo.acquirePairLocks('user-a', 'user-b', 'node-3');
    expect(retry.acquired).toBe(true);

    await retry.release();
    await blocker.release();
  });

  /** Defence in depth behind the SELF hard rule: a self-pair can never take both locks. */
  it('cannot lock a user against themselves', async () => {
    const result = await repo.acquirePairLocks('user-a', 'user-a', 'node-1');
    expect(result.acquired).toBe(false);
  });

  it('frees both locks on release, allowing a later pairing', async () => {
    const first = await repo.acquirePairLocks('user-a', 'user-b', 'node-1');
    await first.release();

    const second = await repo.acquirePairLocks('user-a', 'user-b', 'node-2');
    expect(second.acquired).toBe(true);
    await second.release();

    // Nothing left behind.
    expect(fake.size()).toBe(0);
  });

  it('will not let one node release another node\'s lock', async () => {
    const held = await repo.acquirePairLocks('user-a', 'user-b', 'node-1');
    expect(held.acquired).toBe(true);

    // A different node's release attempt is a no-op because the token does not match.
    const impostor = await repo.acquirePairLocks('user-a', 'user-b', 'node-2');
    await impostor.release();

    // node-1 still holds it.
    expect(fake.peek(keys.matchLock('user-a'))).toBe('node-1');
    await held.release();
  });
});

/**
 * The match registry is the authority the signaling relay consults on every frame.
 * If `resolvePeer` ever returned a peer for a non-participant, any client could inject
 * SDP or ICE into a stranger's conversation.
 */
describe('match registry', () => {
  beforeEach(async () => {
    await repo.saveMatch('match-1', 'user-a', 'user-b');
  });

  it('resolves the peer from either side', async () => {
    expect(await repo.resolvePeer('match-1', 'user-a')).toBe('user-b');
    expect(await repo.resolvePeer('match-1', 'user-b')).toBe('user-a');
  });

  it('refuses a user who is not in the match', async () => {
    expect(await repo.resolvePeer('match-1', 'user-intruder')).toBeNull();
  });

  it('refuses an unknown match id', async () => {
    expect(await repo.resolvePeer('match-does-not-exist', 'user-a')).toBeNull();
  });

  it('refuses everyone once the match is torn down', async () => {
    await repo.deleteMatch('match-1');
    expect(await repo.resolvePeer('match-1', 'user-a')).toBeNull();
    expect(await repo.resolvePeer('match-1', 'user-b')).toBeNull();
  });

  it('exposes both participants for teardown', async () => {
    expect(await repo.getMatchParticipants('match-1')).toEqual({
      userA: 'user-a',
      userB: 'user-b',
    });
  });
});

describe('skip cooldown', () => {
  it('allows the first skip and blocks an immediate second', async () => {
    expect(await repo.checkSkipCooldown('user-a', 5)).toBe(0);
    // Second press within the window is refused, with the remaining seconds.
    expect(await repo.checkSkipCooldown('user-a', 5)).toBe(5);
  });

  it('tracks users independently', async () => {
    await repo.checkSkipCooldown('user-a', 5);
    expect(await repo.checkSkipCooldown('user-b', 5)).toBe(0);
  });

  it('is disabled when the configured spacing is zero', async () => {
    expect(await repo.checkSkipCooldown('user-a', 0)).toBe(0);
    expect(await repo.checkSkipCooldown('user-a', 0)).toBe(0);
  });
});
