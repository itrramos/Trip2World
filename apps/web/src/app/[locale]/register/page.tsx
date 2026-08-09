'use client';

import { COUNTRIES, DEFAULT_MINIMUM_AGE, PASSWORD_MIN_LENGTH } from '@trip2world/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState, type FormEvent } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';
import { AuthShell, Button, Field, FormError, Input, Select } from '@/components/ui';
import { Link, useRouter } from '@/i18n/navigation';

/** Latest date of birth that satisfies the age gate, for the date input's `max`. */
function maxBirthDate(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - DEFAULT_MINIMUM_AGE);
  return date.toISOString().slice(0, 10);
}

export default function RegisterPage() {
  const t = useTranslations('auth.register');
  const tCommon = useTranslations('common');
  const locale = useLocale();
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

  // Sorted in the reader's language: "Deutschland" belongs under D for a German speaker,
  // and an accented initial must not sort after Z.
  const countries = useMemo(
    () => [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [locale],
  );

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
          // The language they signed up in, so verification email and future sessions
          // arrive in it rather than defaulting everyone to English.
          locale,
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
        setError(tCommon('networkError'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthShell
        title={t('checkEmailTitle')}
        subtitle={t('checkEmailSubtitle')}
        footer={
          <Link href="/login" className="text-brand underline underline-offset-4">
            {t('backToSignIn')}
          </Link>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          {t.rich('checkEmailBody', {
            email: form.email,
            strong: (chunks) => <span className="text-foreground">{chunks}</span>,
          })}
        </p>
        <p className="mt-4 text-xs text-muted">{t('checkEmailSpam')}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('title')}
      subtitle={t('subtitle', { age: DEFAULT_MINIMUM_AGE })}
      footer={
        <>
          {t('footerPrompt')}{' '}
          <Link href="/login" className="text-brand underline underline-offset-4">
            {t('footerAction')}
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <FormError message={error} />

        <Field label={t('email')} htmlFor="email" error={fieldErrors.email?.[0]}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            invalid={Boolean(fieldErrors.email)}
            value={form.email}
            onChange={(e) => update('email')(e.target.value)}
            placeholder={tCommon('emailPlaceholder')}
          />
        </Field>

        <Field
          label={t('username')}
          htmlFor="username"
          error={fieldErrors.username?.[0]}
          hint={t('usernameHint')}
        >
          <Input
            id="username"
            autoComplete="username"
            required
            invalid={Boolean(fieldErrors.username)}
            value={form.username}
            onChange={(e) => update('username')(e.target.value.toLowerCase())}
            placeholder={t('usernamePlaceholder')}
          />
        </Field>

        <Field
          label={t('password')}
          htmlFor="password"
          error={fieldErrors.password?.[0]}
          hint={t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
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

        <Field
          label={t('confirmPassword')}
          htmlFor="confirmPassword"
          error={fieldErrors.confirmPassword?.[0]}
        >
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
          label={t('birthDate')}
          htmlFor="birthDate"
          error={fieldErrors.birthDate?.[0]}
          hint={t('birthDateHint')}
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

        <Field label={t('country')} htmlFor="country" error={fieldErrors.country?.[0]}>
          <Select
            id="country"
            required
            invalid={Boolean(fieldErrors.country)}
            value={form.country}
            onChange={(e) => update('country')(e.target.value)}
          >
            <option value="" disabled>
              {t('countryPlaceholder')}
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
            {t.rich('consent', {
              age: DEFAULT_MINIMUM_AGE,
              terms: (chunks) => (
                <Link href="/terms" className="text-brand underline underline-offset-4">
                  {chunks}
                </Link>
              ),
              guidelines: (chunks) => (
                <Link href="/guidelines" className="text-brand underline underline-offset-4">
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </label>

        <Button type="submit" size="lg" fullWidth loading={submitting} disabled={!accepted}>
          {t('submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
