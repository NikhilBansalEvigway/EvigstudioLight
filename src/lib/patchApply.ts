import type { ParsedPatch } from '@/types';

const OP_FROM_HEADER: Record<string, ParsedPatch['operation']> = {
  'Update File': 'update',
  'Create File': 'create',
  'Delete File': 'delete',
};

/** Normalize first line of a patch (path) from various model quirks. */
export function normalizePatchFilePath(raw: string): string {
  let p = raw.trim();
  p = p.replace(/^[`'"]+|[`'"]+$/g, '');
  p = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return p;
}

/**
 * Parse patch blocks from assistant response text.
 * Supports format:
 * ```diff
 * *** Begin Patch
 * *** Update File: path/to/file
 * ...changes...
 * *** End Patch
 * ```
 */
export function parsePatches(text: string): ParsedPatch[] {
  const patches: ParsedPatch[] = [];

  const patchRegex = /\*\*\*\s*Begin Patch([\s\S]*?)\*\*\*\s*End Patch/gim;
  let match;

  while ((match = patchRegex.exec(text)) !== null) {
    const block = match[1];
    const fileOps = block.split(/\*\*\*\s*(Update File|Create File|Delete File):\s*/i);

    for (let i = 1; i < fileOps.length; i += 2) {
      const action = fileOps[i];
      const rest = fileOps[i + 1];
      if (!rest) continue;

      const operation = OP_FROM_HEADER[action] ?? 'update';

      const lines = rest.split(/\r?\n/);
      const rawPath = lines[0]?.trim() ?? '';
      const filePath = normalizePatchFilePath(rawPath);
      const content = lines.slice(1).join('\n').trimEnd();

      if (filePath) {
        patches.push({ filePath, content, operation });
      }
    }
  }

  if (patches.length === 0) {
    const fenceRegex = /```(?:\w+)?\s*\r?\n([\s\S]*?)```/g;
    while ((match = fenceRegex.exec(text)) !== null) {
      const inner = match[1];
      if (/\*\*\*\s*Begin Patch/i.test(inner)) {
        patches.push(...parsePatches(inner));
      }
    }
  }

  // Last-resort: parse single-file operations even when Begin/End wrappers are missing.
  // Matches: *** Update File: path/to/file\n...body...\n*** Create File: other/path\n...body...
  if (patches.length === 0) {
    const inlineOpRegex =
      /\*\*\*\s*(Update File|Create File|Delete File):\s*([^\n\r]+)\s*\r?\n([\s\S]*?)(?=\r?\n\*\*\*\s*(?:Update File|Create File|Delete File):|\r?\n\*\*\*\s*End Patch|\r?\n\*\*\*\s*Begin Patch|$)/gi;
    while ((match = inlineOpRegex.exec(text)) !== null) {
      const action = match[1];
      const rawPath = match[2];
      const body = match[3] ?? '';
      const filePath = normalizePatchFilePath(rawPath);
      if (!filePath) continue;
      const operation = OP_FROM_HEADER[action] ?? 'update';
      patches.push({ filePath, content: body.trimEnd(), operation });
    }
  }

  return patches;
}

/** Existing-file updates must use real unified diff hunks. */
function hasUnifiedDiffHunks(content: string): boolean {
  if (!content.trim()) return false;
  return content.split(/\r?\n/).some((l) => l.trimStart().startsWith('@@'));
}

/** New file / “all additions” body: strip leading `+` / single space from diff-style lines. */
function stripDiffAdditions(content: string): string {
  const lines = content.split(/\r?\n/);
  return lines
    .map((l) => {
      const t = l.trimStart();
      if (t.startsWith('+')) return t.slice(1);
      if (t.startsWith(' ') && t.length > 1) return t.slice(1);
      return l;
    })
    .join('\n');
}

function applyUnifiedDiff(originalContent: string, patchContent: string): string {
  const lines = patchContent.split(/\r?\n/);
  const origLines = originalContent.split(/\r?\n/);
  const result: string[] = [];
  let origIdx = 0;
  let i = 0;

  while (i < lines.length) {
    const header = lines[i].match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
    if (!header) {
      i++;
      continue;
    }

    const oldStart = Math.max(1, Number(header[1]));
    const targetOrigIdx = oldStart - 1;

    while (origIdx < targetOrigIdx && origIdx < origLines.length) {
      result.push(origLines[origIdx]);
      origIdx++;
    }

    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i];

      if (line.startsWith(' ')) {
        const expected = line.slice(1);
        if (origLines[origIdx] !== expected) {
          throw new Error(`Patch context mismatch at line ${origIdx + 1}`);
        }
        result.push(expected);
        origIdx++;
      } else if (line.startsWith('-')) {
        const expected = line.slice(1);
        if (origLines[origIdx] !== expected) {
          throw new Error(`Patch removal mismatch at line ${origIdx + 1}`);
        }
        origIdx++;
      } else if (line.startsWith('+')) {
        result.push(line.slice(1));
      } else if (line === '\\ No newline at end of file') {
        // Ignore diff metadata line.
      } else if (line.trim() === '') {
        throw new Error('Invalid unified diff line: blank lines inside hunks must use a prefix');
      } else {
        throw new Error(`Invalid unified diff line: ${line}`);
      }

      i++;
    }
  }

  while (origIdx < origLines.length) {
    result.push(origLines[origIdx]);
    origIdx++;
  }

  return result.join('\n');
}

/**
 * Apply a patch to file content.
 * - `create`: write body (strip `+` lines if present).
 * - `update`: apply real unified diff hunks; reject unsafe whole-file replacements for existing files.
 */
export function applyPatch(originalContent: string, patch: ParsedPatch): string {
  const { content, operation = 'update' } = patch;
  const lines = content.split(/\r?\n/);

  if (operation === 'create') {
    const nonEmpty = lines.filter((l) => l.trim() !== '');
    const allAddOrSpace =
      nonEmpty.length === 0 ||
      nonEmpty.every((l) => {
        const t = l.trimStart();
        return t.startsWith('+') || (t.startsWith(' ') && t.length > 1);
      });
    if (allAddOrSpace && nonEmpty.some((l) => l.trimStart().startsWith('+'))) {
      return stripDiffAdditions(content);
    }
    return content;
  }

  if (operation === 'delete') {
    return '';
  }

  if (!content.trim() && originalContent.trim()) {
    return originalContent;
  }

  if (!hasUnifiedDiffHunks(content)) {
    const nonEmpty = lines.filter((l) => l.trim() !== '');
    const onlyPlusStyle =
      nonEmpty.length > 0 &&
      nonEmpty.every((l) => {
        const t = l.trimStart();
        return t.startsWith('+') || (t.startsWith(' ') && t.length > 1);
      });
    if (onlyPlusStyle && nonEmpty.some((l) => l.trimStart().startsWith('+'))) {
      return stripDiffAdditions(content);
    }

    if (originalContent.length > 0) {
      throw new Error('Unsafe update patch for existing file: use @@ hunks instead of full-file replacement');
    }

    return content;
  }

  return applyUnifiedDiff(originalContent, content);
}

/**
 * Check if a message contains patches
 */
export function containsPatches(text: string): boolean {
  if (!text) return false;
  return /\*\*\*\s*(Begin Patch|Update File|Create File|Delete File)/i.test(text);
}
