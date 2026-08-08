import {
  AgeBracket,
  type CountryCode,
  type Gender,
  type LanguageCode,
  type PlanTier,
  type PrivacySettings,
  type PublicProfile,
  type UUID,
} from '@trip2world/types';

/**
 * The single funnel through which user data reaches another user.
 *
 * If you are reviewing what a stranger can learn about someone during a match, this file
 * is the whole answer. `toPublicProfile` takes the full internal record and returns only
 * the allow-listed fields — it never spreads its input, so a new column added to the User
 * table cannot leak by accident. That property is what the accompanying tests assert.
 */

/** Superset of user data available server-side. Never serialized to a client as-is. */
export interface InternalUserRecord {
  id: UUID;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  country: CountryCode | null;
  birthDate: Date | string | null;
  languages: LanguageCode[];
  gender: Gender | null;
  interests: string[];
  bio: string | null;
  emailVerified: boolean;
  plan: PlanTier;

  // --- Everything below MUST NOT reach another user ---
  email?: string;
  passwordHash?: string;
  lastIpHash?: string | null;
  safetyScore?: number;
  role?: string;
  status?: string;
  moderatorNotes?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  showDisplayName: true,
  showCountry: true,
  showAgeBracket: true,
  showGender: true,
  showInterests: true,
  showBio: true,
  allowConnectionRequests: true,
  fieldOverrides: {},
};

/**
 * Project an internal user record down to what a match partner may see.
 *
 * Every optional field is gated on the owner's own privacy settings; `username` and `id`
 * are always present because they are required to report or block someone, which must
 * never be defeatable by tightening privacy.
 */
export function toPublicProfile(
  user: InternalUserRecord,
  privacy: PrivacySettings = DEFAULT_PRIVACY_SETTINGS,
): PublicProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: privacy.showDisplayName ? user.displayName : null,
    avatarUrl: user.avatarUrl,
    country: privacy.showCountry ? user.country : null,
    ageBracket: privacy.showAgeBracket ? ageBracketFor(user.birthDate) : null,
    languages: user.languages,
    gender: privacy.showGender ? user.gender : null,
    interests: privacy.showInterests ? user.interests : [],
    bio: privacy.showBio ? user.bio : null,
    verified: user.emailVerified,
    plan: user.plan,
  };
}

/** Field names that must never appear in any payload sent to another user. */
export const FORBIDDEN_PARTNER_FIELDS = [
  'email',
  'passwordHash',
  'password',
  'lastIpHash',
  'ipAddress',
  'safetyScore',
  'role',
  'status',
  'moderatorNotes',
  'city',
  'latitude',
  'longitude',
  'birthDate',
  'accessToken',
  'refreshToken',
] as const;

/**
 * Defence-in-depth assertion used by tests and by the realtime service in development.
 * Throws if a payload about to be broadcast contains a forbidden key at any depth.
 */
export function assertNoPrivateFields(payload: unknown, path = '$'): void {
  if (payload === null || typeof payload !== 'object') return;

  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNoPrivateFields(item, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if ((FORBIDDEN_PARTNER_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Private field "${key}" would be exposed at ${path}.${key}`);
    }
    assertNoPrivateFields(value, `${path}.${key}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Age                                                                         */
/* -------------------------------------------------------------------------- */

/** Whole years between `birthDate` and `now`, or null if unknown/unparseable. */
export function calculateAge(birthDate: Date | string | null, now: Date = new Date()): number | null {
  if (!birthDate) return null;
  const dob = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;

  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/**
 * Coarse age bucket shown to partners.
 *
 * Deliberately lossy: a bracket cannot be used to identify someone the way an exact
 * birthday can, and it is all the matching engine needs.
 */
export function ageBracketFor(
  birthDate: Date | string | null,
  now: Date = new Date(),
): AgeBracket | null {
  const age = calculateAge(birthDate, now);
  if (age === null || age < 0) return null;
  if (age < 25) return AgeBracket.AGE_18_24;
  if (age < 35) return AgeBracket.AGE_25_34;
  if (age < 45) return AgeBracket.AGE_35_44;
  if (age < 55) return AgeBracket.AGE_45_54;
  return AgeBracket.AGE_55_PLUS;
}

export function meetsMinimumAge(
  birthDate: Date | string | null,
  minimumAge: number,
  now: Date = new Date(),
): boolean {
  const age = calculateAge(birthDate, now);
  return age !== null && age >= minimumAge;
}
