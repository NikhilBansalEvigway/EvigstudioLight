// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  auditRetentionDaysFromEnv,
  normalizeAuditRow,
  parseAuditMetadata,
  pruneUndefined,
} from './auditModel.js';

describe('auditModel', () => {
  it('removes undefined fields recursively', () => {
    expect(
      pruneUndefined({
        actor: { id: 'u1', displayName: undefined },
        details: { ok: true, skipped: undefined },
      }),
    ).toEqual({
      actor: { id: 'u1' },
      details: { ok: true },
    });
  });

  it('parses metadata objects and rejects non-objects', () => {
    expect(parseAuditMetadata({ result: { status: 'success' } })).toEqual({
      result: { status: 'success' },
    });
    expect(parseAuditMetadata('x')).toBeNull();
    expect(parseAuditMetadata(null)).toBeNull();
  });

  it('normalizes audit rows into API-safe shape', () => {
    const row = {
      id: 'a1',
      userId: 'u1',
      action: 'chat.read',
      resourceType: 'chat',
      resourceId: 'c1',
      metadata: {
        actor: { id: 'u1', email: 'u@example.com', displayName: 'User', role: 'admin' },
        result: { status: 'success', code: 200 },
        details: { locked: true },
      },
      ip: '127.0.0.1',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    };

    expect(normalizeAuditRow(row as never)).toMatchObject({
      id: 'a1',
      action: 'chat.read',
      actor: { email: 'u@example.com' },
      result: { status: 'success', code: 200 },
      details: { locked: true },
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('normalizes retention days safely', () => {
    expect(auditRetentionDaysFromEnv(undefined)).toBe(180);
    expect(auditRetentionDaysFromEnv('30')).toBe(30);
    expect(auditRetentionDaysFromEnv('-1')).toBe(180);
    expect(auditRetentionDaysFromEnv('999999')).toBe(3650);
  });
});
