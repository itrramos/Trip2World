import { REPORT_DETAILS_MAX_LENGTH } from '@trip2world/shared';
import { z } from 'zod';
import {
  displayTextSchema,
  paginationSchema,
  reportCategorySchema,
  reportStatusSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Filing a report.
 *
 * `alsoBlock` defaults to true: someone distressed enough to report a stranger should not
 * have to take a second action to stop being matched with them again.
 */
export const createReportSchema = z.object({
  reportedUserId: uuidSchema,
  /** Null when reporting from a profile or connection rather than a live match. */
  matchId: uuidSchema.nullable().default(null),
  category: reportCategorySchema,
  details: displayTextSchema(REPORT_DETAILS_MAX_LENGTH).optional(),
  alsoBlock: z.boolean().default(true),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

export const createBlockSchema = z.object({
  userId: uuidSchema,
  reason: displayTextSchema(200).optional(),
});

export const removeBlockSchema = z.object({ userId: uuidSchema });

export const listBlocksSchema = paginationSchema;

/* --- Connections ---------------------------------------------------------- */

export const sendConnectionRequestSchema = z.object({
  userId: uuidSchema,
  matchId: uuidSchema.nullable().default(null),
  message: displayTextSchema(200).optional(),
});

export const respondToConnectionRequestSchema = z.object({
  requestId: uuidSchema,
  accept: z.boolean(),
});

/* --- Moderator-facing ----------------------------------------------------- */

export const moderationQueueQuerySchema = paginationSchema.extend({
  status: reportStatusSchema.optional(),
  category: reportCategorySchema.optional(),
  /** Surface child-safety and threat reports first regardless of age. */
  priorityFirst: z.coerce.boolean().default(true),
});

export const resolveReportSchema = z.object({
  reportId: uuidSchema,
  action: z.enum(['DISMISS', 'WARN', 'SUSPEND', 'BAN']),
  /** Shown to the reported user. Required for anything that restricts an account. */
  reason: displayTextSchema(500).optional(),
  /** Moderator-only note. Never returned to the target. */
  notes: displayTextSchema(2000).optional(),
  /** Required for SUSPEND; ignored otherwise. */
  suspensionHours: z.number().int().min(1).max(24 * 365).optional(),
});
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;

/**
 * Cross-field rules that a plain object schema cannot express: a restriction must carry a
 * user-facing reason, and a suspension must have a duration (an indefinite "suspension"
 * is a ban and should be recorded as one).
 */
export const resolveReportRefinedSchema = resolveReportSchema
  .refine((d) => d.action === 'DISMISS' || (d.reason && d.reason.length > 0), {
    message: 'A reason is required when restricting an account',
    path: ['reason'],
  })
  .refine((d) => d.action !== 'SUSPEND' || d.suspensionHours !== undefined, {
    message: 'A suspension must have a duration',
    path: ['suspensionHours'],
  });
