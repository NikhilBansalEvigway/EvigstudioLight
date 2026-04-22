import { useAppStore } from '@/store/useAppStore';
import { useAuth } from '@/contexts/AuthContext';
import { FileTree } from '@/components/FileTree';
import {
  buildWorkspaceTree,
  getFileSystemAccessStatus,
  getFileExtension,
  getUniqueWorkspaceLabel,
  pickDirectory,
  writeWorkspaceFile,
} from '@/lib/fsWorkspace';
import { SYSTEM_PROMPT } from '@/types';
import { FolderOpen, FileCode, BookOpen, Terminal, Save, AlertTriangle, FilePlus, X, Copy, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import Editor from '@monaco-editor/react';

function getMonacoLanguage(filePath: string): string {
  const ext = getFileExtension(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.m': 'matlab', '.vhd': 'vhdl', '.vhdl': 'vhdl',
    '.js': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.json': 'json', '.md': 'markdown', '.py': 'python',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.html': 'html', '.css': 'css', '.xml': 'xml',
    '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shell',
    '.v': 'systemverilog', '.sv': 'systemverilog',
    '.txt': 'plaintext', '.ini': 'ini', '.toml': 'plaintext',
  };
  return map[ext] || 'plaintext';
}

type SharedWorkspaceRow = {
  id: string;
  label: string;
  rootPath: string;
  groupId: string;
  groupName: string;
};

export function WorkspacePane() {
  const {
    rightPaneTab, setRightPaneTab,
    workspaceRoots, clearWorkspace, removeWorkspacePathReferences, removeWorkspaceRoot, setFileTree,
    openEditorTabs, activeFilePath, activeFileContent, setActiveFileContent, setActiveEditorFile, closeEditorFile, markEditorFileSaved,
    contextFiles, toggleContextFile, clearContextFiles,
  } = useAppStore();
  const { serverAvailable, user } = useAuth();

  const { resolvedTheme } = useTheme();
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [sharedWorkspaces, setSharedWorkspaces] = useState<SharedWorkspaceRow[]>([]);
  const [loadingSharedWorkspaces, setLoadingSharedWorkspaces] = useState(false);

  const fsAccessStatus = getFileSystemAccessStatus();
  const fsSupported = fsAccessStatus.supported;
  const dirtyTabs = openEditorTabs.filter((tab) => tab.content !== tab.savedContent);
  const activeTab = openEditorTabs.find((tab) => tab.path === activeFilePath) ?? null;
  const activeDirty = !!activeTab && activeTab.content !== activeTab.savedContent;
  const hasWorkspace = workspaceRoots.length > 0;

  // Monaco keybindings are registered once; keep callbacks fresh.
  const saveActiveRef = useRef<() => void>(() => {});
  const saveAllRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (dirtyTabs.length === 0) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirtyTabs.length]);

  useEffect(() => {
    if (rightPaneTab !== 'context' || !serverAvailable || !user) {
      if (!serverAvailable || !user) {
        setSharedWorkspaces([]);
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      setLoadingSharedWorkspaces(true);
      try {
        const groupResponse = await fetch('/api/groups', { credentials: 'include' });
        if (!groupResponse.ok) throw new Error('Could not load groups');

        const groupData = (await groupResponse.json()) as {
          groups?: Array<{ id: string; name: string }>;
        };
        const groups = Array.isArray(groupData.groups) ? groupData.groups : [];
        const workspaceLists = await Promise.all(
          groups.map(async (group) => {
            const response = await fetch(`/api/groups/${group.id}/workspaces`, { credentials: 'include' });
            if (!response.ok) return [] as SharedWorkspaceRow[];

            const data = (await response.json()) as {
              workspaces?: Array<{ id: string; label: string; rootPath: string; groupId: string }>;
            };

            return (data.workspaces ?? []).map((workspace) => ({
              id: workspace.id,
              label: workspace.label,
              rootPath: workspace.rootPath,
              groupId: workspace.groupId,
              groupName: group.name,
            }));
          }),
        );

        if (!cancelled) {
          setSharedWorkspaces(workspaceLists.flat());
        }
      } catch {
        if (!cancelled) {
          setSharedWorkspaces([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingSharedWorkspaces(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rightPaneTab, serverAvailable, user]);

  const handleSavePath = useCallback(async (path: string) => {
    const state = useAppStore.getState();
    if (state.workspaceRoots.length === 0) throw new Error('No workspace folder open');

    const tab = state.openEditorTabs.find((entry) => entry.path === path);
    if (!tab) return false;
    if (tab.content === tab.savedContent) return false;

    await writeWorkspaceFile(state.workspaceRoots, path, tab.content);
    markEditorFileSaved(path, tab.content);
    return true;
  }, [markEditorFileSaved]);

  const handleOpenFolder = async () => {
    if (!fsSupported) {
      toast.error(fsAccessStatus.message ?? 'File System Access API not supported.');
      return;
    }
    const handle = await pickDirectory();
    if (handle) {
      const currentRoots = useAppStore.getState().workspaceRoots;
      for (const root of currentRoots) {
        if (typeof (root.handle as any).isSameEntry === 'function' && await (root.handle as any).isSameEntry(handle)) {
          toast.message(`${root.label} is already open`);
          return;
        }
      }

      const label = getUniqueWorkspaceLabel(currentRoots, handle.name);
      const nextRoots = [...currentRoots, { id: crypto.randomUUID(), label, handle }];
      useAppStore.getState().setWorkspaceRoots(nextRoots);
      const tree = await buildWorkspaceTree(nextRoots);
      setFileTree(tree);
      toast.success(`${currentRoots.length === 0 ? 'Opened' : 'Added'}: ${label}`);
    }
  };

  const handleRefresh = useCallback(async () => {
    const roots = useAppStore.getState().workspaceRoots;
    if (roots.length === 0) {
      setFileTree([]);
      return;
    }

    const tree = await buildWorkspaceTree(roots);
    setFileTree(tree);
  }, [setFileTree]);

  const handleRemoveRoot = useCallback(async (rootId: string) => {
    const state = useAppStore.getState();
    const root = state.workspaceRoots.find((entry) => entry.id === rootId);
    if (!root) return;

    const affectedDirtyTabs = state.openEditorTabs.filter(
      (tab) => tab.path === root.label || tab.path.startsWith(`${root.label}/`),
    ).filter((tab) => tab.content !== tab.savedContent);

    if (affectedDirtyTabs.length > 0) {
      const confirmed = window.confirm(
        `Remove ${root.label} from the workspace and close ${affectedDirtyTabs.length} unsaved tab${affectedDirtyTabs.length === 1 ? '' : 's'}?`,
      );
      if (!confirmed) return;
    }

    removeWorkspacePathReferences(root.label);
    if (state.workspaceRoots.length === 1) {
      clearWorkspace();
      toast.success(`Removed ${root.label} from the workspace`);
      return;
    }

    const nextRoots = state.workspaceRoots.filter((entry) => entry.id !== rootId);
    removeWorkspaceRoot(rootId);
    const tree = await buildWorkspaceTree(nextRoots);
    setFileTree(tree);
    toast.success(`Removed ${root.label} from the workspace`);
  }, [clearWorkspace, removeWorkspacePathReferences, removeWorkspaceRoot, setFileTree]);

  const handleSave = async () => {
    if (!hasWorkspace || !activeFilePath) return;
    try {
      const saved = await handleSavePath(activeFilePath);
      if (!saved) return;
      toast.success(`Saved ${activeFilePath} ✅`);
      await handleRefresh();
    } catch (err: any) {
      toast.error(`Save failed: ${err.message}`);
    }
  };

  useEffect(() => {
    saveActiveRef.current = () => {
      void handleSave();
    };
  });

  const handleSaveAll = useCallback(async () => {
    if (dirtyTabs.length === 0) return;

    try {
      let savedCount = 0;
      for (const tab of dirtyTabs) {
        if (await handleSavePath(tab.path)) {
          savedCount += 1;
        }
      }
      if (savedCount > 0) {
        toast.success(`Saved ${savedCount} file${savedCount === 1 ? '' : 's'} ✅`);
        await handleRefresh();
      }
    } catch (err: any) {
      toast.error(`Save all failed: ${err.message}`);
    }
  }, [dirtyTabs, handleRefresh, handleSavePath]);

  useEffect(() => {
    saveAllRef.current = () => {
      void handleSaveAll();
    };
  }, [handleSaveAll]);

  const handleCloseTab = useCallback((path: string) => {
    const tab = openEditorTabs.find((entry) => entry.path === path);
    const isDirty = !!tab && tab.content !== tab.savedContent;
    if (isDirty && !window.confirm(`Discard unsaved changes in ${path}?`)) {
      return;
    }
    closeEditorFile(path);
  }, [closeEditorFile, openEditorTabs]);

  const handleCreateFile = async () => {
    if (!hasWorkspace || !newFileName.trim()) return;
    try {
      await writeWorkspaceFile(workspaceRoots, newFileName.trim(), '');
      toast.success(`Created ${newFileName.trim()}`);
      setNewFileName('');
      setShowNewFile(false);
      await handleRefresh();
    } catch (err: any) {
      toast.error(`Create failed: ${err.message}`);
    }
  };

  const tabs = [
    { id: 'files' as const, label: 'Files', icon: FolderOpen },
    { id: 'editor' as const, label: 'Editor', icon: FileCode },
    { id: 'context' as const, label: 'Context', icon: BookOpen },
  ];

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Tabs */}
      <div className="flex border-b border-border">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setRightPaneTab(tab.id)}
            className={`flex items-center gap-1 px-3 py-2 text-[10px] uppercase tracking-wider font-semibold transition-colors border-b-2 ${rightPaneTab === tab.id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
          >
            <tab.icon className="w-3 h-3" />
            {tab.label}
            {tab.id === 'context' && contextFiles.length > 0 && (
              <span className="ml-1 px-1 py-px rounded-full bg-accent/20 text-accent text-[9px]">{contextFiles.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {rightPaneTab === 'files' && (
          <div className="flex flex-col h-full">
            <div className="border-b border-border bg-gradient-to-b from-card via-card to-muted/20 px-2 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={handleOpenFolder}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary transition-all hover:-translate-y-0.5 hover:bg-primary/15"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {hasWorkspace ? 'Add Folder' : 'Open Folder'}
                </button>
                {hasWorkspace && (
                  <>
                    <button
                      onClick={handleRefresh}
                      className="rounded-xl border border-border/70 bg-background px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground transition-all hover:border-primary/20 hover:text-foreground"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={() => setShowNewFile(!showNewFile)}
                      className={`rounded-xl border px-2.5 py-1.5 text-[10px] font-medium transition-all ${showNewFile
                        ? 'border-primary/20 bg-primary/10 text-primary'
                        : 'border-border/70 bg-background text-muted-foreground hover:border-primary/20 hover:text-primary'}`}
                      title="Quick create file"
                    >
                      <span className="inline-flex items-center gap-1">
                        <FilePlus className="h-3.5 w-3.5" />
                        Quick file
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        if (dirtyTabs.length > 0 && !window.confirm(`Clear the workspace and close ${dirtyTabs.length} open tab${dirtyTabs.length === 1 ? '' : 's'}?`)) {
                          return;
                        }
                        clearWorkspace();
                        toast.success('Cleared workspace folders');
                      }}
                      className="rounded-xl border border-border/70 bg-background px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground transition-all hover:border-destructive/20 hover:text-destructive"
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            </div>
            {!fsSupported && (
              <div className="flex items-start gap-2 border-b border-warning/20 bg-warning/10 px-3 py-2 text-[10px]">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                <span className="text-warning">{fsAccessStatus.message}</span>
              </div>
            )}
            {showNewFile && hasWorkspace && (
              <div className="flex items-center gap-1.5 border-b border-border px-2 py-2 animate-fade-in">
                <input
                  value={newFileName}
                  onChange={e => setNewFileName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateFile()}
                  placeholder={workspaceRoots.length === 1 ? 'folder/path/to/file.vhd or src/file.vhd' : 'folder-name/path/to/file.vhd'}
                  className="flex-1 rounded-xl border border-border/70 bg-input px-3 py-2 text-[10px] outline-none focus:ring-1 focus:ring-ring"
                />
                <button onClick={handleCreateFile} className="rounded-xl bg-accent/15 px-3 py-2 text-[10px] font-semibold text-accent transition-colors hover:bg-accent/25">Create</button>
              </div>
            )}
            {hasWorkspace && (
              <div className="border-b border-border/60 px-2 py-1.5 text-[10px] text-muted-foreground">
                <div className="flex flex-wrap gap-1.5">
                  {workspaceRoots.map((root) => (
                    <div key={root.id} className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1">
                      <FolderOpen className="h-3 w-3 text-primary" />
                      <span className="max-w-[180px] truncate font-medium text-foreground/90">{root.label}</span>
                      <button
                        type="button"
                        onClick={() => void handleRemoveRoot(root.id)}
                        className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
                        title={`Remove ${root.label} from workspace`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              <FileTree />
            </div>
          </div>
        )}

        {rightPaneTab === 'editor' && (
          <div className="flex flex-col h-full">
            {activeFilePath ? (
              <>
                {openEditorTabs.length > 0 && (
                  <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-muted/20 px-2 py-1.5">
                    {openEditorTabs.map((tab) => {
                      const isActive = tab.path === activeFilePath;
                      const shortName = tab.path.split('/').pop() ?? tab.path;
                      return (
                        <div
                            key={tab.path}
                            className={`group inline-flex max-w-[220px] shrink-0 items-center gap-1 rounded-xl border px-2 py-1 text-[10px] transition-colors ${
                              isActive
                                ? 'border-primary/30 bg-primary/10 text-primary'
                                : 'border-border/70 bg-background text-muted-foreground hover:border-primary/20 hover:text-foreground'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => setActiveEditorFile(tab.path)}
                              className="min-w-0 flex-1 truncate text-left"
                              title={tab.path}
                            >
                              <span className="inline-flex min-w-0 items-center gap-1">
                                {tab.content !== tab.savedContent && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
                                <span className="truncate">{shortName}</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCloseTab(tab.path)}
                              className="rounded p-0.5 text-current/70 transition-colors hover:bg-background/70 hover:text-foreground"
                              title={`Close ${tab.path}`}
                            >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
                  <div className="min-w-0">
                    <span className="text-[10px] text-muted-foreground truncate">{activeFilePath}</span>
                    {activeDirty && <div className="text-[10px] text-warning">Unsaved changes</div>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {dirtyTabs.length > 0 && (
                      <button
                        onClick={() => void handleSaveAll()}
                        className="flex items-center gap-1 px-2 py-0.5 rounded border border-border/70 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Save all ({dirtyTabs.length})
                      </button>
                    )}
                    <button
                      onClick={() => void handleSave()}
                      disabled={!activeDirty}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent text-[10px] hover:bg-accent/25 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Save className="w-3 h-3" /> Save
                    </button>
                  </div>
                </div>
                <div className="flex-1 min-h-0">
                  <Editor
                    height="100%"
                    language={getMonacoLanguage(activeFilePath)}
                    value={activeFileContent}
                    onChange={(v) => setActiveFileContent(v ?? '')}
                    theme={resolvedTheme === 'dark' ? 'agent-dark' : 'agent-light'}
                    beforeMount={(monaco) => {
                      monaco.editor.defineTheme('agent-dark', {
                        base: 'vs-dark',
                        inherit: true,
                        rules: [
                          { token: 'comment', foreground: '546E7A', fontStyle: 'italic' },
                          { token: 'keyword', foreground: '17b8a6' },
                          { token: 'string', foreground: '4ade80' },
                          { token: 'number', foreground: 'f59e0b' },
                          { token: 'type', foreground: '60a5fa' },
                        ],
                        colors: {
                          'editor.background': '#0d1017',
                          'editor.foreground': '#d4d8e0',
                          'editor.lineHighlightBackground': '#141b24',
                          'editorCursor.foreground': '#17b8a6',
                          'editor.selectionBackground': '#17b8a633',
                          'editorLineNumber.foreground': '#374151',
                          'editorLineNumber.activeForeground': '#6b7280',
                          'editorGutter.background': '#0d1017',
                          'editorWidget.background': '#141b24',
                          'input.background': '#141b24',
                          'input.foreground': '#d4d8e0',
                          'input.border': '#1e2a36',
                        },
                      });
                      monaco.editor.defineTheme('agent-light', {
                        base: 'vs',
                        inherit: true,
                        rules: [
                          { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
                          { token: 'keyword', foreground: '0d9488' },
                          { token: 'string', foreground: '16a34a' },
                          { token: 'number', foreground: 'd97706' },
                          { token: 'type', foreground: '2563eb' },
                        ],
                        colors: {
                          'editor.background': '#f5f6f8',
                          'editor.foreground': '#1e293b',
                          'editor.lineHighlightBackground': '#e8ecf1',
                          'editorCursor.foreground': '#0d9488',
                          'editor.selectionBackground': '#0d948833',
                          'editorLineNumber.foreground': '#94a3b8',
                          'editorLineNumber.activeForeground': '#64748b',
                          'editorGutter.background': '#f5f6f8',
                          'editorWidget.background': '#eef0f4',
                          'input.background': '#eef0f4',
                          'input.foreground': '#1e293b',
                          'input.border': '#d1d5db',
                        },
                      });
                    }}
                    onMount={(editor, monaco) => {
                      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveRef.current());
                      editor.addCommand(
                        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
                        () => saveAllRef.current(),
                      );
                    }}
                    options={{
                      fontSize: 12,
                      fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace",
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      padding: { top: 8 },
                      lineNumbers: 'on',
                      renderLineHighlight: 'line',
                      bracketPairColorization: { enabled: true },
                      automaticLayout: true,
                      wordWrap: 'on',
                      tabSize: 2,
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Select a file to edit
              </div>
            )}
          </div>
        )}

        {rightPaneTab === 'context' && (
          <div className="p-3 space-y-2">
            {serverAvailable && user && (
              <div className="space-y-2 rounded-xl border border-border/70 bg-card/80 p-3">
                <div className="flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Shared Team Paths
                  </span>
                </div>
                {loadingSharedWorkspaces ? (
                  <p className="text-xs text-muted-foreground">Loading shared workspace references…</p>
                ) : sharedWorkspaces.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No shared workspace references are available for your teams yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {sharedWorkspaces.map((workspace) => (
                      <div key={workspace.id} className="rounded-lg border border-border/70 bg-background px-3 py-2 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">{workspace.label}</div>
                            <div className="text-[10px] text-primary">{workspace.groupName}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard.writeText(workspace.rootPath);
                              toast.success(`Copied ${workspace.label}`);
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                            title={`Copy ${workspace.rootPath}`}
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </button>
                        </div>
                        <div className="mt-2 break-all rounded-md bg-secondary px-2 py-1.5 text-[11px] text-muted-foreground">
                          {workspace.rootPath}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Injected Files</span>
              {contextFiles.length > 0 && (
                <button onClick={clearContextFiles} className="text-[10px] text-destructive hover:underline">Clear all</button>
              )}
            </div>
            {contextFiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No files in context. Click the + icon next to files in the file tree to add them.
              </p>
            ) : (
              <div className="space-y-1">
                {contextFiles.map(path => (
                  <div key={path} className="flex items-center gap-2 px-2 py-1 rounded bg-secondary text-xs">
                    <FileCode className="w-3 h-3 text-primary shrink-0" />
                    <span className="flex-1 truncate">{path}</span>
                    <button onClick={() => toggleContextFile(path)} className="text-muted-foreground hover:text-destructive">×</button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-4">
              Context files are injected into the agent's next request so it can read and edit them.
            </p>
          </div>
        )}

        {rightPaneTab === 'prompt' && (
          <div className="p-3">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">System Prompt (Read-Only)</span>
            <pre className="mt-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap bg-secondary rounded p-3 max-h-[calc(100vh-200px)] overflow-y-auto">
              {SYSTEM_PROMPT}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
