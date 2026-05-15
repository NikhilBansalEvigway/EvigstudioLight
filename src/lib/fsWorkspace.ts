import type { FileNode, WorkspaceRoot } from '@/types';
import { toast } from 'sonner';
import { strToU8, zipSync } from 'fflate';
import { tryWriteWorkspaceMirrorFile } from '@/lib/workspaceMirrorClient';
import { randomId } from '@/lib/randomId';
import {
  buildUploadedWorkspaceChildTree,
  collectUploadedWorkspacePaths,
  createUploadedDirectory,
  createUploadedEmptyFile,
  deleteUploadedSubtree,
  isNativeDiskStubRoot,
  isUploadBackedWorkspaceRoot,
  isUploadedLeafFile,
  listUploadedDirectoryContents,
  readUploadedWorkspaceFile,
  renameUploadedWithinRoot,
  uploadedWorkspaceFileExists,
  writeUploadedWorkspaceFile,
} from '@/lib/uploadedWorkspace';

export {
  createUploadedWorkspaceRootFromFiles,
  createUploadedWorkspaceRootsFromFiles,
  isNativeDiskStubRoot,
} from '@/lib/uploadedWorkspace';

export const NATIVE_DISK_RECONNECT_HINT =
  'This Open Folder root is not linked to disk anymore (common after reload or opening this chat on another device). In the Files tab, click Connect next to the workspace root and pick the same folder again — then Save will write files there.';

export const STALE_WORKSPACE_WRITE_RECOVERY_MESSAGE =
  'Workspace write could not be confirmed. This chat may be holding stale workspace state. Open a new chat, reopen the same workspace, and continue there.';

/** Shown when an upload-backed workspace has no linked disk folder and disk write cannot proceed. */
export const UPLOAD_WORKSPACE_DISK_LINK_HINT =
  'This project is an in-browser copy (not yet linked to a folder on disk). In Chrome or Edge, click Link disk next to the workspace folder in the file tree, pick your project folder, then save again.';

/** Soft-delete folder at workspace root (visible in the tree as “Trash”). */
export const EVIGSTUDIO_TRASH_DIR_NAME = '.evigstudio-trash';

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

export function isWorkspacePathIgnored(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some((part) => part.startsWith('.') || IGNORED_DIR_NAMES.has(part));
}

function shouldSkipDirectory(name: string): boolean {
  if (name === EVIGSTUDIO_TRASH_DIR_NAME) return false;
  return name.startsWith('.') || IGNORED_DIR_NAMES.has(name);
}

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

let warnedDownloadFallbackSave = false;

function showDownloadFallbackHintOnce(): void {
  if (warnedDownloadFallbackSave) return;
  warnedDownloadFallbackSave = true;
  toast.message(
    'This browser cannot write into a project folder directly. Each Save also downloads the file (check Downloads), unless a server disk mirror (LOCAL_WORKSPACE_MIRROR_ROOT) is enabled. In Chrome or Edge, Open folder attaches the project on disk; otherwise use Link disk when shown.',
  );
}

