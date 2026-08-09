import { getRequestConfig } from 'next-intl/server';
import { isSupportedLocale, routing } from './routing';

/**
 * Per-request message loading.
 *
 * Catalogues are imported dynamically so a visitor downloads one language, not six.
 *
 * **English is always merged underneath the active locale.** A partially translated
 * catalogue then renders the translated keys and falls back to English for the rest,
 * instead of throwing or printing a raw key like `discover.controls.next` at a user.
 * That is the property that makes translation a safe, incremental copy task: a
 * translator can ship forty per cent of a file and nothing breaks.
 */
type MessageTree = { [key: string]: string | MessageTree };

/**
 * Merge a translation over English, key by key, at every depth.
 *
 * A shallow spread would not do: catalogues are grouped into namespaces, so `{...en,
 * ...es}` replaces the entire `discover` namespace the moment a translator touches one
 * string inside it, and every key they have not reached yet disappears. Recursing means
 * an untranslated key falls back individually.
 */
function mergeMessages(base: MessageTree, overlay: MessageTree): MessageTree {
  const result: MessageTree = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] =
      typeof value === 'object' && value !== null && typeof existing === 'object' && existing !== null
        ? mergeMessages(existing, value)
        : value;
  }

  return result;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = requested && isSupportedLocale(requested) ? requested : routing.defaultLocale;

  const english = (await import('../../messages/en.json')).default as MessageTree;
  const messages =
    locale === routing.defaultLocale
      ? english
      : mergeMessages(
          english,
          (await import(`../../messages/${locale}.json`)).default as MessageTree,
        );

  return {
    locale,
    messages,
    /**
     * A missing key is a bug, not a crash. In development it is loud; in production the
     * fallback chain has already substituted English by the time this runs, so the user
     * sees real words either way.
     */
    onError(error) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] ${error.message}`);
      }
    },
    getMessageFallback({ key }) {
      return key.split('.').pop() ?? key;
    },
  };
});
