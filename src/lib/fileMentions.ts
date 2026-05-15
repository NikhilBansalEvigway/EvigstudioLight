import type { FileNode } from '@/types';

export type MentionKind = 'file' | 'directory';

export interface MentionEntry {
  name: string;
  path: string;
  type: MentionKind;
  parentPath: string;
  fileCount: number;
}

export function flattenMentionEntries(nodes: FileNode[], result: MentionEntry[] = []): MentionEntry[] {
  for (const node of nodes) {
    const parentPath = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    if (node.type === 'file') {
      result.push({ name: node.name, path: node.path, type: 'file', parentPath, fileCount: 1 });
      continue;
    }

    const fileCount = countFiles(node);
    result.push({ name: node.name, path: node.path, type: 'directory', parentPath, fileCount });
    if (node.children?.length) {
      flattenMentionEntries(node.children, result);
    }
  }
  return result;
}

export function findMentionNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.type === 'directory' && node.children?.length) {
      const found = findMentionNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function filterMentionEntries(entries: MentionEntry[], query: string, limit = 15): MentionEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return entries.slice(0, limit);

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return entries
    .map((entry) => ({ entry, score: scoreMentionEntry(entry, tokens, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function collectDirectoryFilePaths(node: FileNode, limit = 40): string[] {
  if (node.type === 'file') return [node.path];

  const paths: string[] = [];
  const walk = (children: FileNode[] = []) => {
    for (const child of children) {
      if (paths.length >= limit) return;
      if (child.type === 'file') {
        paths.push(child.path);
      } else {
        walk(child.children ?? []);
      }
    }
  };

  walk(node.children ?? []);
  return paths;
}

export function summarizeDirectory(node: FileNode, limit = 120): string {
  const lines: string[] = [];
  const walk = (children: FileNode[] = [], depth = 0) => {
    for (const child of children) {
      if (lines.length >= limit) return;
      lines.push(`${'  '.repeat(depth)}${child.type === 'directory' ? 'dir ' : 'file'} ${child.path}`);
      if (child.type === 'directory') {
        walk(child.children ?? [], depth + 1);
      }
    }
  };

  walk(node.children ?? []);
  const suffix = lines.length >= limit ? '\n... [truncated]' : '';
  return `${lines.join('\n')}${suffix}`;
}

function countFiles(node: FileNode): number {
  if (node.type === 'file') return 1;
  return (node.children ?? []).reduce((sum, child) => sum + countFiles(child), 0);
}

function scoreMentionEntry(entry: MentionEntry, tokens: string[], normalizedQuery: string): number {
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  const compactPath = path.replace(/[\s/_-]+/g, '');
  const compactQuery = normalizedQuery.replace(/[\s/_-]+/g, '');

  if (!tokens.every((token) => path.includes(token) || name.includes(token) || compactPath.includes(token))) {
    return 0;
  }

  let score = entry.type === 'file' ? 10 : 6;
  if (name === normalizedQuery) score += 100;
  if (path === normalizedQuery) score += 90;
  if (name.startsWith(normalizedQuery)) score += 60;
  if (path.startsWith(normalizedQuery)) score += 45;
  if (name.includes(normalizedQuery)) score += 30;
  if (path.includes(normalizedQuery)) score += 20;
  if (compactQuery && compactPath.includes(compactQuery)) score += 12;
  return score;
}