/** Safe filename for `<a download>` when File System Access pickers are unavailable (e.g. Firefox). */
export function buildDownloadFilenameForUploadSave(rootLabel: string, relativePath: string): string {
  const rootSegs = sanitizePath(rootLabel.replace(/\\/g, '/'));
  const safeRoot = (rootSegs.join('-') || 'workspace').replace(/[/\\<>:"|?*\x00-\x1f]/g, '-').slice(0, 72);
  const parts = sanitizePath(relativePath);
  const joined = parts.length ? parts.join('__') : 'file';
  const safeRel = joined.replace(/[/\\<>:"|?*\x00-\x1f]/g, '-').slice(0, 180) || 'file';
  const ext = /\.[a-zA-Z0-9]{1,12}$/.test(safeRel) ? '' : '.txt';
  return `${safeRoot}__${safeRel}${ext}`;
}

/** Writes UTF-8 text to disk via a browser download (Firefox / Safari fallback for upload workspaces). */
export function saveUploadBackedCopyViaBrowserDownload(rootLabel: string, relativePath: string, content: string): void {
  if (typeof document === 'undefined') return;
  const name = buildDownloadFilenameForUploadSave(rootLabel, relativePath);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

async function fileExists(dirHandle: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Whether `relativePath` exists as a file under `dirHandle` (not a directory). */
async function fileExistsOnDisk(dirHandle: FileSystemDirectoryHandle, relativePath: string): Promise<boolean> {
  await ensurePermission(dirHandle, 'read');
  const parts = sanitizePath(relativePath);
  if (parts.length === 0) return false;
  let current = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    try {
      current = await current.getDirectoryHandle(parts[i]);
    } catch {
      return false;
    }
  }
  return fileExists(current, parts[parts.length - 1]);
}

async function ensurePermission(
  handle: any,
  mode: 'read' | 'readwrite',
  options?: { request?: boolean },
): Promise<void> {
  if (!handle || typeof handle.queryPermission !== 'function') return;
  const opts = { mode };
  try {
    const current = await handle.queryPermission(opts);
    if (current === 'granted') return;
    if (options?.request) {
      const next = await handle.requestPermission?.(opts);
      if (next === 'granted') return;
    }
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

function sortFileNodesInPlace(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    const aTrash = a.type === 'directory' && a.name === EVIGSTUDIO_TRASH_DIR_NAME;
    const bTrash = b.type === 'directory' && b.name === EVIGSTUDIO_TRASH_DIR_NAME;
    if (aTrash !== bTrash) return aTrash ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function cloneFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneFileNodes(node.children) : undefined,
  }));
}

function createWorkspaceRootNode(root: WorkspaceRoot, children: FileNode[] = []): FileNode {
  return {
    name: root.label,
    path: root.label,
    type: 'directory' as const,
    children,
    ...(root.handle ? { handle: root.handle } : {}),
    workspaceRootId: root.id,
    workspaceLabel: root.label,
    relativePath: '',
    isWorkspaceRoot: true,
  };
}

export type BuildWorkspaceTreeOptions = {
  initialTree?: FileNode[];
  onProgress?: (tree: FileNode[]) => void;
  rebuildRootIds?: string[];
};

function createProgressEmitter(
  getTree: () => FileNode[],
  onProgress?: (tree: FileNode[]) => void,
  intervalMs = 80,
) {
  let lastEmit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (force = false) => {
    if (!onProgress) return;
    const emit = () => {
      lastEmit = Date.now();
      onProgress(cloneFileNodes(getTree()));
    };

    if (force) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      emit();
      return;
    }

    const elapsed = Date.now() - lastEmit;
    if (elapsed >= intervalMs) {
      emit();
      return;
    }

    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, intervalMs - elapsed);
    }
  };
}

async function buildAnnotatedFileTree(
  root: WorkspaceRoot,
  dirHandle: FileSystemDirectoryHandle,
  targetNodes: FileNode[],
  emitProgress: () => void,
  relativePath = '',
): Promise<void> {
  await ensurePermission(dirHandle, 'read');

  for await (const [name, handle] of (dirHandle as any).entries()) {
    const fullRelativePath = relativePath ? `${relativePath}/${name}` : name;

    if (handle.kind === 'directory') {
      if (shouldSkipDirectory(name)) continue;

      const directoryNode: FileNode = {
        name,
        path: buildWorkspacePath(root.label, fullRelativePath),
        type: 'directory',
        children: [],
        handle,
        relativePath: fullRelativePath,
        workspaceRootId: root.id,
        workspaceLabel: root.label,
        isWorkspaceRoot: false,
      };
      targetNodes.push(directoryNode);
      sortFileNodesInPlace(targetNodes);
      emitProgress();

      await buildAnnotatedFileTree(
        root,
        handle as FileSystemDirectoryHandle,
        directoryNode.children ?? [],
        emitProgress,
        fullRelativePath,
      );
      sortFileNodesInPlace(directoryNode.children ?? []);
      emitProgress();
      continue;
    }

    targetNodes.push({
      name,
      path: buildWorkspacePath(root.label, fullRelativePath),
      type: 'file',
      handle,
      relativePath: fullRelativePath,
      workspaceRootId: root.id,
      workspaceLabel: root.label,
      isWorkspaceRoot: false,
    });
    sortFileNodesInPlace(targetNodes);
    emitProgress();
  }
}

export type FileSystemAccessSupportReason =
  | 'native-fs'
  | 'upload-folder'
  | 'insecure-context'
  | 'ssr';

export interface FileSystemAccessStatus {
  /** HTTPS / localhost — workspace UI (folder button + drag/drop) allowed */
  workspaceUiAvailable: boolean;
  /** Chromium-style writable directory picker (`showDirectoryPicker`) */
  nativeDirectoryPicker: boolean;
  /** `showSaveFilePicker` — per-file “Save as” link for upload workspaces (often Chromium only). */
  saveFilePickerAvailable: boolean;
  reason: FileSystemAccessSupportReason;
  /** Set only when workspace UI is blocked (`insecure-context`) */
  message: string | null;
}

/** @deprecated use workspaceUiAvailable */
export function isFileSystemAccessSupported(): boolean {
  return getFileSystemAccessStatus().workspaceUiAvailable;
}

/** Alias for `getFileSystemAccessStatus` — compatibility naming */
export function checkCompatibility(): FileSystemAccessStatus {
  return getFileSystemAccessStatus();
}

export function getFileSystemAccessStatus(): FileSystemAccessStatus {
  if (typeof window === 'undefined') {
    return {
      workspaceUiAvailable: false,
      nativeDirectoryPicker: false,
      saveFilePickerAvailable: false,
      reason: 'ssr',
      message: null,
    };
  }

  if (!window.isSecureContext) {
    return {
      workspaceUiAvailable: false,
      nativeDirectoryPicker: false,
      saveFilePickerAvailable: false,
      reason: 'insecure-context',
      message:
        'Opening a workspace requires a secure page. Use HTTPS or open EvigStudio at localhost.',
    };
  }

  const nativeDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const w = window as Window & { showSaveFilePicker?: (o?: object) => Promise<FileSystemFileHandle> };
  const saveFilePickerAvailable = typeof w.showSaveFilePicker === 'function';

  return {
    workspaceUiAvailable: true,
    nativeDirectoryPicker,
    saveFilePickerAvailable,
    reason: nativeDirectoryPicker ? 'native-fs' : 'upload-folder',
    message: null,
  };
}

/** Hint when Save cannot write directly back to disk (upload-backed workspace). Neutral wording — no browser names. */
export function getNativeFsSupportErrorMessage(): string | null {
  const s = getFileSystemAccessStatus();
  if (!s.workspaceUiAvailable) return s.message;
  if (!s.nativeDirectoryPicker) {
    return 'Open folder loads a copy in the app. In Chrome or Edge, Open folder can attach the project folder on disk directly. In Firefox, configure the API host with LOCAL_WORKSPACE_MIRROR_ROOT (and token) — see the Files tab banner when enabled. Otherwise use Save-as / download, Save ZIP, or Link disk after Open folder when shown.';
  }
  return null;
}

async function collectNativeFilesForZip(rootHandle: FileSystemDirectoryHandle): Promise<Array<{ rel: string; text: string }>> {
  const acc: Array<{ rel: string; text: string }> = [];

  async function walk(dir: FileSystemDirectoryHandle, relPrefix: string): Promise<void> {
    for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[
      string,
      FileSystemFileHandle | FileSystemDirectoryHandle,
    ]>) {
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (handle.kind === 'directory') {
        if (shouldSkipDirectory(name)) continue;
        await walk(handle as FileSystemDirectoryHandle, rel);
      } else {
        const text = await readFile(rootHandle, rel);
        acc.push({ rel, text });
      }
    }
  }

  await walk(rootHandle, '');
  return acc;
}

