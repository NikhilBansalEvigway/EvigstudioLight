import type { Chat } from '@/types';
import { getMessageText } from '@/types';

export function chatMatchesSearch(chat: Chat, query: string): boolean {
  const s = query.trim().toLowerCase();
  if (!s) return true;
  if (chat.title.toLowerCase().includes(s)) return true;
  if (chat.threadTitle?.toLowerCase().includes(s)) return true;
  for (const t of chat.tags ?? []) {
    if (t.toLowerCase().includes(s)) return true;
  }
  return chat.messages.some((m) => getMessageText(m).toLowerCase().includes(s));
}

export function groupChatsForSidebar(chats: Chat[]): {
  noThread: Chat[];
  threads: { threadId: string; title: string; chats: Chat[] }[];
} {
  const noThread: Chat[] = [];
  const map = new Map<string, { title: string; chats: Chat[] }>();

  for (const c of chats) {
    if (!c.threadId) {
      noThread.push(c);
      continue;
    }
    const g = map.get(c.threadId) ?? { title: c.threadTitle || 'Topic', chats: [] };
    g.chats.push(c);
    if (c.threadTitle) g.title = c.threadTitle;
    map.set(c.threadId, g);
  }

  noThread.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const g of map.values()) {
    g.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const threads = [...map.entries()]
    .map(([threadId, g]) => ({
      threadId,
      title: g.title,
      chats: g.chats,
      latest: Math.max(...g.chats.map((c) => c.updatedAt)),
    }))
    .sort((a, b) => b.latest - a.latest)
    .map(({ threadId, title, chats }) => ({ threadId, title, chats }));

  return { noThread, threads };
}
