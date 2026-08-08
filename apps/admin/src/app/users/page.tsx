'use client';

import { cn } from '@trip2world/ui';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAdminSession } from '@/components/admin-session';
import { Shell } from '@/components/shell';

interface AdminUser {
  id: string;
  username: string;
  email: string;
  role: string;
  status: string;
  plan: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  profile: { displayName: string | null; country: string | null } | null;
  _count: { reportsAgainst: number };
}

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-success/15 text-success',
  PENDING_VERIFICATION: 'bg-warning/15 text-warning',
  SUSPENDED: 'bg-warning/20 text-warning',
  BANNED: 'bg-danger/20 text-danger',
  DEACTIVATED: 'bg-surface-raised text-muted',
};

export default function UsersPage() {
  const { status } = useAdminSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (search: string, statusFilter: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '50' });
      if (search) params.set('q', search);
      if (statusFilter) params.set('status', statusFilter);
      const data = await api.get<{ items: AdminUser[] }>(`/v1/admin/users?${params}`);
      setUsers(data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search: a request per keystroke would hammer the API for no benefit.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const timer = setTimeout(() => void load(query, filter), 300);
    return () => clearTimeout(timer);
  }, [status, query, filter, load]);

  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      </div>

      <div className="mb-5 flex flex-wrap gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search username or email"
            aria-label="Search users"
            className="w-full rounded-sm border border-border bg-surface py-2.5 pl-9 pr-3.5 text-sm"
          />
        </div>
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter by status"
          className="rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="PENDING_VERIFICATION">Pending verification</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="BANNED">Banned</option>
        </select>
      </div>

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {!loading && users.length === 0 && <p className="text-sm text-muted">No users found.</p>}

      {users.length > 0 && (
        // Wide table on a narrow screen must scroll in its own container, never make the
        // page scroll sideways.
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Country</th>
                <th className="px-4 py-3 font-medium">Reports</th>
                <th className="px-4 py-3 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((user) => (
                <tr key={user.id} className="transition-colors hover:bg-surface/40">
                  <td className="px-4 py-3">
                    <Link href={`/users/${user.id}`} className="font-medium text-brand">
                      {user.username}
                    </Link>
                    <div className="text-xs text-muted">{user.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'rounded-full px-2.5 py-0.5 text-xs',
                        STATUS_STYLE[user.status] ?? 'bg-surface-raised text-muted',
                      )}
                    >
                      {user.status}
                    </span>
                    {user.role !== 'USER' && (
                      <span className="ml-2 rounded-full bg-brand/15 px-2 py-0.5 text-xs text-brand">
                        {user.role}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">{user.profile?.country ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={user._count.reportsAgainst > 0 ? 'text-warning' : 'text-muted'}>
                      {user._count.reportsAgainst}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
