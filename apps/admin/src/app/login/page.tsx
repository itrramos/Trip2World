'use client';

import { AuthShell, Button, Field, FormError, Input } from '@trip2world/ui';
import { ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError } from '@/lib/api';
import { useAdminSession } from '@/components/admin-session';

export default function AdminLoginPage() {
  const { signIn, status } = useAdminSession();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email, password);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        if (caught.error.code === 'RATE_LIMITED' && caught.error.retryAfter) {
          const minutes = Math.ceil(caught.error.retryAfter / 60);
          setError(`Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
        } else {
          setError(caught.message);
        }
      } else {
        setError('Could not reach the API. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // A valid sign-in without moderator rights lands here, handled by <Shell>.
  if (status === 'forbidden') {
    return (
      <AuthShell
        title="No moderator access"
        subtitle="Your credentials were accepted, but this panel is restricted."
        footer={null}
      >
        <p className="text-sm text-muted">
          Ask a super administrator to grant your account a moderator role.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Moderator sign-in"
      subtitle="Restricted to Trip2World staff."
      footer={
        <span className="flex items-center justify-center gap-2 text-xs">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
          Every action in this panel is recorded in the audit log.
        </span>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <FormError message={error} />

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
