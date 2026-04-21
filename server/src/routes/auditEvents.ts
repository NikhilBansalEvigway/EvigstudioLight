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
    },
  });

  return c.json({ ok: true });
});
