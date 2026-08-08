'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { AuthShell, Button } from '@/components/ui';

type State =
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'expired' }
  | { kind: 'invalid'; message: string }
  | { kind: 'missing' };

function VerifyEmail() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<State>(token ? { kind: 'verifying' } : { kind: 'missing' });

  /**
   * React 18+ mounts effects twice in development StrictMode. The verification token is
   * strictly single-use, so a second call would consume it and report "already used" for
   * a link the user clicked exactly once. This guard makes the request happen once.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    void (async () => {
      try {
        await api.post('/v1/auth/verify-email', { token }, { authenticated: false });
        setState({ kind: 'success' });
      } catch (error) {
        if (error instanceof ApiRequestError) {
          if (error.error.code === 'TOKEN_EXPIRED') setState({ kind: 'expired' });
          else setState({ kind: 'invalid', message: error.message });
        } else {
          setState({
            kind: 'invalid',
            message: 'We could not reach Trip2World. Check your connection and try again.',
          });
        }
      }
    })();
  }, [token]);

  if (state.kind === 'verifying') {
    return (
      <AuthShell title="Confirming your email" subtitle="This will only take a moment." footer={null}>
        <div className="flex items-center gap-3 text-sm text-muted">
          <Loader2 className="h-5 w-5 animate-spin text-brand" aria-hidden />
          Checking your link…
        </div>
      </AuthShell>
    );
  }

  if (state.kind === 'success') {
    return (
      <AuthShell
        title="Email confirmed"
        subtitle="Your account is ready."
        footer={
          <Link href="/" className="text-muted underline underline-offset-4">
            Back to home
          </Link>
        }
      >
        <div className="space-y-6">
          <div className="flex items-center gap-3 rounded-sm border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden />
            You can now start meeting people.
          </div>
          <Link
            href="/login"
            className="glow inline-flex w-full items-center justify-center rounded-sm bg-brand px-7 py-3.5 font-medium text-background transition-transform duration-fast hover:scale-[1.01]"
          >
            Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  const isExpired = state.kind === 'expired';

  return (
    <AuthShell
      title={isExpired ? 'This link has expired' : 'We could not confirm that link'}
      subtitle={
        isExpired
          ? 'Confirmation links are valid for 24 hours.'
          : 'The link may have already been used.'
      }
      footer={
        <Link href="/login" className="text-brand underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <div className="space-y-6">
        <div className="flex items-start gap-3 rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <span>
            {state.kind === 'missing'
              ? 'That link is incomplete. Open the link from your email directly rather than copying part of it.'
              : state.kind === 'invalid'
                ? state.message
                : 'Request a new confirmation email and try again.'}
          </span>
        </div>

        <ResendVerification />
      </div>
    </AuthShell>
  );
}

/**
 * Resend form.
 *
 * The response is deliberately identical whether or not the address exists — the API
 * behaves the same way. Reporting "no such account" here would turn this into the
 * account-enumeration oracle that the login endpoint carefully avoids being.
 */
function ResendVerification() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (sent) {
    return (
      <p className="text-sm text-muted">
        If that address still needs confirming, a new link is on its way.
      </p>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void api
          .post('/v1/auth/resend-verification', { email }, { authenticated: false })
          .catch(() => undefined)
          .finally(() => {
            setSent(true);
            setBusy(false);
          });
      }}
    >
      <label htmlFor="resend-email" className="block text-sm font-medium">
        Send a new link
      </label>
      <input
        id="resend-email"
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        className="w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm placeholder:text-muted/60 focus:border-brand"
      />
      <Button type="submit" variant="secondary" fullWidth loading={busy}>
        Resend confirmation email
      </Button>
    </form>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <VerifyEmail />
    </Suspense>
  );
}
