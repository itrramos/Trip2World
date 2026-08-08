'use client';

import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell, Button, Field, Input } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);

    /**
     * Always show the same confirmation, and never surface an error.
     *
     * If this screen said "no account with that address", anyone could use it to test
     * whether a given email is registered on a random-video-chat site — which is
     * exactly the kind of disclosure that gets people harassed. The API returns an
     * identical response for both cases; the UI must not undo that by reacting
     * differently to a failure.
     */
    try {
      await api.post('/v1/auth/forgot-password', { email }, { authenticated: false });
    } catch {
      // Intentionally ignored.
    } finally {
      setSent(true);
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="If we found an account, a reset link is on its way."
        footer={
          <Link href="/login" className="text-brand underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <div className="flex items-start gap-3 rounded-sm border border-brand/30 bg-brand/10 px-4 py-3 text-sm">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
          <span className="text-muted">
            We sent a link to <span className="text-foreground">{email}</span> if an account exists
            for it. The link expires in one hour and can only be used once.
          </span>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We will email you a link to set a new one."
      footer={
        <Link href="/login" className="text-brand underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Button type="submit" size="lg" fullWidth loading={busy}>
          Send reset link
        </Button>
      </form>
    </AuthShell>
  );
}
