'use client';

import { Select } from '@trip2world/ui';
import { useLocale } from 'next-intl';
import { useTransition } from 'react';
import { api } from '@/lib/api';
import { usePathname, useRouter } from '@/i18n/navigation';
import { LOCALE_LABELS, TRANSLATED_LOCALES, type AppLocale } from '@/i18n/routing';

/**
 * Change the interface language.
 *
 * Two things happen on change, and both matter:
 *
 * 1. **Navigate.** `usePathname` from `@/i18n/navigation` returns the path *without* the
 *    locale prefix, so re-pushing it under a new locale keeps the user on the page they
 *    were reading instead of dumping them at the home page.
 *
 * 2. **Persist.** The choice is written to the profile, so it survives a new device and a
 *    cleared cookie, and so the API can send emails in it. That request is fire-and-forget
 *    — a failed write must not block a navigation the user already sees happening, and the
 *    cookie next-intl sets covers this browser regardless.
 */
export function LanguageSwitcher({ id = 'locale' }: { id?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  // One language means there is nothing to switch between. Rendering the control anyway
  // would advertise a choice that does not exist.
  if (TRANSLATED_LOCALES.length < 2) return null;

  return (
    <Select
      id={id}
      value={locale}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value as AppLocale;

        void api.patch('/v1/profile', { locale: next }).catch(() => undefined);

        // `replace` rather than `push`: switching language is not a step the back button
        // should have to walk through.
        startTransition(() => {
          router.replace(pathname, { locale: next });
        });
      }}
    >
      {TRANSLATED_LOCALES.map((value) => (
        <option key={value} value={value}>
          {LOCALE_LABELS[value]}
        </option>
      ))}
    </Select>
  );
}
