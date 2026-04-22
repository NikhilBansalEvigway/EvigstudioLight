import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Logo } from '@/components/Logo';
import { toast } from 'sonner';

const REMEMBER_ME_KEY = 'evigstudio.remembered-login';

export default function Login() {
  const navigate = useNavigate();
  const { refresh, serverAvailable } = useAuth();
  const brandName = useAppStore((s) => s.settings.brandName?.trim() || 'EvigStudio');
  const brandLogo = useAppStore((s) => s.settings.brandLogoDataUrl);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REMEMBER_ME_KEY);
      if (!saved) return;

      const parsed = JSON.parse(saved) as { email?: string };
      if (typeof parsed.email !== 'string') return;

      setEmail(parsed.email);
      setRememberMe(true);
    } catch {
      window.localStorage.removeItem(REMEMBER_ME_KEY);
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverAvailable) {
      toast.error('Team server is not reachable. Start the API on port 3001 (see README), then refresh.');
      return;
    }
    setLoading(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body =
        mode === 'login'
          ? { email, password, rememberMe }
          : { email, password, displayName: displayName || email.split('@')[0] };

      const r = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { error?: string };

      if (!r.ok) {
        toast.error(data.error || 'Request failed');
        return;
      }

      if (mode === 'login') {
        if (rememberMe) {
          window.localStorage.setItem(REMEMBER_ME_KEY, JSON.stringify({ email }));
        } else {
          window.localStorage.removeItem(REMEMBER_ME_KEY);
        }
      }

      await refresh();
      toast.success(mode === 'login' ? 'Signed in' : 'Account created');
      navigate('/', { replace: true });
    } catch {
      toast.error('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8 border border-border rounded-lg p-8 bg-card shadow-sm">
        <div className="flex flex-col items-center gap-2">
          {brandLogo ? (
            <img src={brandLogo} alt="" className="h-14 w-14 rounded object-contain" />
          ) : (
            <Logo className="h-12 w-12" />
          )}
          <h1 className="text-lg font-semibold text-foreground">{brandName}</h1>
          <p className="text-xs text-muted-foreground text-center">
            Team server sign-in. Chat history is stored on the shared database after you log in.
          </p>
          {!serverAvailable && (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              <p className="font-medium text-foreground">API server not running</p>
              <p className="mt-1 text-muted-foreground">
                Start the backend (e.g. from the project root:{' '}
                <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">npm run dev --prefix server</code>
                {' '}or{' '}
                <code className="rounded bg-secondary px-1 py-0.5 text-[10px]">npm run dev:lan</code>
                ), then reload this page.
              </p>
            </div>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4">
          {mode === 'register' && (
            <div className="space-y-2">
              <Label htmlFor="displayName">Display name</Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                placeholder="Ada Lovelace"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'register' && (
              <p className="text-[10px] text-muted-foreground">At least 8 characters. First registered user becomes admin.</p>
            )}
          </div>
          {mode === 'login' && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="rememberMe"
                checked={rememberMe}
                onCheckedChange={(checked) => {
                  const enabled = checked === true;
                  setRememberMe(enabled);
                  if (!enabled) {
                    window.localStorage.removeItem(REMEMBER_ME_KEY);
                  }
                }}
              />
              <Label htmlFor="rememberMe" className="text-sm font-normal">
                Remember my email and keep me signed in
              </Label>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={loading || !serverAvailable}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <button
          type="button"
          className="w-full text-xs text-muted-foreground hover:text-primary transition-colors"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
