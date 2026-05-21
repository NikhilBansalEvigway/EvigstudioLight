import { describe, expect, it } from 'vitest';
import { getLastUserContextRefPaths, getMessageContextRefPaths } from '@/lib/chatContext';
import type { Message } from '@/types';
import { useAppStore } from '@/store/useAppStore';

describe('chat context helpers', () => {
  it('extracts unique context reference paths from a message', () => {
    expect(
      getMessageContextRefPaths({
        contextRefs: [
          { path: 'app/main.ts', type: 'file' },
          { path: 'app/main.ts', type: 'file' },
          { path: 'app/components', type: 'directory' },
        ],
      }),
    ).toEqual(['app/main.ts', 'app/components']);
  });

  it('uses the latest user message context references for regenerate flows', () => {
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'first', timestamp: 1, contextRefs: [{ path: 'old.ts', type: 'file' }] },
      { id: '2', role: 'assistant', content: 'reply', timestamp: 2 },
      { id: '3', role: 'user', content: 'second', timestamp: 3, contextRefs: [{ path: 'new.ts', type: 'file' }] },
    ];

    expect(getLastUserContextRefPaths(messages)).toEqual(['new.ts']);
  });

  it('keeps context usage per chat when switching', () => {
    useAppStore.setState({
      chats: [
        {
          id: 'a',
          title: 'A',
          mode: 'chat',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: 'u1', role: 'user', timestamp: 1, content: 'hello' },
            { id: 'a1', role: 'assistant', timestamp: 2, content: 'world' },
          ],
        },
        {
          id: 'b',
          title: 'B',
          mode: 'chat',
          createdAt: 1,
          updatedAt: 1,
          messages: [{ id: 'u2', role: 'user', timestamp: 1, content: 'short' }],
        },
      ],
      activeChatId: 'a',
      historyContextUsedChars: 0,
      workspaceContextUsedChars: 0,
      contextUsedChars: 0,
    } as any);

    const computeHistory = (chatId: string) => {
      const st = useAppStore.getState();
      const chat = st.chats.find((c) => c.id === chatId);
      if (!chat) return;
      const historyChars = chat.messages
        .filter((m: any) => !m.excludedFromContext && (m.role === 'user' || m.role === 'assistant'))
        .reduce((sum: number, m: any) => sum + String(m.content ?? '').length + 48, 0);
      st.setHistoryContextUsage(historyChars);
    };

    computeHistory('a');
    const aUsed = useAppStore.getState().contextUsedChars;
    computeHistory('b');
    const bUsed = useAppStore.getState().contextUsedChars;
    computeHistory('a');
    const aUsedAgain = useAppStore.getState().contextUsedChars;

    expect(aUsed).toBeGreaterThan(bUsed);
    expect(aUsedAgain).toBe(aUsed);
  });
});
