import { type PrismaClient } from '@prisma/client';
import { DEFAULT_PRIVACY_SETTINGS, toPublicProfile } from '@trip2world/shared';
import { AccountStatus, type PublicProfile } from '@trip2world/types';
import { prisma as defaultClient } from './client.js';

/**
 * Query helpers that encode rules we never want re-implemented per call site.
 *
 * The block lookup in particular is a safety control: getting its direction wrong would
 * silently let a blocked pair be matched, so it exists exactly once, here.
 */

/**
 * Every user id that must be excluded from `userId`'s matchmaking.
 *
 * Blocks are stored directionally but enforced BOTH ways: if A blocked B, neither A nor B
 * may be shown the other. Callers get a single merged set and cannot get the direction
 * wrong.
 */
export async function getBlockedUserIds(
  userId: string,
  client: PrismaClient = defaultClient,
): Promise<string[]> {
  const rows = await client.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedUserId: userId }] },
    select: { blockerId: true, blockedUserId: true },
  });

  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.blockerId === userId ? row.blockedUserId : row.blockerId);
  }
  return [...ids];
}

/** Canonical ordering for the Connection table, so a pair cannot be stored twice. */
export function orderConnectionPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function areConnected(
  userA: string,
  userB: string,
  client: PrismaClient = defaultClient,
): Promise<boolean> {
  const [userAId, userBId] = orderConnectionPair(userA, userB);
  const row = await client.connection.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: { id: true },
  });
  return row !== null;
}

export async function isBlockedBetween(
  userA: string,
  userB: string,
  client: PrismaClient = defaultClient,
): Promise<boolean> {
  const row = await client.block.findFirst({
    where: {
      OR: [
        { blockerId: userA, blockedUserId: userB },
        { blockerId: userB, blockedUserId: userA },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The shape needed to build a matchmaking queue entry, loaded in one round trip.
 * Only fields the engine actually uses — no email, no password hash.
 */
export const MATCH_CANDIDATE_SELECT = {
  id: true,
  username: true,
  status: true,
  plan: true,
  emailVerified: true,
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
  preference: true,
  interests: { select: { interest: { select: { slug: true } } } },
} as const;

export type MatchCandidateRow = NonNullable<
  Awaited<ReturnType<typeof loadMatchCandidate>>
>;

export async function loadMatchCandidate(userId: string, client: PrismaClient = defaultClient) {
  return client.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: MATCH_CANDIDATE_SELECT,
  });
}

/**
 * Build the partner-safe profile for a user.
 *
 * Routes through `toPublicProfile`, the single privacy funnel, rather than hand-picking
 * fields — so a new profile column can never leak by being forgotten here.
 */
export function toPublicProfileFromRow(row: {
  id: string;
  username: string;
  emailVerified: boolean;
  plan: string;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
    bio: string | null;
    birthDate: Date;
    gender: string;
    country: string | null;
    languages: string[];
  } | null;
  privacy: {
    showDisplayName: boolean;
    showCountry: boolean;
    showAgeBracket: boolean;
    showGender: boolean;
    showInterests: boolean;
    showBio: boolean;
    allowConnectionRequests: boolean;
  } | null;
  interests: { interest: { slug: string } }[];
}): PublicProfile {
  return toPublicProfile(
    {
      id: row.id,
      username: row.username,
      displayName: row.profile?.displayName ?? null,
      avatarUrl: row.profile?.avatarUrl ?? null,
      country: row.profile?.country ?? null,
      birthDate: row.profile?.birthDate ?? null,
      languages: row.profile?.languages ?? [],
      gender: (row.profile?.gender ?? null) as PublicProfile['gender'],
      interests: row.interests.map((i) => i.interest.slug),
      bio: row.profile?.bio ?? null,
      emailVerified: row.emailVerified,
      plan: row.plan as PublicProfile['plan'],
    },
    row.privacy
      ? { ...DEFAULT_PRIVACY_SETTINGS, ...row.privacy, fieldOverrides: {} }
      : DEFAULT_PRIVACY_SETTINGS,
  );
}

/**
 * Resolve the account restriction currently in force, expiring stale suspensions.
 *
 * A suspension whose `expiresAt` has passed is treated as lifted on read rather than
 * relying on a sweeper job, so a user is never locked out longer than intended just
 * because the worker is down.
 */
export async function getActiveRestriction(
  userId: string,
  client: PrismaClient = defaultClient,
): Promise<{ status: 'SUSPENDED' | 'BANNED'; reason: string; expiresAt: Date | null } | null> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (!user) return null;

  if (user.status === AccountStatus.BANNED) {
    const ban = await client.ban.findFirst({
      where: { userId, liftedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, expiresAt: true, permanent: true },
    });
    if (ban && !ban.permanent && ban.expiresAt && ban.expiresAt <= new Date()) {
      // Temporary ban has run out — restore the account and let the request proceed.
      await client.$transaction([
        client.ban.updateMany({
          where: { userId, liftedAt: null },
          data: { liftedAt: new Date() },
        }),
        client.user.update({ where: { id: userId }, data: { status: AccountStatus.ACTIVE } }),
      ]);
      return null;
    }
    return {
      status: 'BANNED',
      reason: ban?.reason ?? 'Your account has been permanently restricted.',
      expiresAt: ban?.expiresAt ?? null,
    };
  }

  if (user.status === AccountStatus.SUSPENDED) {
    const suspension = await client.moderationAction.findFirst({
      where: { targetUserId: userId, type: 'SUSPENSION' },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, expiresAt: true },
    });

    if (suspension?.expiresAt && suspension.expiresAt <= new Date()) {
      await client.user.update({
        where: { id: userId },
        data: { status: AccountStatus.ACTIVE },
      });
      return null;
    }

    return {
      status: 'SUSPENDED',
      reason: suspension?.reason ?? 'Your account is temporarily restricted.',
      expiresAt: suspension?.expiresAt ?? null,
    };
  }

  return null;
}

/** Count of prior reports against a user, split by whether they were upheld. */
export async function getReportHistory(
  userId: string,
  client: PrismaClient = defaultClient,
): Promise<{ total: number; upheld: number }> {
  const [total, upheld] = await Promise.all([
    client.report.count({ where: { reportedUserId: userId } }),
    client.report.count({ where: { reportedUserId: userId, status: 'ACTIONED' } }),
  ]);
  return { total, upheld };
}
