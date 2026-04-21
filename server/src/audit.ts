import { db } from './db/client.js';
import { auditLogs } from './db/schema.js';

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
