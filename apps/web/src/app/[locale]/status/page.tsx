'use client';

import { REALTIME_NAMESPACE } from '@trip2world/types';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { io } from 'socket.io-client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Browser-side diagnostics.
 *
 * `infrastructure/scripts/diagnose.sh` checks the server from the server. It has been
 * fully green for several rounds while every browser failed, because the two are not the
 * same test: curl does not send an Origin, does not run the compiled bundle, does not
 * hold a session, and does not speak the WebSocket protocol the way a browser does.
 *
 * This page runs the same questions from inside the actual client, using the actual
 * compiled configuration, and prints the answers on screen. It exists so that
 * diagnosing a connection problem does not require opening devtools and reading a
 * console — which is a reasonable thing not to want to do, and which has cost us several
 * exchanges of guessing.
 *
 * Deliberately unauthenticated: the most useful case is the one where signing in is
 * itself the thing that is broken. Nothing here is secret — every value shown is already
 * compiled into the JavaScript that any visitor downloads.
 */

type Status = 'pending' | 'pass' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '(unset)';
const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? '(unset)';
const REALTIME_PATH = process.env.NEXT_PUBLIC_REALTIME_PATH ?? '/rt';

export default function StatusPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);

  const update = useCallback((name: string, status: Status, detail: string) => {
    setChecks((previous) => {
      const next = previous.filter((check) => check.name !== name);
      return [...next, { name, status, detail }];
    });
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setChecks([]);

    /* --- What this bundle was compiled with ------------------------- */

    update('Page origin', 'pass', window.location.origin);
    update('API URL', API_URL.startsWith('http') ? 'pass' : 'fail', API_URL);
    update('Realtime URL', REALTIME_URL.startsWith('http') ? 'pass' : 'fail', REALTIME_URL);
    update('Realtime path', 'pass', REALTIME_PATH);

    /**
     * A mismatch here is invisible and fatal: session cookies are host-scoped, so a page
     * served from www talking to an API on the apex sends no cookie and can never
     * restore a session — while every server-side check passes.
     */
    const apiOrigin = API_URL.startsWith('http') ? new URL(API_URL).origin : '';
    update(
      'API is same-origin as page',
      apiOrigin === window.location.origin ? 'pass' : 'fail',
      apiOrigin === window.location.origin
        ? 'yes — cookies will be sent'
        : `NO — page is ${window.location.origin}, API is ${apiOrigin}. Session cookies will not be sent.`,
    );

    /* --- Can we reach the API at all? ------------------------------- */

    try {
      const response = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      // 401 is the correct answer with no refresh cookie. Any answer proves reachability.
      update(
        'API responds',
        'pass',
        `HTTP ${response.status}${response.status === 401 ? ' (expected when signed out)' : ''}`,
      );
    } catch (error) {
      update(
        'API responds',
        'fail',
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    /* --- The realtime socket, the way the app opens it -------------- */

    await new Promise<void>((resolve) => {
      update('Realtime socket', 'pending', 'connecting…');

      const socket = io(`${REALTIME_URL}${REALTIME_NAMESPACE}`, {
        path: REALTIME_PATH,
        // No token: an UNAUTHENTICATED rejection is a SUCCESS for this check. It proves
        // the handshake reached the server and the server answered. What we are testing
        // is reachability, not credentials.
        auth: {},
        transports: ['polling', 'websocket'],
        tryAllTransports: true,
        reconnection: false,
        withCredentials: true,
        timeout: 10_000,
      });

      const finish = (status: Status, detail: string) => {
        socket.close();
        update('Realtime socket', status, detail);
        resolve();
      };

      socket.on('connect', () => finish('pass', 'connected'));

      socket.on('connect_error', (error) => {
        const message = error.message || String(error);
        // The server rejecting an empty token is the healthy outcome here.
        if (/UNAUTHENTICATED|Missing access token|Invalid access token/i.test(message)) {
          finish('pass', `reached the server (rejected as expected: ${message})`);
        } else {
          finish('fail', message);
        }
      });

      setTimeout(() => finish('fail', 'timed out after 12s with no response'), 12_000);
    });

    setRunning(false);
  }, [update]);

  useEffect(() => {
    void run();
  }, [run]);

  const order = [
    'Page origin',
    'API URL',
    'Realtime URL',
    'Realtime path',
    'API is same-origin as page',
    'API responds',
    'Realtime socket',
  ];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const failures = sorted.filter((check) => check.status === 'fail');

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Connection status</h1>
      <p className="mt-2 text-sm text-muted">
        Runs from inside your browser, using the settings compiled into this page. Screenshot
        this if something is wrong.
      </p>

      <ul className="mt-8 divide-y divide-border rounded-lg border border-border">
        {sorted.map((check) => (
          <li key={check.name} className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 shrink-0">
              {check.status === 'pending' ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted" aria-hidden />
              ) : check.status === 'pass' ? (
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
              ) : (
                <XCircle className="h-4 w-4 text-danger" aria-hidden />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{check.name}</span>
              <span className="block break-words text-xs text-muted">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {!running && (
        <p
          className={
            failures.length === 0
              ? 'mt-6 rounded-sm border border-success/30 bg-success/10 px-4 py-3 text-sm text-success'
              : 'mt-6 rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger'
          }
        >
          {failures.length === 0
            ? 'Everything the browser can check is working.'
            : `${failures.length} problem${failures.length === 1 ? '' : 's'} above.`}
        </p>
      )}

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="mt-6 rounded-sm border border-border px-4 py-2 text-sm hover:bg-surface-raised disabled:opacity-50"
      >
        {running ? 'Running…' : 'Run again'}
      </button>

      <p className="mt-8 text-xs text-muted">
        User agent: <span className="break-all">{typeof navigator !== 'undefined' ? navigator.userAgent : ''}</span>
      </p>
    </main>
  );
}
