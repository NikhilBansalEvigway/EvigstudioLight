import type { AppSettings, ContentPart } from '@/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

interface ChatCompletionOptions {
  messages: ChatMessage[];
  settings: AppSettings;
  useVision?: boolean;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export async function testConnection(settings: AppSettings): Promise<{ ok: boolean; message: string }> {
  const url = `${settings.baseUrl}/models`;
  console.log('[EvigStudio] Testing connection to:', url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    console.log('[EvigStudio] Response status:', res.status);
    if (res.ok) {
      const text = await res.text();
      console.log('[EvigStudio] Raw response:', text);
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, message: `Server returned invalid JSON. Base URL: ${settings.baseUrl}` };
      }
      console.log('[EvigStudio] Parsed data:', data);
      const count = data?.data?.length ?? 0;
      if (count === 0) {
        return { ok: true, message: `Connected (via ${settings.baseUrl}), but 0 models loaded. Load a model in LM Studio.` };
      }
      return { ok: true, message: `Connected. ${count} model(s) available.` };
    }
    return { ok: false, message: `Server returned ${res.status}: ${res.statusText}` };
  } catch (err: any) {
    console.error('[EvigStudio] Connection error:', err);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, message: `Connection timed out. Use Base URL /api/llm/v1 when using the team server proxy (current: ${settings.baseUrl})` };
    }
    if (err.name === 'TypeError' && err.message?.includes('Failed to fetch')) {
      return { ok: false, message: 'Cannot reach the LLM endpoint. Ensure the API is running and Base URL is /api/llm/v1 (or direct http://127.0.0.1:1234/v1 in Electron).' };
    }
    return { ok: false, message: err.message || 'Unknown error' };
  }
}

export async function chatCompletion({ messages, settings, useVision, onToken, signal }: ChatCompletionOptions): Promise<string> {
  const model = useVision ? settings.visionModel : settings.textModel;
  const body: any = {
    model: model === 'auto' ? undefined : model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: settings.stream,
  };

  const res = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.apiKey ? { 'Authorization': `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI server error ${res.status}: ${text || res.statusText}`);
  }

  if (settings.stream && res.body) {
    return streamResponse(res.body, onToken);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  onToken?.(content);
  return content;
}

async function streamResponse(body: ReadableStream<Uint8Array>, onToken?: (token: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  let sawSse = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf('data:');
      if (idx !== 0) continue;
      sawSse = true;
      const data = trimmed.slice(5).trimStart();
      if (data === '[DONE]') {
        // Some servers keep the connection open; stop once DONE is received.
        try { await reader.cancel(); } catch {}
        return full;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken?.(full);
        }
      } catch { }
    }
  }

  // Fallback: if server ignored streaming and returned a JSON body.
  if (!sawSse) {
    const text = (buffer || '').trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content.length > 0) {
          onToken?.(content);
          return content;
        }
        const errMsg = parsed?.error?.message;
        if (typeof errMsg === 'string' && errMsg) {
          throw new Error(errMsg);
        }
      } catch {
        // ignore
      }
    }
  }

  return full;
}
