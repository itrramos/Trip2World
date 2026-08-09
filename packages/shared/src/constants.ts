import { type PlanTier, PlanTier as Plan } from '@trip2world/types';

/** Product-wide constants. Anything an operator should be able to change lives in
 *  SystemSettings instead; these are compile-time invariants. */

export const APP_NAME = 'Trip2World';
export const APP_TAGLINE = 'Meet the world, one conversation at a time.';

/** Absolute floor. An operator may raise the minimum age but never lower it below this. */
export const ABSOLUTE_MINIMUM_AGE = 18;
export const DEFAULT_MINIMUM_AGE = 18;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;
/** Lowercase letters, digits, underscore. No leading/trailing separators, no impersonation
 *  of the reserved names below. */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]{1,22}[a-z0-9])?$/;

export const RESERVED_USERNAMES: readonly string[] = [
  'admin', 'administrator', 'moderator', 'mod', 'staff', 'support', 'help', 'system',
  'trip2world', 'trip2', 't2w', 'official', 'security', 'root', 'api', 'www', 'null',
  'undefined', 'me', 'you', 'everyone', 'here',
];

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const DISPLAY_NAME_MAX_LENGTH = 40;
export const BIO_MAX_LENGTH = 300;
export const REPORT_DETAILS_MAX_LENGTH = 1000;
export const CHAT_MESSAGE_MAX_LENGTH = 500;
export const CONNECTION_REQUEST_MESSAGE_MAX_LENGTH = 200;

export const MAX_INTERESTS_PER_USER = 10;
export const MAX_PREFERRED_COUNTRIES_FREE = 1;
export const MAX_PREFERRED_COUNTRIES_PLUS = 5;
export const MAX_PREFERRED_COUNTRIES_PREMIUM = 20;
export const MAX_PREFERRED_LANGUAGES = 5;

/** Country-preference allowance by plan. Never gates a safety feature. */
export const PREFERRED_COUNTRY_LIMIT: Record<PlanTier, number> = {
  [Plan.FREE]: MAX_PREFERRED_COUNTRIES_FREE,
  [Plan.PLUS]: MAX_PREFERRED_COUNTRIES_PLUS,
  [Plan.PREMIUM]: MAX_PREFERRED_COUNTRIES_PREMIUM,
};

/** Matchmaking priority weight by plan, applied only when priority queueing is enabled. */
export const PLAN_PRIORITY: Record<PlanTier, number> = {
  [Plan.FREE]: 0,
  [Plan.PLUS]: 1,
  [Plan.PREMIUM]: 2,
};

/* --- Timing --------------------------------------------------------------- */

/** How often a connected client pings presence. Must be well under REDIS_TTL.presence. */
export const PRESENCE_HEARTBEAT_MS = 30_000;

/** Client gives up on WebRTC negotiation after this and asks for a new partner. */
export const NEGOTIATION_TIMEOUT_MS = 20_000;

/** Bounded reconnect window before the client returns to matchmaking. */
export const RECONNECT_TIMEOUT_MS = 12_000;
export const RECONNECT_MAX_ATTEMPTS = 3;

/** Minimum spacing between Next presses. Blunts skip-spam without hurting real users. */
export const MIN_SECONDS_BETWEEN_SKIPS = 1;

/** How long two users are kept apart after a skip, when alternatives exist. */
export const SKIP_COOLDOWN_SECONDS = 1800;

/** Queue wait after which the client is told to try again rather than spinning forever. */
export const MAX_QUEUE_SECONDS = 180;

/** Access tokens are short so revocation is cheap; refresh tokens carry the session. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

/** Grace period between a deletion request and irreversible erasure. */
export const ACCOUNT_DELETION_GRACE_DAYS = 14;

/**
 * How long an unanswered connection request stands.
 *
 * Requests expire so that an inbox cannot only grow — one that does is an inbox people
 * stop opening, which turns the feature into a way to be ignored rather than a way to
 * stay in touch. Fourteen days is long enough that someone who checks weekly still sees
 * it, and short enough that a stale request is not a permanent claim on attention.
 */
export const CONNECTION_REQUEST_TTL_DAYS = 14;

/* --- Rate limits ---------------------------------------------------------- */

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 300 },
  register: { limit: 5, windowSeconds: 3600 },
  passwordReset: { limit: 5, windowSeconds: 3600 },
  emailVerificationResend: { limit: 5, windowSeconds: 3600 },
  queueJoin: { limit: 60, windowSeconds: 60 },
  skip: { limit: 90, windowSeconds: 60 },
  report: { limit: 10, windowSeconds: 3600 },
  block: { limit: 60, windowSeconds: 3600 },
  chatMessage: { limit: 25, windowSeconds: 15 },
  socketEvent: { limit: 300, windowSeconds: 60 },
  apiDefault: { limit: 300, windowSeconds: 60 },
  apiWrite: { limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/** Largest realtime payload accepted, in bytes. SDP is the legitimate worst case. */
export const MAX_SOCKET_PAYLOAD_BYTES = 64 * 1024;
/** Largest JSON body the HTTP API accepts. */
export const MAX_HTTP_BODY_BYTES = 128 * 1024;
/** Largest avatar upload, when object storage is enabled. */
export const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
export const ALLOWED_AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/* --- Realtime ------------------------------------------------------------- */

/** How long ephemeral TURN credentials remain valid. Long enough for a match, no longer. */
export const TURN_CREDENTIAL_TTL_SECONDS = 2 * 60 * 60;

/** Ephemeral chat retention when the deployment has not opted into storing transcripts. */
export const CHAT_RETENTION_SECONDS = 0;
