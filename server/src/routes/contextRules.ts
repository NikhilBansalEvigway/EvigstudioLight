import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import type { HonoEnv } from '../middleware/session.js';

export const contextRulesRoutes = new Hono<HonoEnv>();

export type ContextRules = {
  allowedExtensions: string[];
  allowedBasenames: string[];
  allowDotEnv: boolean;
};

const DEFAULT_CONTEXT_RULES: ContextRules = {
  allowedExtensions: [
    '.m', '.vhd', '.vhdl',
    '.txt', '.md', '.json',
    '.v', '.sv',
    '.py',
    '.c', '.h', '.cpp', '.hpp',
    '.ts', '.tsx', '.js', '.jsx',
    '.css', '.scss', '.html',
    '.xml', '.yaml', '.yml', '.toml', '.cfg', '.ini',
    '.sh', '.ps1', '.bat',
    '.java', '.kt', '.go', '.rs', '.php', '.sql',
  ],
  allowedBasenames: ['Dockerfile', 'Makefile', 'CMakeLists.txt'],
  allowDotEnv: true,
};

function normalizeRules(value: unknown): ContextRules {
  const rules = (value && typeof value === 'object' ? (value as Record<string, unknown>) : {}) as Record<string, unknown>;
  const allowedExtensions = Array.isArray(rules.allowedExtensions)
    ? rules.allowedExtensions.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
    : DEFAULT_CONTEXT_RULES.allowedExtensions;
  const allowedBasenames = Array.isArray(rules.allowedBasenames)
    ? rules.allowedBasenames.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
    : DEFAULT_CONTEXT_RULES.allowedBasenames;
  const allowDotEnv = typeof rules.allowDotEnv === 'boolean' ? rules.allowDotEnv : DEFAULT_CONTEXT_RULES.allowDotEnv;

  // Keep it sane and bounded.
  return {
    allowedExtensions: [...new Set(allowedExtensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)))].slice(0, 200),
    allowedBasenames: [...new Set(allowedBasenames)].slice(0, 200),
    allowDotEnv,
  };
}

contextRulesRoutes.get('/context-rules', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, 'context_rules'))
    .limit(1);

  const rules = row ? normalizeRules(row.value) : DEFAULT_CONTEXT_RULES;
  return c.json({ rules, updatedAt: row?.updatedAt?.toISOString?.() ?? null });
});

export function getDefaultContextRules(): ContextRules {
  return DEFAULT_CONTEXT_RULES;
}

export function coerceContextRules(value: unknown): ContextRules {
  return normalizeRules(value);
}
