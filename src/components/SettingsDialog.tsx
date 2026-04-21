import { useAppStore } from '@/store/useAppStore';
import { testConnection } from '@/lib/llmClient';
import { DEFAULT_SETTINGS } from '@/types';
import type { UiThemePresetId } from '@/types';
import { UI_THEME_PRESETS, MAX_BRAND_LOGO_BYTES, MAX_BACKGROUND_BYTES } from '@/lib/uiThemes';
import { X, RotateCcw, Loader2, CheckCircle, XCircle, ImageIcon } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { getSpeechVoices, subscribeVoicesChanged, speakText } from '@/lib/speechTts';
import { isSpeechRecognitionSupported } from '@/lib/speechStt';

export function SettingsDialog() {
  const { settings, setSettings, showSettings, setShowSettings, setLMConnected } = useAppStore();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const [ttsVoices, setTtsVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const sync = () => setTtsVoices(getSpeechVoices());
    sync();
    return subscribeVoicesChanged(sync);
  }, []);

  const readImageFile = (file: File, maxBytes: number): Promise<string | null> =>
    new Promise((resolve) => {
      if (file.size > maxBytes) {
        toast.error(`Image too large (max ${Math.round(maxBytes / 1024)} KB).`);
        resolve(null);
        return;
      }
      if (!file.type.startsWith('image/')) {
        toast.error('Please choose an image file.');
        resolve(null);
        return;
      }
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });

  if (!showSettings) return null;

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testConnection(settings);
    setTestResult(result);
    setLMConnected(result.ok);
    setTesting(false);
    if (result.ok) toast.success('Connected to local AI!');
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
    setTestResult(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" onClick={() => setShowSettings(false)}>
      <div className="w-full max-w-xl bg-card border border-border rounded-lg shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button onClick={() => setShowSettings(false)} className="p-1 hover:text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <Section title="Appearance & white-label">
            <Field label="Color theme">
              <select
                value={settings.uiThemePreset}
                onChange={(e) => setSettings({ uiThemePreset: e.target.value as UiThemePresetId })}
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                {UI_THEME_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground mt-1">
                Works with light/dark (moon icon in the title bar). Use institutional logos and backgrounds approved by your
                policy.
              </p>
            </Field>
            <Field label="Product name (title bar)">
              <input
                value={settings.brandName}
                onChange={(e) => setSettings({ brandName: e.target.value.slice(0, 80) })}
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                placeholder="EvigStudio"
              />
            </Field>
            <div className="flex flex-wrap gap-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Logo (optional)</span>
                <div className="flex items-center gap-2">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      const url = await readImageFile(f, MAX_BRAND_LOGO_BYTES);
                      if (url) setSettings({ brandLogoDataUrl: url });
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => logoInputRef.current?.click()}
                    className="flex items-center gap-1 rounded bg-secondary px-2 py-1.5 text-xs hover:bg-secondary/80"
                  >
                    <ImageIcon className="h-3 w-3" /> Upload
                  </button>
                  {settings.brandLogoDataUrl && (
                    <button type="button" onClick={() => setSettings({ brandLogoDataUrl: null })} className="text-xs text-destructive">
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Background (optional)</span>
                <div className="flex items-center gap-2">
                  <input
                    ref={bgInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      const url = await readImageFile(f, MAX_BACKGROUND_BYTES);
                      if (url) setSettings({ backgroundImageDataUrl: url });
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => bgInputRef.current?.click()}
                    className="flex items-center gap-1 rounded bg-secondary px-2 py-1.5 text-xs hover:bg-secondary/80"
                  >
                    <ImageIcon className="h-3 w-3" /> Upload
                  </button>
                  {settings.backgroundImageDataUrl && (
                    <button type="button" onClick={() => setSettings({ backgroundImageDataUrl: null })} className="text-xs text-destructive">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
            <Field label={`Background overlay: ${Math.round((settings.backgroundOverlayOpacity ?? 0.88) * 100)}%`}>
              <input
                type="range"
                min={0.5}
                max={1}
                step={0.02}
                value={settings.backgroundOverlayOpacity ?? 0.88}
                onChange={(e) => setSettings({ backgroundOverlayOpacity: parseFloat(e.target.value) })}
                className="w-full accent-primary"
              />
            </Field>
          </Section>

          <Section title="Speech (TTS & dictation)">
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Uses your browser&apos;s speech APIs. Text-to-speech reads with <strong className="text-foreground">installed system voices</strong> (often usable offline after language packs are installed). Speech-to-text quality and privacy depend on the browser—some engines work on-device; others may use a network service unless configured otherwise.
            </p>
            <Field label="TTS voice">
              <select
                value={settings.ttsVoiceName}
                onChange={(e) => setSettings({ ttsVoiceName: e.target.value })}
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">System default</option>
                {ttsVoices.map((v) => (
                  <option key={`${v.name}-${v.lang}`} value={v.name}>
                    {v.name} ({v.lang})
                    {v.localService ? ' · on-device' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Speech rate: ${settings.ttsRate.toFixed(2)}`}>
              <input
                type="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={settings.ttsRate}
                onChange={(e) => setSettings({ ttsRate: parseFloat(e.target.value) })}
                className="w-full accent-primary"
              />
            </Field>
            <Field label={`Speech pitch: ${settings.ttsPitch.toFixed(2)}`}>
              <input
                type="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={settings.ttsPitch}
                onChange={(e) => setSettings({ ttsPitch: parseFloat(e.target.value) })}
                className="w-full accent-primary"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  speakText('EvigStudio text to speech is working.', {
                    voiceName: settings.ttsVoiceName || undefined,
                    rate: settings.ttsRate,
                    pitch: settings.ttsPitch,
                  })
                }
                className="rounded bg-secondary px-2 py-1.5 text-xs hover:bg-secondary/80"
              >
                Test voice
              </button>
            </div>
            <Field label="Dictation language (BCP-47)">
              <input
                value={settings.sttLanguage}
                onChange={(e) => setSettings({ sttLanguage: e.target.value.slice(0, 20) })}
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                placeholder="en-US"
              />
            </Field>
            <p className="text-[10px] text-muted-foreground">
              Microphone dictation:{' '}
              {isSpeechRecognitionSupported() ? (
                <span className="text-accent">Supported in this browser.</span>
              ) : (
                <span className="text-warning">Not available — try Chrome or Edge.</span>
              )}
            </p>
          </Section>

          {/* Connection */}
          <Section title="Local AI Connection">
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Offline / LAN:</strong> Point the app at your team API&apos;s LLM proxy{' '}
              <code className="text-primary">/api/llm/v1</code> (same host as the UI). LM Studio runs on the GPU machine; the API forwards to it with a concurrency limit so many users do not overload one GPU. No cloud inference.
            </p>
            <Field label="Base URL">
              <input value={settings.baseUrl} onChange={e => setSettings({ baseUrl: e.target.value })}
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring" />
            </Field>
            <Field label="API Key (optional)">
              <input value={settings.apiKey} onChange={e => setSettings({ apiKey: e.target.value })} type="password"
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                placeholder="Leave blank if not required" />
            </Field>
            <Field label="Text Model">
              <input value={settings.textModel} onChange={e => setSettings({ textModel: e.target.value })}
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                placeholder="auto" />
            </Field>
            <Field label="Vision Model">
              <input value={settings.visionModel} onChange={e => setSettings({ visionModel: e.target.value })}
                className="w-full bg-input rounded px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                placeholder="auto" />
            </Field>
            <div className="flex items-center gap-2">
              <button onClick={handleTest} disabled={testing}
                className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary/15 text-primary text-xs hover:bg-primary/25 transition-colors disabled:opacity-50">
                {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Test Connection
              </button>
              {testResult && (
                <span className={`flex items-center gap-1 text-xs ${testResult.ok ? 'text-accent' : 'text-destructive'}`}>
                  {testResult.ok ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {testResult.message}
                </span>
              )}
            </div>
          </Section>

          {/* Generation */}
          <Section title="Generation">
            <Field label={`Temperature: ${settings.temperature}`}>
              <input type="range" min="0" max="2" step="0.1" value={settings.temperature}
                onChange={e => setSettings({ temperature: parseFloat(e.target.value) })}
                className="w-full accent-primary" />
            </Field>
            <Field label={`Max Tokens: ${settings.maxTokens}`}>
              <input type="range" min="256" max="8192" step="256" value={settings.maxTokens}
                onChange={e => setSettings({ maxTokens: parseInt(e.target.value) })}
                className="w-full accent-primary" />
            </Field>
          </Section>

          {/* Toggles */}
          <Section title="Behavior">
            <Toggle label="Stream responses" checked={settings.stream} onChange={v => setSettings({ stream: v })} />
            <Field label={`Agent max tool rounds: ${Math.min(10, Math.max(1, settings.agentMaxIterations ?? 5))}`}>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={Math.min(10, Math.max(1, settings.agentMaxIterations ?? 5))}
                onChange={(e) => setSettings({ agentMaxIterations: parseInt(e.target.value, 10) })}
                className="w-full accent-primary"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Max read/list iterations when in Agent mode (per-chat toggle controls agent vs plain chat).
              </p>
            </Field>
            <Toggle label="Strict Offline Mode" desc="Block all non-LM-Studio network requests" checked={settings.strictOffline} onChange={v => setSettings({ strictOffline: v })} />
          </Section>

          {/* CORS Help */}
          <Section title="Troubleshooting">
            <div className="text-[10px] text-muted-foreground space-y-1.5">
              <p>
                <strong className="text-foreground">Can&apos;t connect?</strong> Start LM Studio with the local server (default port 1234). With the team app, set Base URL to{' '}
                <code className="text-primary">/api/llm/v1</code> so requests go through the API proxy (Vite dev forwards <code className="text-primary">/api</code> to the Hono server).
              </p>
              <p>
                <strong className="text-foreground">Direct to LM Studio (debug)?</strong> Optional Vite path <code className="text-primary">/lmstudio</code> still maps to 127.0.0.1:1234 with Base URL{' '}
                <code className="text-primary">/lmstudio</code> — bypasses server-side concurrency limits; use only for local troubleshooting.
              </p>
              <p>
                <strong className="text-foreground">Custom host/port?</strong> Set <code className="text-primary">LM_STUDIO_URL</code> on the API host (see <code className="text-primary">server/.env.example</code>), not the browser Base URL.
              </p>
              <p>
                <strong className="text-foreground">0 models?</strong> Load a model in LM Studio before testing the connection.
              </p>
            </div>
          </Section>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <button onClick={handleReset} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <RotateCcw className="w-3 h-3" /> Reset to defaults
          </button>
          <button onClick={() => setShowSettings(false)}
            className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90 transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between cursor-pointer group">
      <div>
        <span className="text-xs">{label}</span>
        {desc && <p className="text-[10px] text-muted-foreground">{desc}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-8 h-4 rounded-full transition-colors relative ${checked ? 'bg-primary' : 'bg-muted'}`}
      >
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-foreground transition-transform ${checked ? 'translate-x-4.5 left-0' : 'left-0.5'}`}
          style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }} />
      </button>
    </label>
  );
}
