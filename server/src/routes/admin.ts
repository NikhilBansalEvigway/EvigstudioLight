import { Hono } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLogs, users } from '../db/schema.js';
import { writeAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';
import { roleHasPermission, type RoleName } from '../rbac.js';

export const adminRoutes = new Hono<HonoEnv>();

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '';
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
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
  if (adminUser.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const parsed = createUserSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

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

    await writeAuditLog({
      userId: adminUser.id,
      action: 'admin.user_create',
      resourceType: 'user',
      resourceId: row.id,
      ip: clientIp(c),
      metadata: { email: row.email, role: row.role },
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
  if (adminUser.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id');
  const parsed = patchUserSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'User not found' }, 404);

  if (parsed.data.role !== undefined && parsed.data.role !== 'admin' && target.id === adminUser.id) {
    return c.json({ error: 'You cannot remove your own admin role' }, 400);
  }

  const nextRole = parsed.data.role ?? target.role;
  if (target.role === 'admin' && nextRole !== 'admin') {
    const [{ n }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'admin'));
    if (Number(n) <= 1) {
      return c.json({ error: 'Cannot demote the last admin' }, 400);
    }
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

    await writeAuditLog({
      userId: adminUser.id,
      action: 'admin.user_update',
      resourceType: 'user',
      resourceId: id,
      ip: clientIp(c),
      metadata: { fields: Object.keys(parsed.data) },
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

const patchRoleSchema = z.object({
  role: z.enum(['admin', 'developer', 'tester', 'auditor']),
});

adminRoutes.patch('/users/:id/role', async (c) => {
  const adminUser = c.get('user');
  if (!adminUser) return c.json({ error: 'Unauthorized' }, 401);
  if (adminUser.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id');
  const parsed = patchRoleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) return c.json({ error: 'User not found' }, 404);

  if (target.id === adminUser.id && parsed.data.role !== 'admin') {
    return c.json({ error: 'You cannot remove your own admin role' }, 400);
  }

  if (target.role === 'admin' && parsed.data.role !== 'admin') {
    const [{ n }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'admin'));
    if (Number(n) <= 1) {
      return c.json({ error: 'Cannot demote the last admin' }, 400);
    }
  }

  const newRole = parsed.data.role as RoleName;
  const [updated] = await db.update(users).set({ role: newRole }).where(eq(users.id, id)).returning();

  await writeAuditLog({
    userId: adminUser.id,
    action: 'admin.user_role_change',
    resourceType: 'user',
    resourceId: id,
    ip: clientIp(c),
    metadata: { from: target.role, to: newRole },
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
  if (adminUser.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id');
  if (id === adminUser.id) {
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
      return c.json({ error: 'Cannot delete the last admin' }, 400);
    }
  }

  await db.delete(users).where(eq(users.id, id));

  await writeAuditLog({
    userId: adminUser.id,
    action: 'admin.user_delete',
    resourceType: 'user',
    resourceId: id,
    ip: clientIp(c),
    metadata: { email: target.email },
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

  const ap = q ? `%${escapeLike(q)}%` : null;
  const whereExpr = ap
    ? or(
        ilike(auditLogs.action, ap),
        ilike(auditLogs.resourceType, ap),
        sql`coalesce(${auditLogs.resourceId}, '') ilike ${ap}`,
      )
    : undefined;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(whereExpr)
    .orderBy(desc(auditLogs.createdAt))
    .limit(pageSize)
    .offset(offset);

  const [{ total }] = await db.select({ total: count() }).from(auditLogs).where(whereExpr);

  return c.json({
    logs: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      metadata: r.metadata,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    })),
    total: Number(total),
    page,
    pageSize,
  });
});
