import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { count, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { COOKIE_NAME, signSession } from '../auth/jwt.js';
import { auditActorSnapshot, auditRequestContext, writeStructuredAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';
import type { RoleName } from '../rbac.js';

export const authRoutes = new Hono<HonoEnv>();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

const REMEMBER_ME_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  token: string,
  options?: { rememberMe?: boolean },
) {
  const rememberMe = options?.rememberMe === true;
  setCookie(c, COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    ...(rememberMe ? { maxAge: REMEMBER_ME_MAX_AGE_SECONDS } : {}),
  });
}

authRoutes.post('/register', async (c) => {
  const body = registerSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'Invalid payload' }, 400);

  const [row] = await db.select({ total: count() }).from(users);
  const isFirst = Number(row?.total ?? 0) === 0;
  const role: RoleName = isFirst ? 'admin' : 'developer';

  const passwordHash = await bcrypt.hash(body.data.password, 10);

  try {
    const [row] = await db
      .insert(users)
      .values({
        email: body.data.email.toLowerCase(),
        passwordHash,
        displayName: body.data.displayName,
        role,
      })
      .returning();

    const token = await signSession({
      sub: row.id,
      email: row.email,
      role: row.role,
    });

    setSessionCookie(c, token);

    await writeStructuredAuditLog({
      action: 'user.register',
      resourceType: 'user',
      resourceId: row.id,
      actor: auditActorSnapshot(row),
      context: auditRequestContext(c),
      target: {
        type: 'user',
        id: row.id,
        label: row.email,
      },
      result: { status: 'success', code: 200 },
      details: { bootstrapAdmin: isFirst },
    });

    return c.json({
      user: { id: row.id, email: row.email, displayName: row.displayName, role: row.role },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return c.json({ error: 'Email already registered' }, 409);
    }
    console.error(e);
    return c.json({ error: 'Registration failed' }, 500);
  }
});

authRoutes.post('/login', async (c) => {
  const body = loginSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: 'Invalid payload' }, 400);

  const email = body.data.email.toLowerCase();
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(body.data.password, user.passwordHash))) {
    await writeStructuredAuditLog({
      action: 'auth.login_failed',
      resourceType: 'user',
      resourceId: email,
      context: auditRequestContext(c),
      target: {
        type: 'user',
        id: null,
        label: email,
      },
      result: { status: 'denied', code: 401, reason: 'invalid_credentials' },
    });
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const rememberMe = body.data.rememberMe === true;
  const token = await signSession(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
    },
    rememberMe ? '30d' : '7d',
  );

  setSessionCookie(c, token, { rememberMe });

  await writeStructuredAuditLog({
    action: 'auth.login',
    resourceType: 'user',
    resourceId: user.id,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: {
      type: 'user',
      id: user.id,
      label: user.email,
    },
    result: { status: 'success', code: 200 },
    details: { rememberMe },
  });

  return c.json({
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
  });
});

authRoutes.post('/logout', async (c) => {
  const u = c.get('user');
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  if (u) {
    await writeStructuredAuditLog({
      action: 'auth.logout',
      resourceType: 'user',
      resourceId: u.id,
      actor: auditActorSnapshot(u),
      context: auditRequestContext(c),
      target: {
        type: 'user',
        id: u.id,
        label: u.email,
      },
      result: { status: 'success', code: 200 },
    });
  }
  return c.json({ ok: true });
});

authRoutes.post('/change-password', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = changePasswordSchema.safeParse(await c.req.json());
  if (!body.success) {
    await writeStructuredAuditLog({
      action: 'auth.password_change',
      resourceType: 'user',
      resourceId: user.id,
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      target: { type: 'user', id: user.id, label: user.email },
      result: { status: 'error', code: 400, reason: 'invalid_payload' },
    });
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const matchesCurrent = await bcrypt.compare(body.data.currentPassword, user.passwordHash);
  if (!matchesCurrent) {
    await writeStructuredAuditLog({
      action: 'auth.password_change',
      resourceType: 'user',
      resourceId: user.id,
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      target: { type: 'user', id: user.id, label: user.email },
      result: { status: 'denied', code: 400, reason: 'invalid_current_password' },
    });
    return c.json({ error: 'Current password is incorrect' }, 400);
  }

  const reusesCurrent = await bcrypt.compare(body.data.newPassword, user.passwordHash);
  if (reusesCurrent) {
    await writeStructuredAuditLog({
      action: 'auth.password_change',
      resourceType: 'user',
      resourceId: user.id,
      actor: auditActorSnapshot(user),
      context: auditRequestContext(c),
      target: { type: 'user', id: user.id, label: user.email },
      result: { status: 'denied', code: 400, reason: 'password_unchanged' },
    });
    return c.json({ error: 'New password must be different from the current password' }, 400);
  }

  const passwordHash = await bcrypt.hash(body.data.newPassword, 10);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

  await writeStructuredAuditLog({
    action: 'auth.password_change',
    resourceType: 'user',
    resourceId: user.id,
    actor: auditActorSnapshot(user),
    context: auditRequestContext(c),
    target: { type: 'user', id: user.id, label: user.email },
    change: {
      fields: ['password'],
      before: { passwordChanged: false },
      after: { passwordChanged: true },
    },
    result: { status: 'success', code: 200 },
  });

  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const u = c.get('user');
  if (!u) return c.json({ user: null }, 401);
  return c.json({
    user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role },
  });
});
