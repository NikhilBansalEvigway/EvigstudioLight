import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chats } from '../db/schema.js';
import { writeAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';
import { canAccessChat, roleHasPermission } from '../rbac.js';
import { getUserGroupIds } from '../lib/groups.js';

export const chatRoutes = new Hono<HonoEnv>();

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string(), z.array(z.unknown())]),
  timestamp: z.number(),
  patches: z.array(z.unknown()).optional(),
});

const versionSnapshotSchema = z.object({
  id: z.string(),
  savedAt: z.number(),
  label: z.string().max(200).optional(),
  title: z.string(),
  messages: z.array(messageSchema),
});

const chatBodySchema = z.object({
  title: z.string().min(1).max(500),
  messages: z.array(messageSchema).default([]),
  groupId: z.string().uuid().nullable().optional(),
  privacy: z.enum(['private', 'shared', 'group']).optional(),
  threadId: z.string().uuid().nullable().optional(),
  threadTitle: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(80)).max(50).optional(),
  versionHistory: z.array(versionSnapshotSchema).max(60).optional(),
});

function resolvePrivacyAndGroup(
  privacy: 'private' | 'shared' | 'group' | undefined,
  groupId: string | null | undefined,
): { privacy: 'private' | 'shared' | 'group'; groupId: string | null } {
  const p = privacy ?? 'private';
  if (p === 'group') {
    if (!groupId) {
      throw new Error('group_required');
    }
    return { privacy: 'group', groupId };
  }
  return { privacy: p, groupId: null };
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '';
}

chatRoutes.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const groupIds = await getUserGroupIds(user.id);
  const gidSet = new Set(groupIds);

  let rows;
  if (user.role === 'admin' || user.role === 'auditor') {
    rows = await db.select().from(chats).orderBy(desc(chats.updatedAt));
  } else {
    const conds = [eq(chats.ownerId, user.id), eq(chats.privacy, 'shared')];
    if (groupIds.length > 0) {
      conds.push(and(eq(chats.privacy, 'group'), inArray(chats.groupId, groupIds))!);
    }
    rows = await db
      .select()
      .from(chats)
      .where(or(...conds))
      .orderBy(desc(chats.updatedAt));
  }

  const out = rows.map((r) => ({
    id: r.id,
    title: r.title,
    messages: r.messages,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    ownerId: r.ownerId,
    groupId: r.groupId,
    privacy: (r.privacy ?? 'private') as 'private' | 'shared' | 'group',
    threadId: r.threadId,
    threadTitle: r.threadTitle,
    tags: (r.tags as string[]) ?? [],
    versionHistory: (r.versionHistory as unknown[]) ?? [],
  }));

  return c.json({ chats: out });
});

chatRoutes.post('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!roleHasPermission(user.role, 'chats.write_own')) {
    return c.json({ error: 'Your role cannot create chats' }, 403);
  }

  const parsed = chatBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid chat payload' }, 400);

  let resolved: { privacy: 'private' | 'shared' | 'group'; groupId: string | null };
  try {
    resolved = resolvePrivacyAndGroup(parsed.data.privacy, parsed.data.groupId ?? null);
  } catch {
    return c.json({ error: 'Group is required when sharing with a team' }, 400);
  }
  if (resolved.groupId) {
    const gids = await getUserGroupIds(user.id);
    if (!gids.includes(resolved.groupId)) {
      return c.json({ error: 'Not a member of that group' }, 403);
    }
  }

  const now = new Date();
  const [row] = await db
    .insert(chats)
    .values({
      ownerId: user.id,
      groupId: resolved.groupId,
      privacy: resolved.privacy,
      threadId: parsed.data.threadId ?? null,
      threadTitle: parsed.data.threadTitle ?? null,
      tags: (parsed.data.tags ?? []) as unknown[],
      versionHistory: (parsed.data.versionHistory ?? []) as unknown[],
      title: parsed.data.title,
      messages: parsed.data.messages as unknown[],
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await writeAuditLog({
    userId: user.id,
    action: 'chat.create',
    resourceType: 'chat',
    resourceId: row.id,
    ip: clientIp(c),
    metadata: { title: row.title, groupId: row.groupId },
  });

  return c.json({
    chat: {
      id: row.id,
      title: row.title,
      messages: row.messages,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      ownerId: row.ownerId,
      groupId: row.groupId,
      privacy: (row.privacy ?? 'private') as 'private' | 'shared' | 'group',
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      tags: (row.tags as string[]) ?? [],
      versionHistory: (row.versionHistory as unknown[]) ?? [],
    },
  });
});

chatRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const parsed = chatBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid chat payload' }, 400);

  const existing = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
  const chat = existing[0];
  if (!chat) return c.json({ error: 'Not found' }, 404);

  const gids = await getUserGroupIds(user.id);
  const access = canAccessChat(user.role, {
    userId: user.id,
    chatOwnerId: chat.ownerId,
    chatGroupId: chat.groupId,
    chatPrivacy: (chat.privacy ?? 'private') as 'private' | 'shared' | 'group',
    memberOfGroupIds: new Set(gids),
  });
  if (!access.write) return c.json({ error: 'Forbidden' }, 403);
  if (!roleHasPermission(user.role, 'chats.write_own')) {
    return c.json({ error: 'Your role cannot edit chats' }, 403);
  }

  const privacyIn =
    parsed.data.privacy !== undefined
      ? parsed.data.privacy
      : ((chat.privacy ?? 'private') as 'private' | 'shared' | 'group');
  const groupIn = parsed.data.groupId !== undefined ? parsed.data.groupId : chat.groupId;
  let resolved: { privacy: 'private' | 'shared' | 'group'; groupId: string | null };
  try {
    resolved = resolvePrivacyAndGroup(privacyIn, groupIn ?? null);
  } catch {
    return c.json({ error: 'Group is required when sharing with a team' }, 400);
  }
  if (resolved.groupId) {
    const memberGids = await getUserGroupIds(user.id);
    if (!memberGids.includes(resolved.groupId)) {
      return c.json({ error: 'Not a member of target group' }, 403);
    }
  }

  const now = new Date();
  const [row] = await db
    .update(chats)
    .set({
      title: parsed.data.title,
      messages: parsed.data.messages as unknown[],
      groupId: resolved.groupId,
      privacy: resolved.privacy,
      threadId: parsed.data.threadId !== undefined ? parsed.data.threadId : chat.threadId,
      threadTitle:
        parsed.data.threadTitle !== undefined ? parsed.data.threadTitle : chat.threadTitle,
      tags: (parsed.data.tags !== undefined
        ? parsed.data.tags
        : Array.isArray(chat.tags)
          ? (chat.tags as string[])
          : []) as unknown[],
      versionHistory: (parsed.data.versionHistory !== undefined
        ? parsed.data.versionHistory
        : Array.isArray(chat.versionHistory)
          ? chat.versionHistory
          : []) as unknown[],
      updatedAt: now,
    })
    .where(eq(chats.id, id))
    .returning();

  await writeAuditLog({
    userId: user.id,
    action: 'chat.update',
    resourceType: 'chat',
    resourceId: id,
    ip: clientIp(c),
    metadata: { messageCount: parsed.data.messages.length },
  });

  return c.json({
    chat: {
      id: row.id,
      title: row.title,
      messages: row.messages,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      ownerId: row.ownerId,
      groupId: row.groupId,
      privacy: (row.privacy ?? 'private') as 'private' | 'shared' | 'group',
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      tags: (row.tags as string[]) ?? [],
      versionHistory: (row.versionHistory as unknown[]) ?? [],
    },
  });
});

chatRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const existing = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
  const chat = existing[0];
  if (!chat) return c.json({ error: 'Not found' }, 404);

  const gids = await getUserGroupIds(user.id);
  const access = canAccessChat(user.role, {
    userId: user.id,
    chatOwnerId: chat.ownerId,
    chatGroupId: chat.groupId,
    chatPrivacy: (chat.privacy ?? 'private') as 'private' | 'shared' | 'group',
    memberOfGroupIds: new Set(gids),
  });
  if (!access.delete) return c.json({ error: 'Forbidden' }, 403);
  if (!roleHasPermission(user.role, 'chats.delete_own') && user.role !== 'admin') {
    return c.json({ error: 'Your role cannot delete chats' }, 403);
  }

  await db.delete(chats).where(eq(chats.id, id));

  await writeAuditLog({
    userId: user.id,
    action: 'chat.delete',
    resourceType: 'chat',
    resourceId: id,
    ip: clientIp(c),
  });

  return c.json({ ok: true });
});
