'use client';

import { Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSession } from '@/components/session-provider';
import { Link } from '@/i18n/navigation';

/**
 * The landing page header, which has to know whether anyone is signed in.
 *
 * The rest of the page is a server component and stays that way — the copy, the country
 * list and the FAQ are identical for everyone and should be static HTML. Only this
 * fragment is a client component, because session state lives in memory in the browser
 * and cannot be known while rendering on the server.
 *
 * It exists because the header previously said "Sign in / Create account"
 * unconditionally. A signed-in user who navigated home was shown signed-out chrome and
 * reasonably concluded their session had died — which was not true, and which no amount
 * of reloading would have corrected.
 *
 * During the boot refresh `status` is 'loading'. Rendering the signed-out links then and
 * swapping a moment later is the same lie in miniature, so the actions are held back
 * until the answer is known. The reserved height keeps the header from jumping.
 */
export function LandingNav() {
  const { status } = useSession();
  const t = useTranslations('common');
  const tNav = useTranslations('nav');

  if (status === 'loading') {
    return <div className="h-9" aria-hidden />;
  }

  if (status === 'authenticated') {
    return (
      <nav className="flex items-center gap-2 text-sm">
        <Link
          href="/settings"
          aria-label={tNav('settings')}
          className="rounded-sm p-2 text-muted transition-colors duration-fast hover:text-foreground"
        >
          <Settings className="h-4 w-4" aria-hidden />
        </Link>
        <Link
          href="/discover"
          className="rounded-sm bg-brand px-4 py-2 font-medium text-background transition-transform duration-fast hover:scale-[1.02]"
        >
          {tNav('discover')}
        </Link>
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-2 text-sm">
      <Link
        href="/login"
        className="rounded-sm px-4 py-2 text-muted transition-colors duration-fast hover:text-foreground"
      >
        {t('signIn')}
      </Link>
      <Link
        href="/register"
        className="rounded-sm bg-surface-raised px-4 py-2 font-medium transition-colors duration-fast hover:bg-border"
      >
        {t('createAccount')}
      </Link>
    </nav>
  );
}
