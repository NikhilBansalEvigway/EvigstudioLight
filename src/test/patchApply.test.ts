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
