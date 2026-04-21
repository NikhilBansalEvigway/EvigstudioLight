import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { testConnection } from '@/lib/llmClient';

/** Load persisted settings and probe local AI once on app load (all routes). */
export function SettingsBootstrap() {
  const initSettings = useAppStore((s) => s.initSettings);
  const setLMConnected = useAppStore((s) => s.setLMConnected);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await initSettings();
      if (cancelled) return;
      const result = await testConnection(useAppStore.getState().settings);
      if (!cancelled) setLMConnected(result.ok);
    })();
    return () => {
      cancelled = true;
    };
  }, [initSettings, setLMConnected]);

  return null;
}
