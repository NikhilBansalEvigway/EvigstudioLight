import { Hono } from 'hono';
import { z } from 'zod';
import { auditActorSnapshot, auditRequestContext, writeStructuredAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';

export const auditEventRoutes = new Hono<HonoEnv>();

const querySchema = z.object({
  chatId: z.string().uuid().optional(),
  chatTitle: z.string().max(500).optional(),
  chatMode: z.enum(['chat', 'agent']).optional(),
  model: z.string().max(200).optional(),
  preview: z.string().max(2000).optional(),
  promptLength: z.number().int().min(0).max(2000000).optional(),
  imageCount: z.number().int().min(0).max(50).optional(),
  mentionedFileCount: z.number().int().min(0).max(500).optional(),
  workspaceFolders: z.array(z.string().trim().min(1).max(240)).max(50).optional(),
  contextFiles: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
  mentionedFiles: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
  workspaceRootSummaries: z.array(z.object({
    label: z.string().trim().min(1).max(240),
    opaqueLabel: z.boolean(),
    topLevelEntries: z.array(z.string().trim().min(1).max(120)).max(6),
  })).max(50).optional(),
  activeDocument: z.object({
    path: z.string().trim().min(1).max(1000),
    fileName: z.string().trim().min(1).max(240),
    folderPath: z.string().trim().min(1).max(1000).nullable().optional(),
    workspaceFolder: z.string().trim().min(1).max(240).nullable().optional(),
  }).optional().nullable(),
});

const workspaceEventSchema = z.object({
  event: z.enum(['open', 'refresh', 'folder_remove', 'clear', 'context_update']),
  chatId: z.string().uuid().optional(),
  chatTitle: z.string().max(500).optional(),
  chatMode: z.enum(['chat', 'agent']).optional(),
  workspaceFolders: z.array(z.string().trim().min(1).max(240)).max(50),
  contextFiles: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
  activeFilePath: z.string().trim().min(1).max(1000).optional().nullable(),
  addedFolder: z.string().trim().min(1).max(240).optional().nullable(),
  removedFolder: z.string().trim().min(1).max(240).optional().nullable(),
  changedPath: z.string().trim().min(1).max(1000).optional().nullable(),
  changeKind: z.enum(['add', 'remove', 'clear']).optional().nullable(),
  trigger: z.string().trim().min(1).max(120).optional().nullable(),
  workspaceRootSummaries: z.array(z.object({
    label: z.string().trim().min(1).max(240),
    opaqueLabel: z.boolean(),
    topLevelEntries: z.array(z.string().trim().min(1).max(120)).max(6),
  })).max(50).optional(),
  activeDocument: z.object({
    path: z.string().trim().min(1).max(1000),
    fileName: z.string().trim().min(1).max(240),
    folderPath: z.string().trim().min(1).max(1000).nullable().optional(),
    workspaceFolder: z.string().trim().min(1).max(240).nullable().optional(),
  }).optional().nullable(),
});

/** Client-reported LLM query metadata (full prompts stay local unless you choose to send them). */
auditEventRoutes.post('/query', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = querySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

  await writeStructuredAuditLog({
    action: 'llm.query',
    resourceType: 'chat',
    resourceId: parsed.data.chatId ?? null,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: {
      type: 'chat',
      id: parsed.data.chatId ?? null,
      label: parsed.data.chatTitle ?? null,
    },
    result: { status: 'success', code: 200 },
    details: {
      model: parsed.data.model ?? null,
      preview: parsed.data.preview ?? null,
      chatMode: parsed.data.chatMode ?? null,
      promptLength: parsed.data.promptLength ?? null,
      imageCount: parsed.data.imageCount ?? 0,
      mentionedFileCount: parsed.data.mentionedFileCount ?? 0,
      workspaceFolders: parsed.data.workspaceFolders ?? [],
      workspaceFolderCount: parsed.data.workspaceFolders?.length ?? 0,
      contextFiles: parsed.data.contextFiles ?? [],
      contextFileCount: parsed.data.contextFiles?.length ?? 0,
      mentionedFiles: parsed.data.mentionedFiles ?? [],
      workspaceRootSummaries: parsed.data.workspaceRootSummaries ?? [],
      activeDocument: parsed.data.activeDocument ?? null,
    },
  });

  return c.json({ ok: true });
});

auditEventRoutes.post('/workspace', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = workspaceEventSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

  await writeStructuredAuditLog({
    action: `workspace.${parsed.data.event}`,
    resourceType: 'workspace',
    resourceId: parsed.data.chatId ?? null,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: {
      type: 'workspace',
      id: parsed.data.chatId ?? null,
      label: parsed.data.chatTitle ?? null,
    },
    result: { status: 'success', code: 200 },
    details: {
      chatMode: parsed.data.chatMode ?? null,
      workspaceFolders: parsed.data.workspaceFolders,
      workspaceFolderCount: parsed.data.workspaceFolders.length,
      contextFiles: parsed.data.contextFiles ?? [],
      contextFileCount: parsed.data.contextFiles?.length ?? 0,
      activeFilePath: parsed.data.activeFilePath ?? null,
      addedFolder: parsed.data.addedFolder ?? null,
      removedFolder: parsed.data.removedFolder ?? null,
      changedPath: parsed.data.changedPath ?? null,
      changeKind: parsed.data.changeKind ?? null,
      trigger: parsed.data.trigger ?? null,
      workspaceRootSummaries: parsed.data.workspaceRootSummaries ?? [],
      activeDocument: parsed.data.activeDocument ?? null,
    },
  });

  return c.json({ ok: true });
});
