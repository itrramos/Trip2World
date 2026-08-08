'use client';

import { Activity, Ban, Flag, Radio, Users, Video } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAdminSession } from '@/components/admin-session';
import { Shell } from '@/components/shell';

interface Stats {
  registeredUsers: number;
  onlineUsers: number;
  queuedUsers: number;
  activeMatches: number;
  matchesToday: number;
  reportsPending: number;
  bannedUsers: number;
  suspendedUsers: number;
}

export default function DashboardPage() {
  const { status } = useAdminSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;

    const load = () =>
      api
        .get<Stats>('/v1/admin/stats')
        .then((data) => {
          setStats(data);
          setError(null);
        })
        .catch(() => setError('Could not load statistics.'));

    void load();
    // Presence and queue figures are live values; a static dashboard would be misleading
    // about whether anyone is actually using the product right now.
    const interval = setInterval(() => void load(), 15_000);
    return () => clearInterval(interval);
  }, [status]);

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">Live figures, refreshed every 15 seconds.</p>
      </div>

      {error && (
        <div className="mb-6 rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Reports first: it is the only number on this page that requires someone to act. */}
      {stats && stats.reportsPending > 0 && (
        <Link
          href="/reports"
          className="mb-6 flex items-center gap-4 rounded-lg border border-warning/40 bg-warning/10 p-5 transition-colors hover:bg-warning/15"
        >
          <Flag className="h-6 w-6 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="font-medium">
              {stats.reportsPending} report{stats.reportsPending === 1 ? '' : 's'} awaiting review
            </p>
            <p className="text-sm text-muted">Open the moderation queue</p>
          </div>
        </Link>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Registered users" value={stats?.registeredUsers} icon={Users} />
        <Stat label="Online now" value={stats?.onlineUsers} icon={Radio} accent />
        <Stat label="Searching" value={stats?.queuedUsers} icon={Activity} accent />
        <Stat label="In conversation" value={stats?.activeMatches} icon={Video} accent />
        <Stat label="Matches today" value={stats?.matchesToday} icon={Video} />
        <Stat label="Reports pending" value={stats?.reportsPending} icon={Flag} />
        <Stat label="Suspended" value={stats?.suspendedUsers} icon={Ban} />
        <Stat label="Banned" value={stats?.bannedUsers} icon={Ban} />
      </div>
    </Shell>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | undefined;
  icon: typeof Users;
  accent?: boolean;
}) {
  return (
    <div className="glass rounded-lg p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{label}</span>
        <Icon className={accent ? 'h-4 w-4 text-brand' : 'h-4 w-4 text-muted'} aria-hidden />
      </div>
      {/* Em dash while loading rather than 0 — showing a real-looking zero before the
          data arrives is worse than showing nothing. */}
      <p className="mt-3 text-3xl font-semibold tabular-nums">
        {value === undefined ? <span className="text-muted">—</span> : value.toLocaleString()}
      </p>
    </div>
  );
}
