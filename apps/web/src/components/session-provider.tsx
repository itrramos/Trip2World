'use client';

import type { SelfProfile } from '@trip2world/types';
import { useRouter } from 'next/navigation';
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

/**
 * Session state for the whole app.
 *
 * On boot the access token is gone (it lived only in memory), so we attempt a refresh
 * from the HttpOnly cookie. `status` distinguishes "still checking" from "definitely
 * signed out" — conflating them causes a visible flash of the signed-out UI on every
 * reload for users who are, in fact, signed in.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface SessionContextValue {
  status: SessionStatus;
  user: SelfProfile | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [user, setUser] = useState<SelfProfile | null>(null);
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
      }>('/v1/auth/login', { email, password }, { authenticated: false });

      setAccessToken(result.tokens.accessToken, result.tokens.expiresIn);
      setUser(result.user);
      setStatus('authenticated');
    },
    [],
  );

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
      setStatus('unauthenticated');
      router.push('/');
    }
  }, [router]);

  const value = useMemo<SessionContextValue>(
    () => ({ status, user, signIn, signOut, reload: async () => void (await loadUser()) }),
    [status, user, signIn, signOut, loadUser],
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

  useEffect(() => {
    if (session.status === 'unauthenticated') {
      const next = encodeURIComponent(window.location.pathname);
      router.replace(`/login?next=${next}`);
    }
  }, [session.status, router]);

  return session;
}
