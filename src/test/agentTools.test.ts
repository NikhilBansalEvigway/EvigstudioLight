import { describe, expect, it } from 'vitest';
import { parseToolCalls } from '@/lib/agentTools';

describe('parseToolCalls', () => {
  it('parses plain and ranged read-file requests', () => {
    const parsed = parseToolCalls([
      '*** Read File: src/App.tsx',
      '*** Read File: src/components/FileTree.tsx#L120-L240',
    ].join('\n'));

    expect(parsed.readFiles).toEqual([
      { path: 'src/App.tsx' },
      { path: 'src/components/FileTree.tsx', startLine: 120, endLine: 240 },
    ]);
  });

  it('normalizes single-line ranged reads', () => {
    const parsed = parseToolCalls('*** Read File: src/main.tsx#L42');

    expect(parsed.readFiles).toEqual([
      { path: 'src/main.tsx', startLine: 42, endLine: 42 },
    ]);
  });
});
