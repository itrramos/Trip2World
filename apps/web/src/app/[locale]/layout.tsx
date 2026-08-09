import { APP_NAME, APP_TAGLINE } from '@trip2world/shared';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/components/session-provider';
import { isSupportedLocale, routing } from '@/i18n/routing';

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

/** Pre-render every locale at build time instead of on first request. */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });

  return {
    metadataBase: new URL(appUrl),
    title: {
      default: `${APP_NAME} — ${APP_TAGLINE}`,
      template: `%s · ${APP_NAME}`,
    },
    description: t('description'),
    applicationName: APP_NAME,
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: 'black-translucent' },
    /**
     * Tell search engines the other five translations of this page exist. Without
     * `alternates` they are treated as duplicate content competing with each other.
     */
    alternates: {
      canonical: locale === routing.defaultLocale ? '/' : `/${locale}`,
      languages: Object.fromEntries(
        routing.locales.map((l) => [l, l === routing.defaultLocale ? '/' : `/${l}`]),
      ),
    },
    openGraph: {
      type: 'website',
      siteName: APP_NAME,
      title: `${APP_NAME} — ${APP_TAGLINE}`,
      description: t('tagline'),
      url: appUrl,
      locale,
    },
    robots: { index: true, follow: true, nosnippet: false },
    formatDetection: { telephone: false, email: false, address: false },
  };
}

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

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // The segment is user-controlled, so `/xx/discover` reaches here with locale "xx".
  // Rendering it would produce lang="xx" and a catalogue lookup that cannot succeed.
  if (!isSupportedLocale(locale)) notFound();

  // Opts this tree into static rendering; without it every page becomes dynamic.
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning className={inter.variable}>
      <body className="min-h-dvh font-sans">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SkipLink />
          <SessionProvider>{children}</SessionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

/** Keyboard users must be able to skip the nav to reach the primary action. */
async function SkipLink() {
  const t = await getTranslations('common');
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-brand focus:px-4 focus:py-2 focus:text-background"
    >
      {t('skipToContent')}
    </a>
  );
}
