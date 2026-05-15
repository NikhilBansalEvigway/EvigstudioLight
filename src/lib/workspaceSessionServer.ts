import type {
  PersistedWorkspaceRoot,
  WorkspaceRoot,
  WorkspaceSession,
  WorkspaceSessionServerSnapshot,
} from '@/types';
import { isUploadBackedWorkspaceRoot } from '@/lib/uploadedWorkspace';

const MAX_TABS = 25;
const MAX_TAB_CHARS = 200_000;

export function buildWorkspaceSessionServerSnapshot(state: {
  workspaceRoots: WorkspaceRoot[];
  openEditorTabs: Array<{ path: string; content: string; savedContent: string }>;
  activeFilePath: string | null;
  contextFiles: string[];
}): WorkspaceSessionServerSnapshot {
  const tabs = state.openEditorTabs.slice(-MAX_TABS).map((tab) => ({
    path: tab.path,
    content:
      tab.content.length > MAX_TAB_CHARS
        ? `${tab.content.slice(0, MAX_TAB_CHARS)}\n\n… [truncated]`
        : tab.content,
    savedContent:
      tab.savedContent.length > MAX_TAB_CHARS
        ? `${tab.savedContent.slice(0, MAX_TAB_CHARS)}\n\n… [truncated]`
        : tab.savedContent,
  }));

  const workspaceRoots = state.workspaceRoots.map((root) => {
    if (isUploadBackedWorkspaceRoot(root)) {
      return {
        id: root.id,
        label: root.label,
        source: 'upload' as const,
        uploadedPaths: root.uploadedFiles?.size ? [...root.uploadedFiles.keys()] : undefined,
        contentOverlayKeys: root.contentOverlay?.size ? [...root.contentOverlay.keys()] : undefined,
        virtualEmptyDirs: root.virtualEmptyDirs?.size ? [...root.virtualEmptyDirs] : undefined,
      };
    }
    return {
      id: root.id,
      label: root.label,
      source: 'native' as const,
    };
  });

  return {
    updatedAt: Date.now(),
    workspaceRoots,
    openEditorTabs: tabs,
    activeFilePath: state.activeFilePath,
    contextFiles: state.contextFiles,
  };
}

/**
 * Convert a Postgres-backed snapshot into local session storage shape.
 * Roots have no handles or uploaded `File` entries until the user reconnects or re-uploads.
 */
export function workspaceSessionFromServerSnapshot(
  snapshot: WorkspaceSessionServerSnapshot,
  chatId: string,
): WorkspaceSession {
  const workspaceRoots: PersistedWorkspaceRoot[] = snapshot.workspaceRoots.map((r) => ({
    id: r.id,
    label: r.label,
    handle: null,
  }));

  return {
    chatId,
    updatedAt: snapshot.updatedAt,
    workspaceRoots,
    openEditorTabs: snapshot.openEditorTabs ?? [],
    activeFilePath: snapshot.activeFilePath ?? null,
    contextFiles: snapshot.contextFiles ?? [],
  };
}
