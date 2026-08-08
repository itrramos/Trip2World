import { AgeBracket, Gender, GenderPreference } from '@trip2world/types';
import { describe, expect, it } from 'vitest';
import {
  activeConstraints,
  checkHardRules,
  DEFAULT_RELAXATION_STAGES,
  GLOBAL_SHARD,
  HardRuleViolation,
  type QueueCandidate,
  relaxationStageFor,
  satisfiesPreferences,
  scorePair,
  selectBestMatch,
  shardFor,
  shardsToScan,
} from './matchmaking.js';

const NOW = 1_700_000_000_000;

function candidate(overrides: Partial<QueueCandidate> & { userId: string }): QueueCandidate {
  return {
    queuedAt: NOW,
    gender: Gender.FEMALE,
    country: 'PT',
    languages: ['pt', 'en'],
    ageBracket: AgeBracket.AGE_25_34,
    interestIds: [],
    preferredGender: GenderPreference.ANY,
    preferredCountries: [],
    preferredLanguages: [],
    preferredAgeBrackets: [],
    excludedUserIds: [],
    recentPartnerIds: [],
    priority: 0,
    ...overrides,
  };
}

describe('hard rules', () => {
  it('never matches a user with themselves', () => {
    const a = candidate({ userId: 'a' });
    expect(checkHardRules(a, a)).toBe(HardRuleViolation.SELF);
  });

  it('respects a block in either direction', () => {
    const a = candidate({ userId: 'a', excludedUserIds: ['b'] });
    const b = candidate({ userId: 'b' });
    expect(checkHardRules(a, b)).toBe(HardRuleViolation.BLOCKED);
    expect(checkHardRules(b, a)).toBe(HardRuleViolation.BLOCKED);
  });

  it('refuses a user already occupied by another match', () => {
    const a = candidate({ userId: 'a' });
    const b = candidate({ userId: 'b' });
    expect(checkHardRules(a, b, new Set(['b']))).toBe(HardRuleViolation.OCCUPIED);
  });

  it('allows an otherwise unrelated pair', () => {
    expect(checkHardRules(candidate({ userId: 'a' }), candidate({ userId: 'b' }))).toBeNull();
  });
});

describe('relaxation ladder', () => {
  it('advances through stages as the wait grows', () => {
    const c = candidate({ userId: 'a', queuedAt: NOW });
    expect(relaxationStageFor(c, NOW)).toBe(0);
    expect(relaxationStageFor(c, NOW + 6_000)).toBe(1);
    expect(relaxationStageFor(c, NOW + 20_000)).toBe(2);
    expect(relaxationStageFor(c, NOW + 35_000)).toBe(3);
    expect(relaxationStageFor(c, NOW + 120_000)).toBe(4);
  });

  it('drops constraints in the documented order', () => {
    expect([...activeConstraints(0)].sort()).toEqual(
      ['ageBracket', 'country', 'gender', 'interests', 'language'].sort(),
    );
    expect(activeConstraints(1).has('interests')).toBe(false);
    expect(activeConstraints(2).has('language')).toBe(false);
    expect(activeConstraints(3).has('country')).toBe(false);
    // Final stage: any otherwise-compatible user.
    expect(activeConstraints(DEFAULT_RELAXATION_STAGES.length - 1).size).toBe(0);
  });
});

