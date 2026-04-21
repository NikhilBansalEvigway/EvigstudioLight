import { useRef, useState, useCallback, useEffect } from 'react';
import { getSpeechRecognitionCtor } from '@/lib/speechStt';

/**
 * Continuous dictation until stopped. Final phrases are appended via onFinal.
 * Uses the browser Web Speech API (engine varies: may be local on some Edge/Windows setups).
 */
export function useSpeechDictation(
  lang: string,
  onFinal: (transcript: string) => void,
  onError?: (message: string) => void,
) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(false);
  const langRef = useRef(lang);
  const onFinalRef = useRef(onFinal);
  const onErrorRef = useRef(onError);

  langRef.current = lang;
  onFinalRef.current = onFinal;
  onErrorRef.current = onError;

  const stop = useCallback(() => {
    activeRef.current = false;
    const r = recRef.current;
    recRef.current = null;
    if (r) {
      try {
        r.abort();
      } catch {
        try {
          r.stop();
        } catch {
          /* */
        }
      }
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      onErrorRef.current?.('Speech recognition is not supported in this browser. Try Chrome or Edge.');
      return;
    }
    stop();
    const rec = new Ctor();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (ev: SpeechRecognitionEvent) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const row = ev.results[i];
        if (row.isFinal) {
          const t = row[0]?.transcript?.trim();
          if (t) onFinalRef.current(t);
        }
      }
    };

    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        onErrorRef.current?.('Microphone permission denied.');
      } else if (ev.error !== 'aborted' && ev.error !== 'no-speech') {
        onErrorRef.current?.(ev.message || ev.error);
      }
      if (activeRef.current) {
        activeRef.current = false;
        setListening(false);
      }
    };

    rec.onend = () => {
      if (activeRef.current && recRef.current) {
        try {
          rec.start();
        } catch {
          activeRef.current = false;
          setListening(false);
        }
      }
    };

    recRef.current = rec;
    activeRef.current = true;
    setListening(true);
    try {
      rec.start();
    } catch {
      activeRef.current = false;
      setListening(false);
      onErrorRef.current?.('Could not start the microphone.');
    }
  }, [stop]);

  const toggle = useCallback(() => {
    if (activeRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    listening,
    supported: typeof window !== 'undefined' && getSpeechRecognitionCtor() !== null,
    start,
    stop,
    toggle,
  };
}
