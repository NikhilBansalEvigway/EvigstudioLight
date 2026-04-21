import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';

/** Syncs theme preset to <html data-ui-preset> for CSS variable overrides. */
export function UiThemeSync() {
  const preset = useAppStore((s) => s.settings.uiThemePreset ?? 'default');

  useEffect(() => {
    const el = document.documentElement;
    if (preset === 'default') {
      delete el.dataset.uiPreset;
    } else {
      el.dataset.uiPreset = preset;
    }
  }, [preset]);

  return null;
}
