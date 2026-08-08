/**
 * Deadlines for calls to external systems.
 *
 * Without these, an unreachable Postgres or Redis does not produce errors — it produces
 * *hangs*. Requests pile up holding connections, the pool is exhausted, and a dependency
 * that is merely slow takes the whole API down with it. A health check that hangs is
 * worse still: the orchestrator never sees a failure, so it never restarts or drains the
 * instance.
 *
 * Failing fast turns all of that into a bounded, visible error.
 */

export class TimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * The underlying work is not cancelled — most database drivers cannot be interrupted —
 * but the caller stops waiting, which is the property that matters. The timer is cleared
 * on settle so a fast call does not keep the event loop alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(operation, ms)), ms);
    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run `promise` with a deadline, returning `fallback` on timeout *or* failure.
 *
 * For values where a stale or default answer is strictly better than an error — cached
 * settings, feature flags, a health probe result.
 */
export async function withTimeoutOr<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  onError?: (error: unknown) => void,
): Promise<T> {
  try {
    return await withTimeout(promise, ms, 'operation');
  } catch (error) {
    onError?.(error);
    return fallback;
  }
}

/** Deadlines, in milliseconds. Deliberately short — these are all local-network calls. */
export const TIMEOUTS = {
  /** Redis is in-memory on the same Docker network; anything slower is a fault. */
  redis: 1_000,
  /** A settings read is a single indexed query. */
  settingsQuery: 2_000,
  /** Health probes must answer well inside the container healthcheck's own timeout. */
  healthCheck: 3_000,
} as const;
