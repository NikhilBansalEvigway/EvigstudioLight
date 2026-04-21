import { useState, useEffect } from 'react';
import { Volume2, Square } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { speakText, stopSpeaking, textForTts } from '@/lib/speechTts';

export function MessageTtsBar({ rawMarkdown }: { rawMarkdown: string }) {
  const settings = useAppStore((s) => s.settings);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    return () => stopSpeaking();
  }, []);

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null;
  }

  const speak = () => {
    if (playing) {
      stopSpeaking();
      setPlaying(false);
      return;
    }
    const plain = textForTts(rawMarkdown);
    if (!plain) return;
    setPlaying(true);
    speakText(plain, {
      voiceName: settings.ttsVoiceName || undefined,
      rate: settings.ttsRate,
      pitch: settings.ttsPitch,
      onEnd: () => setPlaying(false),
      onError: () => setPlaying(false),
    });
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={speak}
        className="inline-flex items-center gap-1 rounded border border-border bg-secondary/40 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        {playing ? <Square className="h-3 w-3 fill-current" /> : <Volume2 className="h-3 w-3" />}
        {playing ? 'Stop speech' : 'Read aloud'}
      </button>
    </div>
  );
}
