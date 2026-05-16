import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { HonoEnv } from '../middleware/session.js';

// In-memory cache for active status (resets on restart, that's fine)
export const lastSeenMap = new Map<string, number>();

export const activeUserRoutes = new Hono<HonoEnv>();

activeUserRoutes.post('/heartbeat', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const now = new Date();
  lastSeenMap.set(user.id, now.getTime());

  // Persist to DB so it survives server restarts
  await db
    .update(users)
    .set({ lastSeen: now })
    .where(eq(users.id, user.id));

  return c.json({ ok: true });
});

activeUserRoutes.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const activeCutoff = Date.now() - 60_000;
  const allUsers = await db.select().from(users);

  const result = allUsers
    .map((u) => {
      // Use in-memory map first (more accurate), fall back to DB value
      const lastSeenTs = lastSeenMap.get(u.id) ?? u.lastSeen?.getTime() ?? null;
      const status = lastSeenTs && lastSeenTs > activeCutoff ? 'active' : 'idle';
      return {
        id: u.id,
        displayName: u.displayName,
        email: u.email,
        lastSeen: lastSeenTs,
        status,
      };
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      if (a.lastSeen === null && b.lastSeen === null) return 0;
      if (a.lastSeen === null) return 1;
      if (b.lastSeen === null) return -1;
      return b.lastSeen - a.lastSeen;
    });

  return c.json(result);
});
