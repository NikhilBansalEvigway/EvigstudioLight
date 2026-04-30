import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkspaceTree, getFileSystemAccessStatus, getUniqueWorkspaceLabel, resolveWorkspacePath, workspaceRootsMatch } from '@/lib/fsWorkspace';
import type { FileNode, WorkspaceRoot } from '@/types';

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

type MockHandle = {
  kind: 'directory' | 'file';
  entries?: () => AsyncGenerator<[string, MockHandle]>;
  queryPermission?: () => Promise<'granted'>;
};

function mockFile(): MockHandle {
  return { kind: 'file' };
}

function mockDirectory(entries: Record<string, MockHandle>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    queryPermission: async () => 'granted',
    async *entries() {
      for (const entry of Object.entries(entries)) {
        yield entry;
      }
    },
  } as unknown as FileSystemDirectoryHandle;
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

  it('matches workspace roots by ordered ids before applying async tree results', () => {
    expect(workspaceRootsMatch(roots, roots)).toBe(true);
    expect(workspaceRootsMatch(roots.slice(1), roots)).toBe(false);
    expect(workspaceRootsMatch([roots[1], roots[0]], roots)).toBe(false);
  });

  it('emits partial workspace trees while rebuilding selected roots', async () => {
    const existingRoot: WorkspaceRoot = {
      id: 'existing-root',
      label: 'existing',
      handle: mockDirectory({}) as FileSystemDirectoryHandle,
    };
    const newRoot: WorkspaceRoot = {
      id: 'new-root',
      label: 'new',
      handle: mockDirectory({
        src: mockDirectory({ 'App.tsx': mockFile() } as Record<string, MockHandle>) as unknown as MockHandle,
        'README.md': mockFile(),
      }),
    };
    const initialTree: FileNode[] = [
      {
        name: 'existing',
        path: 'existing',
        type: 'directory',
        handle: existingRoot.handle,
        workspaceRootId: existingRoot.id,
        workspaceLabel: existingRoot.label,
        relativePath: '',
        isWorkspaceRoot: true,
        children: [
          {
            name: 'old.txt',
            path: 'existing/old.txt',
            type: 'file',
            handle: mockFile() as unknown as FileSystemFileHandle,
            workspaceRootId: existingRoot.id,
            workspaceLabel: existingRoot.label,
            relativePath: 'old.txt',
            isWorkspaceRoot: false,
          },
        ],
      },
    ];
    const progressTrees: FileNode[][] = [];

    const tree = await buildWorkspaceTree([existingRoot, newRoot], {
      initialTree,
      rebuildRootIds: [newRoot.id],
      onProgress: (progressTree) => progressTrees.push(progressTree),
    });

    expect(progressTrees.length).toBeGreaterThan(1);
    expect(progressTrees[0].find((node) => node.workspaceRootId === existingRoot.id)?.children?.[0]?.name).toBe('old.txt');
    expect(progressTrees[0].find((node) => node.workspaceRootId === newRoot.id)?.children).toEqual([]);
    expect(progressTrees.some((progressTree) => {
      const nextRoot = progressTree.find((node) => node.workspaceRootId === newRoot.id);
      return nextRoot?.children?.some((child) => child.name === 'src');
    })).toBe(true);
    expect(tree.find((node) => node.workspaceRootId === existingRoot.id)?.children?.[0]?.name).toBe('old.txt');
    expect(tree.find((node) => node.workspaceRootId === newRoot.id)?.children?.map((child) => child.name)).toEqual([
      'src',
      'README.md',
    ]);
  });
});
