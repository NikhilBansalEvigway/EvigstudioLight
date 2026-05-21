import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  buildCondenseTranscript,
  collectChatContextRefPaths,
  extractAutoSummaryBody,
} from '@/lib/chatSummarization';

describe('chat summarization helpers', () => {
  it('extracts auto-summary body', () => {
    const content = [
      'Conversation summary (auto-generated):',
      '',
      '## Goals',
      '- Do thing',
      '',
      'Continue chatting with this summary as context.',
    ].join('\n');

    expect(extractAutoSummaryBody(content)).toContain('## Goals');
    expect(extractAutoSummaryBody(content)).not.toContain('Conversation summary (auto-generated)');
    expect(extractAutoSummaryBody(content)).not.toContain('Continue chatting with this summary as context.');
  });

  it('builds a transcript that strips summary wrapper and omits patch blocks', () => {
    const msgs: Message[] = [
      {
        id: '1',
        role: 'assistant',
        timestamp: 1,
        content: [
          'Conversation summary (auto-generated):',
          '',
          '## Context',
          '- Foo',
          '',
          'Continue chatting with this summary as context.',
        ].join('\n'),
      },
      {
        id: '2',
        role: 'assistant',
        timestamp: 2,
        content: [
          'Here is a patch:',
          '*** Begin Patch',
          '*** Update File: a.txt',
          '+hello',
          '*** End Patch',
        ].join('\n'),
      },
      {
        id: '3',
        role: 'user',
        timestamp: 3,
        content: 'Please continue.',
      },
    ];

    const t = buildCondenseTranscript(msgs, 20_000);
    expect(t).toContain('Assistant: ## Context');
    expect(t).not.toContain('Conversation summary (auto-generated):');
    expect(t).toContain('[Patch omitted]');
    expect(t).toContain('User: Please continue.');
  });

  it('collects unique contextRef paths across messages', () => {
    const msgs: Message[] = [
      {
        id: '1',
        role: 'user',
        timestamp: 1,
        content: 'hi',
        contextRefs: [
          { path: 'a.ts', type: 'file' },
          { path: 'a.ts', type: 'file' },
          { path: 'b', type: 'directory' },
        ],
      },
      { id: '2', role: 'assistant', timestamp: 2, content: 'ok' },
      {
        id: '3',
        role: 'user',
        timestamp: 3,
        content: 'more',
        contextRefs: [{ path: 'c.ts', type: 'file' }],
      },
    ];

    expect(collectChatContextRefPaths(msgs)).toEqual(['a.ts', 'c.ts']);
  });
});
