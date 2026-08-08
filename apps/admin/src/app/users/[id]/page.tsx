'use client';

import { UserRole } from '@trip2world/types';
import { Button, cn } from '@trip2world/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useAdminSession } from '@/components/admin-session';
import { Shell } from '@/components/shell';

interface UserDetail {
  id: string;
  username: string;
  email: string;
  role: string;
  status: string;
  plan: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  safetyScore: number;
  profile: {
    displayName: string | null;
    country: string | null;
    bio: string | null;
    languages: string[];
  } | null;
  moderationActionsReceived: {
    id: string;
    type: string;
    reason: string;
    notes: string | null;
    expiresAt: string | null;
    createdAt: string;
    moderator: { id: string; username: string } | null;
  }[];
  reportsAgainst: { id: string; category: string; status: string; createdAt: string }[];
}

type Action = 'WARN' | 'SUSPEND' | 'BAN' | 'UNBAN';

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const { status, can, user: me } = useAdminSession();

  const [user, setUser] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);

  const load = useCallback(async () => {
    try {
      setUser(await api.get<UserDetail>(`/v1/admin/users/${params.id}`));
      setError(null);
    } catch {
      setError('Could not load this user.');
    }
  }, [params.id]);

  useEffect(() => {
    if (status === 'authenticated') void load();
  }, [status, load]);

  const isStaff = user ? user.role !== 'USER' : false;
  const isSelf = user?.id === me?.id;

  return (
    <Shell>
      <Link
        href="/users"
        className="mb-6 inline-flex items-center gap-2 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to users
      </Link>

      {error && <p className="text-sm text-danger">{error}</p>}
      {!user && !error && <p className="text-sm text-muted">Loading…</p>}

      {user && (
        <>
          <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{user.username}</h1>
              <p className="mt-1 text-sm text-muted">
                {user.email} · joined {new Date(user.createdAt).toLocaleDateString()}
                {user.lastLoginAt &&
                  ` · last seen ${new Date(user.lastLoginAt).toLocaleDateString()}`}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge>{user.status}</Badge>
                <Badge>{user.role}</Badge>
                <Badge>{user.plan}</Badge>
                {!user.emailVerified && <Badge tone="warning">Email unverified</Badge>}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {/* Staff accounts cannot be restricted from here, and nobody can act on
                  themselves. The API enforces both; the UI simply does not offer it. */}
              {!isStaff && !isSelf && user.status !== 'BANNED' && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setAction('WARN')}>
                    Warn
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setAction('SUSPEND')}>
                    Suspend
                  </Button>
                  {can(UserRole.ADMIN) && (
                    <Button size="sm" variant="danger" onClick={() => setAction('BAN')}>
                      Ban
                    </Button>
                  )}
                </>
              )}
              {!isStaff && user.status === 'BANNED' && can(UserRole.ADMIN) && (
                <Button size="sm" onClick={() => setAction('UNBAN')}>
                  Reinstate
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="glass rounded-lg p-5">
              <h2 className="mb-4 font-medium">Profile</h2>
              <dl className="space-y-2 text-sm">
                <Row label="Display name" value={user.profile?.displayName ?? '—'} />
                <Row label="Country" value={user.profile?.country ?? '—'} />
                <Row label="Languages" value={user.profile?.languages?.join(', ') || '—'} />
                {/* Internal signal — deliberately never exposed on any user-facing API. */}
                <Row label="Safety score" value={String(user.safetyScore)} />
              </dl>
              {user.profile?.bio && (
                <p className="mt-4 whitespace-pre-wrap rounded-sm bg-surface-raised px-3 py-2 text-sm text-muted">
                  {user.profile.bio}
                </p>
              )}
            </section>

            <section className="glass rounded-lg p-5">
              <h2 className="mb-4 font-medium">
                Reports against this account ({user.reportsAgainst.length})
              </h2>
              {user.reportsAgainst.length === 0 ? (
                <p className="text-sm text-muted">None.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {user.reportsAgainst.map((report) => (
                    <li key={report.id} className="flex justify-between gap-3">
                      <span>{report.category}</span>
                      <span className="text-muted">
                        {report.status} · {new Date(report.createdAt).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="glass rounded-lg p-5 lg:col-span-2">
              <h2 className="mb-4 font-medium">Moderation history</h2>
              {user.moderationActionsReceived.length === 0 ? (
                <p className="text-sm text-muted">No actions recorded.</p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {user.moderationActionsReceived.map((entry) => (
                    <li key={entry.id} className="rounded-sm border border-border p-3">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium">{entry.type}</span>
                        <span className="text-xs text-muted">
                          {entry.moderator?.username ?? 'system'} ·{' '}
                          {new Date(entry.createdAt).toLocaleString()}
                          {entry.expiresAt &&
                            ` · until ${new Date(entry.expiresAt).toLocaleString()}`}
                        </span>
                      </div>
                      <p className="mt-1 text-muted">{entry.reason}</p>
                      {entry.notes && (
                        <p className="mt-1 text-xs italic text-muted">Internal: {entry.notes}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {action && (
            <ActionDialog
              action={action}
              username={user.username}
              userId={user.id}
              onClose={() => setAction(null)}
              onDone={() => {
                setAction(null);
                void load();
              }}
            />
          )}
        </>
      )}
    </Shell>
  );
}

function Badge({ children, tone }: { children: string; tone?: 'warning' }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-0.5',
        tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-surface-raised text-muted',
      )}
    >
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function ActionDialog({
  action,
  username,
  userId,
  onClose,
  onDone,
}: {
  action: Action;
  username: string;
  userId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ENDPOINT: Record<Action, string> = {
    WARN: '/v1/admin/users/warn',
    SUSPEND: '/v1/admin/users/suspend',
    BAN: '/v1/admin/users/ban',
    UNBAN: '/v1/admin/users/unban',
  };

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(ENDPOINT[action], {
        userId,
        reason: reason.trim(),
        ...(action === 'SUSPEND' ? { hours } : {}),
        ...(action !== 'UNBAN' && notes.trim() ? { notes: notes.trim() } : {}),
        ...(action === 'BAN' ? { permanent: true } : {}),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'That action failed.');
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div className="glass w-full max-w-md rounded-lg p-6">
        <h2 id="action-title" className="text-lg font-semibold">
          {action === 'UNBAN' ? 'Reinstate' : action.toLowerCase()} {username}
        </h2>

        {error && (
          <p className="mt-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {action === 'SUSPEND' && (
          <label className="mt-5 block text-sm">
            <span className="font-medium">Duration</span>
            <select
              value={hours}
              onChange={(event) => setHours(Number(event.target.value))}
              className="mt-1.5 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm"
            >
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </select>
          </label>
        )}

        <label className="mt-4 block text-sm">
          <span className="font-medium">Reason</span>
          <span className="mt-0.5 block text-xs text-muted">Shown to the user.</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={500}
            className="mt-1.5 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm"
          />
        </label>

        {action !== 'UNBAN' && (
          <label className="mt-4 block text-sm">
            <span className="font-medium">Moderator notes</span>
            <span className="mt-0.5 block text-xs text-muted">Internal only.</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-1.5 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm"
            />
          </label>
        )}

        <div className="mt-6 flex gap-3">
          <Button variant="secondary" fullWidth onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={action === 'BAN' ? 'danger' : 'primary'}
            fullWidth
            loading={busy}
            disabled={reason.trim().length === 0}
            onClick={() => void submit()}
          >
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
