import { useEffect, useState } from 'react';

const CHANNEL_NAME = 'evigstudio-session';
const PING_INTERVAL_MS = 8_000;


export function useTabGuard(userId: string | null | undefined): boolean {
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!userId) { setConflict(false); return; }
    if (typeof BroadcastChannel === 'undefined') return;

    const tabId = crypto.randomUUID();
    const ch = new BroadcastChannel(CHANNEL_NAME);

    const handleMessage = (evt: MessageEvent) => {
      const data = evt.data as { type: string; userId: string; tabId: string } | undefined;
      if (!data || data.userId !== userId || data.tabId === tabId) return;
      if (data.type === 'ping' || data.type === 'hello') {
     
        ch.postMessage({ type: 'pong', userId, tabId });
        setConflict(true);
      }
      if (data.type === 'pong') {
        setConflict(true);
      }
      if (data.type === 'bye') {
     
        setTimeout(() => {
          ch.postMessage({ type: 'ping', userId, tabId });
        }, 500);
      }
    };

    ch.addEventListener('message', handleMessage);

    ch.postMessage({ type: 'hello', userId, tabId });

    const intervalId = setInterval(() => {
      
      ch.postMessage({ type: 'ping', userId, tabId });
   
      setConflict(false);
    }, PING_INTERVAL_MS);

    return () => {
      ch.postMessage({ type: 'bye', userId, tabId });
      clearInterval(intervalId);
      ch.removeEventListener('message', handleMessage);
      ch.close();
    };
  }, [userId]);

  return conflict;
}
