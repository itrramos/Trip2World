import type { SelfProfile } from './domain.js';

/**
 * Uniform HTTP envelope.
 *
 * Every Trip2World API response — success or failure — matches one of these two shapes,
 * so clients only ever need one branch. Errors always carry a stable machine `code`;
 * `message` is for humans and may be localized or reworded without notice.
 */
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** Field-level validation problems, keyed by dot-path. */
  details?: Record<string, string[]>;
  /** Correlates with the `x-request-id` response header and the server logs. */
  requestId?: string;
  /** Seconds until the client may retry. Present on 429 and 503. */
  retryAfter?: number;
}

export interface ApiMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  hasMore?: boolean;
}

export const ApiErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  UNDERAGE: 'UNDERAGE',
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  MAINTENANCE: 'MAINTENANCE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_COUNTRY: 'UNSUPPORTED_COUNTRY',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** Default HTTP status for each error code. Used by the API's error serializer. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_BANNED: 403,
  EMAIL_NOT_VERIFIED: 403,
  UNDERAGE: 403,
  UNSUPPORTED_COUNTRY: 403,
  FEATURE_DISABLED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  REGISTRATION_CLOSED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  MAINTENANCE: 503,
};

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Returned by login/register/refresh.
 *
 * Web clients receive the refresh token as an HttpOnly, SameSite=Strict cookie and never
 * see it in the body. Native clients (which have no cookie jar) get it here and store it
 * in the platform keychain. The `refreshToken` field is therefore optional by design.
 */
export interface AuthTokens {
  accessToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  /** Omitted for cookie-based (web) clients. */
  refreshToken?: string;
}

export interface AuthResult {
  user: SelfProfile;
  tokens: AuthTokens;
}

/** Claims embedded in the signed access token. Keep this small — it travels on every call. */
export interface AccessTokenClaims {
  /** Subject: user id. */
  sub: string;
  role: string;
  plan: string;
  /** Session id, so a single device can be revoked without nuking every session. */
  sid: string;
  /** Token family generation; bumped on password change to invalidate old tokens. */
  gen: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  /** Rotating token id. Reuse of a consumed jti triggers family revocation. */
  jti: string;
  gen: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  version: string;
  uptimeSeconds: number;
  checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; message?: string }>;
}
