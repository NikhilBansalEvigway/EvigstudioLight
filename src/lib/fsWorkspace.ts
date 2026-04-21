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

export function isFileSystemAccessSupported(): boolean {
  return 'showDirectoryPicker' in window;
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
  newName: string
): Promise<void> {
  const parts = sanitizePath(oldPath);
  if (parts.length === 0) throw new Error(`Invalid path: "${oldPath}"`);

  const oldName = parts[parts.length - 1];
  if (oldName === newName) return;

  let parentHandle: FileSystemDirectoryHandle = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    parentHandle = await parentHandle.getDirectoryHandle(parts[i]);
  }

  // Read old file content, create new, delete old
  const oldFileHandle = await parentHandle.getFileHandle(oldName);
  const file = await oldFileHandle.getFile();
  const content = await file.text();

  const newFileHandle = await parentHandle.getFileHandle(newName, { create: true });
  const writable = await (newFileHandle as any).createWritable();
  await writable.write(content);
  await writable.close();

  await (parentHandle as any).removeEntry(oldName);
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
