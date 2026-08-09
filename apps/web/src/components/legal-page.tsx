import { APP_NAME } from '@trip2world/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Shared chrome for the policy pages.
 *
 * These are linked from the registration form, where the user must accept the Terms and
 * the Community Guidelines to create an account. A 404 behind a consent checkbox means
 * the consent is not informed, so these pages are a requirement rather than a nicety.
 */
export function LegalPage({
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
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to {APP_NAME}
      </Link>

      <h1 className="mt-8 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-muted">Last updated {updated}</p>

      <p className="mt-6 rounded-lg border border-border bg-surface/50 p-5 text-sm leading-relaxed">
        {summary}
      </p>

      {/*
        `prose`-style spacing done by hand rather than pulling in a typography plugin for
        four pages. Headings are h2 so the page keeps a single h1.
      */}
      <div className="mt-10 space-y-8 text-sm leading-relaxed text-muted [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_p+p]:mt-3 [&_ul]:mt-2 [&_ul]:space-y-1.5">
        {children}
      </div>

      <footer className="mt-14 border-t border-border pt-6 text-xs text-muted">
        <p>
          Questions about this document? Contact the operator of this Trip2World
          deployment.
        </p>
        <nav className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="/guidelines" className="hover:text-foreground">
            Community Guidelines
          </Link>
          <Link href="/safety" className="hover:text-foreground">
            Safety
          </Link>
        </nav>
      </footer>
    </main>
  );
}

/**
 * Banner marking these documents as un-reviewed templates.
 *
 * They accurately describe what this software does — I wrote them against the actual
 * data handling — but they are not legal advice and have not been reviewed by a lawyer.
 * Publishing them unchanged and unreviewed would be a mistake, so the page says so
 * rather than letting an operator assume otherwise.
 */
export function ReviewNotice() {
  return (
    <div className="rounded-sm border border-warning/40 bg-warning/10 p-4 text-xs text-warning">
      <strong className="font-semibold">Operator note — remove before launch.</strong> This
      document describes how this software actually behaves, but it has not been reviewed by
      a lawyer and is not legal advice. Have it reviewed against the law where you operate
      and where your users are, particularly GDPR if you serve the EU/UK.
    </div>
  );
}
