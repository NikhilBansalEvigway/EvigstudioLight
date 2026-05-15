/** Lets the browser paint / process input so long restores do not trigger “page not responding”. */
export async function yieldToMain(animationFrames = 1): Promise<void> {
  for (let i = 0; i < animationFrames; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/** Build a Map in slices with animation-frame yields (large folder uploads from IndexedDB). */
export async function mapEntriesAsync<K, V>(entries: Array<[K, V]>, chunkSize: number): Promise<Map<K, V>> {
  const out = new Map<K, V>();
  if (entries.length === 0) return out;
  const size = Math.max(50, chunkSize);
  for (let i = 0; i < entries.length; i += size) {
    const slice = entries.slice(i, i + size);
    for (const pair of slice) {
      out.set(pair[0], pair[1]);
    }
    if (i + size < entries.length) {
      await yieldToMain(1);
    }
  }
  return out;
}
