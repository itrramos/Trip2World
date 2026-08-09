import { createApiClient } from '@trip2world/ui';

/**
 * The web app's API client instance.
 *
 * The implementation — token storage, refresh coalescing, retry-on-401 — lives in
 * `@trip2world/ui` so that it exists exactly once and is shared with the admin panel.
 * Only the base URL differs between the two, and that difference is load-bearing: each
 * app talks to its own origin so its session cookie stays host-scoped.
 */
export const api = createApiClient(process.env.NEXT_PUBLIC_API_URL ?? '/api');

export const setAccessToken = api.setAccessToken;
export const getAccessToken = api.getAccessToken;
export const hasValidAccessToken = api.hasValidAccessToken;
export const refresh = api.refresh;
export const ensureAccessToken = api.ensureAccessToken;

export { ApiRequestError } from '@trip2world/ui';
