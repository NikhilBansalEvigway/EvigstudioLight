import type { FileNode, WorkspaceRoot } from '@/types';

/**
 * Sanitize a file path for use with the File System Access API.
 * Normalizes separators, removes leading/trailing slashes, and filters empty segments.
 */
function sanitizePath(path: string): string[] {
  return path
    .replace(/\\/g, '/')     // backslashes to forward slashes
    .replace(/^\.\//, '')     // remove leading ./
    .replace(/^\/+/, '')      // remove leading /
    .replace(/\/+$/, '')      // remove trailing /
    .split('/')
    .filter(part => part.length > 0 && part !== '.' && part !== '..');
}

async function getDirectoryHandleForParts(
  dirHandle: FileSystemDirectoryHandle,
  parts: string[],
  options?: { create?: boolean },
): Promise<FileSystemDirectoryHandle> {
  let current = dirHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: options?.create === true });
  }
  return current;
}

async function entryExists(dirHandle: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    try {
      await dirHandle.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

async function ensurePermission(handle: any, mode: 'read' | 'readwrite'): Promise<void> {
  if (!handle || typeof handle.queryPermission !== 'function') return;
  const opts = { mode };
  try {
    const current = await handle.queryPermission(opts);
    if (current === 'granted') return;
    const next = await handle.requestPermission?.(opts);
    if (next === 'granted') return;
    throw new Error('Permission denied');
  } catch (e) {
    // Some Electron/Chromium builds may throw for permission queries; fall back to operation errors.
    if (e instanceof Error && e.message === 'Permission denied') throw e;
  }
}

async function writeBinaryFile(
  dirHandle: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer,
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(data);
  await writable.close();
}

async function copyDirectoryRecursive(
  source: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const [name, handle] of (source as any).entries()) {
    if (handle.kind === 'directory') {
      const next = await target.getDirectoryHandle(name, { create: true });
      await copyDirectoryRecursive(handle as FileSystemDirectoryHandle, next);
      continue;
    }

    const file = await (handle as FileSystemFileHandle).getFile();
    await writeBinaryFile(target, name, await file.arrayBuffer());
  }
}

async function copyEntryBetweenDirectories(
  sourceRoot: FileSystemDirectoryHandle,
  oldPath: string,
  targetRoot: FileSystemDirectoryHandle,
  newPath: string,
): Promise<void> {
  const oldParts = sanitizePath(oldPath);
  const newParts = sanitizePath(newPath);
  if (oldParts.length === 0) throw new Error(`Invalid path: "${oldPath}"`);
  if (newParts.length === 0) throw new Error(`Invalid path: "${newPath}"`);

  const oldParent = await getDirectoryHandleForParts(sourceRoot, oldParts.slice(0, -1));
  const newParent = await getDirectoryHandleForParts(targetRoot, newParts.slice(0, -1), { create: true });
  const oldName = oldParts[oldParts.length - 1];
  const newName = newParts[newParts.length - 1];

  if (await entryExists(newParent, newName)) {
    throw new Error(`Target already exists: "${newParts.join('/')}"`);
  }

  try {
    const fileHandle = await oldParent.getFileHandle(oldName);
    const file = await fileHandle.getFile();
    await writeBinaryFile(newParent, newName, await file.arrayBuffer());
    return;
  } catch {
    const sourceDir = await oldParent.getDirectoryHandle(oldName);
    const targetDir = await newParent.getDirectoryHandle(newName, { create: true });
    await copyDirectoryRecursive(sourceDir, targetDir);
  }
}

function annotateWorkspaceNodes(nodes: FileNode[], root: WorkspaceRoot): FileNode[] {
  return nodes.map((node) => {
    const relativePath = node.path;
    const nextNode: FileNode = {
      ...node,
      path: buildWorkspacePath(root.label, relativePath),
      relativePath,
      workspaceRootId: root.id,
      workspaceLabel: root.label,
      isWorkspaceRoot: false,
    };

    if (node.type === 'directory' && node.children) {
      nextNode.children = annotateWorkspaceNodes(node.children, root);
    }

    return nextNode;
  });
}

export function isFileSystemAccessSupported(): boolean {
  return getFileSystemAccessStatus().supported;
}

export type FileSystemAccessSupportReason = 'supported' | 'insecure-context' | 'unsupported-browser';

export interface FileSystemAccessStatus {
  supported: boolean;
  reason: FileSystemAccessSupportReason;
  message: string | null;
}

export function getFileSystemAccessStatus(): FileSystemAccessStatus {
  if (typeof window === 'undefined') {
    return {
      supported: false,
      reason: 'unsupported-browser',
      message: 'File System Access requires Chrome or Edge. Firefox/Safari not supported.',
    };
  }

  if ('showDirectoryPicker' in window) {
    return {
      supported: true,
      reason: 'supported',
      message: null,
    };
  }

  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: 'insecure-context',
      message: 'Workspace access over the network requires HTTPS in Chrome or Edge. Open EvigStudio via HTTPS or use localhost.',
    };
  }

  return {
    supported: false,
    reason: 'unsupported-browser',
    message: 'File System Access requires Chrome or Edge. Firefox/Safari not supported.',
  };
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  } catch (err: any) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

