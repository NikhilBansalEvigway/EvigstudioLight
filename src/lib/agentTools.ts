import {
  deleteWorkspacePath,
  listWorkspaceDirectoryContents,
  readWorkspaceFile,
  renameWorkspacePath,
  resolveWorkspacePath,
  workspaceFileExists,
  writeWorkspaceFile,
  writeWorkspaceFileVerified,
} from '@/lib/fsWorkspace';
import type { WorkspaceRoot } from '@/types';

export interface AgentAction {
  type: 'read' | 'edit' | 'write' | 'delete' | 'rename' | 'list';
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
  editFiles: { path: string; search: string; replace: string }[];
  writeFiles: { path: string; content: string }[];
  deletePaths: string[];
  renamePaths: { oldPath: string; newPath: string }[];
};

const READ_RE = /^\s*\*\*\*\s*Read File:\s*(.+)$/gim;
const LIST_RE = /^\s*\*\*\*\s*List Directory:\s*(.+)$/gim;
const DELETE_RE = /^\s*\*\*\*\s*Delete Path:\s*(.+)$/gim;
const RENAME_RE = /^\s*\*\*\*\s*Rename File:\s*(.+?)\s*->\s*(.+)$/gim;
const WRITE_RE = /^\s*\*\*\*\s*Write File:\s*(.+)$/gim;

function looksLikePathLabel(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (trimmed.includes('```')) return false;
  return /^(?:[A-Za-z]:)?[\w.@~/-]+\.[A-Za-z0-9]+$/.test(trimmed);
}

export function sanitizeWrittenFileContent(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '');
  const trimmed = normalized.trim();
  if (!trimmed) return '';

  const fencedOnly = trimmed.match(/^```[^\n`]*\n([\s\S]*?)\n```$/);
  if (fencedOnly) {
    return fencedOnly[1] ?? '';
  }

  const lines = normalized.split(/\r?\n/);
  if (lines.length >= 3 && looksLikePathLabel(lines[0]) && /^```[^\n`]*\s*$/.test(lines[1].trim())) {
    const endFenceIndex = lines.findIndex((line, index) => index > 1 && line.trim() === '```');
    if (endFenceIndex > 1) {
      return lines.slice(2, endFenceIndex).join('\n');
    }
  }

  return content;
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(search, index)) !== -1) {
    count += 1;
    index += search.length;
  }
  return count;
}

/**
 * Strip leaked model artifacts that get appended to a tool path on the same line —
 * most commonly harmony channel routing (`<|channel|>commentary to=functions.edit`,
 * `***commentary to=…`) when the stream is noisy. A real workspace path never
 * contains `<|`, a second `***` marker, ` to=…`, or a bare channel name, so we cut
 * the path at the first such token. This keeps file edits/reads working even when
 * the model's tool line is polluted (the root cause of "Edited … failed" badges).
 */
export function stripLeakedToolArtifacts(value: string): string {
  return value
    // A channel-name remnant with its routing, e.g. "build.js commentary to=functions.edit".
    .replace(/\s+(?:commentary|analysis|final)\s+to=[\s\S]*$/i, '')
    // Harmony recipient routing on its own, e.g. "build.js to=functions.edit".
    .replace(/\s+to=[\s\S]*$/i, '')
    // A second '***' tool marker glued on, e.g. "build.js ***commentary to=".
    .replace(/\s*\*\*\*[\s\S]*$/, '')
    // Any harmony control token (<|channel|>, <|message|>, …) onward.
    .replace(/<\|[\s\S]*$/, '')
    .trim();
}