describe('preference satisfaction', () => {
  it('enforces gender preference while it is active', () => {
    const seeker = candidate({ userId: 'a', preferredGender: GenderPreference.MALE });
    const female = candidate({ userId: 'b', gender: Gender.FEMALE });
    const male = candidate({ userId: 'c', gender: Gender.MALE });

    expect(satisfiesPreferences(seeker, female, activeConstraints(0))).toBe(false);
    expect(satisfiesPreferences(seeker, male, activeConstraints(0))).toBe(true);
    // Last stage drops gender entirely.
    expect(satisfiesPreferences(seeker, female, activeConstraints(4))).toBe(true);
  });

  it('only matches an undeclared gender against someone with no preference', () => {
    const picky = candidate({ userId: 'a', preferredGender: GenderPreference.FEMALE });
    const anyone = candidate({ userId: 'b', preferredGender: GenderPreference.ANY });
    const undeclared = candidate({ userId: 'c', gender: null });

    expect(satisfiesPreferences(picky, undeclared, activeConstraints(0))).toBe(false);
    expect(satisfiesPreferences(anyone, undeclared, activeConstraints(0))).toBe(true);
  });

  it('enforces country preference until the location stage relaxes it', () => {
    const seeker = candidate({ userId: 'a', preferredCountries: ['DE'] });
    const portuguese = candidate({ userId: 'b', country: 'PT' });

    expect(satisfiesPreferences(seeker, portuguese, activeConstraints(0))).toBe(false);
    expect(satisfiesPreferences(seeker, portuguese, activeConstraints(3))).toBe(true);
  });

  it('requires at least one shared language when languages are constrained', () => {
    const seeker = candidate({ userId: 'a', preferredLanguages: ['de'] });
    expect(
      satisfiesPreferences(seeker, candidate({ userId: 'b', languages: ['pt'] }), activeConstraints(0)),
    ).toBe(false);
    expect(
      satisfiesPreferences(
        seeker,
        candidate({ userId: 'c', languages: ['de', 'en'] }),
        activeConstraints(0),
      ),
    ).toBe(true);
  });

  it('treats an empty preference list as no constraint', () => {
    const seeker = candidate({ userId: 'a', preferredCountries: [], preferredLanguages: [] });
    const anyone = candidate({ userId: 'b', country: 'JP', languages: ['ja'] });
    expect(satisfiesPreferences(seeker, anyone, activeConstraints(0))).toBe(true);
  });

  it('never hard-filters on interests, even at the strictest stage', () => {
    const seeker = candidate({ userId: 'a', interestIds: ['travel'] });
    const nothingInCommon = candidate({ userId: 'b', interestIds: ['cars'] });
    expect(satisfiesPreferences(seeker, nothingInCommon, activeConstraints(0))).toBe(true);
  });
});

describe('scoring', () => {
  it('rewards shared interests, capped', () => {
    const seeker = candidate({ userId: 'a', interestIds: ['travel', 'music', 'art', 'food', 'cars'] });
    const twin = candidate({ userId: 'b', interestIds: ['travel', 'music', 'art', 'food', 'cars'] });
    const stranger = candidate({ userId: 'c', interestIds: [] });

    const twinScore = scorePair(seeker, twin, NOW);
    expect(twinScore.sharedInterests).toBe(48); // capped at maxInterestBonus
    expect(twinScore.total).toBeGreaterThan(scorePair(seeker, stranger, NOW).total);
  });

  it('rewards a mutual country preference more than a one-sided one', () => {
    const a = candidate({ userId: 'a', country: 'PT', preferredCountries: ['DE'] });
    const mutual = candidate({ userId: 'b', country: 'DE', preferredCountries: ['PT'] });
    const oneSided = candidate({ userId: 'c', country: 'DE', preferredCountries: [] });

    expect(scorePair(a, mutual, NOW).countryPreference).toBe(15);
    expect(scorePair(a, oneSided, NOW).countryPreference).toBe(7);
  });

  it('penalises a recent partner heavily but not infinitely', () => {
    const a = candidate({ userId: 'a', recentPartnerIds: ['b'] });
    const b = candidate({ userId: 'b' });
    expect(scorePair(a, b, NOW).recentPartnerPenalty).toBe(-500);
  });

  it('grows the wait bonus with the longest-waiting side, capped', () => {
    const fresh = candidate({ userId: 'a', queuedAt: NOW });
    const patient = candidate({ userId: 'b', queuedAt: NOW - 500_000 });
    expect(scorePair(fresh, patient, NOW).waitTime).toBe(60); // maxWaitBonus
  });
});

