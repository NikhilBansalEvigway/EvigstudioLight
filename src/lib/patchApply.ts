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

/** True when the patch body looks like a unified diff (not a plain full-file dump). */
function isUnifiedDiffBody(content: string): boolean {
  if (!content.trim()) return false;
  const lines = content.split(/\r?\n/);
  if (lines.some((l) => l.trimStart().startsWith('@@'))) return true;
  const hasMinus = lines.some((l) => {
    const t = l.trimStart();
    return t.startsWith('-') && !t.startsWith('---');
  });
  if (hasMinus) return true;
  const hasPlus = lines.some((l) => {
    const t = l.trimStart();
    return t.startsWith('+') && !t.startsWith('+++');
  });
  return (
    hasPlus &&
    lines.some((l) => {
      const t = l.trimStart();
      return t.startsWith('-') && !t.startsWith('---');
    })
  );
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

  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith('@@')) continue;
    if (t.startsWith('-')) {
      origIdx++;
    } else if (t.startsWith('+')) {
      result.push(t.slice(1));
    } else if (t.startsWith(' ') && t.length > 1) {
      result.push(t.slice(1));
      origIdx++;
    } else if (line.trim() === '') {
      result.push('');
    } else {
      if (origIdx < origLines.length) {
        result.push(origLines[origIdx]);
        origIdx++;
      } else {
        result.push(line);
      }
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
 * - `update`: if body looks like unified diff, merge; else replace whole file (handles models that omit @@/-+).
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

  if (!isUnifiedDiffBody(content)) {
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