function normalizeToolPath(raw: string): string {
  let p = raw.trim();
  p = stripLeakedToolArtifacts(p);
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
  // Strip leaked channel/marker tokens first so a polluted tail can't hide the #L range.
  const trimmed = stripLeakedToolArtifacts(raw.trim()).replace(/^[`'"]+|[`'"]+$/g, '');
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
  const editFiles: { path: string; search: string; replace: string }[] = [];
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
    if (!listDirs.includes(p)) listDirs.push(p);
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

  // Edit File blocks: exact one-occurrence search/replace against current file contents.
  const editBlockRe =
    /^\s*\*\*\*\s*Edit File:\s*(.+)\r?\n\s*\*\*\*\s*Begin Search\r?\n([\s\S]*?)\r?\n\s*\*\*\*\s*End Search\r?\n\s*\*\*\*\s*Begin Replace\r?\n([\s\S]*?)\r?\n\s*\*\*\*\s*End Replace/gim;
  editBlockRe.lastIndex = 0;
  while ((m = editBlockRe.exec(text)) !== null) {
    const p = normalizeToolPath(m[1] ?? '');
    const search = m[2] ?? '';
    const replace = m[3] ?? '';
    if (p && search) editFiles.push({ path: p, search, replace });
  }

  const writeBlockRe =
    /^\s*\*\*\*\s*Write File:\s*(.+)\r?\n([\s\S]*?)\r?\n\s*\*\*\*\s*End Write/gim;
  writeBlockRe.lastIndex = 0;
  while ((m = writeBlockRe.exec(text)) !== null) {
    const p = normalizeToolPath(m[1] ?? '');
    const content = m[2] ?? '';
    if (p) writeFiles.push({ path: p, content });
  }

  return { readFiles, listDirs, editFiles, writeFiles, deletePaths, renamePaths };
}

export function hasAgentTools(t: ParsedAgentTools): boolean {
  return (
    t.readFiles.length > 0 ||
    t.listDirs.length > 0 ||
    t.editFiles.length > 0 ||
    t.writeFiles.length > 0 ||
    t.deletePaths.length > 0 ||
    t.renamePaths.length > 0
  );
}

export function hasMutationTools(t: ParsedAgentTools): boolean {
  return t.editFiles.length > 0 || t.writeFiles.length > 0 || t.deletePaths.length > 0 || t.renamePaths.length > 0;
}

/** Only read/list tools that need a follow-up turn (not mutating ops). */
export function hasGatherTools(t: ParsedAgentTools): boolean {
  return t.readFiles.length > 0 || t.listDirs.length > 0;
}

export function normalizeWorkspacePath(workspaceRoots: WorkspaceRoot[], path: string): string {
  try {
    return resolveWorkspacePath(workspaceRoots, path).workspacePath;
  } catch {
    return path;
  }
}

export interface AgentToolResult {
  textFeedback: string;
  actions: AgentAction[];
}

export interface AgentToolEvent {
  phase: 'start' | 'finish';
  action: AgentAction;
}

export interface ExecuteAgentToolsOptions {
  onFileWritten?: (path: string, content: string) => void;
  onPathDeleted?: (path: string) => void;
  onPathRenamed?: (oldPath: string, newPath: string) => void;
  onAction?: (event: AgentToolEvent) => void;
}

export async function executeAgentTools(
  workspaceRoots: WorkspaceRoot[],
  tools: ParsedAgentTools,
  options: ExecuteAgentToolsOptions = {},
): Promise<AgentToolResult> {
  const parts: string[] = [];
  const actions: AgentAction[] = [];

  for (const target of tools.readFiles) {
    const label = formatReadLabel(target);
    options.onAction?.({
      phase: 'start',
      action: { type: 'read', path: label, success: true },
    });
    try {
      const content = await readWorkspaceFile(workspaceRoots, target.path);
      parts.push(`### Read File: ${label}\n${formatReadChunk(target, content)}`);
      const action = { type: 'read', path: label, success: true } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Read File: ${label}\n(Error: could not read — ${msg})`);
      const action = { type: 'read', path: label, success: false, error: msg } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    }
  }

  for (const dir of tools.listDirs) {
    const label = dir || '.';
    options.onAction?.({
      phase: 'start',
      action: { type: 'list', path: label, success: true },
    });
    try {
      const entries = await listWorkspaceDirectoryContents(workspaceRoots, dir);
      parts.push(
        `### List Directory: ${dir || '(workspace root)'}\n${entries.length ? entries.join('\n') : '(empty)'}`,
      );
      const action = { type: 'list', path: label, success: true } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### List Directory: ${dir}\n(Error: ${msg})`);
      const action = { type: 'list', path: label, success: false, error: msg } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    }
  }

  for (const { path, search, replace } of tools.editFiles) {
    const normalizedPath = normalizeWorkspacePath(workspaceRoots, path);
    options.onAction?.({
      phase: 'start',
      action: { type: 'edit', path: normalizedPath, success: true },
    });
    try {
      const raw = await readWorkspaceFile(workspaceRoots, path);
      const current = raw.replace(/\r\n/g, '\n');
      const normalizedSearch = search.replace(/\r\n/g, '\n');
      const normalizedReplace = replace.replace(/\r\n/g, '\n');

      const matches = countOccurrences(current, normalizedSearch);
      if (matches === 0) {
        throw new Error('Search text was not found in the current file');
      }
      if (matches > 1) {
        throw new Error(`Search text matched ${matches} times; provide a more specific block`);
      }

      const next = current.replace(normalizedSearch, normalizedReplace);
      await writeWorkspaceFile(workspaceRoots, path, next);
      options.onFileWritten?.(path, next);
      parts.push(`### Edit File: ${path}\n(Edited successfully, replaced ${search.length} chars with ${replace.length} chars)`);
      const action = { type: 'edit', path: normalizedPath, success: true } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Edit File: ${path}\n(Error: ${msg})`);
      const action = { type: 'edit', path: normalizedPath, success: false, error: msg } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    }
  }

  for (const { path, content } of tools.writeFiles) {
    const normalizedPath = normalizeWorkspacePath(workspaceRoots, path);
    options.onAction?.({
      phase: 'start',
      action: { type: 'write', path: normalizedPath, success: true },
    });
    try {
      const sanitizedContent = sanitizeWrittenFileContent(content);
      const existedBefore = await workspaceFileExists(workspaceRoots, path);
      await writeWorkspaceFileVerified(workspaceRoots, path, sanitizedContent, { expectCreate: !existedBefore });
      options.onFileWritten?.(path, sanitizedContent);
      parts.push(`### Write File: ${path}\n(Written successfully, ${sanitizedContent.length} chars)`);
      const action = { type: 'write', path: normalizedPath, success: true } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Write File: ${path}\n(Error: ${msg})`);
      const action = { type: 'write', path: normalizedPath, success: false, error: msg } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    }
  }

  for (const path of tools.deletePaths) {
    const normalizedPath = normalizeWorkspacePath(workspaceRoots, path);
    options.onAction?.({
      phase: 'start',
      action: { type: 'delete', path: normalizedPath, success: true },
    });
    try {
      await deleteWorkspacePath(workspaceRoots, path);
      options.onPathDeleted?.(path);
      parts.push(`### Delete Path: ${path}\n(Deleted successfully)`);
      const action = { type: 'delete', path: normalizedPath, success: true } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Delete Path: ${path}\n(Error: ${msg})`);
      const action = { type: 'delete', path: normalizedPath, success: false, error: msg } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    }
  }

  for (const { oldPath, newPath } of tools.renamePaths) {
    const normalizedOldPath = normalizeWorkspacePath(workspaceRoots, oldPath);
    const normalizedNewPath = normalizeWorkspacePath(workspaceRoots, newPath);
    const normalizedPath = `${normalizedOldPath} -> ${normalizedNewPath}`;
    options.onAction?.({
      phase: 'start',
      action: { type: 'rename', path: normalizedPath, success: true },
    });
    try {
      await renameWorkspacePath(workspaceRoots, oldPath, newPath);
      options.onPathRenamed?.(oldPath, newPath);
      parts.push(`### Rename File: ${oldPath} -> ${newPath}\n(Renamed successfully)`);
      const action = { type: 'rename', path: normalizedPath, success: true } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      parts.push(`### Rename File: ${oldPath} -> ${newPath}\n(Error: ${msg})`);
      const action = { type: 'rename', path: normalizedPath, success: false, error: msg } satisfies AgentAction;
      actions.push(action);
      options.onAction?.({ phase: 'finish', action });
    }
  }

  return { textFeedback: parts.join('\n\n'), actions };
}

export function extractThinkingBlocks(text: string): { thinking: string; rest: string } {
  const thinkingParts: string[] = [];

  // Match any of the known thinking tag names (case-insensitive, closed or unclosed at EOF).
  const TAG = 'think(?:ing)?|reasoning|thought|reflection|internal_thought';
  const closedRe = new RegExp(`<(${TAG})>([\\s\\S]*?)<\\/\\1>`, 'gi');
  const openRe = new RegExp(`^<(${TAG})>([\\s\\S]*)$`, 'i');

  let rest = text.replace(closedRe, (_, _tag: string, content: string) => {
    const trimmed = content.trim();
    if (trimmed) thinkingParts.push(trimmed);
    return '';
  }).trim();

  // Handle a single unclosed opening tag — the model is still streaming its thought.
  const openMatch = openRe.exec(rest);
  if (openMatch) {
    const content = (openMatch[2] ?? '').trim();
    if (content) thinkingParts.push(content);
    rest = '';
  }

  return {
    thinking: thinkingParts.join('\n\n---\n\n'),
    rest,
  };
}

export function stripThinkingBlocks(text: string): string {
  return extractThinkingBlocks(text).rest;
}


export function stripChannelTokens(text: string): string {
  // Never touch content inside fenced or inline code — these tokens are only noise when they
  // leak into prose, and we must not corrupt code that legitimately contains "<|...|>".
  const protectedRe = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;
  return text
    .split(protectedRe)
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
      let r = part
        // Full "harmony" headers, e.g. "<|channel|>commentary to=commentary <|constrain|>json<|message|>".
        .replace(
          /<\|(?:channel|start|role|system|developer|user|assistant|tool)\|>[\s\S]*?<\|message\|>/gi,
          '',
        )
        // Harmony channel routing that leaked as plain text without its <|...|> wrappers,
        // e.g. "commentary to=functions.edit" or a bare "commentary to=" heading.
        .replace(/\b(?:commentary|analysis|final)\s+to=\S*/gi, ' ')
        .replace(/\bto=functions(?:\.\w+)+/gi, ' ')
        // Any remaining standalone harmony control token: <|message|>, <|end|>, <|return|>, <|call|>, <|constrain|>, …
        // Replace with a space so neighbouring words/markers keep a clean boundary instead of gluing together.
        .replace(/<\|[A-Za-z0-9_]+\|>/g, ' ')
        // Legacy half-delimited variants at line start: "<|channel>thought", "<channel|>", "<|assistant|>".
        .replace(/^\s*<\|[^>\n]{1,64}>\s*/gim, '')
        .replace(/^\s*<\|[^>\n]*\|>\s*/gim, '')
        .replace(/^\s*<[^>\n]*\|>\s*/gim, '');
      // Tidy the spacing introduced by inline token removal.
      r = r.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
      return r;
    })
    .join('');
}

