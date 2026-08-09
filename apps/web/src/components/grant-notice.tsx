'use client';

import { Gift, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useSession, type TokenGrantNotice } from '@/components/session-provider';
import { Link } from '@/i18n/navigation';

/**
 * "You received N free tokens."
 *
 * Deliberately dismissed by hand rather than on a timer. A tip toast can fade — it is
 * one of many during a call — but this appears once, tells the user their balance
 * changed, and names the promotion that did it. Someone who blinks and misses it has no
 * way to find out where the tokens came from, and unexplained balance changes are how a
 * money feature loses trust.
 */
export function GrantNotice({ grants }: { grants?: TokenGrantNotice[] }) {
  const session = useSession();
  const t = useTranslations('grants');
  const format = useFormatter();

  // Either passed explicitly (the verification page, which has its own response) or
  // taken from the session (a sign-in that paid out).
  const items = grants ?? session.grants;
  if (items.length === 0) return null;

  const total = items.reduce((sum, grant) => sum + grant.tokens, 0);

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-sm sm:inset-x-auto sm:right-4"
    >
      <div className="glass rounded-lg border border-brand/40 p-4 shadow-2xl">
        <div className="flex items-start gap-3">
          <Gift className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />

          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('title', { count: total })}</p>

            {/* Name the promotion. "Where did these come from?" must be answerable. */}
            <ul className="mt-1 space-y-0.5 text-sm text-muted">
              {items.map((grant) => (
                <li key={grant.campaignId}>
                  {grant.campaignName} · {format.number(grant.tokens)}
                </li>
              ))}
            </ul>

            <Link
              href="/settings/tokens"
              className="mt-2 inline-block text-sm text-brand underline underline-offset-4"
            >
              {t('viewBalance')}
            </Link>
          </div>

          <button
            type="button"
            onClick={session.dismissGrants}
            aria-label={t('dismiss')}
            className="-m-1 shrink-0 rounded-sm p-1 text-muted transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
