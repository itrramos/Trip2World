import {
  type AgeBracket,
  type CountryCode,
  type Gender,
  GenderPreference,
  type LanguageCode,
  type RelaxableConstraint,
  type RelaxationStage,
  type UUID,
} from '@trip2world/types';

/**
 * Matchmaking rules.
 *
 * Everything in this file is a pure function over plain data so the pairing policy can be
 * unit-tested exhaustively without Redis, sockets, or a database. The realtime service
 * supplies candidate snapshots pulled from Redis and applies whatever this returns.
 *
 * Two categories of rule exist and the distinction is load-bearing:
 *
 *   HARD  — safety and correctness invariants. Never relaxed, never scored around.
 *           Self-matching, blocks, restricted accounts, already-occupied users.
 *   SOFT  — user taste. Progressively relaxed the longer someone waits, so a user with
 *           narrow preferences still eventually gets a conversation instead of a spinner.
 */

/** Snapshot of a queued user, as stored in Redis while they wait. */
export interface QueueCandidate {
  userId: UUID;
  /** Epoch ms the user entered the queue. Drives the relaxation stage. */
  queuedAt: number;

  // --- Attributes of this user ---
  gender: Gender | null;
  country: CountryCode | null;
  languages: LanguageCode[];
  ageBracket: AgeBracket | null;
  interestIds: string[];

  // --- What this user is looking for ---
  preferredGender: GenderPreference;
  preferredCountries: CountryCode[];
  preferredLanguages: LanguageCode[];
  preferredAgeBrackets: AgeBracket[];

  /** Users this candidate must never be paired with (blocks, both directions, merged). */
  excludedUserIds: string[];
  /** Recently-skipped partners; avoided when any alternative exists. */
  recentPartnerIds: string[];

  /** Higher tiers may be dequeued sooner when the operator enables priority queueing. */
  priority: number;
}

/** Default relaxation ladder. Operators can override this via system settings. */
export const DEFAULT_RELAXATION_STAGES: RelaxationStage[] = [
  { afterSeconds: 0, drop: [], label: 'strict' },
  { afterSeconds: 5, drop: ['interests'], label: 'relaxed-interests' },
  { afterSeconds: 15, drop: ['interests', 'ageBracket', 'language'], label: 'relaxed-secondary' },
  {
    afterSeconds: 30,
    drop: ['interests', 'ageBracket', 'language', 'country'],
    label: 'relaxed-location',
  },
  {
    afterSeconds: 60,
    drop: ['interests', 'ageBracket', 'language', 'country', 'gender'],
    label: 'any-available',
  },
];

/**
 * Which relaxation stage a candidate has reached.
 *
 * Returns the index into `stages`; higher means more permissive.
 */
export function relaxationStageFor(
  candidate: Pick<QueueCandidate, 'queuedAt'>,
  now: number,
  stages: RelaxationStage[] = DEFAULT_RELAXATION_STAGES,
): number {
  const waitedSeconds = Math.max(0, (now - candidate.queuedAt) / 1000);
  let index = 0;
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    if (stage && waitedSeconds >= stage.afterSeconds) index = i;
  }
  return index;
}

/** The soft constraints still being enforced at a given stage. */
export function activeConstraints(
  stageIndex: number,
  stages: RelaxationStage[] = DEFAULT_RELAXATION_STAGES,
): Set<RelaxableConstraint> {
  const all: RelaxableConstraint[] = ['interests', 'ageBracket', 'language', 'country', 'gender'];
  const dropped = new Set(stages[stageIndex]?.drop ?? []);
  return new Set(all.filter((c) => !dropped.has(c)));
}

/* -------------------------------------------------------------------------- */
/* Hard rules                                                                  */
/* -------------------------------------------------------------------------- */

export const HardRuleViolation = {
  SELF: 'SELF',
  BLOCKED: 'BLOCKED',
  OCCUPIED: 'OCCUPIED',
} as const;
export type HardRuleViolation = (typeof HardRuleViolation)[keyof typeof HardRuleViolation];

