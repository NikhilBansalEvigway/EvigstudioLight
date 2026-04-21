import { Hono } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { and, count, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLogs, users } from '../db/schema.js';
import {
  auditRetentionDays,
  auditActorSnapshot,
  normalizeAuditRow,
  auditRequestContext,
  writeStructuredAuditLog,
} from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';
import { roleHasPermission, type RoleName } from '../rbac.js';

export const adminRoutes = new Hono<HonoEnv>();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

function parseDateInput(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildAuditWhere(params: {
  q?: string;
  actionPrefix?: string;
  resourceType?: string;
  resultStatus?: string;
  start?: Date | null;
  end?: Date | null;
}) {
  const conditions = [];
  const q = (params.q ?? '').trim();
  const ap = q ? `%${escapeLike(q)}%` : null;
  if (ap) {
    conditions.push(
      or(
        ilike(auditLogs.action, ap),
        ilike(auditLogs.resourceType, ap),
        sql`coalesce(${auditLogs.resourceId}, '') ilike ${ap}`,
        sql`coalesce(${auditLogs.metadata}::text, '') ilike ${ap}`,
      )!,
    );
  }
  if (params.actionPrefix) {
    conditions.push(ilike(auditLogs.action, `${escapeLike(params.actionPrefix)}%`));
  }
  if (params.resourceType) {
    conditions.push(eq(auditLogs.resourceType, params.resourceType));
  }
  if (params.resultStatus) {
    conditions.push(sql`coalesce(${auditLogs.metadata}->'result'->>'status', '') = ${params.resultStatus}`);
  }
  if (params.start) {
    conditions.push(gte(auditLogs.createdAt, params.start));
  }
  if (params.end) {
    conditions.push(lte(auditLogs.createdAt, params.end));
  }
  return conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
}

function csvEscape(value: unknown): string {
  const s = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

adminRoutes.get('/users', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? '20')));
  const offset = (page - 1) * pageSize;
  const q = (c.req.query('q') ?? '').trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;

  const whereExpr = pattern
    ? or(ilike(users.email, pattern), ilike(users.displayName, pattern))
    : undefined;

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(whereExpr)
    .orderBy(desc(users.createdAt))
    .limit(pageSize)
    .offset(offset);

  const [{ total }] = await db.select({ total: count() }).from(users).where(whereExpr);

  return c.json({
    users: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    total: Number(total),
    page,
    pageSize,
  });
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120),
  role: z.enum(['admin', 'developer', 'tester', 'auditor']),
});

adminRoutes.post('/users', async (c) => {
  const adminUser = c.get('user');
  if (!adminUser) return c.json({ error: 'Unauthorized' }, 401);
  if (adminUser.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'admin.user_create',
      resourceType: 'user',
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'admin_only' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsed = createUserSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    await writeStructuredAuditLog({
      action: 'admin.user_create',
      resourceType: 'user',
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'error', code: 400, reason: 'invalid_payload' },
    });
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const email = parsed.data.email.toLowerCase();

  try {
    const [row] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        displayName: parsed.data.displayName,
        role: parsed.data.role,
      })
      .returning();

    await writeStructuredAuditLog({
      action: 'admin.user_create',
      resourceType: 'user',
      resourceId: row.id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      target: { type: 'user', id: row.id, label: row.email },
      result: { status: 'success', code: 200 },
      details: { email: row.email, displayName: row.displayName, role: row.role },
    });

    return c.json({
      user: {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        createdAt: row.createdAt.toISOString(),
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return c.json({ error: 'Email already registered' }, 409);
    }
    console.error(e);
    return c.json({ error: 'Create failed' }, 500);
  }
});

const patchUserSchema = z.object({
  email: z.string().email().optional(),
  displayName: z.string().min(1).max(120).optional(),
  password: z.string().min(8).max(128).optional(),
  role: z.enum(['admin', 'developer', 'tester', 'auditor']).optional(),
});

