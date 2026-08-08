import { AgeBracket, Gender, PlanTier } from '@trip2world/types';
import { describe, expect, it } from 'vitest';
import {
  ageBracketFor,
  assertNoPrivateFields,
  calculateAge,
  DEFAULT_PRIVACY_SETTINGS,
  type InternalUserRecord,
  meetsMinimumAge,
  toPublicProfile,
} from './privacy.js';

const NOW = new Date('2026-08-07T00:00:00.000Z');

const internalUser: InternalUserRecord = {
  id: 'user-1',
  username: 'ana',
  displayName: 'Ana',
  avatarUrl: 'https://cdn.example/a.png',
  country: 'PT',
  birthDate: '1996-03-15',
  languages: ['pt', 'en'],
  gender: Gender.FEMALE,
  interests: ['travel', 'music'],
  bio: 'Hello world',
  emailVerified: true,
  plan: PlanTier.FREE,

  // Sensitive fields that must never escape.
  email: 'ana@example.com',
  passwordHash: '$argon2id$v=19$...',
  lastIpHash: 'deadbeef',
  safetyScore: 42,
  role: 'USER',
  status: 'ACTIVE',
  moderatorNotes: 'watch this account',
  city: 'Lisboa',
  latitude: 38.72,
  longitude: -9.14,
};

describe('toPublicProfile', () => {
  it('exposes only the allow-listed keys', () => {
    const profile = toPublicProfile(internalUser);
    expect(Object.keys(profile).sort()).toEqual(
      [
        'id',
        'username',
        'displayName',
        'avatarUrl',
        'country',
        'ageBracket',
        'languages',
        'gender',
        'interests',
        'bio',
        'verified',
        'plan',
      ].sort(),
    );
  });

  it('never leaks credentials, contact details, or moderation metadata', () => {
    const profile = toPublicProfile(internalUser) as unknown as Record<string, unknown>;
    for (const forbidden of [
      'email',
      'passwordHash',
      'lastIpHash',
      'safetyScore',
      'role',
      'status',
      'moderatorNotes',
      'birthDate',
    ]) {
      expect(profile[forbidden]).toBeUndefined();
    }
  });

  it('never leaks precise location, only the country', () => {
    const profile = toPublicProfile(internalUser) as unknown as Record<string, unknown>;
    expect(profile.city).toBeUndefined();
    expect(profile.latitude).toBeUndefined();
    expect(profile.longitude).toBeUndefined();
    expect(profile.country).toBe('PT');
  });

  it('reduces the exact birth date to a coarse bracket', () => {
    const profile = toPublicProfile(internalUser);
    expect(profile.ageBracket).toBe(AgeBracket.AGE_25_34);
  });

  it('honours each privacy toggle', () => {
    const profile = toPublicProfile(internalUser, {
      ...DEFAULT_PRIVACY_SETTINGS,
      showDisplayName: false,
      showCountry: false,
      showAgeBracket: false,
      showGender: false,
      showInterests: false,
      showBio: false,
    });

    expect(profile.displayName).toBeNull();
    expect(profile.country).toBeNull();
    expect(profile.ageBracket).toBeNull();
    expect(profile.gender).toBeNull();
    expect(profile.interests).toEqual([]);
    expect(profile.bio).toBeNull();
  });

  it('always keeps id and username so reporting and blocking cannot be defeated', () => {
    const profile = toPublicProfile(internalUser, {
      ...DEFAULT_PRIVACY_SETTINGS,
      showDisplayName: false,
      showCountry: false,
      showAgeBracket: false,
      showGender: false,
      showInterests: false,
      showBio: false,
    });
    expect(profile.id).toBe('user-1');
    expect(profile.username).toBe('ana');
  });

  it('does not pass through unknown fields added to the source record', () => {
    const withNewColumn = { ...internalUser, secretInternalFlag: true } as InternalUserRecord;
    const profile = toPublicProfile(withNewColumn) as unknown as Record<string, unknown>;
    expect(profile.secretInternalFlag).toBeUndefined();
  });
});

describe('assertNoPrivateFields', () => {
  it('accepts a clean public profile', () => {
    expect(() => assertNoPrivateFields(toPublicProfile(internalUser))).not.toThrow();
  });

  it('catches a leak nested deep inside a payload', () => {
    const payload = { match: { partner: { id: 'x', email: 'leak@example.com' } } };
    expect(() => assertNoPrivateFields(payload)).toThrow(/email/);
  });

  it('catches a leak inside an array', () => {
    expect(() => assertNoPrivateFields({ users: [{ id: 'a' }, { passwordHash: 'x' }] })).toThrow(
      /passwordHash/,
    );
  });
});

describe('age handling', () => {
  it('computes whole years, accounting for a birthday that has not happened yet', () => {
    expect(calculateAge('1996-03-15', NOW)).toBe(30);
    expect(calculateAge('1996-12-31', NOW)).toBe(29);
    // Birthday today counts.
    expect(calculateAge('2000-08-07', NOW)).toBe(26);
    // Day before birthday does not.
    expect(calculateAge('2000-08-08', NOW)).toBe(25);
  });

  it('returns null for missing or unparseable input', () => {
    expect(calculateAge(null, NOW)).toBeNull();
    expect(calculateAge('not-a-date', NOW)).toBeNull();
  });

  it('buckets ages into the documented brackets', () => {
    expect(ageBracketFor('2007-01-01', NOW)).toBe(AgeBracket.AGE_18_24);
    expect(ageBracketFor('1998-01-01', NOW)).toBe(AgeBracket.AGE_25_34);
    expect(ageBracketFor('1988-01-01', NOW)).toBe(AgeBracket.AGE_35_44);
    expect(ageBracketFor('1978-01-01', NOW)).toBe(AgeBracket.AGE_45_54);
    expect(ageBracketFor('1960-01-01', NOW)).toBe(AgeBracket.AGE_55_PLUS);
  });

  it('gates the age minimum on the exact date, not the bracket', () => {
    // Turns 18 tomorrow.
    expect(meetsMinimumAge('2008-08-08', 18, NOW)).toBe(false);
    // Turned 18 today.
    expect(meetsMinimumAge('2008-08-07', 18, NOW)).toBe(true);
    expect(meetsMinimumAge(null, 18, NOW)).toBe(false);
  });
});

