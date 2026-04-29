import { describe, expect, it } from 'vitest';
import { getLastUserContextRefPaths, getMessageContextRefPaths } from '@/lib/chatContext';
import type { Message } from '@/types';

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
});
