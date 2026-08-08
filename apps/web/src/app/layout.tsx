import { APP_NAME, APP_TAGLINE } from '@trip2world/shared';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Self-hosted via next/font rather than a Google Fonts <link>. Two reasons: the font
 * files are served from our own origin, so no user's IP is handed to a third party on
 * every page load; and there is no render-blocking request to an external host.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://call.trip2fun.com';

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: `${APP_NAME} — ${APP_TAGLINE}`,
    template: `%s · ${APP_NAME}`,
  },
  description:
    'Trip2World connects you with people around the world for spontaneous face-to-face conversations. Meet someone new in seconds.',
  applicationName: APP_NAME,
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: 'black-translucent' },
  openGraph: {
    type: 'website',
    siteName: APP_NAME,
    title: `${APP_NAME} — ${APP_TAGLINE}`,
    description: 'Meet the world, one conversation at a time.',
    url: appUrl,
  },
  robots: {
    index: true,
    follow: true,
    // The conversation surface must never be indexed or previewed.
    nosnippet: false,
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1c' },
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
  ],
  width: 'device-width',
  initialScale: 1,
  // Not user-scalable=no: pinch-zoom is an accessibility feature and disabling it is a
  // WCAG failure. viewport-fit=cover handles the notch instead.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="min-h-dvh font-sans">
        {/* Keyboard users must be able to skip the nav to reach the primary action. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-brand focus:px-4 focus:py-2 focus:text-background"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
