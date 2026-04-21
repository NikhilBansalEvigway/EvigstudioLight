import type { UiThemePresetId } from '@/types';

/** Built-in color presets (white-label friendly). Light/dark still toggled separately. */
export const UI_THEME_PRESETS: { id: UiThemePresetId; label: string }[] = [
  { id: 'default', label: 'Default (teal)' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'forest', label: 'Forest' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
  { id: 'midnight', label: 'Midnight blue' },
];

export const MAX_BRAND_LOGO_BYTES = 96 * 1024;
export const MAX_BACKGROUND_BYTES = 512 * 1024;
