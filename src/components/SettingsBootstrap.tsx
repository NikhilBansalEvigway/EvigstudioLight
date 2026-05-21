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
      let delay = 3_000;
      const tick = async () => {
        if (cancelled) return;
        const result = await testConnection(useAppStore.getState().settings, { quiet: true });
        if (cancelled) return;
        setLMConnected(result.ok);
        delay = result.ok ? 15_000 : Math.min(60_000, Math.round(delay * 1.6));
        window.setTimeout(tick, delay);
      };
      void tick();
    })();
    return () => {
      cancelled = true;
    };
  }, [initSettings, setLMConnected]);

  return null;
}
