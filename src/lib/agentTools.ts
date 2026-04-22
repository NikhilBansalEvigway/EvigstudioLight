import {
  listDirectoryContents,
  readFile,
  writeFile,
  deleteFileOrDir,
  renameFileOrDir,
} from '@/lib/fsWorkspace';

export interface AgentAction {
  type: 'read' | 'write' | 'delete' | 'rename' | 'list';
  path: string;
  success: boolean;
  error?: string;
}

export interface ReadTarget {
  path: string;
  startLine?: number;
  endLine?: number;
}

export type ParsedAgentTools = {
  readFiles: ReadTarget[];
  listDirs: string[];
  writeFiles: { path: string; content: string }[];
  deletePaths: string[];
  renamePaths: { oldPath: string; newPath: string }[];
};

const READ_RE = /^\s*\*\*\*\s*Read File:\s*(.+)$/gim;
const LIST_RE = /^\s*\*\*\*\s*List Directory:\s*(.+)$/gim;
const DELETE_RE = /^\s*\*\*\*\s*Delete Path:\s*(.+)$/gim;
const RENAME_RE = /^\s*\*\*\*\s*Rename File:\s*(.+?)\s*->\s*(.+)$/gim;
const WRITE_RE = /^\s*\*\*\*\s*Write File:\s*(.+)$/gim;