adminRoutes.patch('/users/:id', async (c) => {
  const adminUser = c.get('user');
  if (!adminUser) return c.json({ error: 'Unauthorized' }, 401);
  if (adminUser.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'admin.user_update',
      resourceType: 'user',
      resourceId: c.req.param('id'),
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'admin_only' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = c.req.param('id');
  const parsed = patchUserSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    await writeStructuredAuditLog({
      action: 'admin.user_update',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'error', code: 400, reason: 'invalid_payload' },
    });
    return c.json({ error: 'Invalid payload' }, 400);
  }
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'User not found' }, 404);

  if (parsed.data.role !== undefined && parsed.data.role !== 'admin' && target.id === adminUser.id) {
    await writeStructuredAuditLog({
      action: 'admin.user_update',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      target: { type: 'user', id, label: target.email },
      result: { status: 'denied', code: 400, reason: 'cannot_remove_own_admin_role' },
    });
    return c.json({ error: 'You cannot remove your own admin role' }, 400);
  }

  const nextRole = parsed.data.role ?? target.role;
  if (target.role === 'admin' && nextRole !== 'admin') {
    const [{ n }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'admin'));
    if (Number(n) <= 1) {
      await writeStructuredAuditLog({
        action: 'admin.user_update',
        resourceType: 'user',
        resourceId: id,
        actor: auditActorSnapshot(adminUser),
        context: auditRequestContext(c),
        target: { type: 'user', id, label: target.email },
        result: { status: 'denied', code: 400, reason: 'cannot_demote_last_admin' },
      });
      return c.json({ error: 'Cannot demote the last admin' }, 400);
    }
  }

  if (parsed.data.password !== undefined && target.id === adminUser.id) {
    await writeStructuredAuditLog({
      action: 'admin.user_update',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      target: { type: 'user', id, label: target.email },
      result: { status: 'denied', code: 400, reason: 'use_self_password_change' },
    });
    return c.json({ error: 'Use the account password change form for your own password' }, 400);
  }

  const patch: Partial<typeof users.$inferInsert> = {};
  if (parsed.data.email !== undefined) patch.email = parsed.data.email.toLowerCase();
  if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;
  if (parsed.data.role !== undefined) patch.role = parsed.data.role;
  if (parsed.data.password !== undefined) {
    patch.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  }

  try {
    const [updated] = await db.update(users).set(patch).where(eq(users.id, id)).returning();

    await writeStructuredAuditLog({
      action: 'admin.user_update',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      target: { type: 'user', id, label: updated.email },
      change: {
        fields: Object.keys(parsed.data),
        before: {
          email: target.email,
          displayName: target.displayName,
          role: target.role,
          passwordChanged: false,
        },
        after: {
          email: updated.email,
          displayName: updated.displayName,
          role: updated.role,
          passwordChanged: parsed.data.password !== undefined,
        },
      },
      result: { status: 'success', code: 200 },
    });

    return c.json({
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        role: updated.role,
        createdAt: updated.createdAt.toISOString(),
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return c.json({ error: 'Email already in use' }, 409);
    }
    console.error(e);
    return c.json({ error: 'Update failed' }, 500);
  }
});

const changeUserPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

adminRoutes.patch('/users/:id/password', async (c) => {
  const adminUser = c.get('user');
  if (!adminUser) return c.json({ error: 'Unauthorized' }, 401);
  if (adminUser.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'admin.user_password_change',
      resourceType: 'user',
      resourceId: c.req.param('id'),
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'admin_only' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = c.req.param('id');
  const parsed = changeUserPasswordSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    await writeStructuredAuditLog({
      action: 'admin.user_password_change',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'error', code: 400, reason: 'invalid_payload' },
    });
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'User not found' }, 404);

  if (target.id === adminUser.id) {
    await writeStructuredAuditLog({
      action: 'admin.user_password_change',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      target: { type: 'user', id, label: target.email },
      result: { status: 'denied', code: 400, reason: 'use_self_password_change' },
    });
    return c.json({ error: 'Use the account password change form for your own password' }, 400);
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));

  await writeStructuredAuditLog({
    action: 'admin.user_password_change',
    resourceType: 'user',
    resourceId: id,
    actor: auditActorSnapshot(adminUser),
    context: auditRequestContext(c),
    target: { type: 'user', id, label: target.email },
    change: {
      fields: ['password'],
      before: { passwordChanged: false },
      after: { passwordChanged: true },
    },
    result: { status: 'success', code: 200 },
  });

  return c.json({ ok: true });
});

const patchRoleSchema = z.object({
  role: z.enum(['admin', 'developer', 'tester', 'auditor']),
});