/** ZIP every workspace root (native or folder-upload). */
export async function downloadWorkspaceZipBundle(workspaceRoots: WorkspaceRoot[]): Promise<void> {
  const obj: Record<string, Uint8Array> = {};
  for (const root of workspaceRoots) {
    const labelPrefix = `${root.label.replace(/[/\\]/g, '-')}/`;
    if (isUploadBackedWorkspaceRoot(root)) {
      for (const rel of collectUploadedWorkspacePaths(root)) {
        if (!isUploadedLeafFile(root, rel)) continue;
        const text = await readUploadedWorkspaceFile(root, rel);
        obj[`${labelPrefix}${rel}`] = strToU8(text);
      }
    } else if (root.handle) {
      const files = await collectNativeFilesForZip(root.handle);
      for (const { rel, text } of files) {
        obj[`${labelPrefix}${rel}`] = strToU8(text);
      }
    }
  }
  const zipped = zipSync(obj);
  const blob = new Blob([zipped], { type: 'application/zip' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download =
    workspaceRoots.length === 1
      ? `${workspaceRoots[0].label.replace(/[/\\]/g, '-')}-project.zip`
      : 'evigstudio-workspaces.zip';
  a.click();
  URL.revokeObjectURL(url);
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    // Omit a fixed `id` so each "Add folder" pick is independent (some browsers tie `id` to a single remembered grant/slot).
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

export async function buildWorkspaceTree(
  workspaceRoots: WorkspaceRoot[],
  options: BuildWorkspaceTreeOptions = {},
): Promise<FileNode[]> {
  const rebuildRootIds = new Set(options.rebuildRootIds ?? workspaceRoots.map((root) => root.id));
  const roots = workspaceRoots.map((root) => {
    const existingRoot = options.initialTree?.find((node) => node.workspaceRootId === root.id && node.isWorkspaceRoot);
    return createWorkspaceRootNode(root, existingRoot?.children ? cloneFileNodes(existingRoot.children) : []);
  });
  const sortRoots = () => roots.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const emitProgress = createProgressEmitter(() => sortRoots(), options.onProgress);

  sortRoots();
  emitProgress(true);

  await Promise.all(
    workspaceRoots.map(async (root) => {
      if (!rebuildRootIds.has(root.id)) return;

      const rootNode = roots.find((node) => node.workspaceRootId === root.id);
      if (!rootNode) return;

      rootNode.children = [];
      emitProgress(true);
      if (isUploadBackedWorkspaceRoot(root) && !root.diskDirectoryHandle) {
        rootNode.children = buildUploadedWorkspaceChildTree(root);
        sortFileNodesInPlace(rootNode.children);
        emitProgress();
      } else if (root.diskDirectoryHandle) {
        await buildAnnotatedFileTree(root, root.diskDirectoryHandle, rootNode.children, () => emitProgress());
        sortFileNodesInPlace(rootNode.children);
        emitProgress();
      } else if (root.handle) {
        await buildAnnotatedFileTree(root, root.handle, rootNode.children, () => emitProgress());
        sortFileNodesInPlace(rootNode.children);
        emitProgress();
      }
    }),
  );

  sortRoots();
  emitProgress(true);
  return cloneFileNodes(roots);
}

export function removeWorkspaceRootFromTree(nodes: FileNode[], rootId: string): FileNode[] {
  return nodes.filter((node) => node.workspaceRootId !== rootId);
}

export function workspaceRootsMatch(
  currentRoots: Array<Pick<WorkspaceRoot, 'id'>>,
  expectedRoots: Array<Pick<WorkspaceRoot, 'id'>>,
): boolean {
  if (currentRoots.length !== expectedRoots.length) return false;
  const sortIds = (roots: Array<Pick<WorkspaceRoot, 'id'>>) => [...roots].map((r) => r.id).sort();
  const a = sortIds(currentRoots);
  const b = sortIds(expectedRoots);
  return a.every((id, i) => id === b[i]);
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
      if (shouldSkipDirectory(name)) continue;
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

async function ensureFileOrDirectoryWritable(handle: FileSystemFileHandle | FileSystemDirectoryHandle): Promise<void> {
  const h = handle as { queryPermission?: (o: { mode: string }) => Promise<PermissionState>; requestPermission?: (o: { mode: string }) => Promise<PermissionState> };
  if (!h.queryPermission) return;
  const opts = { mode: 'readwrite' } as { mode: string };
  let status = await h.queryPermission(opts);
  if (status === 'granted') return;
  status = (await h.requestPermission?.(opts)) ?? 'denied';
  if (status !== 'granted') throw new Error('Permission denied');
}

/**
 * For folder-upload workspaces: writes bytes to disk when a directory or per-file handle is linked,
 * or via `showSaveFilePicker` when available, or via the API host mirror (`LOCAL_WORKSPACE_MIRROR_ROOT`).
 * If none of those apply, triggers a UTF-8 file download so Save still lands bytes on disk, then returns false.
 * Returns true when a new per-file handle was linked via Save As (persist session to keep it).
 */
async function flushUploadBackedFileToDisk(
  root: WorkspaceRoot,
  relativePath: string,
  content: string,
): Promise<boolean> {
  if (!isUploadBackedWorkspaceRoot(root)) return false;

  if (root.diskDirectoryHandle) {
    await writeFile(root.diskDirectoryHandle, relativePath, content);
    return false;
  }

  const w = typeof window !== 'undefined' ? (window as Window & { showSaveFilePicker?: (o?: object) => Promise<FileSystemFileHandle> }) : null;
  let fileHandle = root.diskFileHandles?.get(relativePath);
  let linkedNewHandle = false;

  if (!fileHandle) {
    const mirror = await tryWriteWorkspaceMirrorFile(root.label, relativePath, content);
    if (mirror.ok) return false;
  }

  if (!fileHandle && typeof w?.showSaveFilePicker === 'function') {
    try {
      const suggestedName = relativePath.split('/').pop() || 'file.txt';
      fileHandle = await w.showSaveFilePicker({
        suggestedName,
      });
      if (!root.diskFileHandles) root.diskFileHandles = new Map();
      root.diskFileHandles.set(relativePath, fileHandle);
      linkedNewHandle = true;
    } catch (e) {
      const name = e instanceof DOMException ? e.name : (e as Error)?.name;
      if (name === 'AbortError') {
        throw new Error('Save cancelled — nothing was written to a folder on disk.');
      }
      throw e;
    }
  }

  if (!fileHandle) {
    const acc = getFileSystemAccessStatus();
    if (!acc.workspaceUiAvailable && acc.message) {
      throw new Error(acc.message);
    }
    if (typeof w?.showSaveFilePicker !== 'function') {
      showDownloadFallbackHintOnce();
      saveUploadBackedCopyViaBrowserDownload(root.label, relativePath, content);
      return false;
    }
    const insecure =
      typeof window !== 'undefined' && window.isSecureContext === false;
    throw new Error(
      insecure
        ? `${UPLOAD_WORKSPACE_DISK_LINK_HINT} (Use https:// or localhost for full disk access.)`
        : UPLOAD_WORKSPACE_DISK_LINK_HINT,
    );
  }

  await ensureFileOrDirectoryWritable(fileHandle);
  const writable = await (fileHandle as FileSystemFileHandle & { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
  await writable.write(content);
  await writable.close();

  return linkedNewHandle;
}

export async function writeFile(dirHandle: FileSystemDirectoryHandle, path: string, content: string): Promise<void> {
  await ensurePermission(dirHandle, 'readwrite', { request: true });
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

export async function workspaceFileExists(workspaceRoots: WorkspaceRoot[], path: string): Promise<boolean> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) {
    return true;
  }

  if (isUploadBackedWorkspaceRoot(root)) {
    if (root.diskDirectoryHandle) {
      const onDisk = await fileExistsOnDisk(root.diskDirectoryHandle, relativePath);
      if (onDisk) return true;
    }
    return uploadedWorkspaceFileExists(root, relativePath);
  }

  const parts = sanitizePath(relativePath);
  if (parts.length === 0) return false;

  const diskHandle = root.diskDirectoryHandle ?? root.handle;
  if (!diskHandle) return false;

  let current: FileSystemDirectoryHandle = diskHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    try {
      current = await current.getDirectoryHandle(parts[i]);
    } catch {
      return false;
    }
  }

  return fileExists(current, parts[parts.length - 1]);
}

export async function writeWorkspaceFileVerified(
  workspaceRoots: WorkspaceRoot[],
  path: string,
  content: string,
  options?: { expectCreate?: boolean },
): Promise<boolean> {
  const linkedNewDiskHandle = await writeWorkspaceFile(workspaceRoots, path, content);

  if (options?.expectCreate) {
    const exists = await workspaceFileExists(workspaceRoots, path);
    if (!exists) {
      throw new Error(`${STALE_WORKSPACE_WRITE_RECOVERY_MESSAGE} File: ${path}`);
    }
  }

  return linkedNewDiskHandle;
}

export async function createDirectory(dirHandle: FileSystemDirectoryHandle, path: string): Promise<void> {
  await ensurePermission(dirHandle, 'readwrite', { request: true });
  const parts = sanitizePath(path);
  if (parts.length === 0) throw new Error(`Invalid directory path: "${path}"`);

  let current: FileSystemDirectoryHandle = dirHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
}

export async function deleteFileOrDir(dirHandle: FileSystemDirectoryHandle, path: string): Promise<void> {
  await ensurePermission(dirHandle, 'readwrite', { request: true });
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
  if (isUploadBackedWorkspaceRoot(root)) {
    const norm = sanitizePath(relativePath).join('/');
    const overlay = root.contentOverlay?.get(norm);
    if (overlay !== undefined) return overlay;
    if (root.diskDirectoryHandle && (await fileExistsOnDisk(root.diskDirectoryHandle, relativePath))) {
      return readFile(root.diskDirectoryHandle, relativePath);
    }
    return readUploadedWorkspaceFile(root, relativePath);
  }
  if (!root.handle) {
    if (isNativeDiskStubRoot(root)) throw new Error(NATIVE_DISK_RECONNECT_HINT);
    throw new Error('No workspace folder handle');
  }
  return readFile(root.handle, relativePath);
}

/** @returns true when a new on-disk file handle was linked (IndexedDB session should persist handles). */
export async function writeWorkspaceFile(
  workspaceRoots: WorkspaceRoot[],
  path: string,
  content: string,
): Promise<boolean> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) throw new Error(`Cannot write to workspace root: "${path}"`);
  if (isUploadBackedWorkspaceRoot(root)) {
    const linkedNew = await flushUploadBackedFileToDisk(root, relativePath, content);
    writeUploadedWorkspaceFile(root, relativePath, content);
    return linkedNew;
  }
  if (!root.handle) {
    if (isNativeDiskStubRoot(root)) throw new Error(NATIVE_DISK_RECONNECT_HINT);
    throw new Error('No workspace folder handle');
  }
  await writeFile(root.handle, relativePath, content);
  return false;
}

export async function createWorkspaceFile(workspaceRoots: WorkspaceRoot[], path: string): Promise<void> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) throw new Error(`Cannot create a file at workspace root: "${path}"`);
  if (isUploadBackedWorkspaceRoot(root)) {
    if (root.diskDirectoryHandle) {
      await createFile(root.diskDirectoryHandle, relativePath);
    }
    createUploadedEmptyFile(root, relativePath);
  } else {
    if (!root.handle) {
      if (isNativeDiskStubRoot(root)) throw new Error(NATIVE_DISK_RECONNECT_HINT);
      throw new Error('No workspace folder handle');
    }
    await createFile(root.handle, relativePath);
  }

  const exists = await workspaceFileExists(workspaceRoots, path);
  if (!exists) {
    throw new Error(`${STALE_WORKSPACE_WRITE_RECOVERY_MESSAGE} File: ${path}`);
  }
}

