'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';
import { AuthShell, Button, Field, FormError, Input } from '@/components/ui';

function LoginForm() {
  const { signIn, status } = useSession();
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Only accept a same-origin relative path as the post-login destination.
   *
   * Taking `?next=` verbatim is a textbook open-redirect: a link to
   * `…/login?next=https://evil.example` would send a freshly-authenticated user straight
   * to an attacker's page, which is a very effective phishing setup. A leading `//` is
   * also protocol-relative, so it must be rejected too.
   */
  const nextParam = params.get('next');
  const next = nextParam && /^\/(?!\/)/.test(nextParam) ? nextParam : '/discover';

  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email, password);
      router.replace(next);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        // The API returns a deliberately identical message for "no such account" and
        // "wrong password"; surfacing it verbatim preserves that property.
        setError(caught.message);
        if (caught.error.code === 'RATE_LIMITED' && caught.error.retryAfter) {
          const minutes = Math.ceil(caught.error.retryAfter / 60);
          setError(`Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
        }
      } else {
        setError('We could not reach Trip2World. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to start meeting people."
      footer={
        <>
          New to Trip2World?{' '}
          <Link href="/register" className="text-brand underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <FormError message={error} />

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
          />
        </Field>

        <div className="flex justify-end">
          <Link
            href="/forgot-password"
            className="text-xs text-muted underline underline-offset-4 hover:text-foreground"
          >
            Forgot your password?
          </Link>
        </div>

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <LoginForm />
    </Suspense>
  );
}