export function normalizeToolMarkerLineBreaks(text: string): string {
  const ALL =
    'Edit File|Write File|Read File|List Directory|Delete Path|Rename File|' +
    'Begin Search|End Search|Begin Replace|End Replace|End Write|' +
    'Begin Patch|End Patch|Update File|Create File|Delete File';

  const THINK_TAG = 'think(?:ing)?|reasoning|thought|reflection|internal_thought';
  const thinkRe = new RegExp(
    `(<(?:${THINK_TAG})>[\\s\\S]*?<\\/(?:${THINK_TAG})>)`,
    'gi',
  );
  const parts = text.split(thinkRe);

  const normalize = (chunk: string): string => {
   
    let r = chunk.replace(
      new RegExp(`([^\\n])([ \\t]*\\*{3}[ \\t]*(?:${ALL})\\b)`, 'g'),
      (_, before, marker) => `${before}\n${marker.trimStart()}`,
    );
  
    r = r.replace(
      /(\*{3}[ \t]*(?:Begin Search|Begin Replace|Begin Patch))([^\n]+)/g,
      (_, marker, content) => `${marker}\n${content.trimStart()}`,
    );
    return r;
  };

  return parts
    .map((part, idx) => (idx % 2 === 1 ? part : normalize(part)))
    .join('');
}

