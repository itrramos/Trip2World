import type { ApiError, ApiResponse } from '@trip2world/types';

/**
 * Shared HTTP client factory.
 *
 * There is exactly one implementation of Trip2World's token handling, and this is it.
 * The web app and the admin panel talk to the same API with the same auth scheme, and
 * duplicating refresh-and-retry logic across two apps means two places for a subtle
 * session bug to hide — and two places to fix when the scheme changes.
 *
 * Each app calls `createApiClient` with its own base URL, so the admin panel talks to
 * its own origin (`admin.trip2world.net/api`) and its cookie stays host-scoped.
 *
 * Token strategy:
 *   - ACCESS token in a closure variable. Never localStorage: anything there is readable
 *     by any script on the page, so one XSS becomes full account takeover.
 *   - REFRESH token as an HttpOnly cookie the browser attaches automatically. JavaScript
 *     cannot read it, so XSS cannot exfiltrate a long-lived credential.
 *
 * The cost is that a reload starts with no access token, which is why callers run
 * `refresh()` on boot.
 */

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
  /** Skip refresh-and-retry. Used by refresh() itself to avoid recursion. */
  skipAuthRetry?: boolean;
  /** Attach the access token. Default true. */
  authenticated?: boolean;
}

export interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  /** Full replacement, used where a partial update has no meaning (e.g. interests). */
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;

  setAccessToken(token: string | null, expiresInSeconds?: number): void;
  getAccessToken(): string | null;
  hasValidAccessToken(): boolean;
  refresh(): Promise<boolean>;
  /** Guarantee a usable token before an operation that cannot transparently retry. */
  ensureAccessToken(): Promise<string | null>;
}

export function createApiClient(baseUrl: string): ApiClient {
  let accessToken: string | null = null;
  let accessTokenExpiresAt = 0;
  let refreshInFlight: Promise<boolean> | null = null;

  function setAccessToken(token: string | null, expiresInSeconds = 0): void {
    accessToken = token;
    // Refresh 30s early, so a request never travels with a token that expires in flight.
    accessTokenExpiresAt = token ? Date.now() + (expiresInSeconds - 30) * 1000 : 0;
  }

  function hasValidAccessToken(): boolean {
    return accessToken !== null && Date.now() < accessTokenExpiresAt;
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { body, skipAuthRetry = false, authenticated = true, headers, ...init } = options;

    const requestHeaders = new Headers(headers);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    if (authenticated && accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: requestHeaders,
      // Required for the HttpOnly refresh cookie to be sent and set.
      credentials: 'include',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

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

    const error: ApiError =
      payload && !payload.ok
        ? payload.error
        : { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };

    /**
     * A 401 on an authenticated request usually just means the 15-minute access token
     * aged out. Refresh once and retry transparently — a user should never be bounced to
     * a login screen because their token expired while they were reading the page.
     *
     * Retried at most once, and never for INVALID_CREDENTIALS, so a genuinely dead
     * session cannot loop.
     */
    if (
      response.status === 401 &&
      authenticated &&
      !skipAuthRetry &&
      error.code !== 'INVALID_CREDENTIALS'
    ) {
      if (await refresh()) return request<T>(path, { ...options, skipAuthRetry: true });
    }

    throw new ApiRequestError(error, response.status);
  }

  async function refresh(): Promise<boolean> {
    // Coalesce concurrent callers: N simultaneous 401s must cause one refresh, not N.
    refreshInFlight ??= (async () => {
      try {
        const data = await request<{ tokens: { accessToken: string; expiresIn: number } }>(
          '/v1/auth/refresh',
          { method: 'POST', skipAuthRetry: true, authenticated: false },
        );
        setAccessToken(data.tokens.accessToken, data.tokens.expiresIn);
        return true;
      } catch {
        setAccessToken(null);
        return false;
      } finally {
        queueMicrotask(() => {
          refreshInFlight = null;
        });
      }
    })();

    return refreshInFlight;
  }

  return {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),

    setAccessToken,
    getAccessToken: () => accessToken,
    hasValidAccessToken,
    refresh,
    ensureAccessToken: async () => (hasValidAccessToken() ? accessToken : (await refresh()) ? accessToken : null),
  };
}