export function buildWorkspacePath(workspaceLabel: string, relativePath = ''): string {
  const cleanRelative = sanitizePath(relativePath).join('/');
  return cleanRelative ? `${workspaceLabel}/${cleanRelative}` : workspaceLabel;
}

export function getUniqueWorkspaceLabel(
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

export function resolveWorkspacePath(
  workspaceRoots: WorkspaceRoot[],
  path: string,
): { root: WorkspaceRoot; relativePath: string; workspacePath: string } {
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid path: "${path}"`);

  const directRoot = workspaceRoots.find((root) => root.label === parts[0]);
  if (directRoot) {
    const relativePath = parts.slice(1).join('/');
    return {
      root: directRoot,
      relativePath,
      workspacePath: buildWorkspacePath(directRoot.label, relativePath),
    };
  }

  if (workspaceRoots.length === 1) {
    return {
      root: workspaceRoots[0],
      relativePath: parts.join('/'),
      workspacePath: buildWorkspacePath(workspaceRoots[0].label, parts.join('/')),
    };
  }

  throw new Error(
    `Path must start with a workspace folder: ${workspaceRoots.map((root) => root.label).join(', ')}`,
  );
}

export async function buildWorkspaceTree(workspaceRoots: WorkspaceRoot[]): Promise<FileNode[]> {
  const roots = await Promise.all(
    workspaceRoots.map(async (root) => {
      const children = annotateWorkspaceNodes(await buildFileTree(root.handle), root);
      return {
        name: root.label,
        path: root.label,
        type: 'directory' as const,
        children,
        handle: root.handle,
        workspaceRootId: root.id,
        workspaceLabel: root.label,
        relativePath: '',
        isWorkspaceRoot: true,
      } satisfies FileNode;
    }),
  );

  return roots.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function buildFileTree(
  dirHandle: FileSystemDirectoryHandle,
  path = ''
): Promise<FileNode[]> {
  await ensurePermission(dirHandle, 'read');
  const nodes: FileNode[] = [];

  for await (const [name, handle] of (dirHandle as any).entries()) {
    const fullPath = path ? `${path}/${name}` : name;

    if (handle.kind === 'directory') {
      // Skip hidden dirs and node_modules
      if (name.startsWith('.') || name === 'node_modules') continue;
      const children = await buildFileTree(handle as FileSystemDirectoryHandle, fullPath);
      nodes.push({ name, path: fullPath, type: 'directory', children, handle });
    } else {
      nodes.push({ name, path: fullPath, type: 'file', handle });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFile(dirHandle: FileSystemDirectoryHandle, path: string): Promise<string> {
  await ensurePermission(dirHandle, 'read');
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid file path: "${path}"`);

  let current: FileSystemDirectoryHandle = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i]);
  }

  const fileHandle = await current.getFileHandle(parts[parts.length - 1]);
  const file = await fileHandle.getFile();
  return file.text();
}