export function stripToolMarkers(text: string): string {

  let cleaned = normalizeToolMarkerLineBreaks(text);


  cleaned = cleaned.replace(/^\s*\*\*\*\s*Read File:\s*.+$/gim, '');
  cleaned = cleaned.replace(/^\s*\*\*\*\s*List Directory:\s*.+$/gim, '');
  cleaned = cleaned.replace(/^\s*\*\*\*\s*Delete Path:\s*.+$/gim, '');
  cleaned = cleaned.replace(/^\s*\*\*\*\s*Rename File:\s*.+$/gim, '');
  cleaned = cleaned.replace(
    /^\s*\*\*\*\s*Edit File:\s*.+\r?\n[\s\S]*?\r?\n\s*\*\*\*\s*End Replace/gim,
    '',
  );
  cleaned = cleaned.replace(
    /^\s*\*\*\*\s*Write File:\s*.+\r?\n[\s\S]*?\r?\n\s*\*\*\*\s*End Write/gim,
    '',
  );
 
  cleaned = cleaned.replace(
    /^\s*\*\*\*\s*Begin Patch[\s\S]*?\*\*\*\s*End Patch/gim,
    '',
  );

 
  const openBlockIdx = cleaned.search(
    /^\s*\*\*\*\s*(Write File|Edit File|Begin Patch)[\s:]/m,
  );
  if (openBlockIdx !== -1) {
    cleaned = cleaned.slice(0, openBlockIdx).trim();
  }

  
  cleaned = cleaned.replace(
    /^\s*\*\*\*\s*(Begin Search|End Search|Begin Replace|End Replace|End Write|Begin Patch|End Patch|Update File|Create File|Delete File).*$/gim,
    '',
  );

  // Non-standard / leaked control markers the model sometimes emits, e.g. "*** Begin Write { ... }"
  // or "*** End commentary". Strip only the marker token and keep any content that followed it on the
  // same line so real code/JSON survives (and can be fenced downstream) instead of leaking as the marker.
  cleaned = cleaned.replace(/\*\*\*\s*(?:Begin|End)\s+[A-Za-z][A-Za-z ]*?(?=[\s:{[(]|$)/gim, '');

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function isLooseCodeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Markdown structure / prose markers are never treated as loose code.
  if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||!\[|\[[^\]]*\]\()/.test(t)) return false;
  if (/^(\*\*|__)/.test(t)) return false;
  if (/^https?:\/\//.test(t)) return false;

  const keywordLed =
    /^(import|export|const|let|var|function|class|interface|type|enum|return|public|private|protected|static|def|package|using|namespace|struct|template|#include|#define|@[A-Za-z]|async|await|throw|new|for|while|switch|case|else|if|}|\)|\/\/|\/\*)\b/.test(
      t,
    );
  const codePunct =
    /[{};]|=>|::|==|!=|<=|>=|\)\s*\{|<\/?[A-Za-z][\w-]*\s*\/?>|^[\w$.[\]]+\s*=\s*[^=]/.test(t);

  if (!keywordLed && !codePunct) return false;
  // A normal sentence (ends in . ! ? and carries no code punctuation) is prose, not code.
  if (/[.!?]$/.test(t) && !/[{};=()<>]/.test(t)) return false;
  return true;
}

function wrapLooseCodeInChunk(chunk: string): string {
  const lines = chunk.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isLooseCodeLine(lines[i])) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const run: string[] = [];
    let j = i;
    while (j < lines.length) {
      if (isLooseCodeLine(lines[j])) {
        run.push(lines[j]);
        j += 1;
        continue;
      }
      // Tolerate a single blank line inside a run when more code follows.
      if (lines[j].trim() === '' && j + 1 < lines.length && isLooseCodeLine(lines[j + 1])) {
        run.push(lines[j]);
        j += 1;
        continue;
      }
      break;
    }
    // Only wrap multi-line runs — a single code-ish line is more likely an inline mention in prose.
    if (run.length >= 2) {
      out.push('```', ...run, '```');
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out.join('\n');
}

/**
 * Best-effort recovery: wrap runs of clearly code-like lines that the model emitted *outside* of any
 * markdown fence (common when it produces non-standard tool/channel output) so they render inside a
 * code block instead of as broken prose. Deliberately conservative — existing fenced/inline code is
 * left untouched, and only multi-line runs whose every line carries a strong code signal are wrapped.
 */
export function wrapLooseCodeBlocks(text: string): string {
  const protectedRe = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;
  return text
    .split(protectedRe)
    .map((part, idx) => (idx % 2 === 1 ? part : wrapLooseCodeInChunk(part)))
    .join('');
}

/**
 * Repair malformed code fences before markdown rendering. Models sometimes emit
 * stray triple-backticks glued into the middle of a line (e.g. `<div> ``` <button>`).
 * CommonMark turns those into spurious inline-code spans, and {@link wrapLooseCodeBlocks}
 * mistakes the text between two stray fences for an already-fenced block and skips it —
 * so a big JSX/code blob leaks into the page as broken prose.
 *
 * We walk the lines tracking only *well-formed* fences (a line that is solely ```/```lang),
 * strip triple-backticks that are embedded mid-line outside any such fence, and finally
 * close an unbalanced fence so the remainder still renders as code rather than prose.
 */
export function repairCodeFences(text: string): string {
  const lines = text.split('\n');
  // A real fence line: optional indent, 3+ backticks, then an info string with no backticks.
  const isFenceLine = (line: string) => /^\s*`{3,}[^`]*$/.test(line);

  let inFence = false;
  let fenceLineCount = 0;
  const repaired = lines.map((line) => {
    if (isFenceLine(line)) {
      inFence = !inFence;
      fenceLineCount += 1;
      return line;
    }
    if (!inFence && /`{3,}/.test(line)) {
      // Noise triple-backticks embedded in a non-fence line — drop them so the
      // surrounding code can be recovered as a single block instead of inline spans.
      return line.replace(/`{3,}/g, '');
    }
    return line;
  });

  let result = repaired.join('\n');
  if (fenceLineCount % 2 === 1) {
    // A fence was opened but never closed; close it at the end.
    result += '\n```';
  }
  return result;
}
