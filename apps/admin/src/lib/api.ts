import { createApiClient } from '@trip2world/ui';

/**
 * Admin API client.
 *
 * Points at the admin panel's OWN origin (`admin.trip2fun.com/api`), which Caddy proxies
 * to the same `api` container the public app uses. That indirection is the entire point
 * of the split: because the request is same-origin, the session cookie is host-scoped to
 * `admin.trip2fun.com` and is never attached to a request made by code running on
 * `call.trip2fun.com`. A cross-site scripting flaw in the public bundle therefore cannot
 * ride a moderator's session.
 *
 * The implementation — token storage, refresh coalescing, retry-on-401 — is shared with
 * the web app via `@trip2world/ui`, so there is one place where session handling can be
 * wrong rather than two.
 */
export const api = createApiClient(process.env.NEXT_PUBLIC_API_URL ?? '/api');

export { ApiRequestError } from '@trip2world/ui';
