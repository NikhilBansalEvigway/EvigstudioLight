import { describe, expect, it } from 'vitest';
import {
  createUploadedWorkspaceRootsFromFiles,
  isNativeDiskStubRoot,
  isUploadBackedWorkspaceRoot,
  normalizeUploadedFolderFilesToGroups,
} from '@/lib/uploadedWorkspace';
import type { WorkspaceRoot } from '@/types';

function fileWithRelativePath(name: string, webkitRelativePath: string): File {
  const f = new File(['x'], name, { type: 'text/plain' });
  Object.defineProperty(f, 'webkitRelativePath', { value: webkitRelativePath, configurable: true });
  return f;
}

describe('normalizeUploadedFolderFilesToGroups', () => {
  it('returns a single group for one folder tree', () => {
    const files = [
      fileWithRelativePath('a.ts', 'my-app/src/a.ts'),
      fileWithRelativePath('b.ts', 'my-app/src/b.ts'),
    ];
    const groups = normalizeUploadedFolderFilesToGroups(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].labelBase).toBe('my-app');
    expect(groups[0].relPaths.has('src/a.ts')).toBe(true);
  });

  it('splits multiple top-level folders into separate groups', () => {
    const files = [
      fileWithRelativePath('a.ts', 'frontend/src/a.ts'),
      fileWithRelativePath('b.ts', 'backend/src/b.ts'),
    ];
    const groups = normalizeUploadedFolderFilesToGroups(files);
    expect(groups).toHaveLength(2);
    const bases = groups.map((g) => g.labelBase).sort();
    expect(bases).toEqual(['backend', 'frontend']);
  });
});

describe('isNativeDiskStubRoot', () => {
  it('is true only when there is no handle and no upload map', () => {
    const nativeStub = { id: 'a', label: 'x', handle: null } as WorkspaceRoot;
    const upload = {
      id: 'b',
      label: 'y',
      handle: null,
      uploadedFiles: new Map([['f', new File([], 'f')]]),
    } as WorkspaceRoot;
    const native: WorkspaceRoot = { id: 'c', label: 'z', handle: {} as WorkspaceRoot['handle'] };

    expect(isNativeDiskStubRoot(nativeStub)).toBe(true);
    expect(isUploadBackedWorkspaceRoot(upload)).toBe(true);
    expect(isNativeDiskStubRoot(upload)).toBe(false);
    expect(isNativeDiskStubRoot(native)).toBe(false);
  });
});

describe('createUploadedWorkspaceRootsFromFiles', () => {
  it('creates distinct roots for multiple top-level folders', () => {
    const files = [
      fileWithRelativePath('a.ts', 'frontend/src/a.ts'),
      fileWithRelativePath('b.ts', 'backend/src/b.ts'),
    ];
    const roots = createUploadedWorkspaceRootsFromFiles(files, []);
    expect(roots).toHaveLength(2);
    const labels = roots.map((r) => r.label).sort();
    expect(labels).toEqual(['backend', 'frontend']);
  });

  it('dedupes labels against existing workspace roots', () => {
    const files = [fileWithRelativePath('a.ts', 'frontend/src/a.ts')];
    const roots = createUploadedWorkspaceRootsFromFiles(files, [{ label: 'frontend' }]);
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe('frontend (2)');
  });
});
