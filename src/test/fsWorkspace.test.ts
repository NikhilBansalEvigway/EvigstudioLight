import { afterEach, describe, expect, it } from 'vitest';
import { getFileSystemAccessStatus, getUniqueWorkspaceLabel, resolveWorkspacePath } from '@/lib/fsWorkspace';
import type { WorkspaceRoot } from '@/types';

const originalPicker = (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
const originalSecureContext = window.isSecureContext;

function setPicker(value?: unknown) {
  if (value === undefined) {
    delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    return;
  }

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value,
  });
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value,
  });
}

afterEach(() => {
  setSecureContext(originalSecureContext);
  setPicker(originalPicker);
});

describe('getFileSystemAccessStatus', () => {
  it('reports support when the directory picker exists', () => {
    setSecureContext(true);
    setPicker(() => Promise.resolve(null));

    expect(getFileSystemAccessStatus()).toEqual({
      supported: true,
      reason: 'supported',
      message: null,
    });
  });

  it('reports insecure-context over LAN/http when the picker is unavailable', () => {
    setSecureContext(false);
    setPicker(undefined);

    expect(getFileSystemAccessStatus()).toEqual({
      supported: false,
      reason: 'insecure-context',
      message: 'Workspace access over the network requires HTTPS in Chrome or Edge. Open EvigStudio via HTTPS or use localhost.',
    });
  });

  it('reports unsupported browsers when secure context is available but picker is missing', () => {
    setSecureContext(true);
    setPicker(undefined);

    expect(getFileSystemAccessStatus()).toEqual({
      supported: false,
      reason: 'unsupported-browser',
      message: 'File System Access requires Chrome or Edge. Firefox/Safari not supported.',
    });
  });
});

describe('workspace path helpers', () => {
  const roots: WorkspaceRoot[] = [
    { id: 'root-1', label: 'frontend', handle: {} as FileSystemDirectoryHandle },
    { id: 'root-2', label: 'backend', handle: {} as FileSystemDirectoryHandle },
  ];

  it('creates unique workspace labels when folder names repeat', () => {
    expect(getUniqueWorkspaceLabel([{ label: 'frontend' }], 'frontend')).toBe('frontend (2)');
    expect(getUniqueWorkspaceLabel([{ label: 'frontend' }, { label: 'frontend (2)' }], 'frontend')).toBe(
      'frontend (3)',
    );
  });

  it('resolves prefixed paths in multi-root workspaces', () => {
    expect(resolveWorkspacePath(roots, 'backend/src/index.ts')).toMatchObject({
      root: roots[1],
      relativePath: 'src/index.ts',
      workspacePath: 'backend/src/index.ts',
    });
  });

  it('allows unprefixed paths when only one workspace root is open', () => {
    expect(resolveWorkspacePath([roots[0]], 'src/App.tsx')).toMatchObject({
      root: roots[0],
      relativePath: 'src/App.tsx',
      workspacePath: 'frontend/src/App.tsx',
    });
  });

  it('rejects ambiguous unprefixed paths in multi-root workspaces', () => {
    expect(() => resolveWorkspacePath(roots, 'src/index.ts')).toThrow(
      'Path must start with a workspace folder: frontend, backend',
    );
  });
});
