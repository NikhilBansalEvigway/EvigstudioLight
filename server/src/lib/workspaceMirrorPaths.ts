import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 12 * 1024 * 1024;

export { MAX_FILE_BYTES };

export function expandMirrorRoot(raw: string): string {
  const t = raw.trim();
  if (t === '~' || t.startsWith('~/') || t.startsWith(`~${sep}`)) {
    return resolve(t.replace(/^~/, homedir()));
  }
  return resolve(t);
}

export function getMirrorConfig(): { root: string; token: string | null } | null {
  const raw = process.env.LOCAL_WORKSPACE_MIRROR_ROOT?.trim();
  if (!raw) return null;
  return { root: expandMirrorRoot(raw), token: process.env.LOCAL_WORKSPACE_MIRROR_TOKEN?.trim() || null };
}

export function sanitizeMirrorRootLabel(label: string): string {
  const s = label
    .trim()
    .replace(/\\/g, '/')
    .replace(/[/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  const out = s.replace(/[^\w ().[\]-]/gi, '_').trim();
  return out || 'workspace';
}

/** Normalized relative POSIX segments; rejects empty, ., .., absolute, or Windows drive paths */
export function sanitizeMirrorRelativePath(relativePath: string): string[] {
  const norm = relativePath.trim().replace(/\\/g, '/');
  if (!norm || norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error('invalid_relative_path');
  }
  const parts = norm.split('/').filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 64) throw new Error('invalid_relative_path');
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error('invalid_relative_path');
    if (p.length > 200) throw new Error('invalid_relative_path');
  }
  return parts;
}

export function isPathInsideRoot(rootDir: string, candidateAbs: string): boolean {
  const root = resolve(rootDir);
  const cand = resolve(candidateAbs);
  const rel = relative(root, cand);
  if (!rel) return false;
  if (rel === '..') return false;
  if (rel.startsWith(`..${sep}`)) return false;
  if (rel.startsWith('../')) return false;
  return true;
}

export function safeEqualToken(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function resolveMirrorTargetAbs(cfgRoot: string, rootLabel: string, relativePath: string): string {
  const parts = sanitizeMirrorRelativePath(relativePath);
  const safeLabel = sanitizeMirrorRootLabel(rootLabel);
  const targetAbs = resolve(join(cfgRoot, safeLabel, ...parts));
  if (!isPathInsideRoot(cfgRoot, targetAbs)) {
    throw new Error('path_escape');
  }
  return targetAbs;
}
