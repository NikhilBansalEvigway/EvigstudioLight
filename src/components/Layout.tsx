import { useEffect, useSyncExternalStore } from 'react';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useAppStore } from '@/store/useAppStore';
import { StatusBar } from '@/components/StatusBar';
import { Sidebar } from '@/components/Sidebar';
import { ChatPane } from '@/components/ChatPane';
import { WorkspacePane } from '@/components/WorkspacePane';
import { SettingsDialog } from '@/components/SettingsDialog';

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
  const { showSidebar, showRightPane, setOnline, settings } = useAppStore();
  const bgUrl = settings.backgroundImageDataUrl;
  const overlay = settings.backgroundOverlayOpacity ?? 0.88;
  const isLgUp = useIsLgUp();

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
      <div
        className={`relative z-[2] flex min-h-0 flex-1 flex-col overflow-hidden ${!bgUrl ? 'bg-background' : ''}`}
      >
        <StatusBar />
        {isLgUp ? (
          <PanelGroup
            key={layoutKey}
            direction="horizontal"
            autoSaveId={`evigstudio-panels-${layoutKey}`}
            className="flex min-h-0 flex-1"
          >
            {showSidebar ? (
              <>
                <Panel defaultSize={22} minSize={14} maxSize={42} className="min-h-0 min-w-0">
                  <div className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar">
                    <Sidebar />
                  </div>
                </Panel>
                <PanelResizeHandle
                  aria-label="Resize between chat list and conversation"
                  className="group relative w-2 shrink-0 bg-border transition-colors hover:bg-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span
                    className="absolute inset-y-3 left-1/2 w-1 -translate-x-1/2 rounded-full bg-muted-foreground/35 group-hover:bg-primary/70"
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
                className={
                  showRightPane
                    ? 'flex h-full min-h-0 flex-col overflow-hidden border-r border-border bg-background'
                    : 'flex h-full min-h-0 flex-col overflow-hidden bg-background'
                }
              >
                <ChatPane />
              </div>
            </Panel>
            {showRightPane ? (
              <>
                <PanelResizeHandle
                  aria-label="Resize between conversation and project workspace"
                  className="group relative w-2 shrink-0 bg-border transition-colors hover:bg-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span
                    className="absolute inset-y-3 left-1/2 w-1 -translate-x-1/2 rounded-full bg-muted-foreground/35 group-hover:bg-primary/70"
                    aria-hidden
                  />
                </PanelResizeHandle>
                <Panel defaultSize={showSidebar ? 28 : 38} minSize={16} maxSize={52} className="min-h-0 min-w-0">
                  <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card">
                    <WorkspacePane />
                  </div>
                </Panel>
              </>
            ) : null}
          </PanelGroup>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {showSidebar && (
              <div className="flex max-h-[min(38vh,320px)] w-full shrink-0 flex-col overflow-hidden border-b border-border bg-sidebar">
                <Sidebar />
              </div>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
              <ChatPane />
            </div>
            {showRightPane && (
              <div className="flex max-h-[min(40vh,360px)] w-full shrink-0 flex-col overflow-hidden border-t border-border bg-card">
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
