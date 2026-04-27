import { describe, expect, it } from 'vitest';
import { applyPatch } from '@/lib/patchApply';

describe('applyPatch', () => {
  it('applies a unified diff hunk at the correct location', () => {
    const original = ['alpha', 'beta', 'gamma', 'delta'].join('\n');

    const updated = applyPatch(original, {
      filePath: 'src/example.ts',
      operation: 'update',
      content: ['@@ -2,2 +2,2 @@', '-beta', '+beta updated', ' gamma'].join('\n'),
    });

    expect(updated).toBe(['alpha', 'beta updated', 'gamma', 'delta'].join('\n'));
  });

  it('relocates a hunk when line numbers drift', () => {
    const original = ['alpha', 'INSERTED', 'beta', 'gamma'].join('\n');

    const updated = applyPatch(original, {
      filePath: 'src/example.ts',
      operation: 'update',
      // Header claims beta is at line 2, but the file shifted.
      content: ['@@ -2,1 +2,1 @@', '-beta', '+beta updated'].join('\n'),
    });

    expect(updated).toBe(['alpha', 'INSERTED', 'beta updated', 'gamma'].join('\n'));
  });

  it('applies a hunk even when indentation differs (whitespace-tolerant fallback)', () => {
    const original = ['<html>', '    <title>Old</title>', '</html>'].join('\n');

    const updated = applyPatch(original, {
      filePath: 'index.html',
      operation: 'update',
      content: ['@@ -2,1 +2,1 @@', '-<title>Old</title>', '+<title>New</title>'].join('\n'),
    });

    expect(updated).toBe(['<html>', '<title>New</title>', '</html>'].join('\n'));
  });

  it('treats an already-applied hunk as a no-op (no context match)', () => {
    const original = ['alpha', 'beta updated', 'gamma'].join('\n');

    const updated = applyPatch(original, {
      filePath: 'src/example.ts',
      operation: 'update',
      content: ['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+beta updated', ' gamma'].join('\n'),
    });

    expect(updated).toBe(original);
  });

  it('rejects unsafe whole-file update bodies for existing files', () => {
    expect(() =>
      applyPatch('const x = 1;\n', {
        filePath: 'src/example.ts',
        operation: 'update',
        content: 'const x = 2;\nconst y = 3;',
      }),
    ).toThrow('Unsafe update patch');
  });

  it('allows create patches that use diff-style additions', () => {
    const created = applyPatch('', {
      filePath: 'src/new.ts',
      operation: 'create',
      content: ['+export const value = 1;', '+export const ready = true;'].join('\n'),
    });

    expect(created).toBe(['export const value = 1;', 'export const ready = true;'].join('\n'));
  });

  it('allows filling an empty file with a plain update body', () => {
    const updated = applyPatch('', {
      filePath: 'src/empty.ts',
      operation: 'update',
      content: 'export const boot = true;\n',
    });

    expect(updated).toBe('export const boot = true;\n');
  });
});
