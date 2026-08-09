import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

/**
 * Locale-aware replacements for `next/link` and the navigation hooks.
 *
 * Everything in the app must import from here rather than from `next/navigation`
 * directly. These wrappers carry the active locale into the generated href, so a
 * Portuguese user clicking "Settings" stays in Portuguese. Importing Next's own `Link`
 * silently drops the prefix and bounces them back to English — a bug that is invisible
 * in development, because development is English.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
