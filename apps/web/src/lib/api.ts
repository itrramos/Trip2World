import type { ApiError, ApiResponse } from '@trip2world/types';

/**
 * HTTP client for the Trip2World API.
 *
 * Token strategy, and why it is this way:
 *
 *   - The ACCESS token is held in a module-scoped variable — in memory only. It is never
 *     written to localStorage or sessionStorage, because anything there is readable by
 *     any script on the page, so a single XSS becomes a full account takeover.
 *   - The REFRESH token is an HttpOnly cookie the browser sends automatically to
 *     /api/v1/auth. JavaScript cannot read it, so XSS cannot exfiltrate a long-lived
 *     credential.
 *
 * The cost is that a page reload starts with no access token; the app calls `refresh()`
 * on boot to obtain one from the cookie. That is a deliberate trade of one extra request
 * for a materially smaller blast radius.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api';

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

/** In-flight refresh, so N concurrent 401s trigger one refresh rather than N. */
let refreshInFlight: Promise<boolean> | null = null;

export function setAccessToken(token: string | null, expiresInSeconds = 0): void {
  accessToken = token;
  // Refresh 30s early so a request never travels with a token that expires mid-flight.
  accessTokenExpiresAt = token ? Date.now() + (expiresInSeconds - 30) * 1000 : 0;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function hasValidAccessToken(): boolean {
  return accessToken !== null && Date.now() < accessTokenExpiresAt;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly error: ApiError,
    public readonly status: number,
  ) {
    super(error.message);
    this.name = 'ApiRequestError';
  }

  /** Field-level messages, for rendering beside form inputs. */
  get fieldErrors(): Record<string, string[]> {
    return this.error.details ?? {};
  }

  fieldError(field: string): string | undefined {
    return this.error.details?.[field]?.[0];
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the automatic refresh-and-retry. Used by refresh() itself to avoid recursion. */
  skipAuthRetry?: boolean;
  /** Attach the access token. Default true. */
  authenticated?: boolean;
}

async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipAuthRetry = false, authenticated = true, headers, ...init } = options;

  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (authenticated && accessToken) {
    requestHeaders.set('Authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: requestHeaders,
    // Required for the HttpOnly refresh cookie to be sent and set.
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // 204 and other empty responses have no JSON to parse.
  const text = await response.text();
  let payload: ApiResponse<T> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as ApiResponse<T>;
    } catch {
      throw new ApiRequestError(
        { code: 'INTERNAL_ERROR', message: 'The server sent an unreadable response.' },
        response.status,
      );
    }
  }

  if (response.ok && payload?.ok) return payload.data;

  const error: ApiError = payload && !payload.ok
    ? payload.error
    : {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
      };

  /**
   * A 401 on an authenticated request usually means the short-lived access token simply
   * aged out. Refresh once and retry transparently — the user should never see a login
   * screen because their 15-minute token expired while they were reading the page.
   *
   * Only retried once, and never for the refresh endpoint itself, so a genuinely invalid
   * session cannot cause an infinite loop.
   */
  if (
    response.status === 401 &&
    authenticated &&
    !skipAuthRetry &&
    error.code !== 'INVALID_CREDENTIALS'
  ) {
    const refreshed = await refresh();
    if (refreshed) {
      return rawRequest<T>(path, { ...options, skipAuthRetry: true });
    }
  }

  throw new ApiRequestError(error, response.status);
}

/**
 * Exchange the refresh cookie for a new access token.
 * Returns false when the session is genuinely over.
 */
export async function refresh(): Promise<boolean> {
  // Coalesce concurrent callers onto a single request.
  refreshInFlight ??= (async () => {
    try {
      const data = await rawRequest<{ tokens: { accessToken: string; expiresIn: number } }>(
        '/v1/auth/refresh',
        { method: 'POST', skipAuthRetry: true, authenticated: false },
      );
      setAccessToken(data.tokens.accessToken, data.tokens.expiresIn);
      return true;
    } catch {
      setAccessToken(null);
      return false;
    } finally {
      // Cleared on the next tick so callers that started during this refresh still join it.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    rawRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    rawRequest<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    rawRequest<T>(path, { ...options, method: 'PATCH', body }),

  delete: <T>(path: string, options?: RequestOptions) =>
    rawRequest<T>(path, { ...options, method: 'DELETE' }),
};

/**
 * Ensure a usable access token before an operation that cannot transparently retry —
 * notably opening the realtime socket, where a rejected handshake is not a retryable
 * HTTP call.
 */
export async function ensureAccessToken(): Promise<string | null> {
  if (hasValidAccessToken()) return accessToken;
  return (await refresh()) ? accessToken : null;
}
