import type { FileNode, WorkspaceRoot } from '@/types';
import { randomId } from '@/lib/randomId';

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  '.venv',
  'env',
  '.env',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'target',
  'bin',
  'obj',
]);

export function isWorkspacePathIgnoredPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some((part) => part.startsWith('.') || IGNORED_DIR_NAMES.has(part));
}

function sanitizePath(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');
}

function buildWorkspacePathLocal(workspaceLabel: string, relativePath = ''): string {
  const cleanRelative = sanitizePath(relativePath).join('/');
  return cleanRelative ? `${workspaceLabel}/${cleanRelative}` : workspaceLabel;
}

function getUniqueLabel(
  existingRoots: Array<Pick<WorkspaceRoot, 'label'>>,
  baseLabel: string,
): string {
  const cleanBase = baseLabel.trim() || 'workspace';
  const existing = new Set(existingRoots.map((root) => root.label));
  if (!existing.has(cleanBase)) return cleanBase;
  let index = 2;
  while (existing.has(`${cleanBase} (${index})`)) {
    index += 1;
  }
  return `${cleanBase} (${index})`;
}

export function isUploadBackedWorkspaceRoot(root: WorkspaceRoot): boolean {
  return root.handle === null && !!root.uploadedFiles;
}

/** Native pick missing a handle (e.g. after reload) — not an upload-backed folder. */
export function isNativeDiskStubRoot(root: WorkspaceRoot): boolean {
  return root.handle === null && !isUploadBackedWorkspaceRoot(root);
}

/**
 * When a file list contains more than one top-level path segment (e.g. `projA/a.ts` and `projB/b.ts`),
 * creates one upload-backed root per top-level folder. Otherwise behaves like a single folder pick.
 */
export function createUploadedWorkspaceRootsFromFiles(
  files: File[],
  existingRoots: Array<Pick<WorkspaceRoot, 'label'>>,
): WorkspaceRoot[] {
  const groups = normalizeUploadedFolderFilesToGroups(files);
  const usedLabels = existingRoots.map((r) => r.label);
  const roots: WorkspaceRoot[] = [];

  for (const group of groups) {
    if (group.relPaths.size === 0) continue;
    const label = getUniqueLabel(
      usedLabels.map((l) => ({ label: l })),
      group.labelBase,
    );
    usedLabels.push(label);
    roots.push({
      id: randomId(),
      label,
      handle: null,
      uploadedFiles: group.relPaths,
      contentOverlay: new Map(),
      virtualEmptyDirs: new Set(),
    });
  }

  if (roots.length === 0) {
    throw new Error(
      'No usable files in that folder (everything may be under skipped paths like node_modules). Try a folder that contains source files.',
    );
  }

  return roots;
}

export function createUploadedWorkspaceRootFromFiles(
  files: File[],
  existingRoots: Array<Pick<WorkspaceRoot, 'label'>>,
): WorkspaceRoot {
  const roots = createUploadedWorkspaceRootsFromFiles(files, existingRoots);
  if (roots.length > 1) {
    throw new Error(
      'Multiple top-level folders were selected; use createUploadedWorkspaceRootsFromFiles instead.',
    );
  }
  return roots[0];
}

/** Split a folder-upload file list into one or more { labelBase, relPaths } groups (multi-root). */
export function normalizeUploadedFolderFilesToGroups(
  files: File[],
): Array<{ labelBase: string; relPaths: Map<string, File> }> {
  const entries = files.map((file) => {
    const raw = (
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    ).replace(/\\/g, '/');
    return { file, parts: sanitizePath(raw) };
  }).filter((e) => e.parts.length > 0);

  if (entries.length === 0) {
    throw new Error('No files were selected');
  }

  const buckets = new Map<string, typeof entries>();
  for (const e of entries) {
    const top = e.parts[0];
    let list = buckets.get(top);
    if (!list) {
      list = [];
      buckets.set(top, list);
    }
    list.push(e);
  }

  if (buckets.size === 1) {
    return [normalizeUploadedFolderFiles(files)];
  }

  const groups: Array<{ labelBase: string; relPaths: Map<string, File> }> = [];
  for (const [top, bucketEntries] of buckets) {
    const relPaths = new Map<string, File>();
    for (const { file, parts } of bucketEntries) {
      const inner = parts.slice(1);
      if (inner.length === 0) continue;
      const rel = inner.join('/');
      if (!rel || isWorkspacePathIgnoredPath(rel)) continue;
      relPaths.set(rel, file);
    }
    if (relPaths.size > 0) {
      groups.push({ labelBase: top, relPaths });
    }
  }

  if (groups.length === 0) {
    throw new Error(
      'No usable files in that folder (everything may be under skipped paths like node_modules). Try a folder that contains source files.',
    );
  }

  return groups;
}

