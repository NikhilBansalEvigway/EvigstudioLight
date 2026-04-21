import type { InferSelectModel } from 'drizzle-orm';
import type { users } from './db/schema.js';

export type AppUser = InferSelectModel<typeof users>;
export type RoleName = AppUser['role'];

/** Fine-grained permission keys checked by middleware and route handlers */
export const PERMISSIONS = [
  'chats.read_own',
  'chats.write_own',
  'chats.delete_own',
  'chats.read_all',
  'chats.write_all',
  'groups.read',
  'groups.manage',
  'users.manage',
  'audit.read',
  'workspace.shares_manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission | '*'>(['*']);

const ROLE_PERMISSIONS: Record<RoleName, Set<Permission | '*'>> = {
  admin: ALL,
  developer: new Set([
    'chats.read_own',
    'chats.write_own',
    'chats.delete_own',
    'groups.read',
    'groups.manage',
    'workspace.shares_manage',
  ]),
  tester: new Set(['chats.read_own', 'chats.write_own', 'groups.read']),
  auditor: new Set(['chats.read_all', 'groups.read', 'audit.read']),
};

export function roleHasPermission(role: RoleName, permission: Permission): boolean {
  const set = ROLE_PERMISSIONS[role];
  return set.has('*') || set.has(permission);
}

export type ChatPrivacy = 'private' | 'shared' | 'group';

export function canAccessChat(
  role: RoleName,
  opts: {
    userId: string;
    chatOwnerId: string;
    chatGroupId: string | null;
    chatPrivacy: ChatPrivacy;
    memberOfGroupIds: Set<string>;
  },
): { read: boolean; write: boolean; delete: boolean } {
  const isOwner = opts.userId === opts.chatOwnerId;
  const inSharedGroup =
    opts.chatGroupId != null && opts.memberOfGroupIds.has(opts.chatGroupId);
  const privacy: ChatPrivacy =
    opts.chatPrivacy === 'shared' || opts.chatPrivacy === 'group' ? opts.chatPrivacy : 'private';

  if (isOwner) {
    return {
      read: roleHasPermission(role, 'chats.read_own') || roleHasPermission(role, 'chats.read_all'),
      write: roleHasPermission(role, 'chats.write_own') || roleHasPermission(role, 'chats.write_all'),
      delete: roleHasPermission(role, 'chats.delete_own'),
    };
  }
  if (roleHasPermission(role, 'chats.read_all')) {
    return { read: true, write: false, delete: false };
  }
  if (privacy === 'private') {
    return { read: false, write: false, delete: false };
  }
  if (privacy === 'shared') {
    const read = roleHasPermission(role, 'chats.read_own');
    return { read, write: false, delete: false };
  }
  if (privacy === 'group' && inSharedGroup) {
    return { read: roleHasPermission(role, 'chats.read_own'), write: false, delete: false };
  }
  return { read: false, write: false, delete: false };
}
