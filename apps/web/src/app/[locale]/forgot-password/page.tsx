'use client';

import { MailCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell, Button, Field, Input } from '@/components/ui';
import { Link } from '@/i18n/navigation';

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgot');
  const tCommon = useTranslations('common');

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
        title={t('sentTitle')}
        subtitle={t('sentSubtitle')}
        footer={
          <Link href="/login" className="text-brand underline underline-offset-4">
            {t('backToSignIn')}
          </Link>
        }
      >
        <div className="flex items-start gap-3 rounded-sm border border-brand/30 bg-brand/10 px-4 py-3 text-sm">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
          <span className="text-muted">
            {t.rich('sentBody', {
              email,
              strong: (chunks) => <span className="text-foreground">{chunks}</span>,
            })}
          </span>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('title')}
      subtitle={t('subtitle')}
      footer={
        <Link href="/login" className="text-brand underline underline-offset-4">
          {t('backToSignIn')}
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <Field label={t('email')} htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={tCommon('emailPlaceholder')}
          />
        </Field>

        <Button type="submit" size="lg" fullWidth loading={busy}>
          {t('submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
