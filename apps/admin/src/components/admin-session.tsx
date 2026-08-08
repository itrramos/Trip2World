'use client';

import { ROLE_HIERARCHY, type SelfProfile, UserRole } from '@trip2world/types';
import { usePathname, useRouter } from 'next/navigation';
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
import { api, ApiRequestError } from '@/lib/api';

/**
 * Admin session and role gate.
 *
 * Two things this does that the public app's provider does not:
 *
 *   1. It requires MODERATOR or above. A regular user with valid credentials is signed
 *      out and told plainly, rather than being shown an empty dashboard that 403s on
 *      every request.
 *   2. It gates the whole app rather than individual pages, because there is no such
 *      thing as a public page here.
 *
 * The role check is a convenience, not the security boundary — every admin endpoint
 * enforces its own guard server-side. This exists so the UI is honest, not so it is safe.
 */

export type AdminStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'forbidden';

interface AdminSessionValue {
  status: AdminStatus;
  user: SelfProfile | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** True when the signed-in user outranks or matches `role`. */
  can: (role: UserRole) => boolean;
}

const AdminSessionContext = createContext<AdminSessionValue | null>(null);

function hasRole(user: SelfProfile | null, required: UserRole): boolean {
  if (!user) return false;
  const actual = ROLE_HIERARCHY.indexOf(user.role as UserRole);
  const needed = ROLE_HIERARCHY.indexOf(required);
  return actual >= 0 && actual >= needed;
}

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AdminStatus>('loading');
  const [user, setUser] = useState<SelfProfile | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadUser = useCallback(async () => {
    try {
      const profile = await api.get<SelfProfile>('/v1/auth/me');
      if (!mounted.current) return;

      if (!hasRole(profile, UserRole.MODERATOR)) {
        setUser(null);
        setStatus('forbidden');
        return;
      }
      setUser(profile);
      setStatus('authenticated');
    } catch {
      if (!mounted.current) return;
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  // Restore from the refresh cookie on boot.
  useEffect(() => {
    void (async () => {
      const restored = await api.refresh();
      if (!restored) {
        if (mounted.current) setStatus('unauthenticated');
        return;
      }
      await loadUser();
    })();
  }, [loadUser]);

  // Keep the access token fresh so a moderator mid-investigation never stalls.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const interval = setInterval(() => void api.refresh(), 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [status]);

  // Bounce to sign-in when the session is gone, unless already there.
  useEffect(() => {
    if (status === 'unauthenticated' && pathname !== '/login') router.replace('/login');
  }, [status, pathname, router]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.post<{
      user: SelfProfile;
      tokens: { accessToken: string; expiresIn: number };
    }>('/v1/auth/login', { email, password }, { authenticated: false });

    api.setAccessToken(result.tokens.accessToken, result.tokens.expiresIn);

    if (!hasRole(result.user, UserRole.MODERATOR)) {
      // Credentials were valid but this account has no business here. Drop the token
      // rather than leaving a usable session lying around in memory.
      api.setAccessToken(null);
      await api.post('/v1/auth/logout').catch(() => undefined);
      setStatus('forbidden');
      return;
    }

    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/v1/auth/logout');
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error;
    } finally {
      api.setAccessToken(null);
      setUser(null);
      setStatus('unauthenticated');
      router.push('/login');
    }
  }, [router]);

  const value = useMemo<AdminSessionValue>(
    () => ({ status, user, signIn, signOut, can: (role) => hasRole(user, role) }),
    [status, user, signIn, signOut],
  );

  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>;
}

export function useAdminSession(): AdminSessionValue {
  const context = useContext(AdminSessionContext);
  if (!context) throw new Error('useAdminSession must be used inside <AdminSessionProvider>');
  return context;
}
