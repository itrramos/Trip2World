import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  PLAN_PRIORITY,
  type QueueCandidate,
  relaxationStageFor,
  selectBestMatch,
  shardsToScan,
} from '@trip2world/shared';
import type { MatchmakingSettings, PlanTier, PublicProfile } from '@trip2world/types';
import type { Logger } from 'pino';
import type { QueueRepository } from './queue.repository.js';

/**
 * The matchmaking engine.
 *
 * Selection policy lives in `@trip2world/shared` as pure functions and is unit-tested
 * there. This class is only responsible for the parts that need the world: reading
 * candidates out of Redis, committing a pairing without double-booking anyone, and
 * writing the Match row.
 *
 * The commit is the delicate part. Two realtime nodes can independently decide to pair
 * the same user at the same instant, so the decision is not authoritative until Redis
 * says so:
 *
 *   1. Take pairing locks for both users, in a fixed order (prevents deadlock).
 *   2. Re-verify both are still queued and unoccupied — state may have changed while
 *      the locks were being taken.
 *   3. Claim occupancy with SET NX. If either claim fails, roll back the other.
 *   4. Only then remove them from the queue and announce the match.
 *
 * Every step is idempotent or reversible, so a node dying mid-commit leaves TTL'd keys
 * that expire rather than a user permanently wedged out of matchmaking.
 */

export interface MatchResult {
  matchId: string;
  seeker: { userId: string; isInitiator: boolean };
  partner: { userId: string; isInitiator: boolean };
  sharedInterestIds: string[];
  seekerStage: number;
  candidateStage: number;
}

export interface MatchmakerDeps {
  prisma: PrismaClient;
  queue: QueueRepository;
  logger: Logger;
  nodeId: string;
}

export class Matchmaker {
  constructor(private readonly deps: MatchmakerDeps) {}

  /**
   * Try to pair `seekerId` with someone.
   *
   * Returns null when nobody suitable is available — the normal case on a quiet server,
   * and not an error. The caller keeps the seeker queued and tries again on the next tick.
   */
  async tryMatch(seekerId: string, settings: MatchmakingSettings): Promise<MatchResult | null> {
    const { queue, logger } = this.deps;
    const now = Date.now();

    const seeker = await queue.getEntry(seekerId);
    if (!seeker) return null;

    // Already in a conversation — a stale tick, or the user was paired by another node
    // between this tick being scheduled and running.
    if (await queue.currentMatch(seekerId)) return null;

    const stage = relaxationStageFor(seeker, now, settings.relaxationStages);
    const shards = shardsToScan(seeker, stage, settings.relaxationStages);

    const pool = await queue.loadCandidates(shards, seekerId);
    if (pool.length === 0) return null;

    // Recent partners are read live rather than baked into the snapshot: the seeker may
    // have skipped several people since joining the queue.
    const seekerRecent = await queue.recentPartners(seekerId);
    const seekerWithRecent: QueueCandidate = { ...seeker, recentPartnerIds: seekerRecent };

    const selection = selectBestMatch(seekerWithRecent, pool, {
      now,
      stages: settings.relaxationStages,
    });
    if (!selection) return null;

    const partnerId = selection.candidate.userId;
    const lockToken = randomUUID();

    const { acquired, release } = await queue.acquirePairLocks(seekerId, partnerId, lockToken);
    if (!acquired) {
      // Another node is committing a pairing involving one of these users. Do not wait —
      // return and let the next tick pick a different candidate.
      return null;
    }

    try {
      // Re-verify under the lock. Between selection and acquisition either side may have
      // left the queue, been matched elsewhere, or disconnected.
      const [stillQueuedSeeker, stillQueuedPartner, seekerBusy, partnerBusy] = await Promise.all([
        queue.isQueued(seekerId),
        queue.isQueued(partnerId),
        queue.currentMatch(seekerId),
        queue.currentMatch(partnerId),
      ]);

      if (!stillQueuedSeeker || !stillQueuedPartner || seekerBusy || partnerBusy) {
        return null;
      }

      const matchId = randomUUID();

      // Occupancy claims are the true commit point. NX means the first writer wins even
      // if the lock somehow failed to exclude a competitor.
      if (!(await queue.claimForMatch(seekerId, matchId))) return null;

      if (!(await queue.claimForMatch(partnerId, matchId))) {
        // Partner was claimed by someone else in the gap. Roll back our own claim so the
        // seeker is not left occupied by a match that will never exist.
        await queue.releaseMatch(seekerId, matchId);
        return null;
      }

      // Both are now committed. Remove them from the queue before announcing, so a
      // concurrent scan cannot still see them as available.
      await Promise.all([
        queue.leave(seekerId, seeker.country),
        queue.leave(partnerId, selection.candidate.country),
      ]);

      await this.persistMatch(matchId, seekerId, partnerId, selection);

      // Remember the pairing so the scorer avoids an immediate rematch after a skip.
      await Promise.all([
        queue.recordRecentPartner(seekerId, partnerId, settings.skipCooldownSeconds),
        queue.recordRecentPartner(partnerId, seekerId, settings.skipCooldownSeconds),
      ]);

      logger.info(
        {
          matchId,
          seekerStage: selection.seekerStage,
          candidateStage: selection.candidateStage,
          score: Math.round(selection.score.total),
          poolSize: pool.length,
        },
        'Match created',
      );

      /**
       * Exactly one side creates the SDP offer. Deciding it here — rather than letting
       * both clients offer and resolving the collision — removes glare entirely. The
       * seeker offers because it is the side that just acted.
       */
      return {
        matchId,
        seeker: { userId: seekerId, isInitiator: true },
        partner: { userId: partnerId, isInitiator: false },
        sharedInterestIds: selection.sharedInterestIds,
        seekerStage: selection.seekerStage,
        candidateStage: selection.candidateStage,
      };
    } finally {
      await release();
    }
  }

