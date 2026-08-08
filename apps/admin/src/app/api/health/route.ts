import { NextResponse } from 'next/server';

/**
 * Liveness probe for the container healthcheck. Checks nothing external — see the
 * equivalent in apps/web for why a readiness-style check here would be wrong.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET() {
  return NextResponse.json(
    { status: 'ok', service: 'admin' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
