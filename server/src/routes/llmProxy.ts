import { Hono } from 'hono';
import { auditActorSnapshot, auditRequestContext, writeStructuredAuditLog } from '../audit.js';
import type { HonoEnv } from '../middleware/session.js';

export const llmProxyRoutes = new Hono<HonoEnv>();

type LLMProvider = 'lmstudio' | 'orchestrator' | 'openrouter';

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

function llmProvider(): LLMProvider {
  const raw = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (raw === 'orchestrator' || raw === 'openrouter') return raw;
  return 'lmstudio';
}

function upstreamBase(): string {
  switch (llmProvider()) {
    case 'orchestrator':
      return (
        process.env.LLM_ORCHESTRATOR_URL?.trim() ||
        process.env.LLM_UPSTREAM_URL?.trim() ||
        process.env.LM_STUDIO_URL?.trim() ||
        'http://127.0.0.1:1234'
      ).replace(/\/$/, '');
    case 'openrouter':
      return (
        process.env.OPENROUTER_URL?.trim() ||
        process.env.LLM_UPSTREAM_URL?.trim() ||
        'https://openrouter.ai/api'
      ).replace(/\/$/, '');
    case 'lmstudio':
    default:
      return (
        process.env.LM_STUDIO_URL?.trim() ||
        process.env.LLM_UPSTREAM_URL?.trim() ||
        'http://127.0.0.1:1234'
      ).replace(/\/$/, '');
  }
}

function withHost(base: string, host: string): string {
  try {
    const u = new URL(base);
    u.hostname = host;
    return u.toString().replace(/\/$/, '');
  } catch {
    return base.replace(/\/$/, '');
  }
}

function orchestratorBaseCandidates(): string[] {
  const configured =
    process.env.LLM_ORCHESTRATOR_URL?.trim() ||
    process.env.LLM_UPSTREAM_URL?.trim() ||
    process.env.LM_STUDIO_URL?.trim() ||
    'http://127.0.0.1:1234';

  const out: string[] = [];
  const add = (v: string | null | undefined) => {
    const val = (v || '').trim().replace(/\/$/, '');
    if (!val) return;
    if (!out.includes(val)) out.push(val);
  };

  add(configured);
  try {
    const host = new URL(configured).hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') {
      add(withHost(configured, 'host.docker.internal'));
    }
  } catch {
    // ignore malformed URL and continue with legacy defaults
  }

  // Legacy/known defaults for older orchestrator deployments.
  add('http://llm-orch:3013');
  add('http://host.docker.internal:3013');
  add('http://host.docker.internal:4000');
  add('http://127.0.0.1:4000');

  return out;
}

function configuredUpstreamApiKey(): string | null {
  return (
    process.env.LLM_UPSTREAM_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.LLM_API_KEY?.trim() ||
    null
  );
}

function queueEnabled(): boolean {
  const raw = process.env.LLM_ENABLE_QUEUE?.trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return llmProvider() === 'orchestrator';
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

function buildUpstreamUrlForBase(c: { req: { url: string } }, base: string): string {
  const u = new URL(c.req.url);
  const path = u.pathname.replace(/^\/api\/llm/, '') || '/';
  return `${base.replace(/\/$/, '')}${path}${u.search}`;
}

function requestPath(c: { req: { url: string } }): string {
  const u = new URL(c.req.url);
  return u.pathname.replace(/^\/api\/llm/, '') || '/';
}

function forwardRequestHeaders(src: Headers, base: string): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP.has(lower)) {
      out.set(key, value);
    }
  });

  if (!out.has('authorization')) {
    const apiKey = configuredUpstreamApiKey();
    if (apiKey) {
      out.set('Authorization', `Bearer ${apiKey}`);
    }
  }

  if (llmProvider() === 'openrouter') {
    const referer = process.env.OPENROUTER_SITE_URL?.trim() || process.env.PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim();
    if (referer && !out.has('HTTP-Referer')) {
      out.set('HTTP-Referer', referer);
    }
    if (!out.has('X-Title')) {
      out.set('X-Title', process.env.OPENROUTER_APP_NAME?.trim() || 'EvigStudio');
    }
  }

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

  const base = upstreamBase();
  const method = c.req.method;
  const headers = forwardRequestHeaders(c.req.raw.headers, base);
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const waitMs = queueWaitMs();
  const useQueue = queueEnabled();
  let acquired = false;
  if (useQueue) {
    try {
      await Promise.race([
        gate.acquire(),
        new Promise<never>((_, rej) => {
          setTimeout(() => {
            rej(Object.assign(new Error('LLM queue wait exceeded'), { name: 'QueueTimeout' }));
          }, waitMs);
        }),
      ]);
      acquired = true;
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
            provider: llmProvider(),
            queueEnabled: useQueue,
            upstreamBase: base,
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
    const buildInit = (): RequestInit & { duplex?: 'half' } => {
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        signal: ctrl?.signal,
      };
      if (hasBody) {
        init.body = c.req.raw.body;
        init.duplex = 'half';
      }
      return init;
    };

    const provider = llmProvider();
    const basesToTry = provider === 'orchestrator' ? orchestratorBaseCandidates() : [base];
    let res: Response | null = null;
    let usedBase = base;
    let lastNetworkError: unknown = null;
    for (const candidateBase of basesToTry) {
      const upstreamUrl = buildUpstreamUrlForBase(c, candidateBase);
      try {
        res = await fetch(upstreamUrl, buildInit());
        usedBase = candidateBase;
        break;
      } catch (err) {
        lastNetworkError = err;
      }
    }

    if (!res) {
      throw lastNetworkError instanceof Error ? lastNetworkError : new Error('fetch failed');
    }

    const outHeaders = forwardResponseHeaders(res.headers);
    await writeStructuredAuditLog({
      action: 'llm.proxy',
      resourceType: 'llm_proxy',
      resourceId: path,
        actor: auditActorSnapshot(user),
        context,
        target: { type: 'llm_proxy', id: path, label: usedBase },
        result: { status: res.ok ? 'success' : 'error', code: res.status, reason: res.ok ? null : res.statusText },
        details: {
          path,
          provider: llmProvider(),
          queueEnabled: useQueue,
          upstreamBase: usedBase,
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
        target: { type: 'llm_proxy', id: path, label: base },
        result: { status: 'error', code: 504, reason: 'upstream_timeout' },
        details: {
          path,
          provider: llmProvider(),
          queueEnabled: useQueue,
          upstreamBase: base,
          method,
          latencyMs: Date.now() - startedAt,
        },
      });
      return c.json({ error: 'Upstream timeout', message: 'The configured LLM provider did not respond in time.' }, 504);
    }
    console.error('[llmProxy] upstream fetch failed', e);
    await writeStructuredAuditLog({
      action: 'llm.proxy',
      resourceType: 'llm_proxy',
      resourceId: path,
      actor: auditActorSnapshot(user),
      context,
      target: { type: 'llm_proxy', id: path, label: base },
      result: { status: 'error', code: 502, reason: e instanceof Error ? e.message : 'fetch_failed' },
      details: {
        path,
        provider: llmProvider(),
        queueEnabled: useQueue,
        upstreamBase: base,
        method,
        latencyMs: Date.now() - startedAt,
      },
    });
    return c.json({ error: 'Upstream error', message: e instanceof Error ? e.message : 'fetch failed' }, 502);
  } finally {
    if (timer) clearTimeout(timer);
    if (acquired) {
      gate.release();
    }
  }
});
