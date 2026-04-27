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

type CompareMode = 'exact' | 'trimEnd' | 'trim' | 'collapseWs';

function normalizeForCompare(line: string, mode: CompareMode): string {
  if (mode === 'trim') return line.trim();
  if (mode === 'trimEnd') return line.trimEnd();
  if (mode === 'collapseWs') return line.trim().replace(/\s+/g, ' ');
  return line;
}

function linesEqual(a: string, b: string, mode: CompareMode): boolean {
  return normalizeForCompare(a, mode) === normalizeForCompare(b, mode);
}

function findNeedleCandidates(opts: {
  haystack: string[];
  needle: string[];
  start: number;
  end: number;
  mode: CompareMode;
}): number[] {
  const { haystack, needle, mode } = opts;
  const start = Math.max(0, Math.min(haystack.length, opts.start));
  const end = Math.max(start, Math.min(haystack.length, opts.end));
  if (needle.length === 0) return [start];

  const maxIdx = end - needle.length;
  const out: number[] = [];
  for (let i = start; i <= maxIdx; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!linesEqual(haystack[i + j] ?? '', needle[j] ?? '', mode)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function pickBestCandidate(candidates: number[], hintIdx: number, mode: CompareMode): number {
  if (candidates.length === 0) throw new Error('No candidates');
  if (candidates.length === 1) return candidates[0];

  // Be conservative for whitespace-insensitive matching: if multiple places match, fail.
  if (mode === 'trim' || mode === 'collapseWs') {
    throw new Error('Ambiguous patch hunk location (multiple whitespace-insensitive matches)');
  }

  let best = candidates[0];
  let bestDist = Math.abs(best - hintIdx);
  for (let i = 1; i < candidates.length; i++) {
    const idx = candidates[i];
    const dist = Math.abs(idx - hintIdx);
    if (dist < bestDist) {
      best = idx;
      bestDist = dist;
    }
  }
  return best;
}

function extractHunkOldLines(hunkLines: string[]): string[] {
  const out: string[] = [];
  for (const line of hunkLines) {
    if (line.startsWith(' ') || line.startsWith('-')) out.push(line.slice(1));
  }
  return out;
}

function extractHunkNewLines(hunkLines: string[]): string[] {
  const out: string[] = [];
  for (const line of hunkLines) {
    if (line.startsWith(' ') || line.startsWith('+')) out.push(line.slice(1));
  }
  return out;
}

function locateNeedle(opts: {
  haystack: string[];
  needle: string[];
  minStart: number;
  hintIdx: number;
  mode: CompareMode;
}): number | null {
  const { haystack, needle, minStart, hintIdx, mode } = opts;
  const SEARCH_BACK = 80;
  const SEARCH_FWD = 220;

  const windowStart = Math.max(minStart, hintIdx - SEARCH_BACK);
  const windowEnd = Math.min(haystack.length, hintIdx + SEARCH_FWD);

  const windowCandidates = findNeedleCandidates({
    haystack,
    needle,
    start: windowStart,
    end: windowEnd,
    mode,
  });
  if (windowCandidates.length > 0) {
    try {
      return pickBestCandidate(windowCandidates, hintIdx, mode);
    } catch {
      // Ambiguous match for whitespace-insensitive modes.
      return null;
    }
  }

  const fullCandidates = findNeedleCandidates({
    haystack,
    needle,
    start: minStart,
    end: haystack.length,
    mode,
  });
  if (fullCandidates.length === 0) return null;
  if (fullCandidates.length === 1) return fullCandidates[0];

  try {
    return pickBestCandidate(fullCandidates, hintIdx, mode);
  } catch {
    return null;
  }
}

function applyUnifiedDiff(originalContent: string, patchContent: string): string {
  const lines = patchContent.split(/\r?\n/);
  const origLines = originalContent.split(/\r?\n/);
  const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
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

    i++;
    const hunkLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith('@@')) {
      hunkLines.push(lines[i]);
      i++;
    }

    const hintIdx = Math.max(origIdx, Math.min(origLines.length, oldStart - 1));
    const oldNeedle = extractHunkOldLines(hunkLines);
    const newNeedle = extractHunkNewLines(hunkLines);

    type HunkLocation = { startIdx: number; mode: CompareMode; status: 'apply' | 'already_applied' };

    const locateHunk = (): HunkLocation | null => {
      const modes: CompareMode[] = ['exact', 'trimEnd', 'trim', 'collapseWs'];

      // 1) Prefer locating by old content, but allow anchoring on a contiguous slice.
      // This helps when some removed lines differ (e.g. already edited) but surrounding lines still exist.
      const MAX_SLICE = 12;
      for (const mode of modes) {
        const n = oldNeedle.length;
        const maxLen = Math.min(MAX_SLICE, n);

        // Try longer slices first to reduce ambiguity.
        for (let len = maxLen; len >= 2; len--) {
          let best: { startIdx: number; dist: number } | null = null;
          for (let s = 0; s + len <= n; s++) {
            const slice = oldNeedle.slice(s, s + len);
            const sliceHint = hintIdx + s;
            const matchAt = locateNeedle({
              haystack: origLines,
              needle: slice,
              minStart: origIdx,
              hintIdx: sliceHint,
              mode,
            });
            if (matchAt == null) continue;
            const startIdx = matchAt - s;
            if (startIdx < origIdx) continue;
            const dist = Math.abs(startIdx - hintIdx);
            if (!best || dist < best.dist) best = { startIdx, dist };
          }
          if (best) return { startIdx: best.startIdx, mode, status: 'apply' };
        }

        // If nothing matched with longer slices, allow a single-line anchor.
        // For whitespace-insensitive modes, locateNeedle() will return null if the match is ambiguous.
        if (n > 0) {
          let best: { startIdx: number; dist: number } | null = null;
          for (let s = 0; s < n; s++) {
            const slice = [oldNeedle[s]];
            const sliceHint = hintIdx + s;
            const matchAt = locateNeedle({
              haystack: origLines,
              needle: slice,
              minStart: origIdx,
              hintIdx: sliceHint,
              mode,
            });
            if (matchAt == null) continue;
            const startIdx = matchAt - s;
            if (startIdx < origIdx) continue;
            const dist = Math.abs(startIdx - hintIdx);
            if (!best || dist < best.dist) best = { startIdx, dist };
          }
          if (best) return { startIdx: best.startIdx, mode, status: 'apply' };
        }
      }

      // 2) If old content can't be found, the patch might already be applied.
      // Detect by locating the post-hunk lines in the file and treat as a no-op.
      for (const mode of modes) {
        const matchAt = locateNeedle({
          haystack: origLines,
          needle: newNeedle,
          minStart: origIdx,
          hintIdx,
          mode,
        });
        if (matchAt != null) {
          return { startIdx: matchAt, mode, status: 'already_applied' };
        }
      }

      return null;
    };

    const located = locateHunk();
    if (!located) {
      throw new Error(`Patch context mismatch near original line ${oldStart}`);
    }

    while (origIdx < located.startIdx && origIdx < origLines.length) {
      result.push(origLines[origIdx]);
      origIdx++;
    }

    if (located.status === 'already_applied') {
      const end = Math.min(origLines.length, origIdx + newNeedle.length);
      for (; origIdx < end; origIdx++) {
        result.push(origLines[origIdx]);
      }
      continue;
    }

    // Apply hunk into a scratch buffer. If it fails but the "new" lines already match,
    // treat it as already applied.
    const hunkOut: string[] = [];
    let tempOrigIdx = origIdx;
    let failed = false;
    for (const line of hunkLines) {
      if (line.startsWith(' ')) {
        const expected = line.slice(1);
        const actual = origLines[tempOrigIdx] ?? '';
        if (!linesEqual(actual, expected, located.mode)) {
          failed = true;
          break;
        }
        hunkOut.push(actual);
        tempOrigIdx++;
      } else if (line.startsWith('-')) {
        const expected = line.slice(1);
        const actual = origLines[tempOrigIdx] ?? '';
        if (!linesEqual(actual, expected, located.mode)) {
          failed = true;
          break;
        }
        tempOrigIdx++;
      } else if (line.startsWith('+')) {
        hunkOut.push(line.slice(1));
      } else if (line === '\\ No newline at end of file') {
        // Ignore diff metadata line.
      } else if (line.trim() === '') {
        throw new Error('Invalid unified diff line: blank lines inside hunks must use a prefix');
      } else {
        throw new Error(`Invalid unified diff line: ${line}`);
      }
    }

    if (failed) {
      const alreadyAt = locateNeedle({
        haystack: origLines,
        needle: newNeedle,
        minStart: origIdx,
        hintIdx: located.startIdx,
        mode: located.mode,
      });
      if (alreadyAt === origIdx) {
        const end = Math.min(origLines.length, origIdx + newNeedle.length);
        for (; origIdx < end; origIdx++) {
          result.push(origLines[origIdx]);
        }
        continue;
      }
      throw new Error(`Patch context mismatch at line ${tempOrigIdx + 1}`);
    }

    result.push(...hunkOut);
    origIdx = tempOrigIdx;
  }

  while (origIdx < origLines.length) {
    result.push(origLines[origIdx]);
    origIdx++;
  }

  return result.join(eol);
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
