'use client';

import { PRIORITY_REPORT_CATEGORIES, type ReportCategory } from '@trip2world/types';
import { Button, cn } from '@trip2world/ui';
import { AlertTriangle, Clock, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useAdminSession } from '@/components/admin-session';
import { Shell } from '@/components/shell';

interface QueuedReport {
  id: string;
  category: ReportCategory;
  details: string | null;
  status: string;
  matchId: string | null;
  createdAt: string;
  reporter: { id: string; username: string } | null;
  reportedUser: {
    id: string;
    username: string;
    status: string;
    createdAt: string;
    profile: { country: string | null; displayName: string | null } | null;
  };
  priorTotalReports: number;
  priorUpheldReports: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  NUDITY: 'Nudity / sexual content',
  HARASSMENT: 'Harassment',
  HATE: 'Hate or abusive behaviour',
  UNDERAGE: 'Underage concern',
  VIOLENCE: 'Violence or threats',
  SPAM: 'Spam',
  SCAM: 'Scam',
  IMPERSONATION: 'Impersonation',
  OTHER: 'Other',
};

type Action = 'DISMISS' | 'WARN' | 'SUSPEND' | 'BAN';

export default function ReportsPage() {
  const { status } = useAdminSession();
  const [reports, setReports] = useState<QueuedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<QueuedReport | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ items: QueuedReport[] }>('/v1/admin/reports?pageSize=50');
      setReports(data.items);
      setError(null);
    } catch {
      setError('Could not load the moderation queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated') void load();
  }, [status, load]);

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation queue</h1>
        <p className="mt-1 text-sm text-muted">
          Child-safety and threat reports are shown first regardless of age.
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-muted">Loading…</p>}

      {!loading && reports.length === 0 && (
        <div className="glass rounded-lg p-10 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-success" aria-hidden />
          <p className="font-medium">Nothing to review</p>
          <p className="mt-1 text-sm text-muted">The queue is empty.</p>
        </div>
      )}

      <ul className="space-y-3">
        {reports.map((report) => {
          const priority = PRIORITY_REPORT_CATEGORIES.includes(report.category);
          return (
            <li
              key={report.id}
              className={cn(
                'glass rounded-lg p-5',
                priority && 'border-danger/40 bg-danger/[0.06]',
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {priority && (
                      <span className="flex items-center gap-1 rounded-full bg-danger/20 px-2.5 py-0.5 text-xs font-medium text-danger">
                        <AlertTriangle className="h-3 w-3" aria-hidden />
                        Priority
                      </span>
                    )}
                    <span className="font-medium">{CATEGORY_LABEL[report.category]}</span>
                    <span className="text-xs text-muted">
                      <Clock className="mr-1 inline h-3 w-3" aria-hidden />
                      {new Date(report.createdAt).toLocaleString()}
                    </span>
                  </div>

                  <p className="mt-2 text-sm">
                    <Link
                      href={`/users/${report.reportedUser.id}`}
                      className="text-brand underline underline-offset-4"
                    >
                      {report.reportedUser.username}
                    </Link>
                    {report.reportedUser.profile?.country && (
                      <span className="text-muted"> · {report.reportedUser.profile.country}</span>
                    )}
                    <span className="text-muted">
                      {' '}
                      · reported by {report.reporter?.username ?? 'a deleted account'}
                    </span>
                  </p>

                  {report.details && (
                    // User-authored text. React escapes it; it is never rendered as HTML.
                    <p className="mt-2 whitespace-pre-wrap rounded-sm bg-surface-raised px-3 py-2 text-sm text-muted">
                      {report.details}
                    </p>
                  )}

                  {/* Prior-report counts are usually the whole decision: one complaint is
                      noise, a pattern is not. */}
                  <p className="mt-2 text-xs text-muted">
                    {report.priorTotalReports} prior report
                    {report.priorTotalReports === 1 ? '' : 's'} ·{' '}
                    <span className={report.priorUpheldReports > 0 ? 'text-warning' : undefined}>
                      {report.priorUpheldReports} upheld
                    </span>
                    {' · account status '}
                    {report.reportedUser.status}
                  </p>
                </div>

                <Button size="sm" onClick={() => setActive(report)}>
                  Review
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {active && (
        <ResolveDialog
          report={active}
          onClose={() => setActive(null)}
          onResolved={() => {
            setActive(null);
            void load();
          }}
        />
      )}
    </Shell>
  );
}

function ResolveDialog({
  report,
  onClose,
  onResolved,
}: {
  report: QueuedReport;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [action, setAction] = useState<Action>('DISMISS');
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

  const restricting = action !== 'DISMISS';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/admin/reports/resolve', {
        reportId: report.id,
        action,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
        ...(action === 'SUSPEND' ? { suspensionHours: hours } : {}),
      });
      onResolved();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not resolve this report.',
      );
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="resolve-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div className="glass max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-lg p-6">
        <h2 id="resolve-title" className="text-lg font-semibold">
          Resolve report against {report.reportedUser.username}
        </h2>
        <p className="mt-1 text-sm text-muted">{CATEGORY_LABEL[report.category]}</p>

        {error && (
          <p className="mt-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Action</legend>
          {(['DISMISS', 'WARN', 'SUSPEND', 'BAN'] as const).map((value) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-sm border px-4 py-2.5 text-sm transition-colors',
                action === value ? 'border-brand bg-brand/10' : 'border-border hover:bg-surface-raised',
              )}
            >
              <input
                type="radio"
                name="action"
                checked={action === value}
                onChange={() => setAction(value)}
                className="accent-brand"
              />
              {value === 'DISMISS' && 'Dismiss — no violation'}
              {value === 'WARN' && 'Warn the user'}
              {value === 'SUSPEND' && 'Suspend temporarily'}
              {value === 'BAN' && 'Ban permanently'}
            </label>
          ))}
        </fieldset>

        {action === 'SUSPEND' && (
          <label className="mt-4 block text-sm">
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
          <span className="font-medium">
            Reason {restricting && <span className="text-danger">*</span>}
          </span>
          {/* Two separate fields, deliberately: the user sees this one. */}
          <span className="mt-0.5 block text-xs text-muted">Shown to the user.</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={500}
            className="mt-1.5 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm"
          />
        </label>

        <label className="mt-4 block text-sm">
          <span className="font-medium">Moderator notes</span>
          <span className="mt-0.5 block text-xs text-muted">
            Internal. Never shown to the user.
          </span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            maxLength={2000}
            className="mt-1.5 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm"
          />
        </label>

        <div className="mt-6 flex gap-3">
          <Button variant="secondary" fullWidth onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={action === 'BAN' ? 'danger' : 'primary'}
            fullWidth
            loading={busy}
            // The API refuses a restriction without a reason; disabling here makes that
            // obvious rather than letting the moderator discover it via an error.
            disabled={restricting && reason.trim().length === 0}
            onClick={() => void submit()}
          >
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
