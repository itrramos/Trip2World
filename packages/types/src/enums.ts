/**
 * Domain enumerations.
 *
 * These are declared as frozen const objects plus derived literal unions rather than
 * TypeScript `enum`s so they survive `isolatedModules`, erase cleanly, and can be shared
 * verbatim with Prisma enums, Zod schemas, and the React Native bundler.
 *
 * IMPORTANT: the string values must stay byte-identical to the Prisma enum members in
 * `packages/database/prisma/schema.prisma`.
 */

/** Helper that turns a const object of string values into a literal union. */
type ValueOf<T> = T[keyof T];

export const Gender = {
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  NON_BINARY: 'NON_BINARY',
  OTHER: 'OTHER',
  UNSPECIFIED: 'UNSPECIFIED',
} as const;
export type Gender = ValueOf<typeof Gender>;
export const GENDERS = Object.values(Gender);

/** What a user is willing to be matched with. `ANY` is always the fallback. */
export const GenderPreference = {
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  ANY: 'ANY',
} as const;
export type GenderPreference = ValueOf<typeof GenderPreference>;
export const GENDER_PREFERENCES = Object.values(GenderPreference);

export const AccountStatus = {
  /** Email not yet confirmed. May browse but not enter matchmaking if verification is enforced. */
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ACTIVE: 'ACTIVE',
  /** Temporary moderation hold with an expiry. */
  SUSPENDED: 'SUSPENDED',
  /** Permanent moderation removal. */
  BANNED: 'BANNED',
  /** User-initiated deactivation; recoverable until the deletion grace period elapses. */
  DEACTIVATED: 'DEACTIVATED',
} as const;
export type AccountStatus = ValueOf<typeof AccountStatus>;
export const ACCOUNT_STATUSES = Object.values(AccountStatus);

/** Statuses that must never be placed into matchmaking. */
export const NON_MATCHABLE_STATUSES: readonly AccountStatus[] = [
  AccountStatus.SUSPENDED,
  AccountStatus.BANNED,
  AccountStatus.DEACTIVATED,
];

