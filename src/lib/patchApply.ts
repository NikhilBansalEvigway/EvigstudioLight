import type { ParsedPatch } from '@/types';
import { stripLeakedToolArtifacts } from '@/lib/agentTools';

const OP_FROM_HEADER: Record<string, ParsedPatch['operation']> = {
  'Update File': 'update',
  'Create File': 'create',
  'Delete File': 'delete',
};

/** Normalize first line of a patch (path) from various model quirks. */
export function normalizePatchFilePath(raw: string): string {
  // Strip leaked harmony/channel tokens (e.g. "package.json ***commentary to=*** End Commentary")
  // before they reach getFileHandle, which rejects names containing spaces/markers.
  let p = stripLeakedToolArtifacts(raw.trim());
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
  let match: RegExpExecArray | null;

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

function normalizeLineForCompare(line: string): string {
  return line.trimEnd();
}

function linesMatch(a: string, b: string): boolean {
  return normalizeLineForCompare(a) === normalizeLineForCompare(b);
}

function hunkContextLines(hunkLines: string[]): Array<{ text: string; idx: number }> {
  const result: Array<{ text: string; idx: number }> = [];
  for (let i = 0; i < hunkLines.length; i++) {
    const l = hunkLines[i];
    if (l.startsWith(' ') || l.startsWith('-')) {
      result.push({ text: l.slice(1), idx: i });
    }
  }
  return result;
}

function findFuzzOffset(
  origLines: string[],
  origIdx: number,
  hunkLines: string[],
  fuzz: number = 6,
): number {
  const ctxLines = hunkContextLines(hunkLines);
  if (ctxLines.length === 0) return 0;

  const scoreAt = (delta: number): number => {
    let matched = 0;
    let pos = origIdx + delta;
    for (const { text } of ctxLines) {
      if (pos >= 0 && pos < origLines.length && linesMatch(origLines[pos], text)) matched++;
      pos++;
    }
    return matched;
  };

  const perfectScore = ctxLines.length;
  const baseScore = scoreAt(0);
  if (baseScore === perfectScore) return 0;

  let bestDelta = 0;
  let bestScore = baseScore;
  for (let d = -fuzz; d <= fuzz; d++) {
    if (d === 0) continue;
    const s = scoreAt(d);
    if (s > bestScore) {
      bestScore = s;
      bestDelta = d;
    }
  }
  return bestDelta;
}


function scanForward(origLines: string[], from: number, expected: string, window = 6): number {
  for (let k = from; k < Math.min(from + window, origLines.length); k++) {
    if (linesMatch(origLines[k], expected)) return k;
  }
  return -1;
}

function applyUnifiedDiff(originalContent: string, patchContent: string): string {
  const lines = patchContent.split(/\r?\n/);
  const origLines = originalContent.split(/\r?\n/);
  const result: string[] = [];
  let origIdx = 0;
  let i = 0;

  while (i < lines.length) {
    const header = lines[i].match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
    if (!header) { i++; continue; }

    const oldStart = Math.max(1, Number(header[1]));
    let targetOrigIdx = oldStart - 1;

   
    const hunkBody: string[] = [];
    for (let j = i + 1; j < lines.length && !/^@@/.test(lines[j]); j++) {
      hunkBody.push(lines[j]);
    }

    const fuzzDelta = findFuzzOffset(origLines, targetOrigIdx, hunkBody);
  
    targetOrigIdx = Math.max(origIdx, targetOrigIdx + fuzzDelta);

    while (origIdx < targetOrigIdx && origIdx < origLines.length) {
      result.push(origLines[origIdx++]);
    }

    i++;
    while (i < lines.length && !/^@@/.test(lines[i])) {
      const line = lines[i];

      if (line.startsWith('+')) {
        result.push(line.slice(1));
      } else if (line.startsWith('-')) {
        const expected = line.slice(1);
        if (origIdx < origLines.length) {
          if (linesMatch(origLines[origIdx], expected)) {
            origIdx++; // consume the removed line
          } else {
            // Scan ahead: maybe there's a blank line or minor shift between here and the target
            const found = scanForward(origLines, origIdx + 1, expected);
            if (found >= 0) {
              // Keep lines we skipped (they weren't in the hunk, so preserve them)
              while (origIdx < found) result.push(origLines[origIdx++]);
              origIdx++; // consume the matched removal
            } else {
              throw new Error(`Patch removal mismatch at line ${origIdx + 1}`);
            }
          }
        }
      } else if (line.startsWith(' ')) {
        // Context line — must exist in orig
        const expected = line.slice(1);
        if (origIdx < origLines.length) {
          if (linesMatch(origLines[origIdx], expected)) {
            result.push(origLines[origIdx++]);
          } else {
            const found = scanForward(origLines, origIdx + 1, expected);
            if (found >= 0) {
              while (origIdx < found) result.push(origLines[origIdx++]);
              result.push(origLines[origIdx++]);
            } else {
              throw new Error(`Patch context mismatch at line ${origIdx + 1}`);
            }
          }
        }
      } else if (line === '' || line === '\\ No newline at end of file') {
        
        if (line === '' && origIdx < origLines.length && origLines[origIdx].trim() === '') {
          result.push(origLines[origIdx++]);
        }
        // else: blank diff line with no matching blank orig line — silently skip
      } else {
        
        if (origIdx < origLines.length && linesMatch(origLines[origIdx], line)) {
          result.push(origLines[origIdx++]);
        } else {
          result.push(line);
        }
      }

      i++;
    }
  }

  while (origIdx < origLines.length) {
    result.push(origLines[origIdx++]);
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
