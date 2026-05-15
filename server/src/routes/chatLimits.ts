import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import type { HonoEnv } from '../middleware/session.js';

export const chatLimitsRoutes = new Hono<HonoEnv>();

const CHAT_LIMITS_KEY = 'chat_limits';

export type ChatLimits = {
  /** Approximate budget in characters for the full prompt context window. */
  contextBudgetChars: number;
};

const DEFAULT_CHAT_LIMITS: ChatLimits = {
  contextBudgetChars: 120_000,
};

function normalizeLimits(value: unknown): ChatLimits {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const n = typeof raw.contextBudgetChars === 'number' ? raw.contextBudgetChars : DEFAULT_CHAT_LIMITS.contextBudgetChars;
  const bounded = Number.isFinite(n) ? Math.round(n) : DEFAULT_CHAT_LIMITS.contextBudgetChars;
  // Keep it sane and bounded.
  return {
    contextBudgetChars: Math.min(500_000, Math.max(40_000, bounded)),
  };
}

chatLimitsRoutes.get('/chat-limits', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, CHAT_LIMITS_KEY)).limit(1);
  const limits = row ? normalizeLimits(row.value) : DEFAULT_CHAT_LIMITS;
  return c.json({ limits, updatedAt: row?.updatedAt?.toISOString?.() ?? null });
});

export function getDefaultChatLimits(): ChatLimits {
  return DEFAULT_CHAT_LIMITS;
}

export function coerceChatLimits(value: unknown): ChatLimits {
  return normalizeLimits(value);
}

export const CHAT_LIMITS_KEY_NAME = CHAT_LIMITS_KEY;
