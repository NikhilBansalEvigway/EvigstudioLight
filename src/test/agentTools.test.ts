import { describe, expect, it } from 'vitest';
import {
  hasMutationTools,
  parseToolCalls,
  repairCodeFences,
  sanitizeWrittenFileContent,
  stripChannelTokens,
  stripToolMarkers,
  wrapLooseCodeBlocks,
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

  it('keeps tool paths clean when harmony channel tokens leak onto the marker line', () => {
    const parsed = parseToolCalls(
      [
        '*** Edit File: build.js ***commentary to=functions.edit',
        '*** Begin Search',
        'const a = 1;',
        '*** End Search',
        '*** Begin Replace',
        'const a = 2;',
        '*** End Replace',
      ].join('\n'),
    );
    expect(parsed.editFiles[0].path).toBe('build.js');
  });

  it('cleans leaked tokens from read, write, delete and rename paths', () => {
    const readParsed = parseToolCalls('*** Read File: build.js ***commentary to=');
    expect(readParsed.readFiles[0]).toEqual({ path: 'build.js' });

    const readRanged = parseToolCalls('*** Read File: build.js#L10-L20 commentary to=functions.read');
    expect(readRanged.readFiles[0]).toEqual({ path: 'build.js', startLine: 10, endLine: 20 });

    const writeParsed = parseToolCalls(
      ['*** Write File: out.js commentary to=functions.write', 'x', '*** End Write'].join('\n'),
    );
    expect(writeParsed.writeFiles[0].path).toBe('out.js');

    const deleteParsed = parseToolCalls('*** Delete Path: old.js <|message|>');
    expect(deleteParsed.deletePaths).toEqual(['old.js']);

    const renameParsed = parseToolCalls('*** Rename File: a.js -> b.js to=functions.rename');
    expect(renameParsed.renamePaths).toEqual([{ oldPath: 'a.js', newPath: 'b.js' }]);
  });

  it('does not strip legitimate paths that merely resemble channel words', () => {
    // No leading space + routing token => these are real file names, left intact.
    const parsed = parseToolCalls('*** Read File: src/analysis.py');
    expect(parsed.readFiles[0]).toEqual({ path: 'src/analysis.py' });
    const parsed2 = parseToolCalls('*** Read File: final.js');
    expect(parsed2.readFiles[0]).toEqual({ path: 'final.js' });
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

describe('stripChannelTokens (harmony format)', () => {
  it('removes a full harmony channel header that leaked into prose', () => {
    const raw = '<|channel|>commentary to=commentary <|constrain|>json<|message|>Here is the answer.';
    expect(stripChannelTokens(raw)).toBe('Here is the answer.');
  });

  it('removes standalone harmony control tokens', () => {
    expect(stripChannelTokens('Done.<|end|>')).toBe('Done.');
    expect(stripChannelTokens('Refactored.<|message|>The code was refactored.'))
      .toBe('Refactored. The code was refactored.');
  });

  it('fully cleans a leaked harmony + marker line through the combined pipeline', () => {
    const raw = '*** End commentary<|message|>The code was refactored.';
    expect(stripToolMarkers(stripChannelTokens(raw))).toBe('The code was refactored.');
  });

  it('does not touch tokens inside fenced code', () => {
    const raw = ['```', 'const x = "<|message|>";', '```'].join('\n');
    expect(stripChannelTokens(raw)).toBe(raw);
  });

  it('removes leaked channel routing that appears as plain text', () => {
    expect(stripChannelTokens('commentary to=functions.edit').trim()).toBe('');
    expect(stripChannelTokens('commentary to=').trim()).toBe('');
    const kept = stripChannelTokens('Done. commentary to=functions.edit');
    expect(kept).toContain('Done.');
    expect(kept).not.toContain('to=');
  });
});

describe('stripToolMarkers (leaked non-standard markers)', () => {
  it('strips a leaked "*** Begin Write" token but keeps the trailing content', () => {
    expect(stripToolMarkers('*** Begin Write { "name": "toy" }')).toBe('{ "name": "toy" }');
  });

  it('strips a leaked "*** End commentary" token', () => {
    expect(stripToolMarkers('*** End commentary')).toBe('');
  });
});

describe('wrapLooseCodeBlocks', () => {
  it('wraps a multi-line run of unfenced code', () => {
    const raw = [
      'Here is the tokenizer:',
      'export function tokenize(input: string): Token[] {',
      '  const tokens: Token[] = [];',
      '  return tokens;',
      '}',
    ].join('\n');

    const wrapped = wrapLooseCodeBlocks(raw);
    expect(wrapped).toContain('Here is the tokenizer:');
    expect(wrapped).toContain('```\nexport function tokenize');
    expect(wrapped.match(/```/g)?.length).toBe(2);
  });

  it('leaves prose untouched', () => {
    const prose = [
      'This explains how the parser works.',
      'It reads tokens one at a time and builds a tree.',
      'No changes are needed to the legacy code.',
    ].join('\n');
    expect(wrapLooseCodeBlocks(prose)).toBe(prose);
  });

  it('does not double-wrap already fenced code', () => {
    const raw = ['```ts', 'const x = 1;', 'const y = 2;', '```'].join('\n');
    expect(wrapLooseCodeBlocks(raw)).toBe(raw);
  });

  it('does not wrap a single code-ish line in prose', () => {
    const raw = 'Call useState() to manage state.';
    expect(wrapLooseCodeBlocks(raw)).toBe(raw);
  });
});

describe('repairCodeFences', () => {
  it('strips stray mid-line triple-backticks so loose code can be recovered', () => {
    // Mirrors the broken model output: JSX with triple-backticks glued mid-line.
    const raw = [
      '<div className="flex"> ``` <button onClick={() => go()}>Go</button>',
      '<span className="y">hi</span> ``` <div>',
      '</div>',
    ].join('\n');
    const repaired = repairCodeFences(raw);
    expect(repaired).not.toContain('```');
    expect(repaired).toContain('<button onClick={() => go()}>Go</button>');
    // After repair, the loose JSX is recoverable as a single fenced code block.
    const wrapped = wrapLooseCodeBlocks(repaired);
    expect(wrapped.match(/```/g)?.length).toBe(2);
  });

  it('leaves a well-formed fenced block untouched', () => {
    const raw = ['```ts', 'const x = 1;', 'const y = 2;', '```'].join('\n');
    expect(repairCodeFences(raw)).toBe(raw);
  });

  it('closes an unbalanced (unclosed) fence so the tail stays code', () => {
    const raw = ['```tsx', 'const a = 1;'].join('\n');
    expect(repairCodeFences(raw)).toBe(['```tsx', 'const a = 1;', '```'].join('\n'));
  });

  it('does not touch single-backtick inline code', () => {
    const raw = 'Run `npm install` then `npm test` to verify.';
    expect(repairCodeFences(raw)).toBe(raw);
  });

  it('preserves triple-backticks that live inside a real fenced block', () => {
    const raw = ['```md', 'Use ``` to open a fence.', '```'].join('\n');
    // The middle line is inside the fence, so its backticks are left as content.
    expect(repairCodeFences(raw)).toBe(raw);
  });
});