/**
 * Safety invariants that no amount of waiting will relax.
 *
 * Restricted (banned/suspended/deactivated) accounts are filtered out before they can ever
 * enter the queue, so they cannot appear as candidates here; blocks are merged
 * bidirectionally into `excludedUserIds` by the caller.
 */
export function checkHardRules(
  seeker: QueueCandidate,
  candidate: QueueCandidate,
  occupiedUserIds: ReadonlySet<string> = new Set(),
): HardRuleViolation | null {
  if (seeker.userId === candidate.userId) return HardRuleViolation.SELF;

  if (
    seeker.excludedUserIds.includes(candidate.userId) ||
    candidate.excludedUserIds.includes(seeker.userId)
  ) {
    return HardRuleViolation.BLOCKED;
  }

  if (occupiedUserIds.has(candidate.userId) || occupiedUserIds.has(seeker.userId)) {
    return HardRuleViolation.OCCUPIED;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Soft rules                                                                  */
/* -------------------------------------------------------------------------- */

function genderSatisfied(preference: GenderPreference, actual: Gender | null): boolean {
  if (preference === GenderPreference.ANY) return true;
  // A user who has not declared a gender can only be matched by someone with no preference.
  if (actual === null) return false;
  return preference === actual;
}

/**
 * Does `candidate` satisfy `seeker`'s soft preferences at `seeker`'s current stage?
 *
 * Note this is deliberately one-directional. Each side is evaluated against its *own*
 * relaxation stage, so a patient user with broad taste can be paired with an impatient
 * user with narrow taste as soon as the narrow one's stage permits — rather than both
 * being held hostage by the stricter of the two.
 */
export function satisfiesPreferences(
  seeker: QueueCandidate,
  candidate: QueueCandidate,
  active: ReadonlySet<RelaxableConstraint>,
): boolean {
  if (active.has('gender') && !genderSatisfied(seeker.preferredGender, candidate.gender)) {
    return false;
  }

  if (active.has('country') && seeker.preferredCountries.length > 0) {
    if (!candidate.country || !seeker.preferredCountries.includes(candidate.country)) return false;
  }

  if (active.has('language') && seeker.preferredLanguages.length > 0) {
    const overlap = candidate.languages.some((l) => seeker.preferredLanguages.includes(l));
    if (!overlap) return false;
  }

  if (active.has('ageBracket') && seeker.preferredAgeBrackets.length > 0) {
    if (!candidate.ageBracket || !seeker.preferredAgeBrackets.includes(candidate.ageBracket)) {
      return false;
    }
  }

  // Interests never hard-filter even at the strictest stage — they only boost the score.
  return true;
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export interface ScoreBreakdown {
  total: number;
  sharedInterests: number;
  sharedLanguages: number;
  countryPreference: number;
  waitTime: number;
  priority: number;
  recentPartnerPenalty: number;
}

export const SCORE_WEIGHTS = {
  perSharedInterest: 12,
  maxInterestBonus: 48,
  perSharedLanguage: 8,
  maxLanguageBonus: 16,
  /** Both sides got a country they asked for. */
  mutualCountryPreference: 15,
  oneSidedCountryPreference: 7,
  /** Per second waited, capped — keeps the queue fair without starving good matches. */
  perWaitSecond: 1.5,
  maxWaitBonus: 60,
  /** Applied per priority level for paid tiers, when priority queueing is enabled. */
  perPriorityLevel: 10,
  /** Strong negative so a recent partner is only chosen when nothing else is available. */
  recentPartnerPenalty: -500,
} as const;

/**
 * Rank a legal pairing. Higher is better.
 *
 * The recent-partner penalty is intentionally large rather than an absolute exclusion:
 * on a quiet server, being reconnected to the one other person online beats being told
 * nobody is available. When alternatives exist the penalty guarantees they win.
 */
export function scorePair(
  seeker: QueueCandidate,
  candidate: QueueCandidate,
  now: number,
): ScoreBreakdown {
  const sharedInterestIds = seeker.interestIds.filter((id) => candidate.interestIds.includes(id));
  const sharedInterests = Math.min(
    sharedInterestIds.length * SCORE_WEIGHTS.perSharedInterest,
    SCORE_WEIGHTS.maxInterestBonus,
  );

  const sharedLanguageCodes = seeker.languages.filter((l) => candidate.languages.includes(l));
  const sharedLanguages = Math.min(
    sharedLanguageCodes.length * SCORE_WEIGHTS.perSharedLanguage,
    SCORE_WEIGHTS.maxLanguageBonus,
  );

  const seekerWantsCandidateCountry =
    seeker.preferredCountries.length > 0 &&
    candidate.country !== null &&
    seeker.preferredCountries.includes(candidate.country);
  const candidateWantsSeekerCountry =
    candidate.preferredCountries.length > 0 &&
    seeker.country !== null &&
    candidate.preferredCountries.includes(seeker.country);

  let countryPreference = 0;
  if (seekerWantsCandidateCountry && candidateWantsSeekerCountry) {
    countryPreference = SCORE_WEIGHTS.mutualCountryPreference;
  } else if (seekerWantsCandidateCountry || candidateWantsSeekerCountry) {
    countryPreference = SCORE_WEIGHTS.oneSidedCountryPreference;
  }

  // Reward the pair for how long the *longest*-waiting side has been queued.
  const oldestQueuedAt = Math.min(seeker.queuedAt, candidate.queuedAt);
  const waitTime = Math.min(
    ((now - oldestQueuedAt) / 1000) * SCORE_WEIGHTS.perWaitSecond,
    SCORE_WEIGHTS.maxWaitBonus,
  );

  const priority = candidate.priority * SCORE_WEIGHTS.perPriorityLevel;

  const isRecentPartner =
    seeker.recentPartnerIds.includes(candidate.userId) ||
    candidate.recentPartnerIds.includes(seeker.userId);
  const recentPartnerPenalty = isRecentPartner ? SCORE_WEIGHTS.recentPartnerPenalty : 0;

  const total =
    sharedInterests +
    sharedLanguages +
    countryPreference +
    waitTime +
    priority +
    recentPartnerPenalty;

  return {
    total,
    sharedInterests,
    sharedLanguages,
    countryPreference,
    waitTime,
    priority,
    recentPartnerPenalty,
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export interface MatchSelection {
  candidate: QueueCandidate;
  score: ScoreBreakdown;
  sharedInterestIds: string[];
  /** Relaxation stage each side was in when the pairing was made — useful for telemetry. */
  seekerStage: number;
  candidateStage: number;
}

export interface SelectOptions {
  now: number;
  stages?: RelaxationStage[];
  /** Users the caller knows are mid-pairing on another node. */
  occupiedUserIds?: ReadonlySet<string>;
}

/**
 * Pick the best legal partner for `seeker` from `pool`, or `null` if none qualifies.
 *
 * Deterministic given the same inputs: ties break on the earliest `queuedAt`, then on
 * user id, so two realtime nodes evaluating the same pool reach the same answer and the
 * Redis lock only has to settle genuine races rather than arbitrary disagreement.
 */
export function selectBestMatch(
  seeker: QueueCandidate,
  pool: readonly QueueCandidate[],
  options: SelectOptions,
): MatchSelection | null {
  const { now, stages = DEFAULT_RELAXATION_STAGES, occupiedUserIds = new Set<string>() } = options;

  const seekerStage = relaxationStageFor(seeker, now, stages);
  const seekerActive = activeConstraints(seekerStage, stages);

  let best: MatchSelection | null = null;

  for (const candidate of pool) {
    if (checkHardRules(seeker, candidate, occupiedUserIds) !== null) continue;

    if (!satisfiesPreferences(seeker, candidate, seekerActive)) continue;

    const candidateStage = relaxationStageFor(candidate, now, stages);
    const candidateActive = activeConstraints(candidateStage, stages);
    if (!satisfiesPreferences(candidate, seeker, candidateActive)) continue;

    const score = scorePair(seeker, candidate, now);

    if (best === null || isBetter(score, candidate, best)) {
      best = {
        candidate,
        score,
        sharedInterestIds: seeker.interestIds.filter((id) => candidate.interestIds.includes(id)),
        seekerStage,
        candidateStage,
      };
    }
  }

  return best;
}

function isBetter(score: ScoreBreakdown, candidate: QueueCandidate, current: MatchSelection) {
  if (score.total !== current.score.total) return score.total > current.score.total;
  if (candidate.queuedAt !== current.candidate.queuedAt) {
    return candidate.queuedAt < current.candidate.queuedAt;
  }
  return candidate.userId < current.candidate.userId;
}

/**
 * Queue shard key for a candidate.
 *
 * Sharding by coarse region keeps each sorted set small enough to scan cheaply while
 * still letting the engine widen its search to the global shard once a user's stage has
 * dropped the country constraint.
 */
export const GLOBAL_SHARD = 'global';

export function shardFor(country: CountryCode | null): string {
  if (!country) return GLOBAL_SHARD;
  return REGION_BY_COUNTRY[country.toUpperCase()] ?? GLOBAL_SHARD;
}

/** Coarse continental buckets. Deliberately not city- or GPS-level. */
export const REGION_BY_COUNTRY: Record<string, string> = {
  PT: 'eu', ES: 'eu', FR: 'eu', DE: 'eu', IT: 'eu', GB: 'eu', IE: 'eu', NL: 'eu', BE: 'eu',
  LU: 'eu', AT: 'eu', CH: 'eu', PL: 'eu', CZ: 'eu', SK: 'eu', HU: 'eu', RO: 'eu', BG: 'eu',
  GR: 'eu', HR: 'eu', SI: 'eu', RS: 'eu', SE: 'eu', NO: 'eu', DK: 'eu', FI: 'eu', IS: 'eu',
  EE: 'eu', LV: 'eu', LT: 'eu', UA: 'eu', TR: 'eu',
  US: 'na', CA: 'na', MX: 'na',
  BR: 'sa', AR: 'sa', CL: 'sa', CO: 'sa', PE: 'sa', UY: 'sa', PY: 'sa', BO: 'sa', EC: 'sa',
  VE: 'sa',
  JP: 'as', KR: 'as', CN: 'as', TW: 'as', HK: 'as', SG: 'as', MY: 'as', TH: 'as', VN: 'as',
  PH: 'as', ID: 'as', IN: 'as', PK: 'as', BD: 'as', AE: 'as', SA: 'as', IL: 'as',
  ZA: 'af', NG: 'af', KE: 'af', EG: 'af', MA: 'af', GH: 'af', TZ: 'af', ET: 'af', AO: 'af',
  MZ: 'af', CV: 'af',
  AU: 'oc', NZ: 'oc', FJ: 'oc',
};

/**
 * Which shards to scan for a seeker at a given relaxation stage.
 *
 * While the country constraint is still active there is no point looking outside the
 * user's own region unless they explicitly asked for specific countries.
 */
export function shardsToScan(
  seeker: QueueCandidate,
  stageIndex: number,
  stages: RelaxationStage[] = DEFAULT_RELAXATION_STAGES,
): string[] {
  const active = activeConstraints(stageIndex, stages);
  const shards = new Set<string>([GLOBAL_SHARD, shardFor(seeker.country)]);

  if (seeker.preferredCountries.length > 0) {
    for (const country of seeker.preferredCountries) shards.add(shardFor(country));
  }

  if (!active.has('country')) {
    for (const region of new Set(Object.values(REGION_BY_COUNTRY))) shards.add(region);
  }

  return [...shards];
}