export function normalizeUploadedFolderFiles(files: File[]): { labelBase: string; relPaths: Map<string, File> } {
  const entries = files.map((file) => {
    const raw = (
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    ).replace(/\\/g, '/');
    return { file, parts: sanitizePath(raw) };
  }).filter((e) => e.parts.length > 0);

  if (entries.length === 0) {
    throw new Error('No files were selected');
  }

  const firstSeg = entries[0].parts[0];
  const allShareFirst = entries.every((e) => e.parts[0] === firstSeg);
  const relPaths = new Map<string, File>();

  if (allShareFirst && entries.some((e) => e.parts.length > 1)) {
    for (const { file, parts } of entries) {
      const rel = parts.slice(1).join('/');
      if (!rel || isWorkspacePathIgnoredPath(rel)) continue;
      relPaths.set(rel, file);
    }
    return { labelBase: firstSeg, relPaths };
  }

  for (const { file, parts } of entries) {
    const rel = parts.join('/');
    if (!rel || isWorkspacePathIgnoredPath(rel)) continue;
    relPaths.set(rel, file);
  }

  return { labelBase: firstSeg, relPaths };
}

export function collectUploadedWorkspacePaths(root: WorkspaceRoot): Set<string> {
  const out = new Set<string>();
  const addParents = (rel: string) => {
    const parts = sanitizePath(rel);
    for (let i = 1; i < parts.length; i++) {
      out.add(parts.slice(0, i).join('/'));
    }
  };

  for (const rel of root.uploadedFiles?.keys() ?? []) {
    out.add(rel);
    addParents(rel);
  }
  for (const rel of root.contentOverlay?.keys() ?? []) {
    out.add(rel);
    addParents(rel);
  }
  for (const d of root.virtualEmptyDirs ?? []) {
    out.add(d);
    addParents(d);
  }
  return out;
}

export function isUploadedLeafFile(root: WorkspaceRoot, relPath: string): boolean {
  return !!(root.uploadedFiles?.has(relPath) || root.contentOverlay?.has(relPath));
}

export async function readUploadedWorkspaceFile(root: WorkspaceRoot, relativePath: string): Promise<string> {
  const norm = sanitizePath(relativePath).join('/');
  if (!norm) throw new Error('Invalid path');
  const overlay = root.contentOverlay?.get(norm);
  if (overlay !== undefined) return overlay;
  const f = root.uploadedFiles?.get(norm);
  if (!f) throw new Error(`File not found: ${norm}`);
  return f.text();
}

export function writeUploadedWorkspaceFile(root: WorkspaceRoot, relativePath: string, content: string): void {
  const norm = sanitizePath(relativePath).join('/');
  if (!norm) throw new Error('Cannot write to workspace root');
  if (!root.contentOverlay) root.contentOverlay = new Map();
  root.contentOverlay.set(norm, content);
}

export function uploadedWorkspaceFileExists(root: WorkspaceRoot, relativePath: string): boolean {
  const norm = sanitizePath(relativePath).join('/');
  if (!norm) return false;
  return isUploadedLeafFile(root, norm);
}

