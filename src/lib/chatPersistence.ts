import { toast } from 'sonner';
import type { Chat, ChatAccess, ChatPrivacy, ChatVersionSnapshot } from '@/types';
import { normalizeChat } from '@/types';
import { loadChats, saveChat, deleteChat as deleteChatIdb } from '@/lib/storage';

/** `idb` = chats in the browser (IndexedDB) when no API. `server` = PostgreSQL via the team API. */
export type ChatPersistenceMode = 'idb' | 'server';

let mode: ChatPersistenceMode = 'idb';

export function setChatPersistenceMode(m: ChatPersistenceMode) {
  mode = m;
}

export function getChatPersistenceMode(): ChatPersistenceMode {
  return mode;
}

function mapServerRow(row: {
  id: string;
  title: string;
  messages: unknown;
  createdAt: number;
  updatedAt: number;
  ownerId?: string;
  ownerDisplayName?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  privacy?: ChatPrivacy;
  access?: ChatAccess;
  threadId?: string | null;
  threadTitle?: string | null;
  tags?: string[];
  versionHistory?: ChatVersionSnapshot[];
}): Chat {
  return normalizeChat({
    id: row.id,
    title: row.title,
    messages: row.messages as Chat['messages'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ownerId: row.ownerId,
    ownerDisplayName: row.ownerDisplayName ?? null,
    groupId: row.groupId ?? null,
    groupName: row.groupName ?? null,
    privacy: row.privacy,
    access: row.access,
    threadId: row.threadId ?? null,
    threadTitle: row.threadTitle ?? null,
    tags: row.tags,
    versionHistory: row.versionHistory,
  });
}

export async function persistenceLoadChats(): Promise<Chat[]> {
  if (mode === 'idb') {
    return loadChats();
  }
  const r = await fetch('/api/chats', { credentials: 'include' });
  if (!r.ok) {
    throw new Error('Failed to load chats from server');
  }
  const data = (await r.json()) as { chats: Parameters<typeof mapServerRow>[0][] };
  return data.chats.map(mapServerRow);
}

export async function persistenceLoadChat(id: string): Promise<Chat> {
  if (mode === 'idb') {
    const chats = await loadChats();
    const chat = chats.find((c) => c.id === id);
    if (!chat) throw new Error('Chat not found');
    return chat;
  }

  const r = await fetch(`/api/chats/${id}`, { credentials: 'include' });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || 'Failed to load chat from server');
  }
  const data = (await r.json()) as { chat: Parameters<typeof mapServerRow>[0] };
  return mapServerRow(data.chat);
}

export async function persistenceSaveChat(chat: Chat): Promise<void> {
  if (mode === 'idb') {
    await saveChat(chat);
    return;
  }
  const r = await fetch(`/api/chats/${chat.id}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: chat.title,
      messages: chat.messages,
      groupId: chat.groupId ?? null,
      privacy: chat.privacy ?? 'private',
      threadId: chat.threadId ?? null,
      threadTitle: chat.threadTitle ?? null,
      tags: chat.tags ?? [],
      versionHistory: chat.versionHistory ?? [],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || 'Failed to save chat');
  }
}

export async function persistenceDeleteChat(id: string): Promise<void> {
  if (mode === 'idb') {
    await deleteChatIdb(id);
    return;
  }
  const r = await fetch(`/api/chats/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || 'Failed to delete chat');
  }
}

async function createChatInIdb(): Promise<Chat> {
  const id = crypto.randomUUID();
  const chat: Chat = normalizeChat({
    id,
    title: 'New Chat',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await saveChat(chat);
  return chat;
}

export async function persistenceCreateChat(): Promise<Chat> {
  if (mode === 'idb') {
    return createChatInIdb();
  }

  let r: Response;
  try {
    r = await fetch('/api/chats', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat', messages: [] }),
    });
  } catch (e) {
    console.warn('[EvigStudio] Network error creating chat; using browser storage', e);
    toast.info('Could not reach the team server — new chat saved in this browser only.');
    setChatPersistenceMode('idb');
    return createChatInIdb();
  }

  if (r.ok) {
    const data = (await r.json()) as { chat: Parameters<typeof mapServerRow>[0] };
    return mapServerRow(data.chat);
  }

  const t = await r.text();
  let message = t || `HTTP ${r.status}`;
  try {
    const j = JSON.parse(t) as { error?: string };
    if (j.error) message = j.error;
  } catch {
    /* plain text */
  }

  if (r.status === 401 || r.status === 403) {
    throw new Error(message);
  }
  if (r.status === 400) {
    throw new Error(message || 'Invalid chat request');
  }

  if (r.status >= 500) {
    console.warn('[EvigStudio] Server error creating chat; using browser storage:', r.status, message);
    toast.info('Server error — new chat saved in this browser only.');
    setChatPersistenceMode('idb');
    return createChatInIdb();
  }

  throw new Error(message);
}
