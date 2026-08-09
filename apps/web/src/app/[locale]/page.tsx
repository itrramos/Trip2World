import { APP_NAME, COUNTRIES, INTEREST_CATALOGUE } from '@trip2world/shared';
import {
  ArrowRight,
  Ban,
  Flag,
  Globe2,
  Languages,
  Lock,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Video,
} from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { LandingNav } from '@/components/landing-nav';
import { Link } from '@/i18n/navigation';

/**
 * Landing page.
 *
 * Deliberately free of invented engagement numbers. "2 million users online" on a
 * freshly deployed instance is a lie, and the moment a visitor clicks through and waits
 * 40 seconds for a match, it is an obvious one. The page sells the idea and the safety
 * model instead, both of which are true on day one.
 *
 * A server component, so the copy for one language is rendered into the HTML rather than
 * shipping all six catalogues to the browser.
 */

/** Icons live in code; every string beside them comes from the catalogue. */
const HOW_IT_WORKS = [
  { key: 'camera', icon: Video },
  { key: 'matched', icon: Globe2 },
  { key: 'next', icon: SkipForward },
] as const;

const SAFETY = [
  { key: 'age', icon: ShieldCheck },
  { key: 'report', icon: Flag },
  { key: 'block', icon: Ban },
  { key: 'recording', icon: Lock },
] as const;