export function listUploadedDirectoryContents(root: WorkspaceRoot, relativePath: string): string[] {
  const cleaned = sanitizePath(relativePath).join('/');
  const names = new Set<string>();
  const all = collectUploadedWorkspacePaths(root);

  for (const p of all) {
    if (cleaned) {
      if (p === cleaned) continue;
      if (!p.startsWith(`${cleaned}/`)) continue;
      const rest = p.slice(cleaned.length + 1);
      const seg = rest.split('/')[0];
      if (!seg) continue;
      const childRel = `${cleaned}/${seg}`;
      if (rest.includes('/')) {
        names.add(`${seg}/`);
      } else if (isUploadedLeafFile(root, childRel)) {
        names.add(seg);
      } else {
        names.add(`${seg}/`);
      }
    } else {
      const parts = sanitizePath(p);
      const top = parts[0];
      if (!top) continue;
      if (parts.length === 1) {
        names.add(isUploadedLeafFile(root, top) ? top : `${top}/`);
      } else {
        names.add(`${top}/`);
      }
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

type Trie = Map<string, Trie | 'file'>;

function insertFilePath(trie: Trie, parts: string[]): void {
  if (parts.length === 0) return;
  let m = trie;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const last = i === parts.length - 1;
    const existing = m.get(part);
    if (last) {
      m.set(part, 'file');
      break;
    }
    if (existing === 'file') break;
    const next = (existing as Trie) ?? new Map<string, Trie | 'file'>();
    m.set(part, next);
    m = next;
  }
}

export function buildUploadedWorkspaceChildTree(root: WorkspaceRoot): FileNode[] {
  const trie: Trie = new Map();

  for (const rel of root.uploadedFiles?.keys() ?? []) {
    insertFilePath(trie, sanitizePath(rel));
  }
  for (const rel of root.contentOverlay?.keys() ?? []) {
    insertFilePath(trie, sanitizePath(rel));
  }
  for (const d of root.virtualEmptyDirs ?? []) {
    const parts = sanitizePath(d);
    let m = trie;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      const existing = m.get(part);
      if (last) {
        if (existing !== 'file') {
          m.set(part, new Map());
        }
        break;
      }
      const next = (existing === 'file' ? new Map() : (existing as Trie)) ?? new Map<string, Trie | 'file'>();
      m.set(part, next);
      m = next;
    }
  }

  const toNodes = (tr: Trie, relPrefix: string): FileNode[] => {
    const out: FileNode[] = [];
    const names = [...tr.keys()].sort((a, b) => {
      const aT = a === '.evigstudio-trash';
      const bT = b === '.evigstudio-trash';
      if (aT !== bT) return aT ? 1 : -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    for (const name of names) {
      const entry = tr.get(name)!;
      const fullRel = relPrefix ? `${relPrefix}/${name}` : name;
      const path = buildWorkspacePathLocal(root.label, fullRel);
      if (entry === 'file') {
        out.push({
          name,
          path,
          type: 'file',
          relativePath: fullRel,
          workspaceRootId: root.id,
          workspaceLabel: root.label,
          isWorkspaceRoot: false,
        });
      } else {
        out.push({
          name,
          path,
          type: 'directory',
          children: toNodes(entry as Trie, fullRel),
          relativePath: fullRel,
          workspaceRootId: root.id,
          workspaceLabel: root.label,
          isWorkspaceRoot: false,
        });
      }
    }
    return out;
  };

  return toNodes(trie, '');
}

export function createUploadedEmptyFile(root: WorkspaceRoot, relativePath: string): void {
  const norm = sanitizePath(relativePath).join('/');
  if (!root.contentOverlay) root.contentOverlay = new Map();
  root.contentOverlay.set(norm, '');
}

export function createUploadedDirectory(root: WorkspaceRoot, relativePath: string): void {
  const norm = sanitizePath(relativePath).join('/');
  if (!root.virtualEmptyDirs) root.virtualEmptyDirs = new Set();
  root.virtualEmptyDirs.add(norm);
}

export function deleteUploadedSubtree(root: WorkspaceRoot, relativePath: string): void {
  const norm = sanitizePath(relativePath).join('/');
  const prefix = norm ? `${norm}/` : '';

  for (const k of [...(root.uploadedFiles?.keys() ?? [])]) {
    if (k === norm || k.startsWith(prefix)) root.uploadedFiles.delete(k);
  }
  for (const k of [...(root.contentOverlay?.keys() ?? [])]) {
    if (k === norm || k.startsWith(prefix)) root.contentOverlay?.delete(k);
  }
  if (root.virtualEmptyDirs) {
    for (const k of [...root.virtualEmptyDirs]) {
      if (k === norm || k.startsWith(prefix)) root.virtualEmptyDirs.delete(k);
    }
  }
}

export function renameUploadedWithinRoot(root: WorkspaceRoot, oldRel: string, newRel: string): void {
  const o = sanitizePath(oldRel).join('/');
  const n = sanitizePath(newRel).join('/');
  const prefix = o ? `${o}/` : '';

  const rekey = <T>(map: Map<string, T> | undefined): void => {
    if (!map) return;
    const additions: [string, T][] = [];
    for (const [k, v] of [...map.entries()]) {
      if (k === o || k.startsWith(prefix)) {
        map.delete(k);
        const tail = k === o ? '' : k.slice(o.length + 1);
        const dest = tail ? `${n}/${tail}` : n;
        additions.push([dest, v]);
      }
    }
    for (const [k, v] of additions) map.set(k, v);
  };

  rekey(root.uploadedFiles);
  rekey(root.contentOverlay);

  if (root.virtualEmptyDirs?.size) {
    const next = new Set<string>();
    for (const d of root.virtualEmptyDirs) {
      if (d === o || d.startsWith(prefix)) {
        const tail = d === o ? '' : d.slice(o.length + 1);
        next.add(tail ? `${n}/${tail}` : n);
      } else {
        next.add(d);
      }
    }
    root.virtualEmptyDirs = next;
  }
}
