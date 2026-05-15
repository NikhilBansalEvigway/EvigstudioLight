import { useAppStore } from '@/store/useAppStore';
import { useAuth } from '@/contexts/AuthContext';
import { FileTree } from '@/components/FileTree';
import {
  buildWorkspaceTree,
  createUploadedWorkspaceRootsFromFiles,
  downloadWorkspaceZipBundle,
  getFileSystemAccessStatus,
  pickDirectory,
  writeWorkspaceFile,
  createWorkspaceFile,
  workspaceRootsMatch,
  isNativeDiskStubRoot,
  getUniqueWorkspaceLabel,
} from '@/lib/fsWorkspace';
import { isUploadBackedWorkspaceRoot } from '@/lib/uploadedWorkspace';
import {
  buildActiveDocumentAudit,
  buildWorkspaceRootSummaries,
  normalizeAuditPaths,
  postWorkspaceAuditEvent,
  workspaceFolderLabels,
} from '@/lib/auditClient';
import {
  fetchWorkspaceMirrorStatus,
  getWorkspaceMirrorToken,
  invalidateWorkspaceMirrorStatusCache,
  setWorkspaceMirrorToken,
  type WorkspaceMirrorStatus,
} from '@/lib/workspaceMirrorClient';
import { SYSTEM_PROMPT } from '@/types';
import { monacoLanguageFromPath } from '@/lib/monacoLanguageFromPath';
import { randomId } from '@/lib/randomId';
import { FileDiffViewer } from '@/components/features/diff-viewer/file-diff-viewer';
import {
  FolderOpen,
  FileCode,
  BookOpen,
  Save,
  AlertTriangle,
  FilePlus,
  X,
  Copy,
  Users,
  Loader2,
  Download,
  GitCompare,
  Info,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { useState, useCallback, useEffect, useRef, useId } from 'react';
import { useTheme } from 'next-themes';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

loader.config({ monaco });

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
    workspaceRoots, clearWorkspace, setFileTree,
    openEditorTabs, activeFilePath, activeFileContent, setActiveFileContent, setActiveEditorFile, closeEditorFile, markEditorFileSaved,
    contextFiles, toggleContextFile, clearContextFiles, settings, fileTree,
  } = useAppStore();
  const { serverAvailable, user } = useAuth();

  const { resolvedTheme } = useTheme();
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [sharedWorkspaces, setSharedWorkspaces] = useState<SharedWorkspaceRow[]>([]);
  const [loadingSharedWorkspaces, setLoadingSharedWorkspaces] = useState(false);
  const [workspaceTreeLoading, setWorkspaceTreeLoading] = useState(false);
  const [mirrorStatus, setMirrorStatus] = useState<WorkspaceMirrorStatus | null>(null);
  const [mirrorTokenDraft, setMirrorTokenDraft] = useState('');

  const fsAccessStatus = getFileSystemAccessStatus();
  const workspaceUiOk = fsAccessStatus.workspaceUiAvailable;
  const linkDiskPickerAvailable = fsAccessStatus.nativeDirectoryPicker && workspaceUiOk;

  const folderInputId = useId();
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const dirtyTabs = openEditorTabs.filter((tab) => tab.content !== tab.savedContent);
  const activeTab = openEditorTabs.find((tab) => tab.path === activeFilePath) ?? null;
  const activeDirty = !!activeTab && activeTab.content !== activeTab.savedContent;
  const hasWorkspace = workspaceRoots.length > 0;
  const hasBackground = Boolean(settings.backgroundImageDataUrl);
  const nativeRootsNeedReconnect = workspaceRoots.some((r) => isNativeDiskStubRoot(r));
  const uploadRootsNeedingDiskLink = workspaceRoots.filter(
    (r) => isUploadBackedWorkspaceRoot(r) && !r.diskDirectoryHandle,
  );

  const mirrorTokenInitRef = useRef(false);
  useEffect(() => {
    if (rightPaneTab !== 'files' || !workspaceUiOk) return;
    let cancelled = false;
    void fetchWorkspaceMirrorStatus().then((s) => {
      if (!cancelled) setMirrorStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [rightPaneTab, workspaceUiOk]);

  useEffect(() => {
    if (mirrorStatus?.enabled && mirrorStatus.requiresToken && !mirrorTokenInitRef.current) {
      mirrorTokenInitRef.current = true;
      setMirrorTokenDraft(getWorkspaceMirrorToken());
    }
    if (!mirrorStatus?.enabled) mirrorTokenInitRef.current = false;
  }, [mirrorStatus]);

  const emitWorkspaceAudit = useCallback((input: {
    event: 'open' | 'refresh' | 'clear' | 'context_update';
    workspaceFolders?: string[];
    addedFolder?: string | null;
    changedPath?: string | null;
    changeKind?: 'add' | 'remove' | 'clear' | null;
    contextFiles?: string[];
    trigger?: string | null;
  }) => {
    const state = useAppStore.getState();
    const activeChat = state.chats.find((chat) => chat.id === state.activeChatId) ?? null;
    void postWorkspaceAuditEvent({
      event: input.event,
      chatId: activeChat?.id ?? null,
      chatTitle: activeChat?.title ?? null,
      chatMode: activeChat?.mode ?? null,
      workspaceFolders: input.workspaceFolders ?? workspaceFolderLabels(state.workspaceRoots),
      contextFiles: input.contextFiles ?? normalizeAuditPaths(state.contextFiles, 50),
      activeFilePath: state.activeFilePath,
      addedFolder: input.addedFolder ?? null,
      changedPath: input.changedPath ?? null,
      changeKind: input.changeKind ?? null,
      trigger: input.trigger ?? null,
      workspaceRootSummaries: buildWorkspaceRootSummaries(state.workspaceRoots, state.fileTree),
      activeDocument: buildActiveDocumentAudit(state.activeFilePath),
    });
  }, []);

  // Monaco keybindings are registered once; keep callbacks fresh.
  const saveActiveRef = useRef<() => void>(() => {});
  const saveAllRef = useRef<() => void>(() => {});
  const treeRequestIdRef = useRef(0);

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

    const linkedDisk = await writeWorkspaceFile(state.workspaceRoots, path, tab.content);
    if (linkedDisk) useAppStore.getState().bumpWorkspaceSessionRevision();
    markEditorFileSaved(path, tab.content);
    return true;
  }, [markEditorFileSaved]);

  const ingestUploadedFolderFiles = useCallback(
    async (files: File[]) => {
      const currentRoots = useAppStore.getState().workspaceRoots;
      let newRootsBatch: import('@/types').WorkspaceRoot[];
      try {
        newRootsBatch = createUploadedWorkspaceRootsFromFiles(files, currentRoots);
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : 'Could not read folder');
        return;
      }

      const nextRoots = [...currentRoots, ...newRootsBatch];
      const currentTree = useAppStore.getState().fileTree;
      const requestId = ++treeRequestIdRef.current;
      const labelsSummary = newRootsBatch.map((r) => r.label).join(', ');
      setWorkspaceTreeLoading(true);
      useAppStore.getState().setWorkspaceRoots(nextRoots);
      try {
        const tree = await buildWorkspaceTree(nextRoots, {
          initialTree: currentTree,
          rebuildRootIds: newRootsBatch.map((r) => r.id),
          onProgress: (progressTree) => {
            if (treeRequestIdRef.current === requestId && workspaceRootsMatch(useAppStore.getState().workspaceRoots, nextRoots)) {
              setFileTree(progressTree);
            }
          },
        });
        if (treeRequestIdRef.current !== requestId || !workspaceRootsMatch(useAppStore.getState().workspaceRoots, nextRoots)) return;
        setFileTree(tree);
        const fileCount = newRootsBatch.reduce((n, r) => n + (r.uploadedFiles?.size ?? 0), 0);
        toast.success(`${currentRoots.length === 0 ? 'Opened' : 'Added'}: ${labelsSummary}`, {
          description: fileCount
            ? `${fileCount} files — To save edits back to a folder on disk, use Link disk next to that workspace folder in the tree (Chrome/Edge), or enable server mirror if your admin configured it.`
            : 'Use Link disk next to the workspace folder in the tree when your browser supports it, or server mirror if enabled.',
        });
        emitWorkspaceAudit({
          event: 'open',
          workspaceFolders: workspaceFolderLabels(nextRoots),
          addedFolder: labelsSummary,
          trigger: currentRoots.length === 0 ? 'open_folder' : 'add_folder',
        });
        const sid = useAppStore.getState().activeChatId;
        if (sid) void useAppStore.getState().persistWorkspaceSession(sid);
      } catch (err: unknown) {
        if (treeRequestIdRef.current === requestId) {
          if (workspaceRootsMatch(useAppStore.getState().workspaceRoots, nextRoots)) {
            useAppStore.getState().setWorkspaceRoots(currentRoots);
            setFileTree(currentTree);
          }
          toast.error(`Could not open ${labelsSummary}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        if (treeRequestIdRef.current === requestId) {
          setWorkspaceTreeLoading(false);
        }
      }
    },
    [emitWorkspaceAudit, setFileTree],
  );

  const countFilesInTreeNodes = useCallback((nodes: import('@/types').FileNode[]): number => {
    let n = 0;
    const walk = (list: import('@/types').FileNode[]) => {
      for (const node of list) {
        if (node.type === 'file') n += 1;
        else if (node.children?.length) walk(node.children);
      }
    };
    walk(nodes);
    return n;
  }, []);

  const openFolderViaDirectoryPicker = useCallback(async () => {
    if (workspaceTreeLoading) return;
    const existingRoots = useAppStore.getState().workspaceRoots;

    toast.message('Choose a folder to open.');
    let handle: FileSystemDirectoryHandle | null = null;
    try {
      handle = await pickDirectory();
    } catch (err: unknown) {
      const name =
        err instanceof DOMException ? err.name : err instanceof Error ? err.name : '';
      if (name === 'AbortError') return;
      console.warn('[EvigStudio] open folder showDirectoryPicker failed', err);
      toast.warning('Could not open the folder dialog.', {
        description:
          'Try again after closing other file dialogs, or drag your project folder onto the workspace instead.',
        duration: 14_000,
      });
      return;
    }
    if (!handle) return;

    for (const r of existingRoots) {
      for (const h of [r.handle, r.diskDirectoryHandle]) {
        if (!h || typeof (h as { isSameEntry?: (x: FileSystemDirectoryHandle) => Promise<boolean> }).isSameEntry !== 'function') {
          continue;
        }
        try {
          if (await (h as { isSameEntry: (x: FileSystemDirectoryHandle) => Promise<boolean> }).isSameEntry(handle)) {
            toast.message('That folder is already in this workspace.');
            return;
          }
        } catch {
          /* ignore */
        }
      }
    }

    const newRoot: import('@/types').WorkspaceRoot = {
      id: randomId(),
      label: getUniqueWorkspaceLabel(existingRoots, handle.name),
      handle,
    };
    const nextRoots = [...existingRoots, newRoot];

    const currentTree = useAppStore.getState().fileTree;
    const requestId = ++treeRequestIdRef.current;
    const labelsSummary = newRoot.label;
    setWorkspaceTreeLoading(true);
    useAppStore.getState().setWorkspaceRoots(nextRoots);
    try {
      const tree = await buildWorkspaceTree(nextRoots, {
        initialTree: currentTree,
        rebuildRootIds: [newRoot.id],
        onProgress: (progressTree) => {
          if (treeRequestIdRef.current === requestId && workspaceRootsMatch(useAppStore.getState().workspaceRoots, nextRoots)) {
            setFileTree(progressTree);
          }
        },
      });
      if (treeRequestIdRef.current !== requestId || !workspaceRootsMatch(useAppStore.getState().workspaceRoots, nextRoots)) return;
      setFileTree(tree);
      const fileCount = countFilesInTreeNodes(tree);
      toast.success(`${existingRoots.length === 0 ? 'Opened' : 'Added'}: ${labelsSummary}`, {
        description: fileCount
          ? `${fileCount} files — saves write directly to this folder on disk.`
          : 'Saves write directly to this folder on disk.',
      });
      emitWorkspaceAudit({
        event: 'open',
        workspaceFolders: workspaceFolderLabels(nextRoots),
        addedFolder: labelsSummary,
        trigger: existingRoots.length === 0 ? 'open_folder' : 'add_folder',
      });
      const sid = useAppStore.getState().activeChatId;
      if (sid) void useAppStore.getState().persistWorkspaceSession(sid, true);
    } catch (err: unknown) {
      if (treeRequestIdRef.current === requestId) {
        if (workspaceRootsMatch(useAppStore.getState().workspaceRoots, nextRoots)) {
          useAppStore.getState().setWorkspaceRoots(existingRoots);
          setFileTree(currentTree);
        }
        toast.error(`Could not open ${labelsSummary}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (treeRequestIdRef.current === requestId) {
        setWorkspaceTreeLoading(false);
      }
    }
  }, [countFilesInTreeNodes, emitWorkspaceAudit, setFileTree, workspaceTreeLoading]);

  const handleOpenFolder = () => {
    if (!workspaceUiOk) {
      toast.error(fsAccessStatus.message ?? 'Workspace is not available on this page.');
      return;
    }
    if (workspaceTreeLoading) return;
    if (fsAccessStatus.nativeDirectoryPicker) {
      void openFolderViaDirectoryPicker();
      return;
    }
    toast.message('Choose a folder to open.');
    folderInputRef.current?.click();
  };

  const runFolderFileList = async (input: HTMLInputElement) => {
    const files = input.files?.length ? Array.from(input.files) : [];
    if (files.length === 0) {
      toast.error('No files arrived from that folder. Try again, or drag the folder onto the dashed box.');
      input.value = '';
      return;
    }
    try {
      await ingestUploadedFolderFiles(files);
    } finally {
      input.value = '';
    }
  };

  const handleFolderFromInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    void runFolderFileList(e.target);
  };

  const setFolderInputRef = useCallback((el: HTMLInputElement | null) => {
    folderInputRef.current = el;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('mozdirectory', '');
      el.setAttribute('directory', '');
    }
  }, []);

  const handleSaveProjectZip = async () => {
    if (workspaceRoots.length === 0) return;
    try {
      await downloadWorkspaceZipBundle(workspaceRoots);
      toast.success('Project ZIP downloaded');
    } catch (err: unknown) {
      toast.error(`ZIP export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRefresh = useCallback(async () => {
    const roots = useAppStore.getState().workspaceRoots;
    if (roots.length === 0) {
      treeRequestIdRef.current += 1;
      setWorkspaceTreeLoading(false);
      setFileTree([]);
      return;
    }

    const currentTree = useAppStore.getState().fileTree;
    const requestId = ++treeRequestIdRef.current;
    setWorkspaceTreeLoading(true);
    try {
      const tree = await buildWorkspaceTree(roots, {
        initialTree: currentTree,
        onProgress: (progressTree) => {
          if (treeRequestIdRef.current === requestId && workspaceRootsMatch(useAppStore.getState().workspaceRoots, roots)) {
            setFileTree(progressTree);
          }
        },
      });
      if (treeRequestIdRef.current === requestId && workspaceRootsMatch(useAppStore.getState().workspaceRoots, roots)) {
        setFileTree(tree);
      }
      emitWorkspaceAudit({ event: 'refresh', workspaceFolders: workspaceFolderLabels(roots), trigger: 'refresh_button' });
    } catch (err: any) {
      if (treeRequestIdRef.current === requestId) {
        toast.error(`Could not refresh file tree: ${err?.message ?? String(err)}`);
      }
    } finally {
      if (treeRequestIdRef.current === requestId) {
        setWorkspaceTreeLoading(false);
      }
    }
  }, [setFileTree]);

  const handleReconnectNativeRoot = useCallback(
    async (rootId: string) => {
      if (!fsAccessStatus.nativeDirectoryPicker) return;
      toast.message('Choose the same folder on disk to reconnect it.');
      let handle: FileSystemDirectoryHandle | null = null;
      try {
        handle = await pickDirectory();
      } catch (err: unknown) {
        const name =
          err instanceof DOMException ? err.name : err instanceof Error ? err.name : '';
        if (name === 'AbortError') return;
        console.warn('[EvigStudio] reconnect showDirectoryPicker failed', err);
        toast.warning('Could not open the folder dialog.', {
          description:
            'Try again after closing other file dialogs, or drag your project folder onto the workspace to use upload mode. Restarting the browser often fixes a stuck Windows file dialog.',
          duration: 14_000,
        });
        return;
      }
      if (!handle) return;

      const roots = useAppStore.getState().workspaceRoots;
      for (const r of roots) {
        if (r.id === rootId) continue;
        if (r.handle && typeof (r.handle as any).isSameEntry === 'function') {
          try {
            if (await (r.handle as any).isSameEntry(handle)) {
              toast.message('That folder is already attached as another workspace root.');
              return;
            }
          } catch {
            /* ignore */
          }
        }
      }

      useAppStore.getState().reconnectWorkspaceRootHandle(rootId, handle);
      toast.success(`Linked ${handle.name} — saves write to this folder on disk.`);
      await handleRefresh();
      const sid = useAppStore.getState().activeChatId;
      if (sid) void useAppStore.getState().persistWorkspaceSession(sid);
    },
    [fsAccessStatus.nativeDirectoryPicker, handleRefresh],
  );

  const handleLinkUploadRootDisk = useCallback(
    async (rootId: string) => {
      if (!fsAccessStatus.nativeDirectoryPicker) return;
      const root = useAppStore.getState().workspaceRoots.find((r) => r.id === rootId);
      if (!root || !isUploadBackedWorkspaceRoot(root)) return;

      toast.message(`Pick the real folder on disk for “${root.label}” (same name as this workspace root).`);
      let handle: FileSystemDirectoryHandle | null = null;
      try {
        handle = await pickDirectory();
      } catch (err: unknown) {
        const name =
          err instanceof DOMException ? err.name : err instanceof Error ? err.name : '';
        if (name === 'AbortError') return;
        console.warn('[EvigStudio] link upload root showDirectoryPicker failed', err);
        toast.warning('Could not open the folder dialog.', {
          description:
            'Try again after closing other file dialogs, or restart the browser if the Windows file dialog is stuck.',
          duration: 12_000,
        });
        return;
      }
      if (!handle) return;

      const roots = useAppStore.getState().workspaceRoots;
      for (const r of roots) {
        if (r.id === rootId) continue;
        if (r.handle && typeof (r.handle as { isSameEntry?: (h: FileSystemDirectoryHandle) => Promise<boolean> }).isSameEntry === 'function') {
          try {
            if (await (r.handle as { isSameEntry: (h: FileSystemDirectoryHandle) => Promise<boolean> }).isSameEntry(handle)) {
              toast.message('That folder is already attached as another workspace root.');
              return;
            }
          } catch {
            /* ignore */
          }
        }
        if (
          r.diskDirectoryHandle &&
          typeof (r.diskDirectoryHandle as { isSameEntry?: (h: FileSystemDirectoryHandle) => Promise<boolean> }).isSameEntry === 'function'
        ) {
          try {
            if (await (r.diskDirectoryHandle as { isSameEntry: (h: FileSystemDirectoryHandle) => Promise<boolean> }).isSameEntry(handle)) {
              toast.message('That folder is already linked to another upload root.');
              return;
            }
          } catch {
            /* ignore */
          }
        }
      }

      useAppStore.getState().linkUploadRootDiskDirectory(rootId, handle);
      toast.success(`Linked “${root.label}” → ${handle.name} on disk. Save writes paths under that folder.`);
      const sid = useAppStore.getState().activeChatId;
      if (sid) void useAppStore.getState().persistWorkspaceSession(sid, true);
    },
    [fsAccessStatus.nativeDirectoryPicker],
  );

  const handleSave = async () => {
    if (!hasWorkspace || !activeFilePath) return;
    try {
      const tab = useAppStore.getState().openEditorTabs.find((entry) => entry.path === activeFilePath);
      const saved = await handleSavePath(activeFilePath);
      if (!saved) {
        if (tab && tab.content === tab.savedContent) {
          toast.message(`No unsaved changes in ${activeFilePath}`);
        }
        return;
      }
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
      await createWorkspaceFile(workspaceRoots, newFileName.trim());
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
    { id: 'changes' as const, label: 'Changes', icon: GitCompare },
    { id: 'context' as const, label: 'Context', icon: BookOpen },
  ];

  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${hasBackground ? 'bg-card/74 backdrop-blur-md' : 'bg-card'}`}>
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
            {tab.id === 'changes' && dirtyTabs.length > 0 && (
              <span className="ml-1 px-1 py-px rounded-full bg-destructive/20 text-destructive text-[9px]">{dirtyTabs.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {rightPaneTab === 'files' && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]">
            {nativeRootsNeedReconnect && (
              <div className="flex shrink-0 items-start gap-2 border-b border-warning/35 bg-warning/12 px-3 py-2.5 text-[10px] leading-snug text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <span className="font-semibold text-foreground">Open Folder is not connected.</span> After a reload or
                  when this chat was restored from the server, the browser may drop the folder permission. Click{' '}
                  <strong className="text-foreground">Connect</strong> next to the workspace root in the tree below and
                  choose the same project folder again — then <strong className="text-foreground">Save</strong> writes to
                  disk.
                </div>
              </div>
            )}
            {workspaceUiOk && fsAccessStatus.nativeDirectoryPicker && !hasWorkspace && (
              <div className="flex shrink-0 items-start gap-2 border-b border-primary/20 bg-primary/6 px-3 py-2.5 text-[10px] leading-snug text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary/80" />
                <div className="min-w-0">
                  <span className="font-semibold text-foreground">Chrome / Edge:</span>{' '}
                  <strong className="text-foreground">Open folder</strong> uses a writable folder picker — your project opens{' '}
                  <strong className="text-foreground">from disk</strong> and <strong className="text-foreground">Save</strong> writes there. If you{' '}
                  <strong className="text-foreground">drag a folder</strong> into the tree instead, use <strong className="text-foreground">Link disk</strong>{' '}
                  so saves go to a real folder.
                </div>
              </div>
            )}
            {workspaceUiOk && !fsAccessStatus.nativeDirectoryPicker && mirrorStatus?.enabled && (
              <div className="flex shrink-0 flex-col gap-2 border-b border-emerald-500/25 bg-emerald-500/8 px-3 py-2.5 text-[10px] leading-snug text-muted-foreground">
                <div className="min-w-0">
                  <span className="font-semibold text-foreground">Server disk sync is enabled.</span>{' '}
                  Firefox cannot expose your project folder to this page, but the API can write to a folder on the machine
                  that runs the server. Each <strong className="text-foreground">Save</strong> is mirrored under{' '}
                  <code className="rounded bg-muted px-1 py-px text-[9px]">LOCAL_WORKSPACE_MIRROR_ROOT</code> → workspace
                  label → file path (bind-mount that host path to your real project when using Docker).
                </div>
                {mirrorStatus.requiresToken && (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                      <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        Mirror token (same as server LOCAL_WORKSPACE_MIRROR_TOKEN)
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={mirrorTokenDraft}
                        onChange={(e) => setMirrorTokenDraft(e.target.value)}
                        className="rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
                        placeholder="Paste token from server .env"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setWorkspaceMirrorToken(mirrorTokenDraft.trim());
                        invalidateWorkspaceMirrorStatusCache();
                        toast.success('Mirror token saved in this browser.');
                      }}
                      className="rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200"
                    >
                      Save token
                    </button>
                  </div>
                )}
              </div>
            )}
            {workspaceUiOk && linkDiskPickerAvailable && uploadRootsNeedingDiskLink.length > 0 && (
              <div className="flex shrink-0 items-start gap-2 border-b border-accent/20 bg-accent/5 px-3 py-2.5 text-[10px] leading-snug text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent/80" />
                <div className="min-w-0">
                  <span className="font-semibold text-foreground">Link disk (Chrome / Edge).</span>{' '}
                  This workspace was loaded via upload or drag-and-drop. Click <strong className="text-foreground">Link disk</strong> next to that folder in the file tree and pick your project directory — then <strong className="text-foreground">Save</strong> writes there.
                </div>
              </div>
            )}
            <div className="border-b border-border bg-gradient-to-b from-card via-card to-muted/20 px-2 py-2">
              <input
                ref={setFolderInputRef}
                id={folderInputId}
                type="file"
                name="evigstudio-folder-upload"
                tabIndex={-1}
                className="sr-only"
                onChange={handleFolderFromInput}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleOpenFolder}
                  disabled={workspaceTreeLoading || !workspaceUiOk}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary transition-all hover:-translate-y-0.5 hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
                  title="Pick a folder to load. In Chrome/Edge, Open folder attaches the folder on disk. After drag-and-drop, use Link disk when shown."
                >
                  {workspaceTreeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                  {workspaceTreeLoading ? 'Loading' : hasWorkspace ? 'Add Folder' : 'Open Folder'}
                </button>
                {/* Keeps `Upload` in scope for older bundles / merges that still reference the icon; visually hidden. */}
                <Upload className="hidden" aria-hidden />
                {hasWorkspace && (
                  <>
                    <button
                      onClick={handleRefresh}
                      disabled={workspaceTreeLoading}
                      className="rounded-xl border border-border/70 bg-background px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground transition-all hover:border-primary/20 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
                    >
                      {workspaceTreeLoading ? 'Refreshing' : 'Refresh'}
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
                      type="button"
                      onClick={() => void handleSaveProjectZip()}
                      className="rounded-xl border border-border/70 bg-background px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground transition-all hover:border-primary/20 hover:text-primary"
                      title="Download workspace as a ZIP file"
                    >
                      <span className="inline-flex items-center gap-1">
                        <Download className="h-3.5 w-3.5" />
                        Save ZIP
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        if (dirtyTabs.length > 0 && !window.confirm(`Clear the workspace and close ${dirtyTabs.length} open tab${dirtyTabs.length === 1 ? '' : 's'}?`)) {
                          return;
                        }
                         treeRequestIdRef.current += 1;
                         setWorkspaceTreeLoading(false);
                         const clearedFolders = workspaceFolderLabels(useAppStore.getState().workspaceRoots);
                         clearWorkspace();
                         emitWorkspaceAudit({ event: 'clear', workspaceFolders: clearedFolders, contextFiles: [], trigger: 'clear_button' });
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
            {!workspaceUiOk && fsAccessStatus.message && (
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
            {workspaceTreeLoading && (
              <div className="flex items-center gap-2 border-b border-border/60 bg-primary/5 px-3 py-2 text-[10px] text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{hasWorkspace ? 'Refreshing workspace files...' : 'Loading workspace folder...'}</span>
              </div>
            )}
            {workspaceTreeLoading && !hasWorkspace ? (
              <div className="flex min-h-[40vh] items-center justify-center p-4 text-center">
                <div className="w-full max-w-[240px] rounded-2xl border border-dashed border-primary/25 bg-primary/5 px-5 py-7 text-primary">
                  <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin" />
                  <p className="text-sm font-semibold">Loading workspace</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Reading folder contents. Large folders can take a moment.</p>
                </div>
              </div>
            ) : (
              <FileTree
                onFolderDropped={workspaceUiOk ? ingestUploadedFolderFiles : undefined}
                onReconnectNativeRoot={fsAccessStatus.nativeDirectoryPicker ? handleReconnectNativeRoot : undefined}
                onLinkUploadRootDisk={fsAccessStatus.nativeDirectoryPicker ? handleLinkUploadRootDisk : undefined}
                linkDiskPickerAvailable={linkDiskPickerAvailable}
              />
            )}
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
                    language={monacoLanguageFromPath(activeFilePath)}
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

        {rightPaneTab === 'changes' && (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-border bg-muted/15 px-3 py-2">
              <p className="text-[10px] leading-snug text-muted-foreground">
                Monaco side-by-side diff: <strong className="text-foreground">last saved</strong> (left) vs{' '}
                <strong className="text-foreground">current buffer</strong> (right). Green highlights additions; red
                highlights deletions. Save in the Editor tab to clear an entry. After a successful save, buffers match
                — nothing appears here until you edit again.
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
              {dirtyTabs.length === 0 ? (
                <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                  No unsaved changes. Edit in the Editor or apply patches, then open this tab to compare last-saved vs
                  current text. If you already saved, the diff clears by design.
                </p>
              ) : (
                dirtyTabs.map((tab) => (
                  <div
                    key={tab.path}
                    className="space-y-1.5 rounded-lg border border-border/80 bg-card p-2 shadow-sm"
                  >
                    <div className="truncate px-1 font-mono text-[10px] font-semibold text-foreground" title={tab.path}>
                      {tab.path}
                    </div>
                    <FileDiffViewer
                      filePath={tab.path}
                      original={tab.savedContent}
                      modified={tab.content}
                      colorMode={resolvedTheme === 'light' ? 'light' : 'dark'}
                      height={320}
                    />
                  </div>
                ))
              )}
            </div>
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
                <button
                  onClick={() => {
                    clearContextFiles();
                    emitWorkspaceAudit({ event: 'context_update', contextFiles: [], changeKind: 'clear', trigger: 'clear_context' });
                  }}
                  className="text-[10px] text-destructive hover:underline"
                >
                  Clear all
                </button>
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
                    <button
                      onClick={() => {
                        toggleContextFile(path);
                        const nextContext = useAppStore.getState().contextFiles.filter((item) => item !== path);
                        emitWorkspaceAudit({
                          event: 'context_update',
                          contextFiles: normalizeAuditPaths(nextContext, 50),
                          changedPath: path,
                          changeKind: 'remove',
                          trigger: 'context_panel_remove',
                        });
                      }}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      ×
                    </button>
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
