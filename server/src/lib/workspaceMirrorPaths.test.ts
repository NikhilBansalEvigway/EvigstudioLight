// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandMirrorRoot,
  isPathInsideRoot,
  resolveMirrorTargetAbs,
  safeEqualToken,
  sanitizeMirrorRelativePath,
  sanitizeMirrorRootLabel,
} from './workspaceMirrorPaths.js';

describe('workspaceMirrorPaths', () => {
  it('sanitizes root labels', () => {
    expect(sanitizeMirrorRootLabel('  juice/shop  ')).toBe('juice-shop');
    expect(sanitizeMirrorRootLabel('')).toBe('workspace');
  });

  it('accepts safe relative paths', () => {
    expect(sanitizeMirrorRelativePath('src/index.ts')).toEqual(['src', 'index.ts']);
  });

  it('rejects path traversal', () => {
    expect(() => sanitizeMirrorRelativePath('../etc/passwd')).toThrow();
    expect(() => sanitizeMirrorRelativePath('a/../b')).toThrow();
  });

  it('detects paths outside mirror root', () => {
    const root = mkdtempSync(join(tmpdir(), 'evig-mirror-'));
    try {
      expect(isPathInsideRoot(root, join(root, 'proj', 'a.txt'))).toBe(true);
      expect(isPathInsideRoot(root, join(root, '..', 'outside'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('expands home in mirror root', () => {
    const expanded = expandMirrorRoot('~/');
    expect(expanded.length).toBeGreaterThan(2);
  });

  it('safeEqualToken compares in constant time shape', () => {
    expect(safeEqualToken('a', 'a')).toBe(true);
    expect(safeEqualToken('a', 'b')).toBe(false);
    expect(safeEqualToken('ab', 'a')).toBe(false);
  });

  it('resolveMirrorTargetAbs writes under root only', () => {
    const root = mkdtempSync(join(tmpdir(), 'evig-mirror-resolve-'));
    try {
      const abs = resolveMirrorTargetAbs(root, 'my-app', 'src/x.ts');
      expect(abs.startsWith(root)).toBe(true);
      expect(() => resolveMirrorTargetAbs(root, 'my-app', '../../x')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes via resolved path when mkdir+writeFile used', () => {
    const root = mkdtempSync(join(tmpdir(), 'evig-mirror-write-'));
    try {
      const target = resolveMirrorTargetAbs(root, 'app', 'a/b.txt');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'ok', 'utf8');
      expect(readFileSync(target, 'utf8')).toBe('ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
