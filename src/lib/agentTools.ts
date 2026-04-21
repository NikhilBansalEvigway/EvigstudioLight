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

export type ParsedAgentTools = {
  readFiles: string[];
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

export function parseToolCalls(text: string): ParsedAgentTools {
  const readFiles: string[] = [];
  const listDirs: string[] = [];
  const writeFiles: { path: string; content: string }[] = [];
  const deletePaths: string[] = [];
  const renamePaths: { oldPath: string; newPath: string }[] = [];

  let m: RegExpExecArray | null;

  READ_RE.lastIndex = 0;
  while ((m = READ_RE.exec(text)) !== null) {
    const p = normalizeToolPath(m[1] ?? '');
    if (p && !readFiles.includes(p)) readFiles.push(p);
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

const MAX_FILE_CHARS = 2000;

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

  for (const path of tools.readFiles) {
    try {
      let content = await readFile(workspaceHandle, path);
      if (content.length > MAX_FILE_CHARS) {
        content =
          content.slice(0, MAX_FILE_CHARS) +
          `\n\n… [truncated, ${content.length} chars total]`;
      }
      parts.push(`### Read File: ${path}\n\`\`\`\n${content}\n\`\`\``);
      actions.push({ type: 'read', path, success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Read File: ${path}\n(Error: could not read — ${msg})`);
      actions.push({ type: 'read', path, success: false, error: msg });
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
      const newName = newPath.split('/').pop() ?? newPath;
      await renameFileOrDir(workspaceHandle, oldPath, newName);
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
