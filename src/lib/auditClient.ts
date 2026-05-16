import { getChatPersistenceMode } from '@/lib/chatPersistence';
import type { ChatMode, FileNode, WorkspaceRoot } from '@/types';

type WorkspaceAuditEvent = 'open' | 'refresh' | 'folder_remove' | 'clear' | 'context_update';

type WorkspaceAuditPayload = {
  event: WorkspaceAuditEvent;
  chatId?: string | null;
  chatTitle?: string | null;
  chatMode?: ChatMode | null;
  workspaceFolders: string[];
  contextFiles?: string[];
  activeFilePath?: string | null;
  addedFolder?: string | null;
  removedFolder?: string | null;
  changedPath?: string | null;
  changeKind?: 'add' | 'remove' | 'clear' | null;
  trigger?: string | null;
  workspaceRootSummaries?: Array<{
    label: string;
    opaqueLabel: boolean;
    topLevelEntries: string[];
  }>;
  activeDocument?: {
    path: string;
    fileName: string;
    folderPath: string | null;
    workspaceFolder: string | null;
  } | null;
};

function looksOpaqueWorkspaceLabel(label: string): boolean {
  const trimmed = label.trim();
  return /^\d{4}-\d{2}-\d{2}t\d{2}[-:]\d{2}[-:]\d{2}/i.test(trimmed)
    || /^[a-f0-9]{8,}$/i.test(trimmed)
    || /^[a-f0-9-]{24,}$/i.test(trimmed);
}

function normalizeAuditStrings(values: Array<string | null | undefined>, maxItems: number, maxLength: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const next = value?.trim();
    if (!next) continue;
    const clipped = next.slice(0, maxLength);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    normalized.push(clipped);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

export function workspaceFolderLabels(workspaceRoots: WorkspaceRoot[]): string[] {
  return normalizeAuditStrings(
    workspaceRoots.map((root) => root.label),
    50,
    240,
  );
}

export function normalizeAuditPaths(values: Array<string | null | undefined>, maxItems = 100): string[] {
  return normalizeAuditStrings(values, maxItems, 1000);
}

export function buildWorkspaceRootSummaries(
  workspaceRoots: WorkspaceRoot[],
  fileTree: FileNode[],
): Array<{ label: string; opaqueLabel: boolean; topLevelEntries: string[] }> {
  return workspaceRoots.map((root) => {
    const rootNode = fileTree.find((node) => node.workspaceRootId === root.id || node.path === root.label);
    const topLevelEntries = normalizeAuditStrings(
      (rootNode?.children ?? []).map((child) => child.name),
      6,
      120,
    );
    return {
      label: root.label,
      opaqueLabel: looksOpaqueWorkspaceLabel(root.label),
      topLevelEntries,
    };
  });
}

export function buildActiveDocumentAudit(path: string | null | undefined) {
  const normalized = path?.trim();
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return {
    path: normalized.slice(0, 1000),
    fileName: (parts[parts.length - 1] ?? '').slice(0, 240),
    folderPath: (parts.length > 1 ? parts.slice(0, -1).join('/') : null)?.slice(0, 1000) ?? null,
    workspaceFolder: (parts[0] ?? null)?.slice(0, 240) ?? null,
  };
}

export async function postWorkspaceAuditEvent(payload: WorkspaceAuditPayload): Promise<void> {
  if (getChatPersistenceMode() !== 'server') return;
  try {
    await fetch('/api/audit/workspace', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        workspaceFolders: normalizeAuditStrings(payload.workspaceFolders, 50, 240),
        contextFiles: normalizeAuditPaths(payload.contextFiles ?? [], 100),
        activeFilePath: payload.activeFilePath?.slice(0, 1000) ?? null,
        addedFolder: payload.addedFolder?.slice(0, 240) ?? null,
        removedFolder: payload.removedFolder?.slice(0, 240) ?? null,
        changedPath: payload.changedPath?.slice(0, 1000) ?? null,
        chatTitle: payload.chatTitle?.slice(0, 500) ?? null,
        trigger: payload.trigger?.slice(0, 120) ?? null,
        workspaceRootSummaries: payload.workspaceRootSummaries?.slice(0, 50).map((item) => ({
          label: item.label.slice(0, 240),
          opaqueLabel: item.opaqueLabel,
          topLevelEntries: normalizeAuditStrings(item.topLevelEntries, 6, 120),
        })) ?? [],
        activeDocument: payload.activeDocument
          ? {
              path: payload.activeDocument.path.slice(0, 1000),
              fileName: payload.activeDocument.fileName.slice(0, 240),
              folderPath: payload.activeDocument.folderPath?.slice(0, 1000) ?? null,
              workspaceFolder: payload.activeDocument.workspaceFolder?.slice(0, 240) ?? null,
            }
          : null,
      }),
    });
  } catch {
    /* optional audit */
  }
}
