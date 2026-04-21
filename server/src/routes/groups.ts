import { Hono } from 'hono';
import { z } from 'zod';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groupMembers, groupWorkspaces, groups, users } from '../db/schema.js';
import { writeAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';
import { roleHasPermission } from '../rbac.js';

export const groupRoutes = new Hono<HonoEnv>();

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '';
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

groupRoutes.get('/:id/summary', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const groupId = c.req.param('id');
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) return c.json({ error: 'Group not found' }, 404);

  const [mem] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1);
  if (!mem && user.role !== 'admin' && user.role !== 'auditor') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const members = await db
    .select({
      userId: groupMembers.userId,
      roleInGroup: groupMembers.roleInGroup,
      email: users.email,
      displayName: users.displayName,
    })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(groupMembers.groupId, groupId));

  const workspaces = await db.select().from(groupWorkspaces).where(eq(groupWorkspaces.groupId, groupId));

  return c.json({ group: g, members, workspaces });
});

groupRoutes.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  if (user.role === 'admin' || user.role === 'auditor') {
    const page = Math.max(1, Number(c.req.query('page') ?? '1'));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? '20')));
    const offset = (page - 1) * pageSize;
    const q = (c.req.query('q') ?? '').trim();
    const pattern = q ? `%${escapeLike(q)}%` : null;
    const whereExpr = pattern
      ? or(ilike(groups.name, pattern), ilike(groups.description, pattern))
      : undefined;

    const rows = await db
      .select()
      .from(groups)
      .where(whereExpr)
      .orderBy(desc(groups.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db.select({ total: count() }).from(groups).where(whereExpr);

    return c.json({
      groups: rows,
      total: Number(total),
      page,
      pageSize,
    });
  }

  const memberRows = await db
    .select({ group: groups })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.userId, user.id));

  return c.json({ groups: memberRows.map((r) => r.group) });
});

const createGroupSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

groupRoutes.post('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!roleHasPermission(user.role, 'groups.manage')) {
    return c.json({ error: 'Only admins or users with group management rights can create teams' }, 403);
  }

  const parsed = createGroupSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

  const [g] = await db
    .insert(groups)
    .values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      createdBy: user.id,
    })
    .returning();

  await db.insert(groupMembers).values({
    groupId: g.id,
    userId: user.id,
    roleInGroup: 'lead',
  });

  await writeAuditLog({
    userId: user.id,
    action: 'group.create',
    resourceType: 'group',
    resourceId: g.id,
    ip: clientIp(c),
    metadata: { name: g.name },
  });

  return c.json({ group: g });
});

const memberSchema = z.object({
  userId: z.string().uuid(),
  roleInGroup: z.enum(['member', 'lead']).default('member'),
});

groupRoutes.post('/:id/members', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const groupId = c.req.param('id');
  const parsed = memberSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) return c.json({ error: 'Group not found' }, 404);

  const [selfMem] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1);
  const isLead = selfMem?.roleInGroup === 'lead';
  const canManageGroups = roleHasPermission(user.role, 'groups.manage');
  if (!canManageGroups && !isLead) {
    return c.json({ error: 'Only admins, group managers, or group leads can add members' }, 403);
  }

  const [target] = await db.select().from(users).where(eq(users.id, parsed.data.userId)).limit(1);
  if (!target) return c.json({ error: 'User not found' }, 404);

  await db
    .insert(groupMembers)
    .values({
      groupId,
      userId: parsed.data.userId,
      roleInGroup: parsed.data.roleInGroup,
    })
    .onConflictDoNothing();

  await writeAuditLog({
    userId: user.id,
    action: 'group.member_add',
    resourceType: 'group',
    resourceId: groupId,
    ip: clientIp(c),
    metadata: { addedUserId: parsed.data.userId },
  });

  return c.json({ ok: true });
});

groupRoutes.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const groupId = c.req.param('id');
  const targetUserId = c.req.param('userId');

  const [selfMem] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1);
  const isLead = selfMem?.roleInGroup === 'lead';
  const canManageGroups = roleHasPermission(user.role, 'groups.manage');
  if (!canManageGroups && !isLead) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await db
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, targetUserId)));

  await writeAuditLog({
    userId: user.id,
    action: 'group.member_remove',
    resourceType: 'group',
    resourceId: groupId,
    ip: clientIp(c),
    metadata: { removedUserId: targetUserId },
  });

  return c.json({ ok: true });
});

const workspaceSchema = z.object({
  label: z.string().min(1).max(200),
  rootPath: z.string().min(1).max(2000),
});

groupRoutes.post('/:id/workspaces', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const groupId = c.req.param('id');
  const parsed = workspaceSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

  const [mem] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1);
  const isLead = mem?.roleInGroup === 'lead';
  const canShare =
    user.role === 'admin' ||
    roleHasPermission(user.role, 'workspace.shares_manage') ||
    isLead;
  if (user.role !== 'admin' && !mem) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!canShare) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const [ws] = await db
    .insert(groupWorkspaces)
    .values({
      groupId,
      label: parsed.data.label,
      rootPath: parsed.data.rootPath,
    })
    .returning();

  await writeAuditLog({
    userId: user.id,
    action: 'group.workspace_add',
    resourceType: 'group_workspace',
    resourceId: ws.id,
    ip: clientIp(c),
    metadata: { groupId, label: ws.label },
  });

  return c.json({ workspace: ws });
});

groupRoutes.get('/:id/workspaces', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const groupId = c.req.param('id');
  const [mem] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1);
  if (!mem && user.role !== 'admin' && user.role !== 'auditor') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const list = await db.select().from(groupWorkspaces).where(eq(groupWorkspaces.groupId, groupId));
  return c.json({ workspaces: list });
});

const patchGroupSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.union([z.string().max(2000), z.null()]).optional(),
});

groupRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const groupId = c.req.param('id');
  const parsed = patchGroupSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) return c.json({ error: 'Group not found' }, 404);

  const [updated] = await db
    .update(groups)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    })
    .where(eq(groups.id, groupId))
    .returning();

  await writeAuditLog({
    userId: user.id,
    action: 'group.update',
    resourceType: 'group',
    resourceId: groupId,
    ip: clientIp(c),
    metadata: parsed.data,
  });

  return c.json({ group: updated });
});

groupRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const groupId = c.req.param('id');
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) return c.json({ error: 'Group not found' }, 404);

  await db.delete(groups).where(eq(groups.id, groupId));

  await writeAuditLog({
    userId: user.id,
    action: 'group.delete',
    resourceType: 'group',
    resourceId: groupId,
    ip: clientIp(c),
    metadata: { name: g.name },
  });

  return c.json({ ok: true });
});