describe('selectBestMatch', () => {
  it('returns null when the pool is empty', () => {
    expect(selectBestMatch(candidate({ userId: 'a' }), [], { now: NOW })).toBeNull();
  });

  it('never returns the seeker', () => {
    const a = candidate({ userId: 'a' });
    expect(selectBestMatch(a, [a], { now: NOW })).toBeNull();
  });

  it('picks the highest-scoring legal partner', () => {
    const seeker = candidate({ userId: 'a', interestIds: ['travel', 'music'] });
    const poor = candidate({ userId: 'b', interestIds: [] });
    const great = candidate({ userId: 'c', interestIds: ['travel', 'music'] });

    const result = selectBestMatch(seeker, [poor, great], { now: NOW });
    expect(result?.candidate.userId).toBe('c');
    expect(result?.sharedInterestIds).toEqual(['travel', 'music']);
  });

  it('prefers anyone over a recently skipped partner', () => {
    const seeker = candidate({ userId: 'a', recentPartnerIds: ['b'], interestIds: ['travel'] });
    // 'b' would otherwise win on shared interests.
    const skipped = candidate({ userId: 'b', interestIds: ['travel'] });
    const other = candidate({ userId: 'c', interestIds: [] });

    expect(selectBestMatch(seeker, [skipped, other], { now: NOW })?.candidate.userId).toBe('c');
  });

  it('falls back to a recent partner when nobody else is available', () => {
    const seeker = candidate({ userId: 'a', recentPartnerIds: ['b'] });
    const skipped = candidate({ userId: 'b' });
    expect(selectBestMatch(seeker, [skipped], { now: NOW })?.candidate.userId).toBe('b');
  });

  it('requires both sides to be satisfied at their own stage', () => {
    // Seeker has waited long enough to drop gender; candidate has not.
    const seeker = candidate({
      userId: 'a',
      gender: Gender.MALE,
      queuedAt: NOW - 120_000,
      preferredGender: GenderPreference.FEMALE,
    });
    const strictCandidate = candidate({
      userId: 'b',
      gender: Gender.MALE,
      queuedAt: NOW,
      preferredGender: GenderPreference.FEMALE,
    });

    // Candidate is still strict and the seeker is male, so no pairing.
    expect(selectBestMatch(seeker, [strictCandidate], { now: NOW })).toBeNull();

    // Once the candidate has also waited it out, the pairing is allowed.
    const patientCandidate = { ...strictCandidate, queuedAt: NOW - 120_000 };
    expect(selectBestMatch(seeker, [patientCandidate], { now: NOW })?.candidate.userId).toBe('b');
  });

  it('excludes blocked users regardless of how long anyone has waited', () => {
    const seeker = candidate({ userId: 'a', excludedUserIds: ['b'], queuedAt: NOW - 600_000 });
    const blocked = candidate({ userId: 'b', queuedAt: NOW - 600_000 });
    expect(selectBestMatch(seeker, [blocked], { now: NOW })).toBeNull();
  });

  it('excludes users already committed to another match', () => {
    const seeker = candidate({ userId: 'a' });
    const busy = candidate({ userId: 'b' });
    expect(
      selectBestMatch(seeker, [busy], { now: NOW, occupiedUserIds: new Set(['b']) }),
    ).toBeNull();
  });

  it('is deterministic across nodes for identical input', () => {
    const seeker = candidate({ userId: 'a' });
    const pool = [candidate({ userId: 'c' }), candidate({ userId: 'b' })];
    const first = selectBestMatch(seeker, pool, { now: NOW });
    const second = selectBestMatch(seeker, [...pool].reverse(), { now: NOW });
    expect(first?.candidate.userId).toBe(second?.candidate.userId);
  });

  it('records the relaxation stage each side was in', () => {
    const seeker = candidate({ userId: 'a', queuedAt: NOW - 40_000 });
    const other = candidate({ userId: 'b', queuedAt: NOW });
    const result = selectBestMatch(seeker, [other], { now: NOW });
    expect(result?.seekerStage).toBe(3);
    expect(result?.candidateStage).toBe(0);
  });
});

describe('sharding', () => {
  it('maps countries to coarse regions and unknowns to global', () => {
    expect(shardFor('PT')).toBe('eu');
    expect(shardFor('BR')).toBe('sa');
    expect(shardFor('JP')).toBe('as');
    expect(shardFor('ZZ')).toBe(GLOBAL_SHARD);
    expect(shardFor(null)).toBe(GLOBAL_SHARD);
  });

  it('scans only the local and global shards while country is constrained', () => {
    const seeker = candidate({ userId: 'a', country: 'PT' });
    expect(shardsToScan(seeker, 0).sort()).toEqual(['eu', GLOBAL_SHARD].sort());
  });

  it('includes shards for explicitly preferred countries', () => {
    const seeker = candidate({ userId: 'a', country: 'PT', preferredCountries: ['JP'] });
    expect(shardsToScan(seeker, 0)).toContain('as');
  });

  it('widens to every region once the country constraint is dropped', () => {
    const seeker = candidate({ userId: 'a', country: 'PT' });
    const shards = shardsToScan(seeker, 3);
    expect(shards).toEqual(expect.arrayContaining(['eu', 'na', 'sa', 'as', 'af', 'oc']));
  });
});