function normalizeToolPath(raw: string): string {
  let p = raw.trim();
  p = p.replace(/^[`'"]+|[`'"]+$/g, '');
  p = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (p === '.') p = '';
  return p;
}

function normalizeLineNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readTargetKey(target: ReadTarget): string {
  return `${target.path}:${target.startLine ?? ''}:${target.endLine ?? ''}`;
}

function parseReadTarget(raw: string): ReadTarget | null {
  const trimmed = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '');
  const match = trimmed.match(/^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/i);
  if (!match) return null;

  const path = normalizeToolPath(match[1] ?? '');
  if (!path) return null;

  const startLine = normalizeLineNumber(match[2]);
  const endLineRaw = normalizeLineNumber(match[3]);
  if (!startLine) {
    return { path };
  }

  return {
    path,
    startLine,
    endLine: endLineRaw && endLineRaw >= startLine ? endLineRaw : startLine,
  };
}

function formatReadLabel(target: ReadTarget): string {
  if (!target.startLine) return target.path;
  const endLine = target.endLine ?? target.startLine;
  return `${target.path}#L${target.startLine}-L${endLine}`;
}

function formatReadChunk(target: ReadTarget, content: string): string {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const maxLines = 220;
  const startLine = Math.min(Math.max(1, target.startLine ?? 1), totalLines);
  const requestedEnd = target.endLine ?? (startLine + maxLines - 1);
  const endLine = Math.max(startLine, Math.min(totalLines, requestedEnd));
  const visibleLines = lines.slice(startLine - 1, endLine);
  const numbered = visibleLines.map((line, index) => `${startLine + index}: ${line}`).join('\n');

  const notes = [`Showing lines ${startLine}-${endLine} of ${totalLines}.`];
  if (endLine < totalLines) {
    const nextEnd = Math.min(totalLines, endLine + maxLines);
    notes.push(`Continue with: *** Read File: ${target.path}#L${endLine + 1}-L${nextEnd}`);
  }
  if (startLine > 1) {
    const prevStart = Math.max(1, startLine - maxLines);
    notes.push(`Earlier lines: *** Read File: ${target.path}#L${prevStart}-L${startLine - 1}`);
  }

  return `${notes.join(' ')}\n\n\`\`\`\n${numbered}${numbered ? '\n' : ''}\`\`\``;
}

export function parseToolCalls(text: string): ParsedAgentTools {
  const readFiles: ReadTarget[] = [];
  const listDirs: string[] = [];
  const writeFiles: { path: string; content: string }[] = [];
  const deletePaths: string[] = [];
  const renamePaths: { oldPath: string; newPath: string }[] = [];

  let m: RegExpExecArray | null;

  READ_RE.lastIndex = 0;
  while ((m = READ_RE.exec(text)) !== null) {
    const target = parseReadTarget(m[1] ?? '');
    if (target && !readFiles.some((existing) => readTargetKey(existing) === readTargetKey(target))) {
      readFiles.push(target);
    }
  }

  LIST_RE.lastIndex = 0;
  while ((m = LIST_RE.exec(text)) !== null) {
    const p = normalizeToolPath(m[1] ?? '');
    if (p && !listDirs.includes(p)) listDirs.push(p);
  }

  DELETE_RE.lastIndex = 0;
  while ((m = DELETE_RE.exec(text)) !== null) {
    const p = normalizeToolPath(m[1] ?? '');
    if (p && !deletePaths.includes(p)) deletePaths.push(p);
  }

  RENAME_RE.lastIndex = 0;
  while ((m = RENAME_RE.exec(text)) !== null) {
    const oldPath = normalizeToolPath(m[1] ?? '');
    const newPath = normalizeToolPath(m[2] ?? '');
    if (oldPath && newPath) renamePaths.push({ oldPath, newPath });
  }

  // Write File blocks: *** Write File: path\n...content...\n*** End Write
  const writeBlockRe =
    /^\s*\*\*\*\s*Write File:\s*(.+)\r?\n([\s\S]*?)\r?\n\s*\*\*\*\s*End Write/gim;
  writeBlockRe.lastIndex = 0;
  while ((m = writeBlockRe.exec(text)) !== null) {
    const p = normalizeToolPath(m[1] ?? '');
    const content = m[2] ?? '';
    if (p) writeFiles.push({ path: p, content });
  }

  return { readFiles, listDirs, writeFiles, deletePaths, renamePaths };
}

export function hasAgentTools(t: ParsedAgentTools): boolean {
  return (
    t.readFiles.length > 0 ||
    t.listDirs.length > 0 ||
    t.writeFiles.length > 0 ||
    t.deletePaths.length > 0 ||
    t.renamePaths.length > 0
  );
}

/** Only read/list tools that need a follow-up turn (not mutating ops). */
export function hasGatherTools(t: ParsedAgentTools): boolean {
  return t.readFiles.length > 0 || t.listDirs.length > 0;
}

export interface AgentToolResult {
  textFeedback: string;
  actions: AgentAction[];
}

export async function executeAgentTools(
  workspaceHandle: FileSystemDirectoryHandle,
  tools: ParsedAgentTools,
): Promise<AgentToolResult> {
  const parts: string[] = [];
  const actions: AgentAction[] = [];

  for (const target of tools.readFiles) {
    const label = formatReadLabel(target);
    try {
      const content = await readFile(workspaceHandle, target.path);
      parts.push(`### Read File: ${label}\n${formatReadChunk(target, content)}`);
      actions.push({ type: 'read', path: label, success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Read File: ${label}\n(Error: could not read — ${msg})`);
      actions.push({ type: 'read', path: label, success: false, error: msg });
    }
  }

  for (const dir of tools.listDirs) {
    try {
      const entries = await listDirectoryContents(workspaceHandle, dir);
      parts.push(
        `### List Directory: ${dir || '(workspace root)'}\n${entries.length ? entries.join('\n') : '(empty)'}`,
      );
      actions.push({ type: 'list', path: dir || '.', success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### List Directory: ${dir}\n(Error: ${msg})`);
      actions.push({ type: 'list', path: dir || '.', success: false, error: msg });
    }
  }

  for (const { path, content } of tools.writeFiles) {
    try {
      await writeFile(workspaceHandle, path, content);
      parts.push(`### Write File: ${path}\n(Written successfully, ${content.length} chars)`);
      actions.push({ type: 'write', path, success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Write File: ${path}\n(Error: ${msg})`);
      actions.push({ type: 'write', path, success: false, error: msg });
    }
  }

  for (const path of tools.deletePaths) {
    try {
      await deleteFileOrDir(workspaceHandle, path);
      parts.push(`### Delete Path: ${path}\n(Deleted successfully)`);
      actions.push({ type: 'delete', path, success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Delete Path: ${path}\n(Error: ${msg})`);
      actions.push({ type: 'delete', path, success: false, error: msg });
    }
  }

  for (const { oldPath, newPath } of tools.renamePaths) {
    try {
      await renameFileOrDir(workspaceHandle, oldPath, newPath);
      parts.push(`### Rename File: ${oldPath} -> ${newPath}\n(Renamed successfully)`);
      actions.push({ type: 'rename', path: `${oldPath} -> ${newPath}`, success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Rename File: ${oldPath} -> ${newPath}\n(Error: ${msg})`);
      actions.push({ type: 'rename', path: `${oldPath} -> ${newPath}`, success: false, error: msg });
    }
  }

  return { textFeedback: parts.join('\n\n'), actions };
}

/** Strip <think>...</think> blocks emitted by reasoning models. */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Strip agent tool markers from displayed text so users see clean output. */
export function stripToolMarkers(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/^\s*\*\*\*\s*Read File:\s*.+$/gim, '');
  cleaned = cleaned.replace(/^\s*\*\*\*\s*List Directory:\s*.+$/gim, '');
  cleaned = cleaned.replace(/^\s*\*\*\*\s*Delete Path:\s*.+$/gim, '');
  cleaned = cleaned.replace(/^\s*\*\*\*\s*Rename File:\s*.+$/gim, '');
  cleaned = cleaned.replace(
    /^\s*\*\*\*\s*Write File:\s*.+\r?\n[\s\S]*?\r?\n\s*\*\*\*\s*End Write/gim,
    '',
  );
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}
