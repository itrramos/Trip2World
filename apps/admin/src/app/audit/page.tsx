'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAdminSession } from '@/components/admin-session';
import { Shell } from '@/components/shell';

interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; username: string } | null;
}

/**
 * Append-only record of sensitive actions.
 *
 * Read-only by design: there is no edit or delete control here, and the API exposes none.
 * An audit log a moderator can alter is not an audit log.
 */
export default function AuditPage() {
  const { status } = useAdminSession();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (action: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (action) params.set('action', action);
      const data = await api.get<{ items: AuditEntry[] }>(`/v1/admin/audit?${params}`);
      setEntries(data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    const timer = setTimeout(() => void load(filter), 300);
    return () => clearTimeout(timer);
  }, [status, filter, load]);

  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted">
          Every sensitive action, recorded permanently and never editable.
        </p>
      </div>

      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter by action, e.g. admin.user.ban"
        aria-label="Filter by action"
        className="mb-5 w-full max-w-md rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm"
      />

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {!loading && entries.length === 0 && <p className="text-sm text-muted">No entries.</p>}

      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Actor</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="px-4 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    {entry.actor?.username ?? <span className="text-muted">{entry.actorType}</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{entry.action}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {entry.targetId ? entry.targetId.slice(0, 8) : '—'}
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-xs text-muted">
                    {entry.metadata ? JSON.stringify(entry.metadata) : '—'}
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