export const UserRole = {
  USER: 'USER',
  MODERATOR: 'MODERATOR',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;
export type UserRole = ValueOf<typeof UserRole>;
export const USER_ROLES = Object.values(UserRole);

/** Ordered privilege ladder — higher index outranks lower. Used by authorization guards. */
export const ROLE_HIERARCHY: readonly UserRole[] = [
  UserRole.USER,
  UserRole.MODERATOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];

export const PlanTier = {
  FREE: 'FREE',
  PLUS: 'PLUS',
  PREMIUM: 'PREMIUM',
} as const;
export type PlanTier = ValueOf<typeof PlanTier>;
export const PLAN_TIERS = Object.values(PlanTier);

export const SubscriptionStatus = {
  ACTIVE: 'ACTIVE',
  TRIALING: 'TRIALING',
  PAST_DUE: 'PAST_DUE',
  CANCELED: 'CANCELED',
  INCOMPLETE: 'INCOMPLETE',
  EXPIRED: 'EXPIRED',
} as const;
export type SubscriptionStatus = ValueOf<typeof SubscriptionStatus>;

export const BillingProvider = {
  STRIPE: 'STRIPE',
  APPLE: 'APPLE',
  GOOGLE: 'GOOGLE',
  MANUAL: 'MANUAL',
} as const;
export type BillingProvider = ValueOf<typeof BillingProvider>;

export const ReportCategory = {
  NUDITY: 'NUDITY',
  HARASSMENT: 'HARASSMENT',
  HATE: 'HATE',
  UNDERAGE: 'UNDERAGE',
  VIOLENCE: 'VIOLENCE',
  SPAM: 'SPAM',
  SCAM: 'SCAM',
  IMPERSONATION: 'IMPERSONATION',
  OTHER: 'OTHER',
} as const;
export type ReportCategory = ValueOf<typeof ReportCategory>;
export const REPORT_CATEGORIES = Object.values(ReportCategory);

/**
 * Categories that must be escalated to the top of the moderation queue regardless of
 * queue age. Child-safety and credible-threat reports are never allowed to age out.
 */
export const PRIORITY_REPORT_CATEGORIES: readonly ReportCategory[] = [
  ReportCategory.UNDERAGE,
  ReportCategory.VIOLENCE,
];

export const ReportStatus = {
  PENDING: 'PENDING',
  UNDER_REVIEW: 'UNDER_REVIEW',
  ACTIONED: 'ACTIONED',
  DISMISSED: 'DISMISSED',
} as const;
export type ReportStatus = ValueOf<typeof ReportStatus>;
export const REPORT_STATUSES = Object.values(ReportStatus);

export const ModerationActionType = {
  NOTE: 'NOTE',
  WARNING: 'WARNING',
  SUSPENSION: 'SUSPENSION',
  UNSUSPEND: 'UNSUSPEND',
  BAN: 'BAN',
  UNBAN: 'UNBAN',
  DISMISS_REPORT: 'DISMISS_REPORT',
  FORCE_LOGOUT: 'FORCE_LOGOUT',
} as const;
export type ModerationActionType = ValueOf<typeof ModerationActionType>;
export const MODERATION_ACTION_TYPES = Object.values(ModerationActionType);

export const BanScope = {
  ACCOUNT: 'ACCOUNT',
  DEVICE: 'DEVICE',
  NETWORK: 'NETWORK',
} as const;
export type BanScope = ValueOf<typeof BanScope>;

/** Why a live match terminated. Recorded on the Match row for analytics and abuse signals. */
export const MatchEndReason = {
  /** One participant pressed Next. */
  SKIPPED: 'SKIPPED',
  /** One participant deliberately ended the conversation without requeueing. */
  ENDED: 'ENDED',
  /** Socket dropped without an explicit end/skip. */
  DISCONNECTED: 'DISCONNECTED',
  REPORTED: 'REPORTED',
  BLOCKED: 'BLOCKED',
  /** Signaling never completed inside the negotiation deadline. */
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
  /** Realtime node shut down; both peers are requeued. */
  SERVER_SHUTDOWN: 'SERVER_SHUTDOWN',
  /** Moderator forcibly terminated the session. */
  MODERATED: 'MODERATED',
} as const;
export type MatchEndReason = ValueOf<typeof MatchEndReason>;

export const ConnectionRequestStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type ConnectionRequestStatus = ValueOf<typeof ConnectionRequestStatus>;

/** Coarse, publicly shareable presence. Stored in Redis, never written to Postgres per beat. */
export const PresenceState = {
  OFFLINE: 'OFFLINE',
  ONLINE: 'ONLINE',
  MATCHING: 'MATCHING',
  CONNECTED: 'CONNECTED',
  AWAY: 'AWAY',
} as const;
export type PresenceState = ValueOf<typeof PresenceState>;

/**
 * Client-side conversation state machine. The UI renders exactly one state at a time;
 * see `packages/shared/src/session-machine.ts` for the legal transition table.
 */
export const SessionState = {
  IDLE: 'IDLE',
  REQUESTING_PERMISSIONS: 'REQUESTING_PERMISSIONS',
  READY: 'READY',
  QUEUED: 'QUEUED',
  MATCH_FOUND: 'MATCH_FOUND',
  SIGNALING: 'SIGNALING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  PARTNER_LEFT: 'PARTNER_LEFT',
  SKIPPING: 'SKIPPING',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR',
} as const;
export type SessionState = ValueOf<typeof SessionState>;

/** Derived connection quality bucket shown to both peers. */
export const ConnectionQuality = {
  EXCELLENT: 'EXCELLENT',
  GOOD: 'GOOD',
  FAIR: 'FAIR',
  POOR: 'POOR',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ConnectionQuality = ValueOf<typeof ConnectionQuality>;

/** Visibility scope for individual profile fields during a match. */
export const FieldVisibility = {
  /** Shown to every matched partner. */
  PUBLIC: 'PUBLIC',
  /** Shown only to accepted connections. */
  CONNECTIONS: 'CONNECTIONS',
  /** Never shown to other users. */
  PRIVATE: 'PRIVATE',
} as const;
export type FieldVisibility = ValueOf<typeof FieldVisibility>;

export const AgeBracket = {
  AGE_18_24: 'AGE_18_24',
  AGE_25_34: 'AGE_25_34',
  AGE_35_44: 'AGE_35_44',
  AGE_45_54: 'AGE_45_54',
  AGE_55_PLUS: 'AGE_55_PLUS',
} as const;
export type AgeBracket = ValueOf<typeof AgeBracket>;
export const AGE_BRACKETS = Object.values(AgeBracket);

export const AuditActorType = {
  USER: 'USER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
} as const;
export type AuditActorType = ValueOf<typeof AuditActorType>;

/** Supported UI locales. Adding one here plus a message catalogue is the whole job. */
export const Locale = {
  EN: 'en',
  ES: 'es',
  PT: 'pt',
  FR: 'fr',
  DE: 'de',
  IT: 'it',
} as const;
export type Locale = ValueOf<typeof Locale>;
export const LOCALES = Object.values(Locale);
export const DEFAULT_LOCALE: Locale = Locale.EN;
