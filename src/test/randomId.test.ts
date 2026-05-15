import { describe, expect, it } from 'vitest';
import { randomId } from '@/lib/randomId';

describe('randomId', () => {
  it('returns distinct strings', () => {
    const a = randomId();
    const b = randomId();
    expect(a.length).toBeGreaterThan(4);
    expect(b.length).toBeGreaterThan(4);
    expect(a).not.toBe(b);
  });
});
