import { Hono } from 'hono';
import type { HonoEnv } from '../middleware/session.js';

export const healthRoutes = new Hono<HonoEnv>();

healthRoutes.get('/health', (c) => c.json({ ok: true, service: 'evigstudio-api' }));
