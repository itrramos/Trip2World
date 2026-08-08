import type {
  AccountStatus,
  AgeBracket,
  BanScope,
  BillingProvider,
  ConnectionQuality,
  ConnectionRequestStatus,
  FieldVisibility,
  Gender,
  GenderPreference,
  Locale,
  MatchEndReason,
  ModerationActionType,
  PlanTier,
  PresenceState,
  ReportCategory,
  ReportStatus,
  SubscriptionStatus,
  UserRole,
} from './enums.js';

/** ISO-8601 timestamp string. All API boundaries serialize dates this way. */
export type ISODateString = string;

/** RFC 3166-1 alpha-2 country code, uppercase (e.g. `PT`, `DE`). */
export type CountryCode = string;

/** ISO 639-1 language code, lowercase (e.g. `en`, `pt`). */
export type LanguageCode = string;

export type UUID = string;

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY user shape ever transmitted to a match partner.
 *
 * Everything here is either non-identifying or explicitly opted into by the owner via
 * their privacy settings. There is deliberately no email, IP, precise location, safety
 * score, role, ban history, or internal identifier beyond the opaque user id.
 *
 * See `packages/shared/src/privacy.ts` — `toPublicProfile()` is the single funnel that
 * produces this type, and it is the function to audit when changing what partners see.
 */
export interface PublicProfile {
  id: UUID;
  username: string;
  /** Optional friendly name. Hidden when the owner sets `showDisplayName: false`. */
  displayName: string | null;
  avatarUrl: string | null;
  /** Country-level only. Never a city, region, or coordinate pair. */
  country: CountryCode | null;
  /** Coarse bracket rather than an exact age or birthday. */
  ageBracket: AgeBracket | null;
  languages: LanguageCode[];
  gender: Gender | null;
  interests: string[];
  bio: string | null;
  /** True once the account has passed whatever verification the deployment enforces. */
  verified: boolean;
  /** Cosmetic tier badge only — never gates safety features. */
  plan: PlanTier;
}

/** The authenticated user's own view of themselves. Includes private-but-own data. */
export interface SelfProfile extends PublicProfile {
  email: string;
  emailVerified: boolean;
  role: UserRole;
  status: AccountStatus;
  /** Exact date of birth, only ever returned to the owner. */
  birthDate: ISODateString | null;
  age: number | null;
  locale: Locale;
  createdAt: ISODateString;
  privacy: PrivacySettings;
  /** Present only while the account is under an active moderation hold. */
  restriction: AccountRestriction | null;
}

export interface AccountRestriction {
  status: Extract<AccountStatus, 'SUSPENDED' | 'BANNED'>;
  /** Operator-authored, user-safe explanation. Never contains internal moderator notes. */
  reason: string;
  /** Null for permanent bans. */
  expiresAt: ISODateString | null;
  appealUrl: string | null;
}

export interface PrivacySettings {
  showDisplayName: boolean;
  showCountry: boolean;
  showAgeBracket: boolean;
  showGender: boolean;
  showInterests: boolean;
  showBio: boolean;
  /** Allow strangers met via matchmaking to send a connection request. */
  allowConnectionRequests: boolean;
  /** Field-level override map for anything not covered by the booleans above. */
  fieldOverrides: Partial<Record<keyof PublicProfile, FieldVisibility>>;
}

/* -------------------------------------------------------------------------- */
/* Matching preferences                                                        */
/* -------------------------------------------------------------------------- */

export interface MatchPreferences {
  /** Who the user wants to meet. */
  preferredGender: GenderPreference;
  /** Empty array means "no country preference". */
  preferredCountries: CountryCode[];
  /** Empty array means "any language". */
  preferredLanguages: LanguageCode[];
  preferredAgeBrackets: AgeBracket[];
  /** Interest ids to prioritise. Never hard-filters — only boosts the score. */
  interestIds: string[];
  /** Requeue automatically when a partner leaves. */
  autoRequeue: boolean;
  /** Start matches with the microphone muted. */
  startMuted: boolean;
  /** Start matches with the camera off (audio-only until toggled). */
  startCameraOff: boolean;
}

export interface Interest {
  id: string;
  /** Stable machine key used for i18n lookups, e.g. `interest.travel`. */
  slug: string;
  /** English fallback label. Clients prefer the translated string. */
  label: string;
  emoji: string | null;
  sortOrder: number;
}

/* -------------------------------------------------------------------------- */
/* Matching / sessions                                                         */
/* -------------------------------------------------------------------------- */

