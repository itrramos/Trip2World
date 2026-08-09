'use client';

import type { SelfProfile } from '@trip2world/types';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiRequestError, refresh, setAccessToken } from '@/lib/api';
import { usePathname, useRouter } from '@/i18n/navigation';

/**
 * Session state for the whole app.
 *
 * On boot the access token is gone (it lived only in memory), so we attempt a refresh
 * from the HttpOnly cookie. `status` distinguishes "still checking" from "definitely
 * signed out" — conflating them causes a visible flash of the signed-out UI on every
 * reload for users who are, in fact, signed in.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** A promotional grant that landed during this sign-in. */
export interface TokenGrantNotice {
  campaignId: string;
  campaignName: string;
  tokens: number;
}

interface SessionContextValue {
  status: SessionStatus;
  user: SelfProfile | null;
  /**
   * Promotions that paid out on the most recent sign-in.
   *
   * Held here rather than returned from `signIn`, because the sign-in happens on
   * /login and the user is redirected away before anything could render. The next
   * screen picks it up and acknowledges it. Silently increasing someone's balance is a
   * missed moment and, worse, looks like a bug when they notice it later.
   */
  grants: TokenGrantNotice[];
  dismissGrants: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [user, setUser] = useState<SelfProfile | null>(null);
  const [grants, setGrants] = useState<TokenGrantNotice[]>([]);
  const router = useRouter();

  // Guards against a state update after unmount during the boot sequence.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadUser = useCallback(async (): Promise<SelfProfile | null> => {
    try {
      const profile = await api.get<SelfProfile>('/v1/auth/me');
      if (mounted.current) {
        setUser(profile);
        setStatus('authenticated');
      }
      return profile;
    } catch {
      if (mounted.current) {
        setUser(null);
        setStatus('unauthenticated');
      }
      return null;
    }
  }, []);

  // Boot: try to restore a session from the refresh cookie.
  useEffect(() => {
    void (async () => {
      const restored = await refresh();
      if (!restored) {
        if (mounted.current) setStatus('unauthenticated');
        return;
      }
      await loadUser();
    })();
  }, [loadUser]);

  /**
   * Proactively refresh before the access token expires.
   *
   * Without this, the first request after ~15 minutes idle pays a refresh round trip.
   * That is invisible on a page load but very visible when it delays joining the
   * matchmaking queue.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;
    const interval = setInterval(() => void refresh(), 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [status]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<{
        user: SelfProfile;
        tokens: { accessToken: string; expiresIn: number };
        grants?: TokenGrantNotice[];
      }>('/v1/auth/login', { email, password }, { authenticated: false });

      setAccessToken(result.tokens.accessToken, result.tokens.expiresIn);
      setUser(result.user);
      setGrants(result.grants ?? []);
      setStatus('authenticated');
    },
    [],
  );

  const dismissGrants = useCallback(() => setGrants([]), []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/v1/auth/logout');
    } catch (error) {
      // A failed logout call must still clear local state — otherwise the UI claims the
      // user is signed in when their session is gone (or vice versa).
      if (!(error instanceof ApiRequestError)) throw error;
    } finally {
      setAccessToken(null);
      setUser(null);
      setGrants([]);
      setStatus('unauthenticated');
      router.push('/');
    }
  }, [router]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      user,
      grants,
      dismissGrants,
      signIn,
      signOut,
      reload: async () => void (await loadUser()),
    }),
    [status, user, grants, dismissGrants, signIn, signOut, loadUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

/**
 * Redirect to sign-in when unauthenticated.
 *
 * Waits for `status` to leave 'loading' first — redirecting during the boot refresh
 * would bounce every signed-in user to the login page on each reload.
 */
export function useRequireAuth(): SessionContextValue {
  const session = useSession();
  const router = useRouter();
  /**
   * The locale-aware `usePathname` returns the path *without* its locale prefix.
   *
   * That is what has to go into `?next=`. `window.location.pathname` would carry the
   * prefix — `/pt/settings` — and the locale-aware router would prefix it again on the
   * way back, landing a Portuguese user on `/pt/pt/settings`, which is a 404.
   */
  const pathname = usePathname();

  useEffect(() => {
    if (session.status === 'unauthenticated') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [session.status, router, pathname]);

  return session;
}
