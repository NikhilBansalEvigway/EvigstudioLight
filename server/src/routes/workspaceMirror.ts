import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoEnv } from '../middleware/session.js';
import {
  MAX_FILE_BYTES,
  getMirrorConfig,
  resolveMirrorTargetAbs,
  safeEqualToken,
} from '../lib/workspaceMirrorPaths.js';

const putBodySchema = z.object({
  rootLabel: z.string().min(1).max(500),
  relativePath: z.string().min(1).max(8192),
  content: z.string().max(MAX_FILE_BYTES),
});

export const workspaceMirrorRoutes = new Hono<HonoEnv>();

workspaceMirrorRoutes.get('/workspace-mirror/status', (c) => {
  const cfg = getMirrorConfig();
  if (!cfg) return c.json({ enabled: false, requiresToken: false });
  return c.json({ enabled: true, requiresToken: Boolean(cfg.token) });
});

workspaceMirrorRoutes.put('/workspace-mirror/file', async (c) => {
  const cfg = getMirrorConfig();
  if (!cfg) return c.json({ error: 'mirror_disabled' }, 404);

  const user = c.get('user');
  const headerTok = c.req.header('X-Evig-Local-Mirror-Token')?.trim() ?? '';

  let authorized = false;
  if (cfg.token) {
    if (headerTok && safeEqualToken(headerTok, cfg.token)) authorized = true;
  } else if (user) {
    authorized = true;
  }

  if (!authorized) {
    return c.json(
      {
        error: 'unauthorized',
        message: cfg.token
          ? 'Set the same LOCAL_WORKSPACE_MIRROR_TOKEN value in the browser (Files tab → server disk sync) or sign in if your deployment allows session-only mirror writes.'
          : 'Local workspace mirror requires a signed-in user when LOCAL_WORKSPACE_MIRROR_TOKEN is not set.',
      },
      401,
    );
  }

  let body: z.infer<typeof putBodySchema>;
  try {
    body = putBodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const buf = Buffer.from(body.content, 'utf8');
  if (buf.length > MAX_FILE_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413);
  }

  let targetAbs: string;
  try {
    targetAbs = resolveMirrorTargetAbs(cfg.root, body.rootLabel, body.relativePath);
  } catch {
    return c.json({ error: 'invalid_relative_path' }, 400);
  }

  try {
    await mkdir(dirname(targetAbs), { recursive: true });
    await writeFile(targetAbs, buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: 'write_failed', message: msg }, 500);
  }

  return c.json({ ok: true, path: relative(cfg.root, targetAbs) });
});