/** Payload the server sends when two users have been paired. */
export interface MatchFoundPayload {
  matchId: UUID;
  partner: PublicProfile;
  /**
   * Exactly one peer is told to create the SDP offer. Decided server-side so both
   * clients never glare (simultaneous offers).
   */
  isInitiator: boolean;
  /** Ephemeral, time-limited ICE servers scoped to this match. */
  iceServers: IceServerConfig[];
  /** Interest slugs both users share, for the "you both like…" affordance. */
  sharedInterests: string[];
  /** Milliseconds the client has to complete signaling before the server tears down. */
  negotiationTimeoutMs: number;
  startedAt: ISODateString;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface MatchSummary {
  id: UUID;
  partner: PublicProfile | null;
  startedAt: ISODateString;
  endedAt: ISODateString | null;
  durationSeconds: number | null;
  endReason: MatchEndReason | null;
}

export interface QueueStatus {
  position: number | null;
  /** Seconds spent in queue so far. Drives the preference-relaxation UI copy. */
  waitingSeconds: number;
  /** Which relaxation stage the search is currently in. */
  relaxationStage: number;
  /** Human-readable hint, already localized by the server. */
  hint: string | null;
  /** Approximate number of users currently searching. Bucketed, never exact. */
  searchingNow: number | null;
}

export interface ConnectionStats {
  quality: ConnectionQuality;
  roundTripTimeMs: number | null;
  packetsLostPct: number | null;
  /** Negotiated ICE candidate pair type, useful for TURN diagnostics. */
  candidateType: 'host' | 'srflx' | 'prflx' | 'relay' | null;
}

/* -------------------------------------------------------------------------- */
/* Social graph                                                                */
/* -------------------------------------------------------------------------- */

export interface Connection {
  id: UUID;
  user: PublicProfile;
  connectedAt: ISODateString;
  /** Match the connection originated from, if it came from a conversation. */
  originMatchId: UUID | null;
}

export interface ConnectionRequest {
  id: UUID;
  from: PublicProfile;
  to: PublicProfile;
  status: ConnectionRequestStatus;
  message: string | null;
  createdAt: ISODateString;
  respondedAt: ISODateString | null;
}

export interface BlockedUser {
  id: UUID;
  user: PublicProfile;
  blockedAt: ISODateString;
  /** Only visible to the blocker. */
  reason: string | null;
}

/* -------------------------------------------------------------------------- */
/* Text chat                                                                   */
/* -------------------------------------------------------------------------- */

export interface ChatMessage {
  id: UUID;
  matchId: UUID;
  senderId: UUID;
  body: string;
  sentAt: ISODateString;
}

/* -------------------------------------------------------------------------- */
/* Safety                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReportInput {
  reportedUserId: UUID;
  matchId: UUID | null;
  category: ReportCategory;
  details?: string;
  /** Convenience: also block the reported user. Defaults to true in the UI. */
  alsoBlock?: boolean;
}

/** Report as the *reporter* sees it — deliberately free of moderator-only fields. */
export interface ReportReceipt {
  id: UUID;
  category: ReportCategory;
  createdAt: ISODateString;
  status: ReportStatus;
}

/** Report as a moderator sees it. Never sent to a non-moderator client. */
export interface ModerationReport {
  id: UUID;
  reporter: PublicProfile | null;
  reported: PublicProfile;
  category: ReportCategory;
  details: string | null;
  status: ReportStatus;
  matchId: UUID | null;
  createdAt: ISODateString;
  reviewedAt: ISODateString | null;
  reviewedById: UUID | null;
  moderatorNotes: string | null;
  /** How many prior upheld reports exist against the reported account. */
  priorUpheldReports: number;
  priorTotalReports: number;
}

export interface ModerationActionRecord {
  id: UUID;
  type: ModerationActionType;
  targetUserId: UUID;
  moderatorId: UUID | null;
  reason: string;
  /** Internal note; never surfaced to the target user. */
  notes: string | null;
  expiresAt: ISODateString | null;
  createdAt: ISODateString;
}

export interface BanRecord {
  id: UUID;
  userId: UUID;
  scope: BanScope;
  reason: string;
  permanent: boolean;
  expiresAt: ISODateString | null;
  liftedAt: ISODateString | null;
  createdAt: ISODateString;
}

/* -------------------------------------------------------------------------- */
/* Billing                                                                     */
/* -------------------------------------------------------------------------- */

export interface Subscription {
  id: UUID;
  plan: PlanTier;
  status: SubscriptionStatus;
  provider: BillingProvider;
  currentPeriodEnd: ISODateString | null;
  cancelAtPeriodEnd: boolean;
}

/* -------------------------------------------------------------------------- */
/* Presence                                                                    */
/* -------------------------------------------------------------------------- */

export interface Presence {
  userId: UUID;
  state: PresenceState;
  lastSeenAt: ISODateString;
  /** Realtime node currently owning this socket, for cross-node routing. */
  nodeId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

export interface AdminDashboardStats {
  registeredUsers: number;
  onlineUsers: number;
  queuedUsers: number;
  activeMatches: number;
  matchesToday: number;
  reportsPending: number;
  bannedUsers: number;
  suspendedUsers: number;
  registrationTrend: TrendPoint[];
  matchTrend: TrendPoint[];
}

export interface TrendPoint {
  date: ISODateString;
  value: number;
}

/** Runtime-tunable settings an operator can change without a redeploy. */
export interface SystemSettings {
  minimumAge: number;
  registrationOpen: boolean;
  guestAccessEnabled: boolean;
  maintenanceMode: boolean;
  requireEmailVerificationToMatch: boolean;
  enabledCountries: CountryCode[] | null;
  supportedLocales: Locale[];
  matchmaking: MatchmakingSettings;
}

export interface MatchmakingSettings {
  /** Ordered relaxation stages, evaluated by elapsed queue time. */
  relaxationStages: RelaxationStage[];
  /** Hard ceiling on queue wait before the client is told to retry. */
  maxQueueSeconds: number;
  /** How long a skipped pair is kept apart when alternatives exist. */
  skipCooldownSeconds: number;
  /** Minimum spacing between successive Next presses, per user. */
  minSecondsBetweenSkips: number;
  /** Deadline for completing WebRTC negotiation before the match is aborted. */
  negotiationTimeoutMs: number;
}

export interface RelaxationStage {
  /** Inclusive lower bound of queue age, in seconds. */
  afterSeconds: number;
  /** Constraints dropped once this stage is reached. */
  drop: RelaxableConstraint[];
  label: string;
}

export type RelaxableConstraint =
  | 'interests'
  | 'ageBracket'
  | 'language'
  | 'country'
  | 'gender';

export interface FeatureFlagRecord {
  key: string;
  enabled: boolean;
  description: string | null;
  /** 0-100. Deterministic per-user bucketing when below 100. */
  rolloutPercentage: number;
}

export interface AuditLogEntry {
  id: UUID;
  actorId: UUID | null;
  actorType: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: ISODateString;
}