adminRoutes.patch('/users/:id/role', async (c) => {
  const adminUser = c.get('user');
  if (!adminUser) return c.json({ error: 'Unauthorized' }, 401);
  if (adminUser.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'admin.user_role_change',
      resourceType: 'user',
      resourceId: c.req.param('id'),
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'admin_only' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = c.req.param('id');
  const parsed = patchRoleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    await writeStructuredAuditLog({
      action: 'admin.user_role_change',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'error', code: 400, reason: 'invalid_payload' },
    });
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'User not found' }, 404);

  if (target.id === adminUser.id && parsed.data.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'admin.user_role_change',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      target: { type: 'user', id, label: target.email },
      result: { status: 'denied', code: 400, reason: 'cannot_remove_own_admin_role' },
    });
    return c.json({ error: 'You cannot remove your own admin role' }, 400);
  }

  if (target.role === 'admin' && parsed.data.role !== 'admin') {
    const [{ n }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'admin'));
    if (Number(n) <= 1) {
      await writeStructuredAuditLog({
        action: 'admin.user_role_change',
        resourceType: 'user',
        resourceId: id,
        actor: auditActorSnapshot(adminUser),
        context: auditRequestContext(c),
        target: { type: 'user', id, label: target.email },
        result: { status: 'denied', code: 400, reason: 'cannot_demote_last_admin' },
      });
      return c.json({ error: 'Cannot demote the last admin' }, 400);
    }
  }

  const newRole = parsed.data.role as RoleName;
  const [updated] = await db.update(users).set({ role: newRole }).where(eq(users.id, id)).returning();

  await writeStructuredAuditLog({
    action: 'admin.user_role_change',
    resourceType: 'user',
    resourceId: id,
    actor: auditActorSnapshot(adminUser),
    context: auditRequestContext(c),
    target: { type: 'user', id, label: updated.email },
    change: {
      fields: ['role'],
      before: { role: target.role },
      after: { role: newRole },
    },
    result: { status: 'success', code: 200 },
  });

  return c.json({
    user: {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      role: updated.role,
    },
  });
});

adminRoutes.delete('/users/:id', async (c) => {
  const adminUser = c.get('user');
  if (!adminUser) return c.json({ error: 'Unauthorized' }, 401);
  if (adminUser.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'admin.user_delete',
      resourceType: 'user',
      resourceId: c.req.param('id'),
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'admin_only' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = c.req.param('id');
  if (id === adminUser.id) {
    await writeStructuredAuditLog({
      action: 'admin.user_delete',
      resourceType: 'user',
      resourceId: id,
      actor: auditActorSnapshot(adminUser),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 400, reason: 'cannot_delete_self' },
    });
    return c.json({ error: 'You cannot delete your own account' }, 400);
  }

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'User not found' }, 404);

  if (target.role === 'admin') {
    const [{ n }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'admin'));
    if (Number(n) <= 1) {
      await writeStructuredAuditLog({
        action: 'admin.user_delete',
        resourceType: 'user',
        resourceId: id,
        actor: auditActorSnapshot(adminUser),
        context: auditRequestContext(c),
        target: { type: 'user', id, label: target.email },
        result: { status: 'denied', code: 400, reason: 'cannot_delete_last_admin' },
      });
      return c.json({ error: 'Cannot delete the last admin' }, 400);
    }
  }

  await db.delete(users).where(eq(users.id, id));

  await writeStructuredAuditLog({
    action: 'admin.user_delete',
    resourceType: 'user',
    resourceId: id,
    actor: auditActorSnapshot(adminUser),
    context: auditRequestContext(c),
    target: { type: 'user', id, label: target.email },
    result: { status: 'success', code: 200 },
    details: { email: target.email, displayName: target.displayName, role: target.role },
  });

  return c.json({ ok: true });
});

adminRoutes.get('/audit', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!roleHasPermission(user.role, 'audit.read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize') ?? '50')));
  const offset = (page - 1) * pageSize;
  const q = (c.req.query('q') ?? '').trim();
  const actionPrefix = (c.req.query('action') ?? '').trim();
  const resourceType = (c.req.query('resourceType') ?? '').trim();
  const resultStatus = (c.req.query('result') ?? '').trim();
  const start = parseDateInput(c.req.query('start'));
  const end = parseDateInput(c.req.query('end'));
  const whereExpr = buildAuditWhere({ q, actionPrefix, resourceType, resultStatus, start, end });

  const rows = await db
    .select()
    .from(auditLogs)
    .where(whereExpr)
    .orderBy(desc(auditLogs.createdAt))
    .limit(pageSize)
    .offset(offset);

  const [{ total }] = await db.select({ total: count() }).from(auditLogs).where(whereExpr);

  await writeStructuredAuditLog({
    action: 'audit.read',
    resourceType: 'audit_log',
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'audit_log', label: 'admin audit search' },
    result: { status: 'success', code: 200 },
    details: {
      page,
      pageSize,
      q: q || null,
      actionPrefix: actionPrefix || null,
      resourceType: resourceType || null,
      resultStatus: resultStatus || null,
      start: start?.toISOString() ?? null,
      end: end?.toISOString() ?? null,
      returnedRows: rows.length,
    },
  });

  return c.json({
    logs: rows.map(normalizeAuditRow),
    total: Number(total),
    page,
    pageSize,
    retentionDays: auditRetentionDays(),
  });
});

