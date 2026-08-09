import { z } from 'zod';
import { displayTextSchema, paginationSchema, uuidSchema } from './primitives.js';

/**
 * Tokens and tipping.
 *
 * Amounts are always whole tokens. Fractional or negative values are rejected at the
 * boundary rather than relying on the ledger to catch them — a negative "tip" would be a
 * withdrawal from the recipient.
 */

/** Upper bound on a single tip. Generous, but a typo should not empty an account. */
export const MAX_TIP_TOKENS = 10_000;

export const tokenAmountSchema = z
  .number()
  .int('Tips must be a whole number of tokens')
  .positive('Tip must be greater than zero')
  .max(MAX_TIP_TOKENS, `A single tip cannot exceed ${MAX_TIP_TOKENS} tokens`);

/**
 * Extra call time a tip may offer.
 *
 * Bounded at an hour: this is an offer the recipient must accept, but an unbounded value
 * would let a sender put an absurd number on screen as a pressure tactic.
 */
export const offeredSecondsSchema = z
  .number()
  .int()
  .min(30, 'Offer at least 30 seconds')
  .max(3600, 'Offers cannot exceed one hour');

export const sendTipSchema = z.object({
  toUserId: uuidSchema,
  matchId: uuidSchema.nullable().default(null),
  tokens: tokenAmountSchema,
  message: displayTextSchema(200).optional(),
  /** Omit for a plain tip with no strings attached. */
  offeredSeconds: offeredSecondsSchema.optional(),
});
export type SendTipInput = z.infer<typeof sendTipSchema>;

/**
 * The recipient's answer to a time offer.
 *
 * Note there is no "amount" here and no refund path. The tokens have already moved; this
 * decides only whether the conversation continues. Declining must never cost the
 * recipient anything, or it stops being a free choice.
 */
export const tipOfferResponseSchema = z.object({
  tipId: uuidSchema,
  accepted: z.boolean(),
});

export const buyTokensSchema = z.object({
  packageId: uuidSchema,
});

export const tokenHistoryQuerySchema = paginationSchema;

/**
 * Manual balance correction. Administrators only.
 *
 * The note is mandatory and stored on the ledger row: an unexplained balance change is
 * indistinguishable from theft, including to an auditor reviewing the operator.
 */
export const adminAdjustTokensSchema = z.object({
  userId: uuidSchema,
  delta: z
    .number()
    .int()
    .refine((v) => v !== 0, 'Adjustment cannot be zero')
    .refine((v) => Math.abs(v) <= 1_000_000, 'Adjustment is implausibly large'),
  note: displayTextSchema(200).pipe(z.string().min(1, 'An adjustment requires a reason')),
});

export const adminTokenPackageSchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  tokens: z.number().int().positive().max(1_000_000),
  priceCents: z.number().int().positive().max(100_000_000),
  currency: z.string().length(3).toUpperCase(),
  label: z.string().max(50).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
