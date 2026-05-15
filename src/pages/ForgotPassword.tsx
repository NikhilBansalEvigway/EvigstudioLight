import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Logo } from '@/components/Logo';
import { toast } from 'sonner';

const NETWORK_ERROR_MESSAGE = 'Network error. Check your connection and try again.';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const { serverAvailable } = useAuth();
  const brandLogo = useAppStore((s) => s.settings.brandLogoDataUrl);
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverAvailable) {
      toast.error('Team server is not reachable. Start the API, then try again.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const r = await fetch('/api/auth/self-reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, newPassword }),
      });
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!r.ok) {
        toast.error(data.error || 'Could not update password');
        return;
      }

      toast.success('Password updated. Sign in with your new password.');
      navigate('/login', { replace: true });
    } catch {
      toast.error(NETWORK_ERROR_MESSAGE);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 border border-border rounded-lg p-8 bg-card shadow-sm">
        <div className="flex flex-col items-center gap-2">
          {brandLogo ? (
            <img src={brandLogo} alt="" className="h-14 w-14 rounded object-contain" />
          ) : (
            <Logo className="h-12 w-12" />
          )}
          <h1 className="text-lg font-semibold text-foreground">Set a new password</h1>
          <p className="text-xs text-muted-foreground text-center">
            Enter your account email and choose a new password. It is saved immediately — no email link.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="forgot-email">Email</Label>
            <Input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="forgot-new">New password</Label>
            <Input
              id="forgot-new"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
            <p className="text-[10px] text-muted-foreground">At least 8 characters.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="forgot-confirm">Confirm new password</Label>
            <Input
              id="forgot-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading || !serverAvailable}>
            {loading ? 'Please wait…' : 'Update password'}
          </Button>
        </form>

        <p className="text-[10px] leading-snug text-muted-foreground text-center">
          Trusted network only: anyone who knows an email could change that account&apos;s password. Use sign-in →
          change password when you are already logged in for a safer flow.
        </p>

        <Link
          to="/login"
          className="block w-full text-center text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
