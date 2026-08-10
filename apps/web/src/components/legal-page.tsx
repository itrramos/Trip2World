import { APP_NAME } from '@trip2world/shared';
import { ArrowLeft, Languages } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/**
 * Shared chrome for the policy pages.
 *
 * These are linked from the registration form, where the user must accept the Terms and
 * the Community Guidelines to create an account. A 404 behind a consent checkbox means
 * the consent is not informed, so these pages are a requirement rather than a nicety.
 *
 * **The documents themselves stay in English in every locale, deliberately.** The chrome
 * around them is translated, and a non-English reader gets a notice explaining why. A
 * machine-translated Privacy Policy is not a convenience — it is a document that may not
 * say what it appears to say, in an area where the wording is the entire point. These
 * need a lawyer per jurisdiction, not a translation pass, and pretending otherwise would
 * be the most damaging thing i18n could do to this codebase.
 */
export async function LegalPage({
  title,
  updated,
  summary,
  children,
}: {
  title: string;
  updated: string;
  summary: string;
  children: ReactNode;
}) {
  const t = await getTranslations('legal');
  const tNav = await getTranslations('nav');
  const locale = await getLocale();
  const isTranslated = locale === routing.defaultLocale;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('backTo', { app: APP_NAME })}
      </Link>

      {/*
        `lang="en"` on the document itself, so a screen reader switches voice rather than
        reading English prose with Spanish phonetics.
      */}
      <div lang="en">
        <h1 className="mt-8 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      </div>
      <p className="mt-2 text-sm text-muted">{t('lastUpdated', { date: updated })}</p>

      {!isTranslated && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-border bg-surface/50 p-5 text-sm leading-relaxed">
          <Languages className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
          <span>
            <strong className="font-medium text-foreground">{t('englishOnlyTitle')}</strong>{' '}
            <span className="text-muted">{t('englishOnlyBody')}</span>
          </span>
        </div>
      )}

      <p
        lang="en"
        className="mt-6 rounded-lg border border-border bg-surface/50 p-5 text-sm leading-relaxed"
      >
        {summary}
      </p>

      {/*
        `prose`-style spacing done by hand rather than pulling in a typography plugin for
        four pages. Headings are h2 so the page keeps a single h1.
      */}
      <div
        lang="en"
        className="mt-10 space-y-8 text-sm leading-relaxed text-muted [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_p+p]:mt-3 [&_ul]:mt-2 [&_ul]:space-y-1.5"
      >
        {children}
      </div>

      <footer className="mt-14 border-t border-border pt-6 text-xs text-muted">
        <p>{t('questions')}</p>
        <nav className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/terms" className="hover:text-foreground">
            {tNav('terms')}
          </Link>
          <Link href="/privacy" className="hover:text-foreground">
            {tNav('privacy')}
          </Link>
          <Link href="/guidelines" className="hover:text-foreground">
            {tNav('guidelines')}
          </Link>
          <Link href="/safety" className="hover:text-foreground">
            {tNav('safety')}
          </Link>
        </nav>
      </footer>
    </main>
  );
}

/*
 * `ReviewNotice` used to live here — a banner warning that these documents were drafted
 * against the software's actual behaviour but had not been seen by a lawyer. The
 * operator has since had them reviewed by an attorney, so the warning is no longer true
 * and has been removed along with its message keys.
 *
 * If this codebase is ever redeployed by somebody else, that review does not travel with
 * it: the documents describe how the software behaves, not the law where the new
 * operator is. See README.
 */