adminRoutes.get('/audit/summary', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!roleHasPermission(user.role, 'audit.read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const q = (c.req.query('q') ?? '').trim();
  const actionPrefix = (c.req.query('action') ?? '').trim();
  const resourceType = (c.req.query('resourceType') ?? '').trim();
  const resultStatus = (c.req.query('result') ?? '').trim();
  const start = parseDateInput(c.req.query('start'));
  const end = parseDateInput(c.req.query('end'));
  const whereExpr = buildAuditWhere({ q, actionPrefix, resourceType, resultStatus, start, end });

  const [summary] = await db
    .select({
      total: count(),
      success: sql<number>`count(*) filter (where coalesce(${auditLogs.metadata}->'result'->>'status', '') = 'success')`,
      denied: sql<number>`count(*) filter (where coalesce(${auditLogs.metadata}->'result'->>'status', '') = 'denied')`,
      error: sql<number>`count(*) filter (where coalesce(${auditLogs.metadata}->'result'->>'status', '') = 'error')`,
      chatReads: sql<number>`count(*) filter (where ${auditLogs.action} = 'chat.read')`,
      loginFailures: sql<number>`count(*) filter (where ${auditLogs.action} = 'auth.login_failed')`,
      adminChanges: sql<number>`count(*) filter (where ${auditLogs.action} like 'admin.%')`,
      llmQueries: sql<number>`count(*) filter (where ${auditLogs.action} = 'llm.query')`,
    })
    .from(auditLogs)
    .where(whereExpr);

  const topActions = await db
    .select({ action: auditLogs.action, total: count() })
    .from(auditLogs)
    .where(whereExpr)
    .groupBy(auditLogs.action)
    .orderBy(sql`count(*) desc`, desc(auditLogs.action))
    .limit(6);

  return c.json({
    summary: {
      total: Number(summary?.total ?? 0),
      success: Number(summary?.success ?? 0),
      denied: Number(summary?.denied ?? 0),
      error: Number(summary?.error ?? 0),
      chatReads: Number(summary?.chatReads ?? 0),
      loginFailures: Number(summary?.loginFailures ?? 0),
      adminChanges: Number(summary?.adminChanges ?? 0),
      llmQueries: Number(summary?.llmQueries ?? 0),
      topActions: topActions.map((row) => ({ action: row.action, total: Number(row.total) })),
      retentionDays: auditRetentionDays(),
      window: {
        start: start?.toISOString() ?? null,
        end: end?.toISOString() ?? null,
      },
    },
  });
});

adminRoutes.get('/audit/export', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!roleHasPermission(user.role, 'audit.read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const q = (c.req.query('q') ?? '').trim();
  const actionPrefix = (c.req.query('action') ?? '').trim();
  const resourceType = (c.req.query('resourceType') ?? '').trim();
  const resultStatus = (c.req.query('result') ?? '').trim();
  const start = parseDateInput(c.req.query('start'));
  const end = parseDateInput(c.req.query('end'));
  const format = ((c.req.query('format') ?? 'json').trim().toLowerCase() === 'csv' ? 'csv' : 'json') as
    | 'json'
    | 'csv';
  const whereExpr = buildAuditWhere({ q, actionPrefix, resourceType, resultStatus, start, end });

  const rows = await db.select().from(auditLogs).where(whereExpr).orderBy(desc(auditLogs.createdAt)).limit(5000);
  const normalized = rows.map(normalizeAuditRow);

  await writeStructuredAuditLog({
    action: 'audit.export',
    resourceType: 'audit_log',
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'audit_log', label: `audit export (${format})` },
    result: { status: 'success', code: 200 },
    details: {
      q: q || null,
      actionPrefix: actionPrefix || null,
      resourceType: resourceType || null,
      resultStatus: resultStatus || null,
      start: start?.toISOString() ?? null,
      end: end?.toISOString() ?? null,
      exportedRows: normalized.length,
      format,
    },
  });

  if (format === 'json') {
    return new Response(JSON.stringify(normalized, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-log-export.json"',
      },
    });
  }

  const header = [
    'createdAt',
    'action',
    'resourceType',
    'resourceId',
    'actorDisplayName',
    'actorEmail',
    'actorRole',
    'targetLabel',
    'resultStatus',
    'resultCode',
    'resultReason',
    'route',
    'method',
    'ip',
    'metadata',
  ];
  const lines = [header.join(',')];
  for (const row of normalized) {
    lines.push(
      [
        row.createdAt,
        row.action,
        row.resourceType,
        row.resourceId,
        row.actor?.displayName,
        row.actor?.email,
        row.actor?.role,
        row.target?.label,
        row.result?.status,
        row.result?.code,
        row.result?.reason,
        row.metadata?.context?.route,
        row.metadata?.context?.method,
        row.ip,
        row.metadata,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit-log-export.csv"',
    },
  });
});
