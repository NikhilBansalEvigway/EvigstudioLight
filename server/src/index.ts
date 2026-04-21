import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { existsSync } from 'node:fs';
import { verifyPostgresOrExit } from './db/verifyPostgres.js';
import { backfillLegacyAuditLogs, cleanupExpiredAuditLogs } from './audit.js';
import { sessionMiddleware, type HonoEnv } from './middleware/session.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chats.js';
import { groupRoutes } from './routes/groups.js';
import { adminRoutes } from './routes/admin.js';
import { auditEventRoutes } from './routes/auditEvents.js';
import { llmProxyRoutes } from './routes/llmProxy.js';

await verifyPostgresOrExit();
console.log('[evigstudio] API data store: PostgreSQL only (no SQLite .db files).');
const auditCleanup = await cleanupExpiredAuditLogs();
console.log(
  `[evigstudio] Audit retention ${auditCleanup.retentionDays}d; removed ${auditCleanup.deleted} expired audit row(s).`,
);
const auditBackfill = await backfillLegacyAuditLogs();
console.log(`[evigstudio] Audit backfill repaired ${auditBackfill.updated} legacy audit row(s).`);

const app = new Hono<HonoEnv>();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin) => origin || '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

app.use('*', sessionMiddleware);

app.route('/api', healthRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/chats', chatRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/audit', auditEventRoutes);
app.route('/api/llm', llmProxyRoutes);

const staticRoot = process.env.STATIC_ROOT?.trim();
if (staticRoot && existsSync(staticRoot)) {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  app.use('/*', serveStatic({ root: staticRoot }));
}

const port = Number(process.env.PORT ?? '3001');

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`EvigStudio API listening on http://0.0.0.0:${info.port}`);
  if (staticRoot) {
    console.log(`Serving static UI from ${staticRoot}`);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[evigstudio] Port ${port} is already in use (another API process is running).`);
    console.error('  • Stop the other terminal (Ctrl+C) or close the duplicate process, or');
    console.error('  • Set PORT=3002 in server/.env , or');
    console.error(`  • Windows: netstat -ano | findstr :${port}`);
    console.error('    then: taskkill /PID <pid> /F\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});
