import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chats, groups, users } from '../db/schema.js';
import {
  auditActorSnapshot,
  auditRequestContext,
  writeStructuredAuditLog,
} from '../audit.js';
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

function serializeChat(
  row: typeof chats.$inferSelect,
  access: { read: boolean; write: boolean; delete: boolean },
  extras?: { ownerDisplayName?: string | null; groupName?: string | null },
) {
  return {
    id: row.id,
    title: row.title,
    messages: row.messages,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ownerId: row.ownerId,
    ownerDisplayName: extras?.ownerDisplayName ?? null,
    groupId: row.groupId,
    groupName: extras?.groupName ?? null,
    privacy: (row.privacy ?? 'private') as 'private' | 'shared' | 'group',
    access,
    threadId: row.threadId,
    threadTitle: row.threadTitle,
    tags: (row.tags as string[]) ?? [],
    versionHistory: (row.versionHistory as unknown[]) ?? [],
  };
}

function chatStateSnapshot(row: typeof chats.$inferSelect) {
  return {
    title: row.title,
    privacy: row.privacy ?? 'private',
    groupId: row.groupId,
    threadId: row.threadId,
    threadTitle: row.threadTitle,
    tags: (row.tags as string[]) ?? [],
    tagCount: Array.isArray(row.tags) ? row.tags.length : 0,
    messageCount: Array.isArray(row.messages) ? row.messages.length : 0,
    versionCount: Array.isArray(row.versionHistory) ? row.versionHistory.length : 0,
  };
}

function chatTargetSnapshot(
  row: typeof chats.$inferSelect,
  extras?: { ownerDisplayName?: string | null; groupName?: string | null },
) {
  return {
    type: 'chat',
    id: row.id,
    label: row.title,
    ownerId: row.ownerId,
    ownerDisplayName: extras?.ownerDisplayName ?? null,
    groupId: row.groupId,
    groupName: extras?.groupName ?? null,
  };
}

function chatAccessMode(
  user: NonNullable<HonoEnv['Variables']['user']>,
  row: typeof chats.$inferSelect,
  groupIds: string[],
): string {
  if (row.ownerId === user.id) return 'owner';
  if (roleHasPermission(user.role, 'chats.read_all')) return `${user.role}_read_all`;
  if ((row.privacy ?? 'private') === 'shared') return 'shared';
  if ((row.privacy ?? 'private') === 'group' && row.groupId && groupIds.includes(row.groupId)) {
    return 'group_member';
  }
  return 'none';
}

chatRoutes.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const groupIds = await getUserGroupIds(user.id);
  const gidSet = new Set(groupIds);

  let rows;
  if (user.role === 'admin' || user.role === 'auditor') {
    rows = await db
      .select({ chat: chats, ownerDisplayName: users.displayName, groupName: groups.name })
      .from(chats)
      .innerJoin(users, eq(chats.ownerId, users.id))
      .leftJoin(groups, eq(chats.groupId, groups.id))
      .orderBy(desc(chats.updatedAt));
  } else {
    const conds = [eq(chats.ownerId, user.id), eq(chats.privacy, 'shared')];
    if (groupIds.length > 0) {
      conds.push(and(eq(chats.privacy, 'group'), inArray(chats.groupId, groupIds))!);
    }
    rows = await db
      .select({ chat: chats, ownerDisplayName: users.displayName, groupName: groups.name })
      .from(chats)
      .innerJoin(users, eq(chats.ownerId, users.id))
      .leftJoin(groups, eq(chats.groupId, groups.id))
      .where(or(...conds))
      .orderBy(desc(chats.updatedAt));
  }

  const out = rows
    .map((r) => {
      const access = canAccessChat(user.role, {
        userId: user.id,
        chatOwnerId: r.chat.ownerId,
        chatGroupId: r.chat.groupId,
        chatPrivacy: (r.chat.privacy ?? 'private') as 'private' | 'shared' | 'group',
        memberOfGroupIds: gidSet,
      });
      if (!access.read) return null;
      return serializeChat(r.chat, access, {
        ownerDisplayName: r.ownerDisplayName,
        groupName: r.groupName,
      });
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  return c.json({ chats: out });
});

chatRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const [row] = await db
    .select({ chat: chats, ownerDisplayName: users.displayName, groupName: groups.name })
    .from(chats)
    .innerJoin(users, eq(chats.ownerId, users.id))
    .leftJoin(groups, eq(chats.groupId, groups.id))
    .where(eq(chats.id, id))
    .limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);

  const groupIds = await getUserGroupIds(user.id);
  const access = canAccessChat(user.role, {
    userId: user.id,
    chatOwnerId: row.chat.ownerId,
    chatGroupId: row.chat.groupId,
    chatPrivacy: (row.chat.privacy ?? 'private') as 'private' | 'shared' | 'group',
    memberOfGroupIds: new Set(groupIds),
  });
  const context = auditRequestContext(c);
  const mode = chatAccessMode(user, row.chat, groupIds);

  if (!access.read) {
    await writeStructuredAuditLog({
      action: 'chat.read',
      resourceType: 'chat',
      resourceId: id,
      actor: auditActorSnapshot(user),
      context,
      target: chatTargetSnapshot(row.chat, {
        ownerDisplayName: row.ownerDisplayName,
        groupName: row.groupName,
      }),
      access: {
        mode,
        reason: 'chat_not_visible',
        privacy: row.chat.privacy ?? 'private',
        isOwner: row.chat.ownerId === user.id,
        groupId: row.chat.groupId,
        groupName: row.groupName,
      },
      result: { status: 'denied', code: 403, reason: 'forbidden' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }

  await writeStructuredAuditLog({
    action: 'chat.read',
    resourceType: 'chat',
    resourceId: id,
    actor: auditActorSnapshot(user),
    context,
    target: chatTargetSnapshot(row.chat, {
      ownerDisplayName: row.ownerDisplayName,
      groupName: row.groupName,
    }),
    access: {
      mode,
      reason: access.write ? 'owner_or_full_control' : 'locked_read_only',
      privacy: row.chat.privacy ?? 'private',
      isOwner: row.chat.ownerId === user.id,
      groupId: row.chat.groupId,
      groupName: row.groupName,
    },
    result: { status: 'success', code: 200 },
    details: {
      locked: !access.write,
      messageCount: Array.isArray(row.chat.messages) ? row.chat.messages.length : 0,
    },
  });

  return c.json({
    chat: serializeChat(row.chat, access, {
      ownerDisplayName: row.ownerDisplayName,
      groupName: row.groupName,
    }),
  });
});

chatRoutes.post('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!roleHasPermission(user.role, 'chats.write_own')) {
    await writeStructuredAuditLog({
      action: 'chat.create',
      resourceType: 'chat',
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      result: { status: 'denied', code: 403, reason: 'role_cannot_create_chat' },
    });
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
      await writeStructuredAuditLog({
        action: 'chat.create',
        resourceType: 'chat',
        actor: auditActorSnapshot(user),
        context: auditRequestContext(c),
        access: { mode: 'owner', reason: 'not_in_target_group', privacy: resolved.privacy, groupId: resolved.groupId },
        result: { status: 'denied', code: 403, reason: 'not_in_target_group' },
      });
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

  await writeStructuredAuditLog({
    action: 'chat.create',
    resourceType: 'chat',
    resourceId: row.id,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: chatTargetSnapshot(row, { ownerDisplayName: user.displayName }),
    access: {
      mode: 'owner',
      reason: 'owner_created_chat',
      privacy: row.privacy ?? 'private',
      isOwner: true,
      groupId: row.groupId,
    },
    result: { status: 'success', code: 200 },
    details: chatStateSnapshot(row),
  });

  return c.json({
    chat: serializeChat(
      row,
      canAccessChat(user.role, {
        userId: user.id,
        chatOwnerId: row.ownerId,
        chatGroupId: row.groupId,
        chatPrivacy: (row.privacy ?? 'private') as 'private' | 'shared' | 'group',
        memberOfGroupIds: new Set(await getUserGroupIds(user.id)),
      }),
      { ownerDisplayName: user.displayName },
    ),
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
  const context = auditRequestContext(c);
  const mode = chatAccessMode(user, chat, gids);
  if (!access.write) {
    await writeStructuredAuditLog({
      action: 'chat.update',
      resourceType: 'chat',
      resourceId: id,
      actor: auditActorSnapshot(user),
      context,
      target: chatTargetSnapshot(chat),
      access: {
        mode,
        reason: 'chat_locked_or_not_visible',
        privacy: chat.privacy ?? 'private',
        isOwner: chat.ownerId === user.id,
        groupId: chat.groupId,
      },
      result: { status: 'denied', code: 403, reason: 'forbidden' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!roleHasPermission(user.role, 'chats.write_own')) {
    await writeStructuredAuditLog({
      action: 'chat.update',
      resourceType: 'chat',
      resourceId: id,
      actor: auditActorSnapshot(user),
      context,
      target: chatTargetSnapshot(chat),
      access: {
        mode,
        reason: 'role_cannot_edit_chat',
        privacy: chat.privacy ?? 'private',
        isOwner: chat.ownerId === user.id,
        groupId: chat.groupId,
      },
      result: { status: 'denied', code: 403, reason: 'role_cannot_edit_chat' },
    });
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
      await writeStructuredAuditLog({
        action: 'chat.update',
        resourceType: 'chat',
        resourceId: id,
        actor: auditActorSnapshot(user),
        context,
        target: chatTargetSnapshot(chat),
        access: {
          mode,
          reason: 'not_in_target_group',
          privacy: resolved.privacy,
          isOwner: chat.ownerId === user.id,
          groupId: resolved.groupId,
        },
        result: { status: 'denied', code: 403, reason: 'not_in_target_group' },
      });
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

  const beforeState = chatStateSnapshot(chat);
  const afterState = chatStateSnapshot(row);
  const changedFields = Object.keys(afterState).filter(
    (key) => JSON.stringify(beforeState[key as keyof typeof beforeState]) !== JSON.stringify(afterState[key as keyof typeof afterState]),
  );

  await writeStructuredAuditLog({
    action: 'chat.update',
    resourceType: 'chat',
    resourceId: id,
    actor: auditActorSnapshot(user),
    context,
    target: chatTargetSnapshot(row, { ownerDisplayName: user.displayName }),
    access: {
      mode,
      reason: 'owner_edit',
      privacy: row.privacy ?? 'private',
      isOwner: row.ownerId === user.id,
      groupId: row.groupId,
    },
    change: {
      fields: changedFields,
      before: beforeState,
      after: afterState,
    },
    result: { status: 'success', code: 200 },
  });

  return c.json({
    chat: serializeChat(
      row,
      canAccessChat(user.role, {
        userId: user.id,
        chatOwnerId: row.ownerId,
        chatGroupId: row.groupId,
        chatPrivacy: (row.privacy ?? 'private') as 'private' | 'shared' | 'group',
        memberOfGroupIds: new Set(gids),
      }),
      { ownerDisplayName: user.displayName },
    ),
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
  const context = auditRequestContext(c);
  const mode = chatAccessMode(user, chat, gids);
  if (!access.delete) {
    await writeStructuredAuditLog({
      action: 'chat.delete',
      resourceType: 'chat',
      resourceId: id,
      actor: auditActorSnapshot(user),
      context,
      target: chatTargetSnapshot(chat),
      access: {
        mode,
        reason: 'chat_locked_or_not_owned',
        privacy: chat.privacy ?? 'private',
        isOwner: chat.ownerId === user.id,
        groupId: chat.groupId,
      },
      result: { status: 'denied', code: 403, reason: 'forbidden' },
    });
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!roleHasPermission(user.role, 'chats.delete_own') && user.role !== 'admin') {
    await writeStructuredAuditLog({
      action: 'chat.delete',
      resourceType: 'chat',
      resourceId: id,
      actor: auditActorSnapshot(user),
      context,
      target: chatTargetSnapshot(chat),
      access: {
        mode,
        reason: 'role_cannot_delete_chat',
        privacy: chat.privacy ?? 'private',
        isOwner: chat.ownerId === user.id,
        groupId: chat.groupId,
      },
      result: { status: 'denied', code: 403, reason: 'role_cannot_delete_chat' },
    });
    return c.json({ error: 'Your role cannot delete chats' }, 403);
  }

  await db.delete(chats).where(eq(chats.id, id));

  await writeStructuredAuditLog({
    action: 'chat.delete',
    resourceType: 'chat',
    resourceId: id,
    actor: auditActorSnapshot(user),
    context,
    target: chatTargetSnapshot(chat),
    access: {
      mode,
      reason: 'owner_delete',
      privacy: chat.privacy ?? 'private',
      isOwner: chat.ownerId === user.id,
      groupId: chat.groupId,
    },
    result: { status: 'success', code: 200 },
    details: chatStateSnapshot(chat),
  });

  return c.json({ ok: true });
});
