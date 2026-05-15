import { describe, expect, it } from 'vitest';
import {
  hasMutationTools,
  parseToolCalls,
  sanitizeWrittenFileContent,
  stripChannelTokens,
  stripToolMarkers,
} from '@/lib/agentTools';

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

  it('parses exact edit-file search and replace blocks', () => {
    const parsed = parseToolCalls([
      '*** Edit File: src/App.tsx',
      '*** Begin Search',
      'const title = "Old";',
      '*** End Search',
      '*** Begin Replace',
      'const title = "New";',
      '*** End Replace',
    ].join('\n'));

    expect(parsed.editFiles).toEqual([
      {
        path: 'src/App.tsx',
        search: 'const title = "Old";',
        replace: 'const title = "New";',
      },
    ]);
    expect(hasMutationTools(parsed)).toBe(true);
  });

  it('strips edit-file tool markers from assistant display text', () => {
    const text = [
      'I will update the title.',
      '*** Edit File: src/App.tsx',
      '*** Begin Search',
      'old',
      '*** End Search',
      '*** Begin Replace',
      'new',
      '*** End Replace',
      'Done.',
    ].join('\n');

    expect(stripToolMarkers(text)).toBe('I will update the title.\n\nDone.');
  });

  it('strips markdown fences from write-file content', () => {
    expect(
      sanitizeWrittenFileContent(['```ts', 'export const answer = 42;', '```'].join('\n')),
    ).toBe('export const answer = 42;');
  });

  it('strips filename labels before fenced write-file content', () => {
    expect(
      sanitizeWrittenFileContent(['src/example.ts', '```ts', 'export const answer = 42;', '```'].join('\n')),
    ).toBe('export const answer = 42;');
  });

  it('can strip model channel prefixes so tool calls still parse', () => {
    const raw = [
      '<|channel>thought I will inspect the folder.',
      '<channel|>*** List Directory: src',
      '<|assistant|>*** Read File: src/main.tsx#L1-L5',
    ].join('\n');

    const cleaned = stripChannelTokens(raw);
    const parsed = parseToolCalls(cleaned);

    expect(parsed.listDirs).toEqual(['src']);
    expect(parsed.readFiles[0]).toEqual({ path: 'src/main.tsx', startLine: 1, endLine: 5 });
  });
});
