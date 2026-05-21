import { applyPatch } from '@/lib/patchApply';
import {
  deleteWorkspacePath,
  readWorkspaceFile,
  writeWorkspaceFile,
} from '@/lib/fsWorkspace';
import { useAppStore } from '@/store/useAppStore';
import type { ParsedPatch, WorkspaceRoot } from '@/types';

export async function applyPatchToWorkspace(roots: WorkspaceRoot[], patch: ParsedPatch): Promise<void> {
  if (roots.length === 0) throw new Error('No workspace folder open');

  const { filePath, operation = 'update' } = patch;

  if (operation === 'delete') {
    await deleteWorkspacePath(roots, filePath);
    useAppStore.getState().removeWorkspacePathReferences(filePath);
    return;
  }

  let original = '';
  try {
    original = await readWorkspaceFile(roots, filePath);
  } catch {
    /* new or missing file */
  }

  const result = applyPatch(original, patch);
  await writeWorkspaceFile(roots, filePath, result);
  useAppStore.getState().syncEditorFileContent(filePath, result);
}
