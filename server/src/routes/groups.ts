import { Hono } from 'hono';
import { z } from 'zod';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groupMembers, groupWorkspaces, groups, users } from '../db/schema.js';
import {
  auditActorSnapshot,
  auditRequestContext,
  writeStructuredAuditLog,
} from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';
import { roleHasPermission } from '../rbac.js';

export const groupRoutes = new Hono<HonoEnv>();

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
    await writeStructuredAuditLog({
      action: 'group.create',
      resourceType: 'group',
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'role_cannot_create_group' },
    });
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

  await writeStructuredAuditLog({
    action: 'group.create',
    resourceType: 'group',
    resourceId: g.id,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'group', id: g.id, label: g.name },
    result: { status: 'success', code: 200 },
    details: { name: g.name, description: g.description ?? null },
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
    await writeStructuredAuditLog({
      action: 'group.member_add',
      resourceType: 'group',
      resourceId: groupId,
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      target: { type: 'group', id: groupId, label: g.name },
      result: { status: 'denied', code: 403, reason: 'not_group_manager_or_lead' },
    });
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

  await writeStructuredAuditLog({
    action: 'group.member_add',
    resourceType: 'group',
    resourceId: groupId,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'group', id: groupId, label: g.name },
    result: { status: 'success', code: 200 },
    details: {
      addedUser: {
        id: target.id,
        email: target.email,
        displayName: target.displayName,
      },
      roleInGroup: parsed.data.roleInGroup,
    },
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
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) return c.json({ error: 'Group not found' }, 404);
  if (!canManageGroups && !isLead) {
    await writeStructuredAuditLog({
      action: 'group.member_remove',
      resourceType: 'group',
      resourceId: groupId,
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      target: { type: 'group', id: groupId, label: g.name },
      result: { status: 'denied', code: 403, reason: 'not_group_manager_or_lead' },
      details: { removedUserId: targetUserId },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const [target] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);

  await db
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, targetUserId)));

  await writeStructuredAuditLog({
    action: 'group.member_remove',
    resourceType: 'group',
    resourceId: groupId,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'group', id: groupId, label: g.name },
    result: { status: 'success', code: 200 },
    details: {
      removedUser: target
        ? { id: target.id, email: target.email, displayName: target.displayName }
        : { id: targetUserId },
    },
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
    await writeStructuredAuditLog({
      action: 'group.workspace_add',
      resourceType: 'group_workspace',
      resourceId: groupId,
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      target: { type: 'group', id: groupId },
      result: { status: 'denied', code: 403, reason: 'not_group_member' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!canShare) {
    await writeStructuredAuditLog({
      action: 'group.workspace_add',
      resourceType: 'group_workspace',
      resourceId: groupId,
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      target: { type: 'group', id: groupId },
      result: { status: 'denied', code: 403, reason: 'cannot_manage_workspace_shares' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);

  const [ws] = await db
    .insert(groupWorkspaces)
    .values({
      groupId,
      label: parsed.data.label,
      rootPath: parsed.data.rootPath,
    })
    .returning();

  await writeStructuredAuditLog({
    action: 'group.workspace_add',
    resourceType: 'group_workspace',
    resourceId: ws.id,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'group_workspace', id: ws.id, label: ws.label, groupId, groupName: g?.name ?? null },
    result: { status: 'success', code: 200 },
    details: { groupId, groupName: g?.name ?? null, label: ws.label, rootPath: ws.rootPath },
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
  if (user.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'group.update',
      resourceType: 'group',
      resourceId: c.req.param('id'),
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'admin_only' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

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

  await writeStructuredAuditLog({
    action: 'group.update',
    resourceType: 'group',
    resourceId: groupId,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'group', id: groupId, label: updated.name },
    change: {
      fields: Object.keys(parsed.data),
      before: { name: g.name, description: g.description },
      after: { name: updated.name, description: updated.description },
    },
    result: { status: 'success', code: 200 },
  });

  return c.json({ group: updated });
});

groupRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (user.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'group.delete',
      resourceType: 'group',
      resourceId: c.req.param('id'),
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'admin_only' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  const groupId = c.req.param('id');
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) return c.json({ error: 'Group not found' }, 404);

  await db.delete(groups).where(eq(groups.id, groupId));

  await writeStructuredAuditLog({
    action: 'group.delete',
    resourceType: 'group',
    resourceId: groupId,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'group', id: groupId, label: g.name },
    result: { status: 'success', code: 200 },
    details: { name: g.name, description: g.description },
  });

  return c.json({ ok: true });
});
