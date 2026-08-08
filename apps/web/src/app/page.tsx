import { APP_NAME, COUNTRIES, countryFlagEmoji, INTEREST_CATALOGUE } from '@trip2world/shared';
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
import Link from 'next/link';

/**
 * Landing page.
 *
 * Deliberately free of invented engagement numbers. "2 million users online" on a
 * freshly deployed instance is a lie, and the moment a visitor clicks through and waits
 * 40 seconds for a match, it is an obvious one. The page sells the idea and the safety
 * model instead, both of which are true on day one.
 */

const HOW_IT_WORKS = [
  {
    icon: Video,
    title: 'Allow your camera',
    body: 'One tap. Your video is peer-to-peer — it goes to the person you are talking to, not to a server.',
  },
  {
    icon: Globe2,
    title: 'Get matched',
    body: 'Choose a country, a language, or nothing at all. We find someone available and compatible.',
  },
  {
    icon: SkipForward,
    title: 'Press Next any time',
    body: 'Not feeling it? One tap ends the call and finds someone new. No explanation needed.',
  },
];

const SAFETY = [
  {
    icon: ShieldCheck,
    title: '18+ only, enforced',
    body: 'Every account is age-gated at signup. The minimum cannot be lowered by configuration.',
  },
  {
    icon: Flag,
    title: 'Report in one tap',
    body: 'Reports go to a human moderation queue. Child-safety and threat reports jump the queue.',
  },
  {
    icon: Ban,
    title: 'Block means never again',
    body: 'Blocking is permanent and mutual. You will not be matched with that person again.',
  },
  {
    icon: Lock,
    title: 'Conversations are not recorded',
    body: 'We store who spoke to whom and when — never the video, audio, or what was said.',
  },
];

const FAQ = [
  {
    q: 'Is Trip2World free?',
    a: 'Yes. Matching, video, text chat, reporting and blocking are all free and always will be. Safety features are never behind a paywall.',
  },
  {
    q: 'Do you record calls?',
    a: 'No. We keep metadata about a conversation — the participants, when it started, how it ended — so that abuse reports can be investigated. The conversation itself is peer-to-peer and is never captured.',
  },
  {
    q: 'Who can see my details?',
    a: 'The person you are matched with sees your username, and only the details you choose to share: country, an age range, languages, interests. Never your exact age, email, or location beyond the country.',
  },
  {
    q: 'What happens when I press Next?',
    a: 'The call ends immediately for both of you, and you go straight back into matching. You will not be paired with the same person again while other people are available.',
  },
  {
    q: 'Can I use Trip2World on my phone?',
    a: 'Yes — the web app works in a mobile browser and can be installed to your home screen. Native apps are on the way.',
  },
];

export default function LandingPage() {
  // Country strip: real data from the supported-country list, not decoration.
  const flagStrip = COUNTRIES.slice(0, 28);

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

        <nav className="flex items-center gap-2 text-sm">
          <Link
            href="/login"
            className="rounded-sm px-4 py-2 text-muted transition-colors duration-fast hover:text-foreground"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="rounded-sm bg-surface-raised px-4 py-2 font-medium transition-colors duration-fast hover:bg-border"
          >
            Create account
          </Link>
        </nav>
      </header>

      <main id="main" className="relative z-10">
        {/* ── Hero ───────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-4xl px-6 pb-20 pt-16 text-center sm:pt-24">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-1.5 text-xs text-muted backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
            Real conversations with real people
          </p>

          <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
            Meet the world,
            <br />
            <span className="text-gradient">one conversation at a time.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted">
            Trip2World pairs you face to face with someone new, anywhere on earth. Talk as long as
            you like. Move on whenever you want.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/discover"
              className="glow group inline-flex w-full items-center justify-center gap-2 rounded bg-brand px-8 py-4 text-base font-semibold text-background transition-transform duration-fast hover:scale-[1.02] active:scale-[0.99] sm:w-auto"
            >
              Start Exploring
              <ArrowRight
                className="h-4 w-4 transition-transform duration-base group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
            <Link
              href="#how-it-works"
              className="inline-flex w-full items-center justify-center rounded border border-border bg-surface/60 px-8 py-4 text-base font-medium backdrop-blur transition-colors duration-fast hover:bg-surface-raised sm:w-auto"
            >
              How it works
            </Link>
          </div>

          <p className="mt-6 text-xs text-muted">
            Free to use · 18+ only · Your camera stays off until you choose to start
          </p>
        </section>

        {/* ── Country strip ──────────────────────────────────────────────── */}
        <section aria-label="Countries you can meet people from" className="pb-24">
          <div className="relative mx-auto max-w-6xl px-6">
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 text-2xl">
              {flagStrip.map((country) => (
                <span key={country.code} title={country.name} className="opacity-70">
                  <span aria-hidden>{countryFlagEmoji(country.code)}</span>
                  <span className="sr-only">{country.name}</span>
                </span>
              ))}
            </div>
            <p className="mt-5 text-center text-sm text-muted">
              {COUNTRIES.length} countries supported at launch
            </p>
          </div>
        </section>

        {/* ── How it works ───────────────────────────────────────────────── */}
        <section id="how-it-works" className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-6xl px-6">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              Three taps to a conversation
            </h2>

            <ol className="mt-14 grid gap-6 md:grid-cols-3">
              {HOW_IT_WORKS.map((step, index) => (
                <li key={step.title} className="glass rounded-lg p-7">
                  <div className="mb-5 flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-sm bg-brand/10 text-brand">
                      <step.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <span className="text-sm tabular-nums text-muted">Step {index + 1}</span>
                  </div>
                  <h3 className="text-lg font-medium">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Interests ──────────────────────────────────────────────────── */}
        <section className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-4xl px-6 text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Matched on what you actually care about
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted">
              Pick your interests and we will prioritise people who share them — without ever
              trapping you in a bubble.
            </p>

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
                Safety is not a feature we added later
              </h2>
              <p className="mt-4 text-muted">
                Talking to strangers only works if the rules are clear and enforced. Here is exactly
                what we do.
              </p>
            </div>

            <div className="mt-14 grid gap-6 sm:grid-cols-2">
              {SAFETY.map((item) => (
                <div key={item.title} className="glass rounded-lg p-7">
                  <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-sm bg-accent/10 text-accent">
                    <item.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h3 className="text-lg font-medium">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
                </div>
              ))}
            </div>

            <p className="mt-10 text-center text-sm text-muted">
              Read the{' '}
              <Link href="/guidelines" className="text-brand underline underline-offset-4">
                Community Guidelines
              </Link>{' '}
              before you start.
            </p>
          </div>
        </section>

        {/* ── FAQ ────────────────────────────────────────────────────────── */}
        <section className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-3xl px-6">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              Questions, answered
            </h2>

            <dl className="mt-12 divide-y divide-border/60">
              {FAQ.map((item) => (
                <div key={item.q} className="py-6">
                  <dt className="font-medium">{item.q}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-muted">{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ── Final CTA ──────────────────────────────────────────────────── */}
        <section className="border-t border-border/60 py-24">
          <div className="mx-auto max-w-2xl px-6 text-center">
            <Languages className="mx-auto mb-6 h-8 w-8 text-brand" aria-hidden />
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Someone interesting is one tap away
            </h2>
            <Link
              href="/discover"
              className="glow mt-8 inline-flex items-center gap-2 rounded bg-brand px-8 py-4 font-semibold text-background transition-transform duration-fast hover:scale-[1.02]"
            >
              Start Exploring
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
              Community Guidelines
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/safety" className="transition-colors hover:text-foreground">
              Safety
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