export async function createWorkspaceDirectory(workspaceRoots: WorkspaceRoot[], path: string): Promise<void> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) throw new Error(`Cannot create a folder at workspace root: "${path}"`);
  if (isUploadBackedWorkspaceRoot(root)) {
    if (root.diskDirectoryHandle) {
      await createDirectory(root.diskDirectoryHandle, relativePath);
    }
    createUploadedDirectory(root, relativePath);
    return;
  }
  if (!root.handle) {
    if (isNativeDiskStubRoot(root)) throw new Error(NATIVE_DISK_RECONNECT_HINT);
    throw new Error('No workspace folder handle');
  }
  await createDirectory(root.handle, relativePath);
}

export async function deleteWorkspacePath(workspaceRoots: WorkspaceRoot[], path: string): Promise<void> {
  const { root, relativePath } = resolveWorkspacePath(workspaceRoots, path);
  if (!relativePath) {
    throw new Error('Cannot delete a workspace root from disk. Remove it from the workspace instead.');
  }
  if (isUploadBackedWorkspaceRoot(root)) {
    if (root.diskDirectoryHandle) {
      await deleteFileOrDir(root.diskDirectoryHandle, relativePath);
    }
    deleteUploadedSubtree(root, relativePath);
    return;
  }
  if (!root.handle) {
    if (isNativeDiskStubRoot(root)) throw new Error(NATIVE_DISK_RECONNECT_HINT);
    throw new Error('No workspace folder handle');
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
    if (isUploadBackedWorkspaceRoot(oldResolved.root)) {
      if (oldResolved.root.diskDirectoryHandle) {
        await renameFileOrDir(
          oldResolved.root.diskDirectoryHandle,
          oldResolved.relativePath,
          newResolved.relativePath,
        );
      }
      renameUploadedWithinRoot(oldResolved.root, oldResolved.relativePath, newResolved.relativePath);
      return;
    }
    if (!oldResolved.root.handle) {
      if (isNativeDiskStubRoot(oldResolved.root)) throw new Error(NATIVE_DISK_RECONNECT_HINT);
      throw new Error('No workspace folder handle');
    }
    await renameFileOrDir(oldResolved.root.handle, oldResolved.relativePath, newResolved.relativePath);
    return;
  }

  if (
    isUploadBackedWorkspaceRoot(oldResolved.root) ||
    isUploadBackedWorkspaceRoot(newResolved.root)
  ) {
    throw new Error(
      'Moving items between workspace folders is only supported when both sides use the same folder picker (native File System Access).',
    );
  }

  if (!oldResolved.root.handle || !newResolved.root.handle) {
    if (isNativeDiskStubRoot(oldResolved.root) || isNativeDiskStubRoot(newResolved.root)) {
      throw new Error(NATIVE_DISK_RECONNECT_HINT);
    }
    throw new Error('No workspace folder handle');
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
  await ensurePermission(dirHandle, 'readwrite', { request: true });
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
  if (parts[0] === EVIGSTUDIO_TRASH_DIR_NAME) {
    if (isUploadBackedWorkspaceRoot(root)) {
      if (root.diskDirectoryHandle) {
        await deleteFileOrDir(root.diskDirectoryHandle, relativePath);
      }
      deleteUploadedSubtree(root, relativePath);
    } else if (root.handle) {
      await deleteFileOrDir(root.handle, relativePath);
    }
    return { trashedPath: buildWorkspacePath(root.label, relativePath) };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = randomId().replace(/-/g, '').slice(0, 8);
  const trashBase = `${EVIGSTUDIO_TRASH_DIR_NAME}/${stamp}-${nonce}`;
  const destRel = `${trashBase}/${parts.join('/')}`;

  if (isUploadBackedWorkspaceRoot(root)) {
    if (root.diskDirectoryHandle) {
      await renameFileOrDir(root.diskDirectoryHandle, relativePath, destRel);
    }
    renameUploadedWithinRoot(root, relativePath, destRel);
  } else if (root.handle) {
    await renameFileOrDir(root.handle, relativePath, destRel);
  } else if (isNativeDiskStubRoot(root)) {
    throw new Error(NATIVE_DISK_RECONNECT_HINT);
  }
  return { trashedPath: buildWorkspacePath(root.label, destRel) };
}

/**
 * For a path under `.evigstudio-trash/<batch>/…`, returns the original workspace path (same root).
 * Returns null for the Trash root, a batch folder alone, or paths outside Trash.
 */
export function getRestoreDestinationWorkspacePath(
  workspaceRoots: WorkspaceRoot[],
  trashedWorkspacePath: string,
): string | null {
  try {
    const { root, relativePath } = resolveWorkspacePath(workspaceRoots, trashedWorkspacePath);
    const parts = sanitizePath(relativePath);
    if (parts[0] !== EVIGSTUDIO_TRASH_DIR_NAME || parts.length < 3) return null;
    const originalRel = parts.slice(2).join('/');
    if (!originalRel) return null;
    return buildWorkspacePath(root.label, originalRel);
  } catch {
    return null;
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
  if (isUploadBackedWorkspaceRoot(root)) {
    if (root.diskDirectoryHandle) {
      return listDirectoryContents(root.diskDirectoryHandle, relativePath);
    }
    return listUploadedDirectoryContents(root, relativePath);
  }
  if (!root.handle) return [];
  return listDirectoryContents(root.handle, relativePath);
}
