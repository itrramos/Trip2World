import { NextResponse } from 'next/server';

/**
 * Liveness probe for the container healthcheck.
 *
 * Deliberately checks nothing external. The web tier renders pages and proxies nothing;
 * if the API or database is down, the correct behaviour is to keep serving the marketing
 * pages and show an error state in the app — not to have the orchestrator kill and
 * restart a perfectly functional Next.js process, which would fix nothing and drop every
 * in-flight request.
 */

// Never statically optimised or cached: a cached health response would report "ok"
// indefinitely, including after the process had stopped being able to render anything.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET() {
  return NextResponse.json(
    { status: 'ok', service: 'web' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
