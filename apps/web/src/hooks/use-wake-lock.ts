'use client';

import { useEffect, useRef } from 'react';

/**
 * Keep the screen awake while a conversation is live.
 *
 * A phone left alone for thirty seconds dims and locks. The tab is then backgrounded,
 * the camera stops producing frames, and the person on the other end is left looking at
 * a frozen still of your face — with the connection still technically "connected", so
 * nothing errors and nothing recovers. That exact failure showed up in testing and read
 * as a bug in the call rather than as the screen going to sleep.
 *
 * Video calls are the canonical case the Screen Wake Lock API exists for: the user is
 * present and looking at the screen without touching it.
 *
 * Two things this has to get right, and both are easy to miss:
 *
 * 1. **The browser releases the lock whenever the page is hidden**, and does not restore
 *    it when the page comes back. Without the `visibilitychange` listener, switching
 *    apps once permanently loses the lock for the rest of the call.
 *
 * 2. **`request()` rejects rather than throwing synchronously**, including on Firefox
 *    and on iOS below 16.4 where the API does not exist at all. Every failure here is
 *    non-fatal — the call works, the screen just sleeps — so nothing is surfaced to the
 *    user, who cannot act on it anyway.
 */
export function useWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let cancelled = false;

    const acquire = async () => {
      // `visible` is a hard requirement: requesting while hidden always rejects.
      if (cancelled || document.visibilityState !== 'visible') return;
      if (sentinelRef.current) return;

      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
        // Fires both when we release it and when the browser does.
        sentinel.addEventListener('release', () => {
          sentinelRef.current = null;
        });
      } catch {
        // Unsupported, denied, or the tab lost focus mid-request. Not worth reporting.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinelRef.current?.release().catch(() => undefined);
      sentinelRef.current = null;
    };
  }, [active]);
}
