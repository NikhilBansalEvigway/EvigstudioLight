import { useEffect, useSyncExternalStore } from 'react';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Link } from 'react-router-dom';
import { useAppStore } from '@/store/useAppStore';
import { useAuth } from '@/contexts/AuthContext';
import { StatusBar } from '@/components/StatusBar';
import { Sidebar } from '@/components/Sidebar';
import { ChatPane } from '@/components/ChatPane';
import { WorkspacePane } from '@/components/WorkspacePane';
import { SettingsDialog } from '@/components/SettingsDialog';
import { MessageSquare, FolderOpen, Settings2, Shield } from 'lucide-react';

const LG_MQ = '(min-width: 1024px)';

function subscribeWide(callback: () => void) {
  const mq = window.matchMedia(LG_MQ);
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

function getWideSnapshot() {
  return window.matchMedia(LG_MQ).matches;
}

function getServerWideSnapshot() {
  return false;
}

function useIsLgUp() {
  return useSyncExternalStore(subscribeWide, getWideSnapshot, getServerWideSnapshot);
}

export function Layout() {
  const { showSidebar, showRightPane, setOnline, settings, setShowSidebar, setShowRightPane, setRightPaneTab, setShowSettings } = useAppStore();
  const { user } = useAuth();
  const bgUrl = settings.backgroundImageDataUrl;
  const overlay = settings.backgroundOverlayOpacity ?? 0.88;
  const isLgUp = useIsLgUp();
  const shellSurfaceClass = bgUrl ? 'bg-background/70 backdrop-blur-sm' : 'bg-background';
  const sidebarSurfaceClass = bgUrl ? 'bg-sidebar/80 backdrop-blur-xl shadow-[0_20px_60px_hsl(var(--background)/0.16)]' : 'bg-sidebar';
  const workspaceSurfaceClass = bgUrl ? 'bg-card/74 backdrop-blur-xl shadow-[0_20px_60px_hsl(var(--background)/0.14)]' : 'bg-card';

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline]);

  const layoutKey = `${showSidebar ? 'L' : 'l'}${showRightPane ? 'R' : 'r'}`;

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden">
      {bgUrl ? (
        <>
          <div
            className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
            style={{ backgroundImage: `url(${bgUrl})` }}
            aria-hidden
          />
          <div
            className="pointer-events-none absolute inset-0 z-[1] bg-background"
            style={{ opacity: overlay }}
            aria-hidden
          />
        </>
      ) : null}
      <div className={`relative z-[2] flex min-h-0 flex-1 flex-col overflow-hidden ${!bgUrl ? 'bg-background' : ''}`}>
        <StatusBar />
        {isLgUp ? (
          <PanelGroup
            key={layoutKey}
            direction="horizontal"
            autoSaveId={`evigstudio-panels-${layoutKey}`}
            className="flex min-h-0 flex-1"
          >
            <Panel defaultSize={showSidebar ? 22 : 5} minSize={showSidebar ? 14 : 4} maxSize={showSidebar ? 42 : 8} className="min-h-0 min-w-0">
              <div className={`flex h-full min-h-0 flex-col overflow-hidden ${sidebarSurfaceClass}`}>
                {showSidebar ? (
                  <Sidebar />
                ) : (
                  <CollapsedSidebarRail
                    isAdmin={user?.role === 'admin' || user?.role === 'auditor'}
                    canOpenSettings={user?.role === 'admin'}
                    onExpandChats={() => setShowSidebar(true)}
                    onOpenFiles={() => {
                      setShowRightPane(true);
                      setRightPaneTab('files');
                    }}
                    onOpenSettings={() => setShowSettings(true)}
                  />
                )}
              </div>
            </Panel>
            {showSidebar ? (
              <>
                <PanelResizeHandle
                  aria-label="Resize between chat list and conversation"
                  className="group relative w-3 shrink-0 bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span
                    className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full bg-border/0 transition-all group-hover:bg-primary/45 group-hover:w-1"
                    aria-hidden
                  />
                </PanelResizeHandle>
              </>
            ) : null}
            <Panel
              defaultSize={showSidebar ? (showRightPane ? 50 : 78) : showRightPane ? 62 : 100}
              minSize={28}
              className="min-h-0 min-w-0"
            >
              <div
                  className={showRightPane
                    ? `flex h-full min-h-0 flex-col overflow-hidden border-r border-border ${shellSurfaceClass}`
                    : `flex h-full min-h-0 flex-col overflow-hidden ${shellSurfaceClass}`}
                >
                  <ChatPane />
                </div>
            </Panel>
            {showRightPane ? (
              <>
                <PanelResizeHandle
                  aria-label="Resize between conversation and project workspace"
                  className="group relative w-3 shrink-0 bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span
                    className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full bg-border/0 transition-all group-hover:bg-primary/45 group-hover:w-1"
                    aria-hidden
                  />
                </PanelResizeHandle>
                <Panel defaultSize={showSidebar ? 28 : 38} minSize={16} maxSize={52} className="min-h-0 min-w-0">
                  <div className={`flex h-full min-h-0 flex-col overflow-hidden ${workspaceSurfaceClass}`}>
                    <WorkspacePane />
                  </div>
                </Panel>
              </>
            ) : null}
          </PanelGroup>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {showSidebar && (
              <div className={`flex max-h-[min(38vh,320px)] w-full shrink-0 flex-col overflow-hidden border-b border-border ${sidebarSurfaceClass}`}>
                <Sidebar />
              </div>
            )}
            <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${shellSurfaceClass}`}>
              <ChatPane />
            </div>
            {showRightPane && (
              <div className={`flex max-h-[min(40vh,360px)] w-full shrink-0 flex-col overflow-hidden border-t border-border ${workspaceSurfaceClass}`}>
                <WorkspacePane />
              </div>
            )}
          </div>
        )}
      </div>

      <SettingsDialog />
    </div>
  );
}

function CollapsedSidebarRail({
  isAdmin,
  canOpenSettings,
  onExpandChats,
  onOpenFiles,
  onOpenSettings,
}: {
  isAdmin: boolean;
  canOpenSettings: boolean;
  onExpandChats: () => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center gap-2 px-2 py-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Nav</div>
      <button
        type="button"
        onClick={onExpandChats}
        className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border/70 bg-background/70 text-muted-foreground transition-colors hover:border-primary/20 hover:text-primary"
        title="Expand chats"
      >
        <MessageSquare className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onOpenFiles}
        className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border/70 bg-background/70 text-muted-foreground transition-colors hover:border-primary/20 hover:text-primary"
        title="Open files"
      >
        <FolderOpen className="h-4 w-4" />
      </button>
      {canOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border/70 bg-background/70 text-muted-foreground transition-colors hover:border-primary/20 hover:text-primary"
          title="Open settings"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      )}
      {isAdmin && (
        <Link
          to="/admin"
          className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border/70 bg-background/70 text-muted-foreground transition-colors hover:border-primary/20 hover:text-primary"
          title="Open admin"
        >
          <Shield className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
