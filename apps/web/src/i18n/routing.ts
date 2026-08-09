import { DEFAULT_LOCALE, LOCALES, type Locale } from '@trip2world/types';
import { defineRouting } from 'next-intl/routing';

/**
 * Locale routing.
 *
 * The locale list is the one in `packages/types`, not a second copy. It is also what the
 * API validates a profile's `locale` against, so a language the UI cannot render can
 * never be stored on an account.
 *
 * **`localePrefix: 'as-needed'`** is the important choice here. English serves from the
 * bare path — `/discover`, not `/en/discover` — and only the other five carry a prefix.
 * Trip2World is already deployed with those URLs live, in a manifest `start_url`, in
 * verification emails that have already been sent, and in whatever users have
 * bookmarked. A scheme that prefixed every locale would break all of them for the
 * benefit of a language nobody is using yet.
 */
export const routing = defineRouting({
  locales: LOCALES as Locale[],
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',

  /**
   * Detection is on, so a browser set to Portuguese lands on Portuguese. next-intl
   * writes its choice to a cookie, which is what stops the detection from fighting a
   * user who has deliberately switched away from their browser's language.
   */
  localeDetection: true,
});

export type AppLocale = (typeof routing.locales)[number];

/** Whether an arbitrary string is a locale this build can actually render. */
export function isSupportedLocale(value: string): value is AppLocale {
  return (routing.locales as readonly string[]).includes(value);
}

/**
 * Locales that actually have a message catalogue.
 *
 * Every locale in `routing.locales` *routes* — `/de/discover` resolves and renders,
 * falling back to English key by key. But only these are offered in the language picker,
 * because a switcher entry that changes the URL and nothing else is exactly the kind of
 * control that looks broken. Adding a language is: write `messages/<code>.json`, add the
 * code here. No component changes.
 *
 * Kept as a hand-maintained list rather than derived at runtime because
 * `generateStaticParams` and the middleware both need it before any request exists.
 */
export const TRANSLATED_LOCALES: readonly AppLocale[] = ['en', 'pt'];

/**
 * What each language calls itself.
 *
 * Endonyms, deliberately: someone looking for Portuguese is looking for "Português", and
 * may not read the English word for their own language. No flags — a flag is a country,
 * not a language, and picking one for Portuguese or Spanish tells a large part of the
 * world they are an afterthought.
 */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  es: 'Español',
  pt: 'Português',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
};
