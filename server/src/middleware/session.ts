import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { COOKIE_NAME, verifySession } from '../auth/jwt.js';
import type { AppUser } from '../rbac.js';

export type HonoEnv = {
  Variables: {
    user: AppUser | null;
    sessionSub: string | null;
  };
};

export async function sessionMiddleware(c: Context<HonoEnv>, next: Next) {
  const token = getCookie(c, COOKIE_NAME);
  const session = token ? await verifySession(token) : null;
  let user: AppUser | null = null;
  if (session?.sub) {
    const rows = await db.select().from(users).where(eq(users.id, session.sub)).limit(1);
    user = rows[0] ?? null;
  }
  c.set('user', user);
  c.set('sessionSub', session?.sub ?? null);
  await next();
}
