import { Link } from 'react-router-dom';
import { useState, type FormEvent } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from 'next-themes';
import {
  Wifi,
  WifiOff,
  Server,
  ServerOff,
  Settings,
  PanelLeft,
  PanelRight,
  Sun,
  Moon,
  Shield,
  LogOut,
  Users,
  LogIn,
  KeyRound,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';

export function StatusBar() {
  const {
    isOnline,
    isLMConnected,
    setShowSettings,
    showSidebar,
    setShowSidebar,
    showRightPane,
    setShowRightPane,
    settings,
    contextBudgetChars,
    contextUsedChars,
    agentStep,
    agentStepTotal,
    isStreaming,
  } = useAppStore();
  const brand = settings.brandName?.trim() || 'EvigStudio';
  const logo = settings.brandLogoDataUrl;
  const { serverAvailable, user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const hasBackground = Boolean(settings.backgroundImageDataUrl);
  const canOpenSettings = user?.role === 'admin';
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  const resetPasswordFields = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
  };

  const submitOwnPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentPassword || newPassword.length < 8) {
      toast.error('Enter current password and a new password (min 8 chars)');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      toast.error('New passwords do not match');
      return;
    }

    const r = await fetch('/api/auth/change-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      toast.error(data.error || 'Could not change password');
      return;
    }

    toast.success('Password updated');
    setPasswordDialogOpen(false);
    resetPasswordFields();
  };

  const formatChars = (n: number) => {
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${Math.round(n / 1_000)}k`;
    return `${n}`;
  };

  const safeBudget = Math.max(0, contextBudgetChars || 0);
  const safeUsed = Math.max(0, contextUsedChars || 0);
  const remaining = Math.max(0, safeBudget - safeUsed);
  const ctxPct = safeBudget > 0 ? Math.min(100, Math.max(0, Math.round((safeUsed / safeBudget) * 100))) : 0;

  return (
    <header className={`flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2 sm:px-3 ${hasBackground ? 'bg-card/82 backdrop-blur-md' : 'bg-card'}`}>
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={showSidebar}
              aria-label={showSidebar ? 'Hide chat list' : 'Show chat list'}
              onClick={() => setShowSidebar(!showSidebar)}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelLeft className="h-4 w-4" />
              <span className="hidden text-xs font-medium sm:inline">Chats</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            {showSidebar ? 'Hide the chat list (history)' : 'Show the chat list (history)'}
          </TooltipContent>
        </Tooltip>
        <div className="flex min-w-0 items-center gap-2">
          {logo ? (
            <img src={logo} alt="" className="h-7 w-7 shrink-0 rounded object-contain" />
          ) : (
            <Logo className="h-6 w-6 shrink-0" />
          )}
          <span className="truncate text-sm font-bold tracking-wide text-primary">{brand}</span>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-2 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ctx</span>
              <div className="h-1 w-12 sm:w-16 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary/70" style={{ width: `${ctxPct}%` }} />
              </div>
              <span className="hidden md:inline text-[10px] font-medium text-muted-foreground">{formatChars(remaining)} left</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px]">
            Context budget (chars): {formatChars(safeUsed)} used / {formatChars(safeBudget)} total.
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`flex items-center gap-2 rounded-full border px-2 py-1 ${agentStepTotal > 0 && isStreaming ? 'border-primary/25 bg-primary/5' : 'border-border/70 bg-muted/20'}`}>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agent</span>
              <span className={`text-[10px] font-medium ${agentStepTotal > 0 && isStreaming ? 'text-primary' : 'text-muted-foreground'}`}>
                {agentStepTotal > 0 && isStreaming ? `${agentStep}/${agentStepTotal}` : 'idle'}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px]">
            Agent loop steps this turn (max from settings).
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        <div className="hidden items-center gap-1.5 text-xs sm:flex">
          {isOnline ? (
            <>
              <span className="status-dot-connected" />
              <Wifi className="w-3 h-3 text-accent" />
              <span className="text-muted-foreground">Online</span>
            </>
          ) : (
            <>
              <span className="status-dot-offline" />
              <WifiOff className="w-3 h-3 text-warning" />
              <span className="text-warning">Offline</span>
            </>
          )}
        </div>
        <div className="hidden items-center gap-1.5 text-xs sm:flex">
          {isLMConnected ? (
            <>
              <span className="status-dot-connected" />
              <Server className="w-3 h-3 text-accent" />
              <span className="text-muted-foreground">Local AI</span>
            </>
          ) : (
            <>
              <span className="status-dot-disconnected" />
              <ServerOff className="w-3 h-3 text-destructive" />
              <span className="text-muted-foreground">Disconnected</span>
            </>
          )}
        </div>
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="p-1 hover:text-primary transition-colors"
          title="Toggle theme"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        {!user && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" asChild>
                <Link to="/login">
                  <LogIn className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Sign in</span>
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px]">
              {serverAvailable
                ? 'Open team sign-in (shared chat history on the server).'
                : 'Team API is offline (port 3001). Start the backend, then sign in — you can still open this page for instructions.'}
            </TooltipContent>
          </Tooltip>
        )}
        {serverAvailable && user && (
          <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground max-w-[140px] truncate" title={user.email}>
            <Users className="w-3 h-3 shrink-0" />
            <span className="truncate">{user.displayName}</span>
            <span className="text-[10px] opacity-70 shrink-0">({user.role})</span>
          </div>
        )}
        {(user?.role === 'admin' || user?.role === 'auditor') && (
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Administration">
            <Link to="/admin">
              <Shield className="w-4 h-4" />
            </Link>
          </Button>
        )}
        {serverAvailable && user && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            type="button"
            title="Change password"
            onClick={() => setPasswordDialogOpen(true)}
          >
            <KeyRound className="w-4 h-4" />
          </Button>
        )}
        {serverAvailable && user && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            type="button"
            title="Sign out"
            onClick={() => void logout()}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        )}
        {canOpenSettings && (
          <button onClick={() => setShowSettings(true)} className="p-1 hover:text-primary transition-colors" title="Settings">
            <Settings className="w-4 h-4" />
          </button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={showRightPane}
              aria-label={showRightPane ? 'Hide project workspace' : 'Show project workspace'}
              onClick={() => setShowRightPane(!showRightPane)}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelRight className="h-4 w-4" />
              <span className="hidden text-xs font-medium sm:inline">Project</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            {showRightPane ? 'Hide files and project tools' : 'Show files and project tools'}
          </TooltipContent>
        </Tooltip>
      </div>

      <Dialog
        open={passwordDialogOpen}
        onOpenChange={(open) => {
          setPasswordDialogOpen(open);
          if (!open) {
            resetPasswordFields();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>Use your current password to set a new one.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitOwnPassword} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="status-current-password">Current password</Label>
              <Input
                id="status-current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="status-new-password">New password</Label>
              <Input
                id="status-new-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="status-confirm-password">Confirm new password</Label>
              <Input
                id="status-confirm-password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPasswordDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Update password</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
}
