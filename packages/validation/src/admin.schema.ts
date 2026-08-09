import { ABSOLUTE_MINIMUM_AGE } from '@trip2world/shared';
import { z } from 'zod';
import {
  accountStatusSchema,
  countryCodeSchema,
  displayTextSchema,
  localeSchema,
  paginationSchema,
  userRoleSchema,
  uuidSchema,
} from './primitives.js';

export const adminUserQuerySchema = paginationSchema.extend({
  /** Free-text search across id, username and email. */
  q: z.string().trim().max(200).optional(),
  status: accountStatusSchema.optional(),
  role: userRoleSchema.optional(),
  country: countryCodeSchema.optional(),
  registeredAfter: z.coerce.date().optional(),
  registeredBefore: z.coerce.date().optional(),
  sort: z.enum(['createdAt', 'lastLoginAt', 'reports']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

/* --- Token campaigns ------------------------------------------------------ */

export const campaignAudienceSchema = z.enum(['NEW_USERS', 'ALL_USERS']);
export const campaignStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED']);

/**
 * Upper bound on a single grant.
 *
 * Not arbitrary caution: this number is typed into a form by a tired operator, and a
 * stray zero on a launch promotion is a budget mistake that cannot be taken back once
 * the tokens are in people's accounts. 100 000 is far beyond any sensible promotion and
 * still catches the extra digit.
 */
const MAX_CAMPAIGN_TOKENS = 100_000;

export const createCampaignSchema = z
  .object({
    name: displayTextSchema(80),
    description: displayTextSchema(300).optional(),
    tokens: z.number().int().positive().max(MAX_CAMPAIGN_TOKENS),
    audience: campaignAudienceSchema.default('NEW_USERS'),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    maxGrants: z.number().int().positive().max(10_000_000).nullable().optional(),
    requiresVerifiedEmail: z.boolean().default(true),
  })
  .strict()
  .refine((value) => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, {
    message: 'The end date must be after the start date.',
    path: ['endsAt'],
  });

export const updateCampaignSchema = z
  .object({
    name: displayTextSchema(80).optional(),
    description: displayTextSchema(300).nullable().optional(),
    tokens: z.number().int().positive().max(MAX_CAMPAIGN_TOKENS).optional(),
    audience: campaignAudienceSchema.optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    maxGrants: z.number().int().positive().max(10_000_000).nullable().optional(),
    requiresVerifiedEmail: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, {
    message: 'The end date must be after the start date.',
    path: ['endsAt'],
  });

export const setCampaignStatusSchema = z
  .object({ status: campaignStatusSchema })
  .strict();

export const adminWarnUserSchema = z.object({
  userId: uuidSchema,
  reason: displayTextSchema(500),
  notes: displayTextSchema(2000).optional(),
});

export const adminSuspendUserSchema = z.object({
  userId: uuidSchema,
  reason: displayTextSchema(500),
  notes: displayTextSchema(2000).optional(),
  hours: z.number().int().min(1).max(24 * 365),
});

export const adminBanUserSchema = z.object({
  userId: uuidSchema,
  reason: displayTextSchema(500),
  notes: displayTextSchema(2000).optional(),
  permanent: z.boolean().default(true),
  /** Required when `permanent` is false. */
  hours: z.number().int().min(1).max(24 * 365 * 10).optional(),
});

export const adminUnbanUserSchema = z.object({
  userId: uuidSchema,
  reason: displayTextSchema(500),
});

/**
 * Role changes are separated from every other admin mutation and restricted to
 * SUPER_ADMIN in the route guard: privilege escalation is the highest-value target in
 * the whole admin surface, so it gets its own narrow endpoint and its own audit action.
 */
export const adminSetRoleSchema = z.object({
  userId: uuidSchema,
  role: userRoleSchema,
  reason: displayTextSchema(500),
});

/* --- Configuration -------------------------------------------------------- */

const relaxationStageSchema = z.object({
  afterSeconds: z.number().int().min(0).max(600),
  drop: z.array(z.enum(['interests', 'ageBracket', 'language', 'country', 'gender'])),
  label: z.string().min(1).max(50),
});

export const adminUpdateSettingsSchema = z
  .object({
    minimumAge: z.number().int().min(ABSOLUTE_MINIMUM_AGE).max(99).optional(),
    registrationOpen: z.boolean().optional(),
    guestAccessEnabled: z.boolean().optional(),
    maintenanceMode: z.boolean().optional(),
    requireEmailVerificationToMatch: z.boolean().optional(),
    /** Null clears the allow-list, permitting every supported country. */
    enabledCountries: z.array(countryCodeSchema).min(1).nullable().optional(),
    supportedLocales: z.array(localeSchema).min(1).optional(),
    matchmaking: z
      .object({
        relaxationStages: z.array(relaxationStageSchema).min(1).max(10),
        maxQueueSeconds: z.number().int().min(10).max(3600),
        skipCooldownSeconds: z.number().int().min(0).max(86_400),
        minSecondsBetweenSkips: z.number().min(0).max(60),
        negotiationTimeoutMs: z.number().int().min(5_000).max(120_000),
      })
      .optional(),
  })
  .strict();

/** Relaxation stages must be strictly increasing, or later stages are unreachable. */
export const adminUpdateSettingsRefinedSchema = adminUpdateSettingsSchema.refine(
  (d) => {
    const stages = d.matchmaking?.relaxationStages;
    if (!stages) return true;
    return stages.every((s, i) => i === 0 || s.afterSeconds > stages[i - 1]!.afterSeconds);
  },
  {
    message: 'Relaxation stages must be ordered by strictly increasing afterSeconds',
    path: ['matchmaking', 'relaxationStages'],
  },
);

export const adminUpdateFeatureFlagSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  enabled: z.boolean(),
  rolloutPercentage: z.number().int().min(0).max(100).default(100),
  description: z.string().max(300).nullable().optional(),
});

export const adminAuditQuerySchema = paginationSchema.extend({
  actorId: uuidSchema.optional(),
  action: z.string().max(100).optional(),
  targetId: z.string().max(100).optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});
