/**
 * Central registry of every Redis key Trip2World uses.
 *
 * Nothing outside this file should build a Redis key by string concatenation. Keeping the
 * namespace in one place makes it possible to reason about what is ephemeral (and thus
 * excluded from backups), to scope a `SCAN` safely, and to run several environments
 * against a single Redis instance by changing `REDIS_PREFIX`.
 */

export const DEFAULT_REDIS_PREFIX = 't2w';

export interface RedisKeyBuilder {
  readonly prefix: string;

  /** Presence hash for a user: state, node, lastSeen. TTL-refreshed by heartbeats. */
  presence(userId: string): string;
  /** Set of all user ids currently considered online. */
  onlineSet(): string;
  /** Set of socket ids owned by one user, so multi-tab sessions can be reconciled. */
  userSockets(userId: string): string;

  /** Sorted set of queued users, scored by queue-entry timestamp (ms). */
  queue(shard: string): string;
  /** Hash of a queued user's matching criteria snapshot. */
  queueEntry(userId: string): string;
  /** Set of shards that currently have at least one waiting user. */
  activeShards(): string;

  /** Hash describing a live match. */
  match(matchId: string): string;
  /** Reverse index: which match a user is currently in. Doubles as the occupancy lock. */
  userMatch(userId: string): string;
  /** Mutual exclusion lock held while a pairing decision is being committed. */
  matchLock(userId: string): string;
  /** Sorted set of recently-seen partner ids, scored by expiry, for skip cooldowns. */
  recentPartners(userId: string): string;

  /** Cached set of user ids this user has blocked (either direction). */
  blockCache(userId: string): string;

  /** Generic fixed-window rate-limit counter. */
  rateLimit(bucket: string, identity: string): string;
  /** Per-user skip cooldown marker. */
  skipCooldown(userId: string): string;

  /** Short-lived single-use tokens (email verification, password reset) by hash. */
  oneTimeToken(kind: string, tokenHash: string): string;
  /** Refresh-token family generation counter, for reuse detection. */
  refreshFamily(sessionId: string): string;
  /** Denylist of revoked access-token session ids until their natural expiry. */
  revokedSession(sessionId: string): string;

  /** Cached system settings blob. */
  systemSettings(): string;
  /** Cached feature-flag map. */
  featureFlags(): string;

  /** Pub/sub channel used to push an event to whichever node owns a user's socket. */
  userChannel(userId: string): string;
  /** Distributed lock for singleton background work. */
  lock(name: string): string;

  /** Rolling counters used by the admin dashboard. */
  statCounter(name: string, bucket: string): string;
}

export function createRedisKeys(prefix: string = DEFAULT_REDIS_PREFIX): RedisKeyBuilder {
  const k = (...parts: (string | number)[]): string => [prefix, ...parts].join(':');

  return {
    prefix,

    presence: (userId) => k('presence', userId),
    onlineSet: () => k('online'),
    userSockets: (userId) => k('sockets', userId),

    queue: (shard) => k('queue', shard),
    queueEntry: (userId) => k('queue-entry', userId),
    activeShards: () => k('queue-shards'),

    match: (matchId) => k('match', matchId),
    userMatch: (userId) => k('user-match', userId),
    matchLock: (userId) => k('match-lock', userId),
    recentPartners: (userId) => k('recent-partners', userId),

    blockCache: (userId) => k('blocks', userId),

    rateLimit: (bucket, identity) => k('rate-limit', bucket, identity),
    skipCooldown: (userId) => k('skip-cooldown', userId),

    oneTimeToken: (kind, tokenHash) => k('ott', kind, tokenHash),
    refreshFamily: (sessionId) => k('refresh-family', sessionId),
    revokedSession: (sessionId) => k('revoked-session', sessionId),

    systemSettings: () => k('settings'),
    featureFlags: () => k('flags'),

    userChannel: (userId) => k('channel', 'user', userId),
    lock: (name) => k('lock', name),

    statCounter: (name, bucket) => k('stat', name, bucket),
  };
}

/**
 * Key prefixes holding purely ephemeral state.
 *
 * Losing these on a Redis restart is safe and expected: queues drain, matches are torn
 * down, and clients re-enter matchmaking. They must NOT be part of any backup or restore
 * procedure — see `docs/BACKUP_RESTORE.md`.
 */
export const EPHEMERAL_KEY_PREFIXES = [
  'presence',
  'online',
  'sockets',
  'queue',
  'queue-entry',
  'queue-shards',
  'match',
  'user-match',
  'match-lock',
  'recent-partners',
  'skip-cooldown',
  'rate-limit',
  'channel',
  'lock',
] as const;

/** Standard TTLs, in seconds. Centralised so operators can reason about memory usage. */
export const REDIS_TTL = {
  /** Presence expires shortly after the heartbeat interval so crashed clients vanish. */
  presence: 90,
  /** A queue entry that is never matched or cancelled self-destructs. */
  queueEntry: 600,
  /** Live match metadata. Refreshed while the match is active. */
  match: 3600,
  /** Occupancy lock — generous, but must expire so a crashed node cannot wedge a user. */
  userMatch: 3600,
  /** Short critical-section lock around the pairing commit. */
  matchLock: 10,
  /** How long two users are kept apart after a skip, when alternatives exist. */
  recentPartner: 1800,
  /** Cached block list. Invalidated explicitly on block/unblock. */
  blockCache: 300,
  /** Cached settings/flags. Invalidated explicitly on admin write. */
  settings: 60,
  /** Access-token revocation entries outlive the longest access token. */
  revokedSession: 3600,
} as const;
