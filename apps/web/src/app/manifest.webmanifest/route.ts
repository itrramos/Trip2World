import { APP_NAME, APP_TAGLINE } from '@trip2world/shared';
import { NextResponse } from 'next/server';

/**
 * PWA manifest, served from a route rather than a static file so the start URL and name
 * follow the deployment's configured domain instead of being baked in at author time.
 */
export function GET() {
  return NextResponse.json(
    {
      name: `${APP_NAME} — ${APP_TAGLINE}`,
      short_name: APP_NAME,
      description: 'Meet people around the world for spontaneous face-to-face conversations.',
      // Launch straight into the product, not the marketing page. Someone who installed
      // the app has already been sold on it.
      start_url: '/discover',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait-primary',
      background_color: '#0a0f1c',
      theme_color: '#0a0f1c',
      categories: ['social', 'communication'],
      icons: [
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
      ],
    },
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' } },
  );
}
