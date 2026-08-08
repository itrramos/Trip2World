'use client';

import { PASSWORD_MIN_LENGTH } from '@trip2world/shared';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { AuthShell, Button, Field, FormError, Input } from '@/components/ui';

function ResetPasswordForm() {
  const token = useSearchParams().get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);

    try {
      await api.post(
        '/v1/auth/reset-password',
        { token, password, confirmPassword },
        { authenticated: false },
      );
      setDone(true);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setFieldErrors(caught.fieldErrors);
        setError(Object.keys(caught.fieldErrors).length > 0 ? null : caught.message);
      } else {
        setError('We could not reach Trip2World. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthShell
        title="This link is incomplete"
        subtitle="Open the link from your email directly."
        footer={
          <Link href="/forgot-password" className="text-brand underline underline-offset-4">
            Request a new link
          </Link>
        }
      >
        <p className="text-sm text-muted">
          The reset link is missing its token. Copying only part of the URL is the usual cause.
        </p>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        title="Password changed"
        subtitle="Every other device has been signed out."
        footer={null}
      >
        <div className="space-y-6">
          <div className="flex items-start gap-3 rounded-sm border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <span>
              For your safety, resetting a password ends every existing session — including
              anyone else who had access.
            </span>
          </div>
          <Link
            href="/login"
            className="glow inline-flex w-full items-center justify-center rounded-sm bg-brand px-7 py-3.5 font-medium text-background"
          >
            Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Make it something you have not used elsewhere."
      footer={
        <Link href="/login" className="text-muted underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <FormError message={error} />

        <Field
          label="New password"
          htmlFor="password"
          error={fieldErrors.password?.[0] ?? fieldErrors.token?.[0]}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            invalid={Boolean(fieldErrors.password)}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Field label="Confirm new password" htmlFor="confirmPassword" error={fieldErrors.confirmPassword?.[0]}>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            invalid={Boolean(fieldErrors.confirmPassword)}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Field>

        <Button type="submit" size="lg" fullWidth loading={busy}>
          Change password
        </Button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
