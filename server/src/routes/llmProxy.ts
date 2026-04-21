import { Hono } from 'hono';
import { auditActorSnapshot, auditRequestContext, writeStructuredAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';

export const llmProxyRoutes = new Hono<HonoEnv>();

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function upstreamBase(): string {
  return (process.env.LM_STUDIO_URL ?? 'http://127.0.0.1:1234').replace(/\/$/, '');
}

function maxConcurrent(): number {
  const n = Number(process.env.LLM_MAX_CONCURRENT ?? '6');
  return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 6;
}

function queueWaitMs(): number {
  const n = Number(process.env.LLM_QUEUE_WAIT_MS ?? '120000');
  return Number.isFinite(n) && n >= 0 ? Math.min(600_000, n) : 120_000;
}

function upstreamTimeoutMs(): number {
  const n = Number(process.env.LLM_UPSTREAM_TIMEOUT_MS ?? '0');
  return Number.isFinite(n) && n >= 0 ? Math.min(3_600_000, n) : 0;
}

function requireAuth(): boolean {
  return process.env.LLM_REQUIRE_AUTH === 'true' || process.env.LLM_REQUIRE_AUTH === '1';
}

/** Limit parallel upstream requests to LM Studio. */
class ConcurrencyGate {
  private count = 0;
  private readonly q: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.q.push(resolve);
    });
    this.count++;
  }

  release(): void {
    this.count--;
    const next = this.q.shift();
    if (next) {
      next();
    }
  }
}

const gate = new ConcurrencyGate(maxConcurrent());

function buildUpstreamUrl(c: { req: { url: string } }): string {
  const u = new URL(c.req.url);
  const path = u.pathname.replace(/^\/api\/llm/, '') || '/';
  return `${upstreamBase()}${path}${u.search}`;
}

function requestPath(c: { req: { url: string } }): string {
  const u = new URL(c.req.url);
  return u.pathname.replace(/^\/api\/llm/, '') || '/';
}

function forwardRequestHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP.has(lower)) {
      out.set(key, value);
    }
  });
  return out;
}

function forwardResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== 'transfer-encoding' && !HOP_BY_HOP.has(lower)) {
      out.set(key, value);
    }
  });
  return out;
}

llmProxyRoutes.all('*', async (c) => {
  const user = c.get('user');
  const context = auditRequestContext(c);
  const path = requestPath(c);
  const startedAt = Date.now();

  if (requireAuth()) {
    if (!user) {
      await writeStructuredAuditLog({
        action: 'llm.proxy',
        resourceType: 'llm_proxy',
        resourceId: path,
        context,
        target: { type: 'llm_proxy', id: path, label: upstreamBase() },
        result: { status: 'denied', code: 401, reason: 'auth_required' },
        details: { path, upstreamBase: upstreamBase() },
      });
      return c.json({ error: 'Unauthorized', message: 'LLM proxy requires sign-in (LLM_REQUIRE_AUTH).' }, 401);
    }
  }

  const upstreamUrl = buildUpstreamUrl(c);
  const method = c.req.method;
  const headers = forwardRequestHeaders(c.req.raw.headers);
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const waitMs = queueWaitMs();
  try {
    await Promise.race([
      gate.acquire(),
      new Promise<never>((_, rej) => {
        setTimeout(() => {
          rej(Object.assign(new Error('LLM queue wait exceeded'), { name: 'QueueTimeout' }));
        }, waitMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.name === 'QueueTimeout') {
      await writeStructuredAuditLog({
        action: 'llm.proxy',
        resourceType: 'llm_proxy',
        resourceId: path,
        actor: auditActorSnapshot(user),
        context,
        target: { type: 'llm_proxy', id: path, label: upstreamBase() },
        result: { status: 'error', code: 503, reason: 'queue_timeout' },
        details: {
          path,
          upstreamBase: upstreamBase(),
          method,
          latencyMs: Date.now() - startedAt,
          queueWaitMs: waitMs,
        },
      });
      return c.json(
        {
          error: 'Too many concurrent LLM requests',
          message: `Waited ${waitMs}ms for a slot. Increase LLM_MAX_CONCURRENT or LLM_QUEUE_WAIT_MS.`,
          retryAfterSeconds: 5,
        },
        503,
        { 'Retry-After': '5' },
      );
    }
    throw e;
  }

  const timeoutMs = upstreamTimeoutMs();
  const ctrl = timeoutMs > 0 ? new AbortController() : undefined;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          ctrl!.abort();
        }, timeoutMs)
      : undefined;

  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      signal: ctrl?.signal,
    };
    if (hasBody) {
      init.body = c.req.raw.body;
      init.duplex = 'half';
    }

    const res = await fetch(upstreamUrl, init);
    const outHeaders = forwardResponseHeaders(res.headers);
    await writeStructuredAuditLog({
      action: 'llm.proxy',
      resourceType: 'llm_proxy',
      resourceId: path,
      actor: auditActorSnapshot(user),
      context,
      target: { type: 'llm_proxy', id: path, label: upstreamBase() },
      result: { status: res.ok ? 'success' : 'error', code: res.status, reason: res.ok ? null : res.statusText },
      details: {
        path,
        upstreamBase: upstreamBase(),
        method,
        latencyMs: Date.now() - startedAt,
      },
    });
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'AbortError') {
      await writeStructuredAuditLog({
        action: 'llm.proxy',
        resourceType: 'llm_proxy',
        resourceId: path,
        actor: auditActorSnapshot(user),
        context,
        target: { type: 'llm_proxy', id: path, label: upstreamBase() },
        result: { status: 'error', code: 504, reason: 'upstream_timeout' },
        details: {
          path,
          upstreamBase: upstreamBase(),
          method,
          latencyMs: Date.now() - startedAt,
        },
      });
      return c.json({ error: 'Upstream timeout', message: 'LM Studio did not respond in time.' }, 504);
    }
    console.error('[llmProxy] upstream fetch failed', e);
    await writeStructuredAuditLog({
      action: 'llm.proxy',
      resourceType: 'llm_proxy',
      resourceId: path,
      actor: auditActorSnapshot(user),
      context,
      target: { type: 'llm_proxy', id: path, label: upstreamBase() },
      result: { status: 'error', code: 502, reason: e instanceof Error ? e.message : 'fetch_failed' },
      details: {
        path,
        upstreamBase: upstreamBase(),
        method,
        latencyMs: Date.now() - startedAt,
      },
    });
    return c.json({ error: 'Upstream error', message: e instanceof Error ? e.message : 'fetch failed' }, 502);
  } finally {
    if (timer) clearTimeout(timer);
    gate.release();
  }
});
