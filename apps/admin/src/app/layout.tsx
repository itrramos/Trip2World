import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { AdminSessionProvider } from '@/components/admin-session';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Trip2World Admin', template: '%s · Trip2World Admin' },
  description: 'Moderation and administration for Trip2World.',
  // Belt and braces alongside the X-Robots-Tag header: this panel must never be indexed.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  themeColor: '#0a0f1c',
  width: 'device-width',
  initialScale: 1,
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <AdminSessionProvider>{children}</AdminSessionProvider>
      </body>
    </html>
  );
}
