import type { AppUser } from '../rbac.js';
import { auditLogs } from '../db/schema.js';

export type AuditResultStatus = 'success' | 'denied' | 'error';

export type AuditActor = {
  id: string;
  email: string;
  displayName: string;
  role: AppUser['role'];
};

export type AuditTarget = {
  type: string;
  id?: string | null;
  label?: string | null;
  ownerId?: string | null;
  ownerDisplayName?: string | null;
  groupId?: string | null;
  groupName?: string | null;
};

export type AuditRequestContext = {
  method: string;
  route: string;
  ip: string | null;
  userAgent: string | null;
};

export type AuditAccess = {
  mode?: string | null;
  reason?: string | null;
  privacy?: string | null;
  isOwner?: boolean;
  groupId?: string | null;
  groupName?: string | null;
};

export type AuditChange = {
  fields?: string[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

export type AuditMetadata = {
  actor?: AuditActor | null;
  target?: AuditTarget | null;
  context?: AuditRequestContext | null;
  access?: AuditAccess | null;
  change?: AuditChange | null;
  result?: {
    status?: AuditResultStatus;
    code?: number | null;
    reason?: string | null;
  } | null;
  details?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type AuditRowJson = {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: AuditMetadata | null;
  actor: AuditActor | null;
  target: AuditTarget | null;
  access: AuditAccess | null;
  change: AuditChange | null;
  result: AuditMetadata['result'] | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
};

export function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, pruneUndefined(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function parseAuditMetadata(value: unknown): AuditMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AuditMetadata;
}

export function normalizeAuditRow(row: typeof auditLogs.$inferSelect): AuditRowJson {
  const metadata = parseAuditMetadata(row.metadata);
  const result = metadata?.result ?? inferLegacyAuditResult(row.action);
  return {
    id: row.id,
    userId: row.userId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata,
    actor: metadata?.actor ?? null,
    target: metadata?.target ?? null,
    access: metadata?.access ?? null,
    change: metadata?.change ?? null,
    result,
    details: (metadata?.details as Record<string, unknown> | null | undefined) ?? null,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

export function inferLegacyAuditResult(action: string): {
  status: AuditResultStatus;
  code: number;
  reason?: string | null;
} {
  if (action === 'auth.login_failed') {
    return { status: 'denied', code: 401, reason: 'invalid_credentials' };
  }
  return { status: 'success', code: 200, reason: 'legacy_backfill' };
}

export function auditRetentionDaysFromEnv(envValue: string | undefined): number {
  const raw = Number(envValue ?? '180');
  if (!Number.isFinite(raw) || raw < 0) return 180;
  return Math.min(3650, Math.floor(raw));
}
