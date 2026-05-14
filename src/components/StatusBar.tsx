import { Link } from 'react-router-dom';
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
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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
    </header>
  );
}
