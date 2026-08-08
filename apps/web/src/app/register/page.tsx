'use client';

import { COUNTRIES, DEFAULT_MINIMUM_AGE, PASSWORD_MIN_LENGTH } from '@trip2world/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';
import { AuthShell, Button, Field, FormError, Input, Select } from '@/components/ui';

/** Latest date of birth that satisfies the age gate, for the date input's `max`. */
function maxBirthDate(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - DEFAULT_MINIMUM_AGE);
  return date.toISOString().slice(0, 10);
}

export default function RegisterPage() {
  const router = useRouter();
  const { signIn } = useSession();

  const [form, setForm] = useState({
    email: '',
    username: '',
    password: '',
    confirmPassword: '',
    birthDate: '',
    country: '',
  });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ requiresVerification: boolean } | null>(null);

  const countries = useMemo(() => [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name)), []);

  const update = (key: keyof typeof form) => (value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      const result = await api.post<{ requiresVerification: boolean }>(
        '/v1/auth/register',
        {
          ...form,
          // The country's primary languages seed the profile; the user can edit them later.
          languages: COUNTRIES.find((c) => c.code === form.country)?.languages ?? ['en'],
          locale: 'en',
          acceptedTerms: true,
          acceptedGuidelines: true,
        },
        { authenticated: false },
      );

      if (result.requiresVerification) {
        setDone({ requiresVerification: true });
        return;
      }

      // Verification disabled on this deployment — sign straight in.
      await signIn(form.email, form.password);
      router.replace('/discover');
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setFieldErrors(caught.fieldErrors);
        // Field-level messages are rendered inline; only show a banner when there are none,
        // otherwise the same problem is reported twice.
        setError(Object.keys(caught.fieldErrors).length > 0 ? null : caught.message);
      } else {
        setError('We could not reach Trip2World. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="One more step before you can start."
        footer={
          <Link href="/login" className="text-brand underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          We sent a confirmation link to <span className="text-foreground">{form.email}</span>. Open
          it to activate your account.
        </p>
        <p className="mt-4 text-xs text-muted">
          Nothing arrived? Check your spam folder — the link expires in 24 hours.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle={`Free, and you must be ${DEFAULT_MINIMUM_AGE} or over.`}
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="text-brand underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <FormError message={error} />

        <Field label="Email" htmlFor="email" error={fieldErrors.email?.[0]}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            invalid={Boolean(fieldErrors.email)}
            value={form.email}
            onChange={(e) => update('email')(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Field
          label="Username"
          htmlFor="username"
          error={fieldErrors.username?.[0]}
          hint="Lowercase letters, numbers and underscores. This is what other people see."
        >
          <Input
            id="username"
            autoComplete="username"
            required
            invalid={Boolean(fieldErrors.username)}
            value={form.username}
            onChange={(e) => update('username')(e.target.value.toLowerCase())}
            placeholder="ana_pt"
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          error={fieldErrors.password?.[0]}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            invalid={Boolean(fieldErrors.password)}
            value={form.password}
            onChange={(e) => update('password')(e.target.value)}
          />
        </Field>

        <Field label="Confirm password" htmlFor="confirmPassword" error={fieldErrors.confirmPassword?.[0]}>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            invalid={Boolean(fieldErrors.confirmPassword)}
            value={form.confirmPassword}
            onChange={(e) => update('confirmPassword')(e.target.value)}
          />
        </Field>

        <Field
          label="Date of birth"
          htmlFor="birthDate"
          error={fieldErrors.birthDate?.[0]}
          hint="Only ever shown to you. Others see an age range."
        >
          <Input
            id="birthDate"
            type="date"
            required
            max={maxBirthDate()}
            invalid={Boolean(fieldErrors.birthDate)}
            value={form.birthDate}
            onChange={(e) => update('birthDate')(e.target.value)}
          />
        </Field>

        <Field label="Country" htmlFor="country" error={fieldErrors.country?.[0]}>
          <Select
            id="country"
            required
            invalid={Boolean(fieldErrors.country)}
            value={form.country}
            onChange={(e) => update('country')(e.target.value)}
          >
            <option value="" disabled>
              Select your country
            </option>
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </Select>
        </Field>

        {/*
          One checkbox covering both documents, but the submitted payload sets each flag
          explicitly. A single unchecked box blocks submission entirely — the API also
          requires a literal `true` for each, so consent cannot be omitted by a crafted
          request either.
        */}
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            required
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border bg-surface accent-brand"
          />
          <span className="text-muted">
            I am {DEFAULT_MINIMUM_AGE} or older and I accept the{' '}
            <Link href="/terms" className="text-brand underline underline-offset-4">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/guidelines" className="text-brand underline underline-offset-4">
              Community Guidelines
            </Link>
            .
          </span>
        </label>

        <Button type="submit" size="lg" fullWidth loading={submitting} disabled={!accepted}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
