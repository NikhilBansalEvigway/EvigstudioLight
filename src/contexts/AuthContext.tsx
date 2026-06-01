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

  // When the server is temporarily unreachable, keep the last known user so we don't
  // bounce users back to /login. We'll restore auth state when the server returns.
  const [hadUserSession, setHadUserSession] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      const data = (await r.json()) as { user?: AuthUser };
      if (r.ok && data.user) {
        setUser(data.user);
      } else {
        // Only clear the user for real auth failures.
        if (r.status === 401) {
          setUser(null);
          setHadUserSession(false);
        }
      }
    } catch {
      // Network/server error: don't change serverAvailable here — the health poller
     
    }
  }, []);

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

  // Continuously monitor API health so temporary disconnects recover without reload/relogin.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let delay = 8_000;
    let pendingTimer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await fetch('/api/health', { credentials: 'include', cache: 'no-store' });
        if (cancelled) return;
        setServerAvailable(r.ok);
        delay = r.ok ? 10_000 : Math.min(60_000, Math.round(delay * 1.6));
      } catch {
        if (cancelled) return;
        setServerAvailable(false);
        delay = Math.min(60_000, Math.round(delay * 1.6));
      }
      if (!cancelled) {
        pendingTimer = window.setTimeout(tick, delay);
      }
    };

   
    const onReconnect = () => {
      if (cancelled) return;
      if (pendingTimer != null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      delay = 8_000;
      void tick();
    };

    window.addEventListener('online', onReconnect);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onReconnect();
    });

    pendingTimer = window.setTimeout(tick, delay);
    return () => {
      cancelled = true;
      if (pendingTimer != null) window.clearTimeout(pendingTimer);
      window.removeEventListener('online', onReconnect);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    if (serverAvailable) {
      void refresh();
    }
  }, [ready, serverAvailable, refresh]);

  useEffect(() => {
    if (user) setHadUserSession(true);
  }, [user]);

  useEffect(() => {
    if (!ready || !serverAvailable || !user) {
      useAppStore.setState({ serverSystemPrompts: null, serverChatLimits: null, serverContextRules: null });
      return;
    }
    void useAppStore.getState().refreshServerSystemPrompts();
    void useAppStore.getState().refreshServerChatLimits();
    void useAppStore.getState().refreshServerContextRules();
  }, [ready, serverAvailable, user]);

  useEffect(() => {
    if (!ready) return;
    // Prefer server persistence whenever the user has an active session.
    // If the server drops temporarily, stay on server mode and keep showing the current chats.
    if (serverAvailable && user) {
      setChatPersistenceMode('server');
      return;
    }
    if (user || hadUserSession) {
      // Keep server mode while reconnecting.
      setChatPersistenceMode('server');
      return;
    }
    setChatPersistenceMode('idb');
  }, [ready, serverAvailable, user, hadUserSession]);

  /** Load chats after persistence mode matches auth (server vs IndexedDB). */
  useEffect(() => {
    if (!ready) return;
    // If we have (or had) a server session but the server is currently down,
    // keep existing chats in memory instead of re-initializing from IndexedDB.
    if (!serverAvailable && (user || hadUserSession)) return;
    if (serverAvailable && !user) return;
    void initChats();
  }, [ready, serverAvailable, user, hadUserSession, initChats]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      resetChats();
      setUser(null);
      setHadUserSession(false);
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
