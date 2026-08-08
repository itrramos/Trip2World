'use client';

import { UserRole } from '@trip2world/types';
import { cn } from '@trip2world/ui';
import { Flag, Gauge, LogOut, ScrollText, ShieldAlert, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAdminSession } from '@/components/admin-session';

const NAV = [
  { href: '/', label: 'Dashboard', icon: Gauge, role: UserRole.MODERATOR },
  { href: '/reports', label: 'Reports', icon: Flag, role: UserRole.MODERATOR },
  { href: '/users', label: 'Users', icon: Users, role: UserRole.MODERATOR },
  { href: '/audit', label: 'Audit log', icon: ScrollText, role: UserRole.ADMIN },
] as const;

/**
 * Application chrome and the gate in front of it.
 *
 * Everything below MODERATOR is refused here rather than at each page, because there is
 * no page in this app a regular user should reach. The server enforces the same rule on
 * every endpoint — this is about not showing a UI that would only 403.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { status, user, signOut, can } = useAdminSession();
  const pathname = usePathname();

  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <span className="text-sm text-muted">Loading…</span>
      </div>
    );
  }

  if (status === 'forbidden') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6">
        <div className="glass max-w-md rounded-lg p-8 text-center">
          <ShieldAlert className="mx-auto mb-4 h-8 w-8 text-danger" aria-hidden />
          <h1 className="text-xl font-semibold">This account has no moderator access</h1>
          <p className="mt-2 text-sm text-muted">
            Your sign-in was valid, but this panel is restricted to moderators and
            administrators. If that is unexpected, ask a super administrator to review your role.
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-6 rounded-sm bg-surface-raised px-5 py-2.5 text-sm font-medium hover:bg-border"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Unauthenticated is handled by a redirect in the provider; render nothing meanwhile
  // so the layout does not flash before navigation.
  if (status !== 'authenticated') return <div className="min-h-dvh" />;

  const visibleNav = NAV.filter((item) => can(item.role));

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface/40 p-5 md:block">
        <div className="mb-8 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-brand" aria-hidden />
          <span className="font-semibold tracking-tight">Trip2World</span>
        </div>

        <nav className="space-y-1">
          {visibleNav.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-sm px-3 py-2 text-sm transition-colors',
                  active ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-raised hover:text-foreground',
                )}
              >
                <item.icon className="h-4 w-4" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          {/* Mobile nav: the sidebar is hidden below md. */}
          <nav className="flex gap-1 md:hidden">
            {visibleNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                className="rounded-sm p-2 text-muted hover:bg-surface-raised hover:text-foreground"
              >
                <item.icon className="h-5 w-5" aria-hidden />
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="text-muted">
              {user?.displayName ?? user?.username}
              <span className="ml-2 rounded-full bg-surface-raised px-2 py-0.5 text-xs">
                {user?.role}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sign out"
              className="rounded-sm p-2 text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <LogOut className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
