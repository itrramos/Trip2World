import type { ReactNode } from 'react';
import './globals.css';

/**
 * The root layout exists only because Next.js requires one.
 *
 * It deliberately renders no `<html>` or `<body>` — `app/[locale]/layout.tsx` does that,
 * because those tags carry `lang` and `dir`, and neither can be decided before the locale
 * is known. Putting them here would emit `lang="en"` for every visitor and quietly lie to
 * every screen reader that is not reading English.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
