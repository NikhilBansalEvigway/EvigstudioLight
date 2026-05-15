/** Remember which chat was open so workspace (per-chat IndexedDB) restores after refresh. */

const STORAGE_KEY = 'evigstudio:last-active-chat-id';

export function readLastActiveChatId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)?.trim();
    if (!raw || raw.length > 120) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeLastActiveChatId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!id) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* quota / private mode */
  }
}
