'use client';

import { countryName } from '@trip2world/shared';
import type { PublicProfile } from '@trip2world/types';
import { Button, FormError } from '@trip2world/ui';
import { ArrowLeft, Loader2, UserPlus, Users } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/components/session-provider';
import { Link } from '@/i18n/navigation';

interface ConnectionRequest {
  id: string;
  message: string | null;
  createdAt: string;
  expiresAt: string | null;
  user: PublicProfile;
}

interface Connection {
  id: string;
  connectedAt: string;
  user: PublicProfile;
}

/**
 * Connections, and the requests waiting on an answer.
 *
 * Requests come first and are visually louder than the list below, because they are the
 * only thing on this page that needs a decision. A list of people you already agreed to
 * keep is reference material.
 */
export default function ConnectionsPage() {
  const t = useTranslations('connections');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const { status } = useRequireAuth();

  const [requests, setRequests] = useState<ConnectionRequest[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pending, list] = await Promise.all([
        api.get<ConnectionRequest[]>('/v1/connections/requests'),
        api.get<{ items: Connection[] }>('/v1/connections'),
      ]);
      setRequests(pending);
      setConnections(list.items);
    } catch {
      setError(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (status === 'authenticated') void load();
  }, [status, load]);

  async function respond(requestId: string, accept: boolean) {
    setBusyId(requestId);
    try {
      await api.post('/v1/connections/requests/respond', { requestId, accept });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(connection: Connection) {
    const name = connection.user.displayName ?? connection.user.username;
    if (!window.confirm(`${t('removeConfirmTitle', { name })}\n\n${t('removeConfirmBody')}`)) {
      return;
    }

    setBusyId(connection.id);
    try {
      await api.delete(`/v1/connections/${connection.id}`);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand" aria-hidden />
        <span className="sr-only">{tCommon('loading')}</span>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/discover"
        className="inline-flex items-center gap-2 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {tCommon('back')}
      </Link>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>

      {error && <div className="mt-6"><FormError message={error} /></div>}

      {requests.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <UserPlus className="h-4 w-4 text-brand" aria-hidden />
            {t('requestsTitle')}
          </h2>

          <ul className="space-y-3">
            {requests.map((request) => (
              <li key={request.id} className="rounded-lg border border-brand/30 bg-brand/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {request.user.displayName ?? request.user.username}
                      {request.user.country && (
                        <span className="ml-2 text-sm font-normal text-muted">
                          {countryName(request.user.country)}
                        </span>
                      )}
                    </p>
                    {request.message && (
                      <p className="mt-1 rounded-sm bg-surface-raised px-3 py-2 text-sm text-muted">
                        {request.message}
                      </p>
                    )}
                    {request.expiresAt && (
                      <p className="mt-1.5 text-xs text-muted">
                        {t('expires', {
                          date: format.dateTime(new Date(request.expiresAt), {
                            dateStyle: 'medium',
                          }),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === request.id}
                      onClick={() => void respond(request.id, false)}
                    >
                      {t('decline')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busyId === request.id}
                      onClick={() => void respond(request.id, true)}
                    >
                      {t('accept')}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        {connections.length === 0 ? (
          <div className="rounded-lg border border-border p-10 text-center">
            <Users className="mx-auto mb-3 h-7 w-7 text-muted" aria-hidden />
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t('emptyBody')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {connection.user.displayName ?? connection.user.username}
                  </span>
                  <span className="text-xs text-muted">
                    {connection.user.country && `${countryName(connection.user.country)} · `}
                    {t('connectedOn', {
                      date: format.dateTime(new Date(connection.connectedAt), {
                        dateStyle: 'medium',
                      }),
                    })}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === connection.id}
                  onClick={() => void remove(connection)}
                >
                  {t('remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
