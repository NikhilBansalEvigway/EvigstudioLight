import type { FileNode } from '@/types';

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

export async function buildFileTree(
  dirHandle: FileSystemDirectoryHandle,
  path = ''
): Promise<FileNode[]> {
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
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid directory path: "${path}"`);

  let current: FileSystemDirectoryHandle = dirHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
}

export async function deleteFileOrDir(dirHandle: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid path: "${path}"`);

  let current: FileSystemDirectoryHandle = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i]);
  }

  await (current as any).removeEntry(parts[parts.length - 1], { recursive: true });
}

export async function renameFileOrDir(
  dirHandle: FileSystemDirectoryHandle,
  oldPath: string,
  newPath: string,
): Promise<void> {
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