  private async persistMatch(
    matchId: string,
    seekerId: string,
    partnerId: string,
    selection: { seekerStage: number; candidateStage: number },
  ): Promise<void> {
    const { prisma, logger, nodeId } = this.deps;

    try {
      await prisma.match.create({
        data: {
          id: matchId,
          nodeId,
          seekerStage: selection.seekerStage,
          candidateStage: selection.candidateStage,
          participants: {
            create: [
              { userId: seekerId, wasInitiator: true },
              { userId: partnerId, wasInitiator: false },
            ],
          },
        },
      });
    } catch (error) {
      // The conversation is already live in Redis and the users are connected. Failing
      // the match because the analytics write failed would be a worse outcome than
      // losing the row — but it must be loud, because reports reference match ids.
      logger.error({ err: error, matchId }, 'Failed to persist match row');
    }
  }

  /**
   * Tear down a match: release both users' occupancy and record why it ended.
   *
   * Safe to call more than once — releases are conditional on the match id, so a
   * duplicate teardown from a racing disconnect and skip cannot evict a user from a
   * conversation they have since started.
   */
  async endMatch(
    matchId: string,
    participantIds: string[],
    reason: string,
    endedById: string | null,
  ): Promise<void> {
    const { prisma, queue, logger } = this.deps;

    await Promise.all(participantIds.map((id) => queue.releaseMatch(id, matchId)));

    try {
      const match = await prisma.match.findUnique({
        where: { id: matchId },
        select: { startedAt: true, endedAt: true },
      });

      // Already finalised by whichever side got here first.
      if (!match || match.endedAt) return;

      const endedAt = new Date();
      await prisma.match.update({
        where: { id: matchId },
        data: {
          endedAt,
          endReason: reason as never,
          endedById,
          durationSeconds: Math.round((endedAt.getTime() - match.startedAt.getTime()) / 1000),
        },
      });

      await prisma.matchParticipant.updateMany({
        where: { matchId, leftAt: null },
        data: { leftAt: endedAt },
      });
    } catch (error) {
      logger.error({ err: error, matchId }, 'Failed to record match end');
    }
  }

  /**
   * Build the queue snapshot for a user.
   *
   * Reads everything the selection policy needs in one pass, and merges blocks from both
   * directions into a single exclusion list so the engine cannot get the direction wrong.
   */
  static buildCandidate(input: {
    userId: string;
    plan: PlanTier;
    profile: PublicProfile;
    preferences: {
      preferredGender: string;
      preferredCountries: string[];
      preferredLanguages: string[];
      preferredAgeBrackets: string[];
    };
    interestIds: string[];
    excludedUserIds: string[];
    recentPartnerIds: string[];
    priorityQueueEnabled: boolean;
  }): QueueCandidate {
    return {
      userId: input.userId,
      queuedAt: Date.now(),

      gender: input.profile.gender,
      country: input.profile.country,
      languages: input.profile.languages,
      ageBracket: input.profile.ageBracket,
      interestIds: input.interestIds,

      preferredGender: input.preferences.preferredGender as QueueCandidate['preferredGender'],
      preferredCountries: input.preferences.preferredCountries,
      preferredLanguages: input.preferences.preferredLanguages,
      preferredAgeBrackets: input.preferences
        .preferredAgeBrackets as QueueCandidate['preferredAgeBrackets'],

      excludedUserIds: input.excludedUserIds,
      recentPartnerIds: input.recentPartnerIds,

      // Priority is only ever applied when the operator has explicitly enabled it.
      // Paid queue-jumping is a product decision, not a default.
      priority: input.priorityQueueEnabled ? (PLAN_PRIORITY[input.plan] ?? 0) : 0,
    };
  }
}
