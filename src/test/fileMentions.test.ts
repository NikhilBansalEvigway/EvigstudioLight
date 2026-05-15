import { describe, expect, it } from 'vitest';
import { collectDirectoryFilePaths, filterMentionEntries, findMentionNode, flattenMentionEntries, summarizeDirectory } from '@/lib/fileMentions';
import type { FileNode } from '@/types';

const tree: FileNode[] = [
  {
    name: 'app',
    path: 'app',
    type: 'directory',
    children: [
      { name: 'Button.tsx', path: 'app/components/Button.tsx', type: 'file' },
      { name: 'index.ts', path: 'app/index.ts', type: 'file' },
    ],
  },
  {
    name: 'server',
    path: 'server',
    type: 'directory',
    children: [
      { name: 'Button.ts', path: 'server/ui/Button.ts', type: 'file' },
    ],
  },
];

describe('file mention helpers', () => {
  it('flattens files and folders with parent paths', () => {
    const entries = flattenMentionEntries(tree);

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'app', type: 'directory', fileCount: 2 }),
        expect.objectContaining({ path: 'app/components/Button.tsx', parentPath: 'app/components', type: 'file' }),
      ]),
    );
  });

  it('matches tokenized path searches and duplicate filenames', () => {
    const results = filterMentionEntries(flattenMentionEntries(tree), 'server button');

    expect(results[0]).toMatchObject({ path: 'server/ui/Button.ts' });
  });

  it('finds folders and summarizes folder contents', () => {
    const node = findMentionNode(tree, 'app');

    expect(node?.type).toBe('directory');
    expect(node ? collectDirectoryFilePaths(node) : []).toEqual(['app/components/Button.tsx', 'app/index.ts']);
    expect(node ? summarizeDirectory(node) : '').toContain('file app/index.ts');
  });
});
