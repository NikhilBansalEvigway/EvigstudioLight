import type { Message } from '@/types';
import { getMessageText, hasImages } from '@/types';

const AUTO_SUMMARY_HEADER = 'Conversation summary (auto-generated):';
const AUTO_SUMMARY_FOOTER = 'Continue chatting with this summary as context.';

export function extractAutoSummaryBody(content: string): string | null {
  const markerIndex = content.indexOf(AUTO_SUMMARY_HEADER);
  if (markerIndex < 0) return null;
  let body = content.slice(markerIndex + AUTO_SUMMARY_HEADER.length).trim();
  if (!body) return null;
  if (body.endsWith(AUTO_SUMMARY_FOOTER)) {
    body = body.slice(0, -AUTO_SUMMARY_FOOTER.length).trim();
  }
  return body || null;
}

function sanitizeForTranscript(text: string): string {
  let t = text;

  // Avoid summary-of-summary loops by stripping wrapper.
  const markerIndex = t.indexOf(AUTO_SUMMARY_HEADER);
  if (markerIndex >= 0) {
    let body = t.slice(markerIndex + AUTO_SUMMARY_HEADER.length).trim();
    if (body.endsWith(AUTO_SUMMARY_FOOTER)) {
      body = body.slice(0, -AUTO_SUMMARY_FOOTER.length).trim();
    }
    t = body;
  }

  // Drop patch blocks (large + low-signal for continuity summaries).
  t = t.replace(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/gm, '[Patch omitted]');

  // Drop fenced code blocks above a small threshold.
  t = t.replace(/```[\s\S]*?```/g, (m) => (m.length > 900 ? '```\n[Code block omitted]\n```' : m));

  // Clamp per-message so one huge assistant response doesn't dominate the transcript.
  const cap = 6_000;
  if (t.length > cap) t = t.slice(0, cap) + '\n\n[Message truncated]';
  return t.trim();
}

export function buildCondenseTranscript(messages: Message[], maxChars: number): string {
  const chunks: string[] = [];
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const baseText = getMessageText(message).trim();
    const fallback = hasImages(message) ? '[Image attachment]' : '(empty)';
    const messageText = sanitizeForTranscript(baseText || fallback);
    if (!messageText) continue;

    const linePrefix = message.role === 'user' ? 'User' : 'Assistant';
    const line = `${linePrefix}: ${messageText}`;

    if (used + line.length <= maxChars) {
      chunks.push(line);
      used += line.length;
      continue;
    }

    const remaining = maxChars - used;
    if (remaining > 24) {
      chunks.push(`${line.slice(0, remaining)}…`);
    }
    break;
  }

  return chunks.reverse().join('\n\n').trim();
}

export function collectChatContextRefPaths(messages: Message[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    for (const ref of m.contextRefs ?? []) {
      if (ref.type && ref.type !== 'file') continue;
      const p = ref.path?.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
