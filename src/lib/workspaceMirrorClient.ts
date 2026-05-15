const STATUS_CACHE_MS = 15_000;
const TOKEN_STORAGE_KEY = 'evigstudio_workspace_mirror_token';

let statusCache: { at: number; value: WorkspaceMirrorStatus | null } = { at: 0, value: null };

export type WorkspaceMirrorStatus = {
  enabled: boolean;
  requiresToken: boolean;
};

export function getWorkspaceMirrorToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? '';
}

export function setWorkspaceMirrorToken(token: string): void {
  if (typeof localStorage === 'undefined') return;
  const t = token.trim();
  if (!t) localStorage.removeItem(TOKEN_STORAGE_KEY);
  else localStorage.setItem(TOKEN_STORAGE_KEY, t);
}

export function invalidateWorkspaceMirrorStatusCache(): void {
  statusCache = { at: 0, value: null };
}

export async function fetchWorkspaceMirrorStatus(): Promise<WorkspaceMirrorStatus> {
  const now = Date.now();
  if (statusCache.value && now - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value;
  }
  try {
    const r = await fetch('/api/workspace-mirror/status', { credentials: 'include' });
    if (!r.ok) {
      const next = { enabled: false, requiresToken: false };
      statusCache = { at: now, value: next };
      return next;
    }
    const data = (await r.json()) as Partial<WorkspaceMirrorStatus>;
    const next: WorkspaceMirrorStatus = {
      enabled: data.enabled === true,
      requiresToken: data.requiresToken === true,
    };
    statusCache = { at: now, value: next };
    return next;
  } catch {
    const next = { enabled: false, requiresToken: false };
    statusCache = { at: now, value: next };
    return next;
  }
}

/**
 * Writes one file to the host path configured on the API (`LOCAL_WORKSPACE_MIRROR_ROOT`).
 * Used when the browser cannot link a folder (Firefox): saves sync to disk in real time via the server.
 */
export async function tryWriteWorkspaceMirrorFile(
  rootLabel: string,
  relativePath: string,
  content: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const status = await fetchWorkspaceMirrorStatus();
  if (!status.enabled) return { ok: false, reason: 'mirror_disabled' };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tok = getWorkspaceMirrorToken();
  if (tok) headers['X-Evig-Local-Mirror-Token'] = tok;

  try {
    const r = await fetch('/api/workspace-mirror/file', {
      method: 'PUT',
      credentials: 'include',
      headers,
      body: JSON.stringify({ rootLabel, relativePath, content }),
    });
    if (r.ok) return { ok: true };
    if (r.status === 401) return { ok: false, reason: 'unauthorized' };
    if (r.status === 404) return { ok: false, reason: 'mirror_disabled' };
    return { ok: false, reason: `http_${r.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'network_error' };
  }
}
