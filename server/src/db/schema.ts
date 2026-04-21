import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  pgEnum,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['admin', 'developer', 'tester', 'auditor']);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: userRoleEnum('role').notNull().default('developer'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const groups = pgTable('groups', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .references(() => groups.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    roleInGroup: text('role_in_group').notNull().default('member'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
  }),
);

export const groupWorkspaces = pgTable(
  'group_workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .references(() => groups.id, { onDelete: 'cascade' })
      .notNull(),
    label: text('label').notNull(),
    rootPath: text('root_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    groupIdx: index('group_workspaces_group_idx').on(t.groupId),
  }),
);

export const chats = pgTable(
  'chats',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
    /** private = owner only; shared = all authenticated users; group = members of groupId */
    privacy: text('privacy').notNull().default('private'),
    threadId: uuid('thread_id'),
    threadTitle: text('thread_title'),
    tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),
    versionHistory: jsonb('version_history').notNull().default(sql`'[]'::jsonb`),
    title: text('title').notNull(),
    messages: jsonb('messages').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index('chats_owner_idx').on(t.ownerId),
    groupIdx: index('chats_group_idx').on(t.groupId),
    threadIdx: index('chats_thread_idx').on(t.threadId),
  }),
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    createdIdx: index('audit_logs_created_idx').on(t.createdAt),
    userIdx: index('audit_logs_user_idx').on(t.userId),
    actionIdx: index('audit_logs_action_idx').on(t.action),
    resourceTypeIdx: index('audit_logs_resource_type_idx').on(t.resourceType),
  }),
);
