import { MAX_INTERESTS_PER_USER, MAX_PREFERRED_LANGUAGES } from '@trip2world/shared';
import { z } from 'zod';
import {
  ageBracketSchema,
  avatarUrlSchema,
  bioSchema,
  countryCodeSchema,
  displayNameSchema,
  genderPreferenceSchema,
  genderSchema,
  interestSlugSchema,
  languageCodeSchema,
  localeSchema,
} from './primitives.js';

/**
 * Profile update.
 *
 * Note what is absent: email, username, role, plan, status, and birthDate cannot be
 * changed here. Email and username changes have their own verified flows; the rest are
 * not user-editable at all. Keeping them out of the schema means a mass-assignment
 * attempt is rejected at the boundary rather than relying on the service to ignore them.
 */
export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema.nullable().optional(),
    bio: bioSchema.nullable().optional(),
    avatarUrl: avatarUrlSchema.nullable().optional(),
    country: countryCodeSchema.optional(),
    gender: genderSchema.optional(),
    languages: z.array(languageCodeSchema).min(1).max(MAX_PREFERRED_LANGUAGES).optional(),
    locale: localeSchema.optional(),
  })
  .strict();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updatePrivacySchema = z
  .object({
    showDisplayName: z.boolean().optional(),
    showCountry: z.boolean().optional(),
    showAgeBracket: z.boolean().optional(),
    showGender: z.boolean().optional(),
    showInterests: z.boolean().optional(),
    showBio: z.boolean().optional(),
    allowConnectionRequests: z.boolean().optional(),
  })
  .strict();
export type UpdatePrivacyInput = z.infer<typeof updatePrivacySchema>;

/**
 * Matching preferences.
 *
 * `preferredCountries` is capped at the PREMIUM allowance here; the service re-checks
 * against the caller's actual plan, because a schema cannot know who is asking.
 */
export const updatePreferencesSchema = z
  .object({
    preferredGender: genderPreferenceSchema.optional(),
    preferredCountries: z.array(countryCodeSchema).max(20).optional(),
    preferredLanguages: z.array(languageCodeSchema).max(MAX_PREFERRED_LANGUAGES).optional(),
    preferredAgeBrackets: z.array(ageBracketSchema).max(5).optional(),
    autoRequeue: z.boolean().optional(),
    startMuted: z.boolean().optional(),
    startCameraOff: z.boolean().optional(),
  })
  .strict();
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export const updateInterestsSchema = z.object({
  interests: z
    .array(interestSlugSchema)
    .max(MAX_INTERESTS_PER_USER, `Choose at most ${MAX_INTERESTS_PER_USER} interests`)
    .transform((list) => [...new Set(list)]),
});

export const changeEmailSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

export const changeUsernameSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(24)
    .regex(/^[a-z0-9](?:[a-z0-9_]{1,22}[a-z0-9])?$/),
  password: z.string().min(1).max(128),
});