export async function writeFile(dirHandle: FileSystemDirectoryHandle, path: string, content: string): Promise<void> {
  await ensurePermission(dirHandle, 'readwrite');
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid file path: "${path}"`);

  let current: FileSystemDirectoryHandle = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i], { create: true });
  }

  const fileHandle = await current.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(content);
  await writable.close();
}

export async function createFile(dirHandle: FileSystemDirectoryHandle, path: string): Promise<void> {
  await writeFile(dirHandle, path, '');
}

export async function createDirectory(dirHandle: FileSystemDirectoryHandle, path: string): Promise<void> {
  await ensurePermission(dirHandle, 'readwrite');
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid directory path: "${path}"`);

  let current: FileSystemDirectoryHandle = dirHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
}

export async function deleteFileOrDir(dirHandle: FileSystemDirectoryHandle, path: string): Promise<void> {
  await ensurePermission(dirHandle, 'readwrite');
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid path: "${path}"`);

  let current: FileSystemDirectoryHandle = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i]);
  }

  await (current as any).removeEntry(parts[parts.length - 1], { recursive: true });
}

export async function readWorkspaceFile(workspaceRoots: WorkspaceRoot[], path: string): Promise<string> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) throw new Error(`Cannot read workspace root: "${path}"`);
  return readFile(root.handle, relativePath);
}

export async function writeWorkspaceFile(
  workspaceRoots: WorkspaceRoot[],
  path: string,
  content: string,
): Promise<void> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) throw new Error(`Cannot write to workspace root: "${path}"`);
  await writeFile(root.handle, relativePath, content);
}

export async function createWorkspaceFile(workspaceRoots: WorkspaceRoot[], path: string): Promise<void> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) throw new Error(`Cannot create a file at workspace root: "${path}"`);
  await createFile(root.handle, relativePath);
}

export async function createWorkspaceDirectory(workspaceRoots: WorkspaceRoot[], path: string): Promise<void> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) throw new Error(`Cannot create a folder at workspace root: "${path}"`);
  await createDirectory(root.handle, relativePath);
}

export async function deleteWorkspacePath(workspaceRoots: WorkspaceRoot[], path: string): Promise<void> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) {
    throw new Error('Cannot delete a workspace root from disk. Remove it from the workspace instead.');
  }
  await deleteFileOrDir(root.handle, relativePath);
}

export async function renameWorkspacePath(
  workspaceRoots: WorkspaceRoot[],
  oldPath: string,
  newPath: string,
): Promise<void> {
  const oldResolved = resolveWorkspacePath(workspaceRoots, oldPath);
  const newResolved = resolveWorkspacePath(workspaceRoots, newPath);

  if (!oldResolved.relativePath || !newResolved.relativePath) {
    throw new Error('Workspace roots cannot be renamed or moved from the file tree.');
  }

  if (oldResolved.root.id === newResolved.root.id) {
    await renameFileOrDir(oldResolved.root.handle, oldResolved.relativePath, newResolved.relativePath);
    return;
  }

  await copyEntryBetweenDirectories(
    oldResolved.root.handle,
    oldResolved.relativePath,
    newResolved.root.handle,
    newResolved.relativePath,
  );
  await deleteFileOrDir(oldResolved.root.handle, oldResolved.relativePath);
}

export async function renameFileOrDir(
  dirHandle: FileSystemDirectoryHandle,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await ensurePermission(dirHandle, 'readwrite');
  const oldParts = sanitizePath(oldPath);
  const newParts = sanitizePath(newPath);
  if (oldParts.length === 0) throw new Error(`Invalid path: "${oldPath}"`);
  if (newParts.length === 0) throw new Error(`Invalid path: "${newPath}"`);

  const oldNormalized = oldParts.join('/');
  const newNormalized = newParts.join('/');
  if (oldNormalized === newNormalized) return;

  const movingDirectoryIntoItself =
    newParts.length > oldParts.length &&
    oldParts.every((part, index) => newParts[index] === part);
  if (movingDirectoryIntoItself) {
    throw new Error('Cannot move a folder inside itself');
  }

  const oldParent = await getDirectoryHandleForParts(dirHandle, oldParts.slice(0, -1));
  const newParent = await getDirectoryHandleForParts(dirHandle, newParts.slice(0, -1), { create: true });
  const oldName = oldParts[oldParts.length - 1];
  const newName = newParts[newParts.length - 1];

  if (await entryExists(newParent, newName)) {
    throw new Error(`Target already exists: "${newNormalized}"`);
  }

  try {
    const fileHandle = await oldParent.getFileHandle(oldName);
    const file = await fileHandle.getFile();
    await writeBinaryFile(newParent, newName, await file.arrayBuffer());
    await (oldParent as any).removeEntry(oldName);
    return;
  } catch {
    const sourceDir = await oldParent.getDirectoryHandle(oldName);
    const targetDir = await newParent.getDirectoryHandle(newName, { create: true });
    await copyDirectoryRecursive(sourceDir, targetDir);
    await (oldParent as any).removeEntry(oldName, { recursive: true });
  }
}

export async function trashWorkspacePath(
  workspaceRoots: WorkspaceRoot[],
  path: string,
): Promise<{ trashedPath: string }>
{
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) {
    throw new Error('Cannot trash a workspace root. Remove it from the workspace instead.');
  }

  const parts = sanitizePath(relativePath);
  if (parts.length === 0) throw new Error(`Invalid path: "${path}"`);

  // If something is already under the internal trash, just delete it.
  if (parts[0] === '.evigstudio-trash') {
    await deleteFileOrDir(root.handle, relativePath);
    return { trashedPath: buildWorkspacePath(root.label, relativePath) };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)).slice(0, 8);
  const trashBase = `.evigstudio-trash/${stamp}-${nonce}`;
  const destRel = `${trashBase}/${parts.join('/')}`;

  await renameFileOrDir(root.handle, relativePath, destRel);
  return { trashedPath: buildWorkspacePath(root.label, destRel) };
}

export function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

export function isSupportedFile(name: string): boolean {
  const ext = getFileExtension(name).toLowerCase();
  return ['.m', '.vhd', '.vhdl', '.txt', '.md', '.json', '.v', '.sv', '.py', '.c', '.h', '.cpp', '.hpp', '.ts', '.js', '.css', '.html', '.xml', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.sh', '.bat'].includes(ext);
}

/** Flat list of file paths (directories omitted) for LLM project overview. */
export function serializeFileTree(nodes: FileNode[]): string {
  const paths: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.type === 'file') {
        paths.push(n.path);
      } else if (n.type === 'directory' && n.children?.length) {
        walk(n.children);
      }
    }
  };
  walk(nodes);
  paths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return paths.join('\n');
}

/**
 * List immediate child names under a path relative to workspace root (directories end with /).
 */
export async function listDirectoryContents(
  dirHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<string[]> {
  await ensurePermission(dirHandle, 'read');
  const parts = sanitizePath(relativePath);
  let current = dirHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part);
  }
  const names: string[] = [];
  for await (const [name, handle] of (current as any).entries()) {
    names.push(handle.kind === 'directory' ? `${name}/` : name);
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export async function listWorkspaceDirectoryContents(
  workspaceRoots: WorkspaceRoot[],
  path: string,
): Promise<string[]> {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') {
    return workspaceRoots
      .map((root) => `${root.label}/`)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, trimmed);
  return listDirectoryContents(root.handle, relativePath);
}
