import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { prompts } from '../db/schema.js';
import type { HonoEnv } from '../middleware/session.js';

export const promptRoutes = new Hono<HonoEnv>();

/** Latest stored prompt per kind (chat / agent). Missing rows mean clients fall back to bundled defaults. */
promptRoutes.get('/prompts', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [chatRow] = await db
    .select()
    .from(prompts)
    .where(eq(prompts.type, 'chat'))
    .orderBy(desc(prompts.createdAt))
    .limit(1);

  const [agentRow] = await db
    .select()
    .from(prompts)
    .where(eq(prompts.type, 'agent'))
    .orderBy(desc(prompts.createdAt))
    .limit(1);

  return c.json({
    chat: chatRow
      ? {
          id: chatRow.id,
          content: chatRow.content,
          createdAt: chatRow.createdAt.toISOString(),
        }
      : null,
    agent: agentRow
      ? {
          id: agentRow.id,
          content: agentRow.content,
          createdAt: agentRow.createdAt.toISOString(),
        }
      : null,
  });
});
