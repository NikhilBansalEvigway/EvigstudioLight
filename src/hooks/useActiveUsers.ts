import { useEffect, useState } from 'react';

export type ActiveUser = {
  id: string;
  displayName: string;
  email: string;
  lastSeen: number | null;
  status: 'active' | 'idle';
};

export function useActiveUsers(enabled: boolean) {
  const [users, setUsers] = useState<ActiveUser[]>([]);

  useEffect(() => {
    if (!enabled) return;

    const heartbeat = () =>
      fetch('/api/active-users/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});

    const fetchUsers = () =>
      fetch('/api/active-users', { credentials: 'include' })
        .then((r) => r.json())
        .then(setUsers)
        .catch(() => {});

    heartbeat();
    fetchUsers();

    const heartbeatTimer = setInterval(heartbeat, 30_000);
    const fetchTimer = setInterval(fetchUsers, 10_000);

    return () => {
      clearInterval(heartbeatTimer);
      clearInterval(fetchTimer);
    };
  }, [enabled]);

  return users;
}
