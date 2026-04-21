import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { setChatPersistenceMode } from '@/lib/chatPersistence';
import { useAppStore } from '@/store/useAppStore';

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'developer' | 'tester' | 'auditor';
};

type AuthContextValue = {
  ready: boolean;
  serverAvailable: boolean;
  user: AuthUser | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const resetChats = useAppStore((s) => s.resetChats);
  const initChats = useAppStore((s) => s.initChats);

  const refresh = useCallback(async () => {
    if (!serverAvailable) {
      setUser(null);
      return;
    }
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      const data = (await r.json()) as { user?: AuthUser };
      if (r.ok && data.user) {
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    }
  }, [serverAvailable]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/health', { credentials: 'include' });
        if (!cancelled) setServerAvailable(r.ok);
      } catch {
        if (!cancelled) setServerAvailable(false);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the API was down, poll so starting the server later picks up without a full reload.
  useEffect(() => {
    if (!ready || serverAvailable) return;
    const id = window.setInterval(async () => {
      try {
        const r = await fetch('/api/health', { credentials: 'include' });
        if (r.ok) setServerAvailable(true);
      } catch {
        /* still down */
      }
    }, 12000);
    return () => window.clearInterval(id);
  }, [ready, serverAvailable]);

  useEffect(() => {
    if (!ready) return;
    if (serverAvailable) {
      void refresh();
    } else {
      setUser(null);
    }
  }, [ready, serverAvailable, refresh]);

  useEffect(() => {
    if (!ready) return;
    if (!serverAvailable || !user) {
      setChatPersistenceMode('idb');
    } else {
      setChatPersistenceMode('server');
    }
  }, [ready, serverAvailable, user]);

  /** Load chats after persistence mode matches auth (server vs IndexedDB). */
  useEffect(() => {
    if (!ready) return;
    if (serverAvailable && !user) return;
    void initChats();
  }, [ready, serverAvailable, user, initChats]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      resetChats();
      setUser(null);
      setChatPersistenceMode('idb');
    }
  }, [resetChats]);

  const value = useMemo(
    () => ({ ready, serverAvailable, user, refresh, logout }),
    [ready, serverAvailable, user, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
