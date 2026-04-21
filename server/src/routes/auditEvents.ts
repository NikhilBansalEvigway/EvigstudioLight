import { Hono } from 'hono';
import { z } from 'zod';
import { writeAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';

export const auditEventRoutes = new Hono<HonoEnv>();

const querySchema = z.object({
  chatId: z.string().uuid().optional(),
  model: z.string().max(200).optional(),
  preview: z.string().max(2000).optional(),
});

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '';
}

/** Client-reported LLM query metadata (full prompts stay local unless you choose to send them). */
auditEventRoutes.post('/query', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const parsed = querySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid payload' }, 400);

  await writeAuditLog({
    userId: user.id,
    action: 'llm.query',
    resourceType: 'chat',
    resourceId: parsed.data.chatId ?? null,
    ip: clientIp(c),
    metadata: {
      model: parsed.data.model ?? null,
      preview: parsed.data.preview ?? null,
    },
  });

  return c.json({ ok: true });
});
