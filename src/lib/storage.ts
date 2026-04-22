import { openDB, type IDBPDatabase } from 'idb';
import type { Chat, AppSettings, WorkspaceSession } from '@/types';
import { normalizeChat } from '@/types';
import { DEFAULT_SETTINGS } from '@/types';

const DB_NAME = 'offline-dev-agent';
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains('chats')) {
          db.createObjectStore('chats', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        if (oldVersion < 2 && db.objectStoreNames.contains('chats')) {
          // v2: chats may include privacy, threadId, tags, versionHistory — no store shape change
        }

        if (!db.objectStoreNames.contains('workspaceSessions')) {
          db.createObjectStore('workspaceSessions', { keyPath: 'chatId' });
        }
      },
    });
  }
  return dbPromise;
}

export async function loadChats(): Promise<Chat[]> {
  const db = await getDB();
  const rows = await db.getAll('chats');
  return rows.map((r) => normalizeChat(r as Chat));
}

export async function saveChat(chat: Chat): Promise<void> {
  const db = await getDB();
  await db.put('chats', chat);
}

export async function deleteChat(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('chats', id);
}

export async function loadSettings(): Promise<AppSettings> {
  const isElectron = !!(window as any).electronAPI?.isElectron;
  /** Browser: team API throttles concurrent LLM calls via /api/llm. Electron: direct LM Studio, no server semaphore. */
  const targetBaseUrl = isElectron ? 'http://127.0.0.1:1234/v1' : '/api/llm/v1';

  try {
    const db = await getDB();
    const settings = await db.get('settings', 'app-settings');
    if (!settings) {
      const defaults = { ...DEFAULT_SETTINGS, baseUrl: targetBaseUrl };
      return defaults;
    }
    const merged = { ...DEFAULT_SETTINGS, ...settings };

    // In Electron: ensure we use direct URL, not the proxy path
    // In browser: ensure we use the Hono proxy path (not raw LM Studio URL)
    if (merged.baseUrl !== targetBaseUrl) {
      const isOldViteProxy = merged.baseUrl === '/lmstudio' || merged.baseUrl.startsWith('/lmstudio/');
      const isBrowserDirect =
        !isElectron &&
        (merged.baseUrl.startsWith('http://127.0.0.1:') || merged.baseUrl.startsWith('http://localhost:'));
      const shouldMigrate = isElectron
        ? isOldViteProxy || merged.baseUrl.startsWith('/api/llm')
        : isOldViteProxy || isBrowserDirect;
      if (shouldMigrate) {
        console.log('[EvigStudio] Migrating baseUrl:', merged.baseUrl, '→', targetBaseUrl);
        merged.baseUrl = targetBaseUrl;
        await saveSettings(merged);
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS, baseUrl: targetBaseUrl };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await getDB();
  await db.put('settings', settings, 'app-settings');
}

export async function loadWorkspaceSession(chatId: string): Promise<WorkspaceSession | null> {
  const db = await getDB();
  const row = await db.get('workspaceSessions', chatId);
  return (row as WorkspaceSession) ?? null;
}

export async function saveWorkspaceSession(session: WorkspaceSession): Promise<void> {
  const db = await getDB();
  await db.put('workspaceSessions', session);
}

export async function deleteWorkspaceSession(chatId: string): Promise<void> {
  const db = await getDB();
  await db.delete('workspaceSessions', chatId);
}
