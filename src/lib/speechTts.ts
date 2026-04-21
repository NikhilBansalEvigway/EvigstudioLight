/** Browser Text-to-Speech using the system / installed voices (often offline-capable). */

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Prepare markdown-ish assistant text for speaking (strip fences, reduce noise). */
export function textForTts(raw: string): string {
  let s = raw
    .replace(/```[\s\S]*?```/g, ' code snippet. ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/[*_~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 32000) s = s.slice(0, 32000) + '…';
  return s;
}

export function getSpeechVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSynthesisSupported()) return [];
  return speechSynthesis.getVoices().slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** Call after mount; voices may load asynchronously (voiceschanged). */
export function subscribeVoicesChanged(cb: () => void): () => void {
  if (!isSpeechSynthesisSupported()) return () => {};
  speechSynthesis.addEventListener('voiceschanged', cb);
  return () => speechSynthesis.removeEventListener('voiceschanged', cb);
}

export function stopSpeaking(): void {
  if (isSpeechSynthesisSupported()) {
    speechSynthesis.cancel();
  }
}

export function isSpeaking(): boolean {
  return isSpeechSynthesisSupported() && speechSynthesis.speaking;
}

export function speakText(
  text: string,
  opts: {
    voiceName?: string;
    rate?: number;
    pitch?: number;
    lang?: string;
    onEnd?: () => void;
    onError?: () => void;
  } = {},
): void {
  if (!isSpeechSynthesisSupported() || !text.trim()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;
  u.lang = opts.lang ?? 'en-US';
  const voices = speechSynthesis.getVoices();
  if (opts.voiceName) {
    const v = voices.find((x) => x.name === opts.voiceName);
    if (v) u.voice = v;
  }
  u.onend = () => opts.onEnd?.();
  u.onerror = () => opts.onError?.();
  speechSynthesis.speak(u);
}
