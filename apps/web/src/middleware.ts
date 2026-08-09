import createMiddleware from 'next-intl/middleware';
import { routing } from '@/i18n/routing';

export default createMiddleware(routing);

/**
 * What the locale middleware runs on.
 *
 * Excluded deliberately:
 *
 * - `/api` — this app's own route handlers (the health check, the manifest). They return
 *   JSON, not pages, and a locale rewrite would move them.
 * - `/_next`, `/_vercel` — build output.
 * - Anything with a file extension. Rewriting `/icon.svg` to `/en/icon.svg` produces a
 *   404 for an asset that exists, which breaks the PWA manifest and the favicon.
 */
export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