const FAQ = ['free', 'recording', 'details', 'next', 'mobile'] as const;

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('landing');
  const tNav = await getTranslations('nav');
  const tCommon = await getTranslations('common');

  // Real data from the supported-country list, not invented decoration.
  const countryStrip = COUNTRIES.slice(0, 24);

  return (
    <div className="relative overflow-hidden">
      {/* Ambient brand glow. Pointer-events-none so it never intercepts a click. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[36rem] bg-[radial-gradient(60%_60%_at_50%_0%,hsl(var(--brand)/0.18),transparent_70%)]"
      />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Globe2 className="h-6 w-6 text-brand" aria-hidden />
          {APP_NAME}
        </span>

        {/* The only part of this page that depends on who is looking at it. */}
        <LandingNav />
      </header>

      <main id="main" className="relative z-10">
        {/* ── Hero ───────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-4xl px-6 pb-20 pt-16 text-center sm:pt-24">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-1.5 text-xs text-muted backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
            {t('badge')}
          </p>

          <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
            {t('headlineLine1')}
            <br />
            <span className="text-gradient">{t('headlineLine2')}</span>
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted">
            {t('subhead')}
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/discover"
              className="glow group inline-flex w-full items-center justify-center gap-2 rounded bg-brand px-8 py-4 text-base font-semibold text-background transition-transform duration-fast hover:scale-[1.02] active:scale-[0.99] sm:w-auto"
            >
              {t('startExploring')}
              <ArrowRight
                className="h-4 w-4 transition-transform duration-base group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex w-full items-center justify-center rounded border border-border bg-surface/60 px-8 py-4 text-base font-medium backdrop-blur transition-colors duration-fast hover:bg-surface-raised sm:w-auto"
            >
              {t('howItWorksLink')}
            </a>
          </div>

          <p className="mt-6 text-xs text-muted">{t('reassurance')}</p>
        </section>

        {/* ── Country strip ──────────────────────────────────────────────── */}
        {/*
          Country NAMES, not flag emoji. Windows has no flag glyphs, so a row of flags
          renders there as bare letter pairs ("AR AT AU BE") — which looks like a broken
          font rather than a design. Names read correctly on every platform, and are
          more informative anyway.
        */}
        <section aria-label={t('countriesLabel')} className="pb-24">
          <div className="relative mx-auto max-w-5xl px-6">
            <div
              className="flex flex-wrap items-center justify-center gap-2"
              // Fade the edges so the list reads as a sample rather than a truncated set.
              style={{
                maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
              }}
            >
              {countryStrip.map((country) => (
                <span
                  key={country.code}
                  className="rounded-full border border-border/70 bg-surface/40 px-3.5 py-1.5 text-sm text-muted backdrop-blur"
                >
                  {country.name}
                </span>
              ))}
            </div>
            <p className="mt-6 text-center text-sm text-muted">
              <span className="font-medium text-foreground">
                {t('countriesSupported', { count: COUNTRIES.length })}
              </span>{' '}
              {t('countriesSuffix')}
            </p>
          </div>
        </section>

        {/* ── How it works ───────────────────────────────────────────────── */}
        <section id="how-it-works" className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-6xl px-6">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              {t('howItWorksTitle')}
            </h2>

            <ol className="mt-14 grid gap-6 md:grid-cols-3">
              {HOW_IT_WORKS.map((step, index) => (
                <li key={step.key} className="glass rounded-lg p-7">
                  <div className="mb-5 flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-sm bg-brand/10 text-brand">
                      <step.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <span className="text-sm tabular-nums text-muted">
                      {t('step', { number: index + 1 })}
                    </span>
                  </div>
                  <h3 className="text-lg font-medium">{t(`steps.${step.key}.title`)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {t(`steps.${step.key}.body`)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Interests ──────────────────────────────────────────────────── */}
        <section className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-4xl px-6 text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {t('interestsTitle')}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted">{t('interestsBody')}</p>

            <ul className="mt-10 flex flex-wrap justify-center gap-2.5">
              {INTEREST_CATALOGUE.map((interest) => (
                <li
                  key={interest.slug}
                  className="rounded-full border border-border bg-surface/60 px-4 py-2 text-sm backdrop-blur"
                >
                  <span aria-hidden className="mr-1.5">
                    {interest.emoji}
                  </span>
                  {interest.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Safety ─────────────────────────────────────────────────────── */}
        <section id="safety" className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-6xl px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                {t('safetyTitle')}
              </h2>
              <p className="mt-4 text-muted">{t('safetyBody')}</p>
            </div>

            <div className="mt-14 grid gap-6 sm:grid-cols-2">
              {SAFETY.map((item) => (
                <div key={item.key} className="glass rounded-lg p-7">
                  <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-sm bg-accent/10 text-accent">
                    <item.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h3 className="text-lg font-medium">{t(`safety.${item.key}.title`)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {t(`safety.${item.key}.body`)}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-10 text-center text-sm text-muted">
              {t.rich('guidelinesPrompt', {
                link: (chunks) => (
                  <Link href="/guidelines" className="text-brand underline underline-offset-4">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </div>
        </section>

        {/* ── FAQ ────────────────────────────────────────────────────────── */}
        <section className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-3xl px-6">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              {t('faqTitle')}
            </h2>

            <dl className="mt-12 divide-y divide-border/60">
              {FAQ.map((key) => (
                <div key={key} className="py-6">
                  <dt className="font-medium">{t(`faq.${key}.q`)}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-muted">{t(`faq.${key}.a`)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ── Final CTA ──────────────────────────────────────────────────── */}
        <section className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-2xl px-6 text-center">
            <Languages className="mx-auto mb-6 h-8 w-8 text-brand" aria-hidden />
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('finalCta')}</h2>
            <Link
              href="/discover"
              className="glow mt-8 inline-flex items-center gap-2 rounded bg-brand px-8 py-4 font-semibold text-background transition-transform duration-fast hover:scale-[1.02]"
            >
              {t('startExploring')}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-border/60 py-12">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 text-sm text-muted sm:flex-row">
          <span className="flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-brand" aria-hidden />
            {APP_NAME}
          </span>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link href="/guidelines" className="transition-colors hover:text-foreground">
              {tNav('guidelines')}
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              {tNav('terms')}
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              {tNav('privacy')}
            </Link>
            <Link href="/safety" className="transition-colors hover:text-foreground">
              {tNav('safety')}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
