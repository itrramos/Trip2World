import { API_ERROR_STATUS, type ApiError, ApiErrorCode, type ApiFailure } from '@trip2world/types';

/**
 * Application errors.
 *
 * Every failure the API returns is an `AppError` carrying a stable machine `code`. The
 * HTTP status is derived from the code rather than passed separately, so a given error
 * can never be returned with two different statuses depending on the call site.
 *
 * `message` is user-facing and safe to display. Anything an operator needs but a user
 * must not see goes in `internal`, which is logged and never serialized.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, string[]>;
  readonly retryAfter?: number;
  /** Operator-only context. Logged, never sent to the client. */
  readonly internal?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: {
      details?: Record<string, string[]>;
      retryAfter?: number;
      internal?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = API_ERROR_STATUS[code];
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.internal = options.internal;
  }

  toResponse(requestId?: string): ApiFailure {
    const error: ApiError = {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
      ...(requestId ? { requestId } : {}),
    };
    return { ok: false, error };
  }
}

/* -------------------------------------------------------------------------- */
/* Constructors                                                                */
/* -------------------------------------------------------------------------- */

export const Errors = {
  validation: (details: Record<string, string[]>) =>
    new AppError(ApiErrorCode.VALIDATION_ERROR, 'Some of the information provided is not valid.', {
      details,
    }),

  unauthenticated: (internal?: Record<string, unknown>) =>
    new AppError(ApiErrorCode.UNAUTHENTICATED, 'You need to sign in to do that.', { internal }),

  /**
   * Deliberately identical for "no such account" and "wrong password".
   *
   * Distinguishing them turns the login endpoint into an account-enumeration oracle —
   * an attacker learns which email addresses are registered. The timing of the two paths
   * is equalised separately, in the auth service.
   */
  invalidCredentials: () =>
    new AppError(ApiErrorCode.INVALID_CREDENTIALS, 'That email or password is incorrect.'),

  forbidden: (message = 'You do not have permission to do that.') =>
    new AppError(ApiErrorCode.FORBIDDEN, message),

  notFound: (what = 'That') => new AppError(ApiErrorCode.NOT_FOUND, `${what} could not be found.`),

  conflict: (message: string) => new AppError(ApiErrorCode.CONFLICT, message),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError(ApiErrorCode.RATE_LIMITED, 'Too many attempts. Please wait and try again.', {
      retryAfter: retryAfterSeconds,
    }),

  accountSuspended: (reason: string, until: Date | null) =>
    new AppError(
      ApiErrorCode.ACCOUNT_SUSPENDED,
      until
        ? `Your account is suspended until ${until.toISOString()}. ${reason}`
        : `Your account is suspended. ${reason}`,
    ),

  accountBanned: (reason: string) =>
    new AppError(ApiErrorCode.ACCOUNT_BANNED, `Your account has been restricted. ${reason}`),

  emailNotVerified: () =>
    new AppError(
      ApiErrorCode.EMAIL_NOT_VERIFIED,
      'Please confirm your email address before continuing.',
    ),

  underage: (minimumAge: number) =>
    new AppError(ApiErrorCode.UNDERAGE, `You must be at least ${minimumAge} to use Trip2World.`),

  registrationClosed: () =>
    new AppError(
      ApiErrorCode.REGISTRATION_CLOSED,
      'New registrations are temporarily closed. Please check back soon.',
    ),

  maintenance: () =>
    new AppError(ApiErrorCode.MAINTENANCE, 'Trip2World is undergoing maintenance. Back shortly.'),

  tokenExpired: (message = 'That link has expired. Please request a new one.') =>
    new AppError(ApiErrorCode.TOKEN_EXPIRED, message),

  tokenInvalid: (message = 'That link is not valid. Please request a new one.') =>
    new AppError(ApiErrorCode.TOKEN_INVALID, message),

  unsupportedCountry: () =>
    new AppError(ApiErrorCode.UNSUPPORTED_COUNTRY, 'Trip2World is not yet available in your country.'),

  featureDisabled: (feature: string) =>
    new AppError(ApiErrorCode.FEATURE_DISABLED, `${feature} is not available.`),

  /**
   * Generic 500. The message is intentionally uninformative: internal error text leaks
   * stack frames, table names, and library versions. Detail goes to `internal` for the
   * logs, correlated to the client by request id.
   */
  internal: (internal?: Record<string, unknown>, cause?: unknown) =>
    new AppError(ApiErrorCode.INTERNAL_ERROR, 'Something went wrong on our end.', {
      internal,
      cause,
    }),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
