import type { Context } from 'hono';
import { count, eq, lt, or, sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { auditLogs, users } from './db/schema.js';
import type { AppUser } from './rbac.js';
import {
  auditRetentionDaysFromEnv,
  inferLegacyAuditResult,
  parseAuditMetadata,
  pruneUndefined,
  type AuditAccess,
  type AuditActor,
  type AuditChange,
  type AuditRequestContext,
  type AuditResultStatus,
  type AuditTarget,
} from './lib/auditModel.js';
export {
  auditRetentionDaysFromEnv,
  inferLegacyAuditResult,
  normalizeAuditRow,
  parseAuditMetadata,
  type AuditMetadata,
  type AuditRowJson,
  type AuditAccess,
  type AuditActor,
  type AuditChange,
  type AuditRequestContext,
  type AuditResultStatus,
  type AuditTarget,
} from './lib/auditModel.js';

type AuditStructuredInput = {
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  actor?: AuditActor | null;
  target?: AuditTarget | null;
  context?: AuditRequestContext | null;
  access?: AuditAccess | null;
  change?: AuditChange | null;
  result?: {
    status: AuditResultStatus;
    code?: number | null;
    reason?: string | null;
  } | null;
  details?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

export function auditRetentionDays(): number {
  return auditRetentionDaysFromEnv(process.env.AUDIT_RETENTION_DAYS);
}

export async function backfillLegacyAuditLogs(): Promise<{ updated: number }> {
  const rows = await db
    .select({
      log: auditLogs,
      userEmail: users.email,
      userDisplayName: users.displayName,
      userRole: users.role,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(
      or(
        sql`${auditLogs.metadata} is null`,
        sql`coalesce(${auditLogs.metadata}->'result'->>'status', '') = ''`,
        sql`coalesce(${auditLogs.metadata}->'actor'->>'id', '') = ''`,
        sql`coalesce(${auditLogs.metadata}->'target'->>'type', '') = ''`,
      ),
    );

  let updated = 0;
  for (const row of rows) {
    const metadata = parseAuditMetadata(row.log.metadata) ?? {};
    let changed = false;

    if (!metadata.result?.status) {
      metadata.result = inferLegacyAuditResult(row.log.action);
      changed = true;
    }

    if (!metadata.actor && row.log.userId && row.userEmail && row.userDisplayName && row.userRole) {
      metadata.actor = {
        id: row.log.userId,
        email: row.userEmail,
        displayName: row.userDisplayName,
        role: row.userRole,
      };
      changed = true;
    }

    if (!metadata.target && row.log.resourceType) {
      metadata.target = {
        type: row.log.resourceType,
        id: row.log.resourceId ?? null,
        label: row.log.resourceId ?? null,
      };
      changed = true;
    }

    if (!changed) continue;

    await db
      .update(auditLogs)
      .set({ metadata: pruneUndefined(metadata) as Record<string, unknown> })
      .where(eq(auditLogs.id, row.log.id));
    updated++;
  }

  return { updated };
}

export async function cleanupExpiredAuditLogs(now = new Date()): Promise<{ deleted: number; retentionDays: number }> {
  const retentionDays = auditRetentionDays();
  if (retentionDays <= 0) return { deleted: 0, retentionDays };

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const oldRows = await db.select({ total: count() }).from(auditLogs).where(lt(auditLogs.createdAt, cutoff));
  const toDelete = Number(oldRows[0]?.total ?? 0);
  if (toDelete > 0) {
    await db.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff));
  }
  return { deleted: toDelete, retentionDays };
}

export function auditActorSnapshot(user: AppUser | null | undefined): AuditActor | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}

export function auditRequestContext(c: Context): AuditRequestContext {
  return {
    method: c.req.method,
    route: new URL(c.req.url).pathname,
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  };
}

export async function writeAuditLog(input: {
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
}) {
  await db.insert(auditLogs).values({
    userId: input.userId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    metadata: input.metadata ?? null,
    ip: input.ip ?? null,
  });
}

export async function writeStructuredAuditLog(input: AuditStructuredInput) {
  const metadata = pruneUndefined({
    actor: input.actor ?? null,
    target: input.target ?? null,
    context: input.context ?? null,
    access: input.access ?? null,
    change: input.change ?? null,
    result: input.result ?? null,
    details: input.details ?? null,
    ...(input.metadata ?? {}),
  }) as Record<string, unknown>;

  const ip = input.context?.ip ?? null;
  await writeAuditLog({
    userId: input.userId ?? input.actor?.id ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    metadata,
    ip,
  });
}
