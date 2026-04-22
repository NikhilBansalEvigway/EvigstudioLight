import { create } from 'zustand';
import { toast } from 'sonner';
import type {
  AppSettings,
  Chat,
  ChatMode,
  ChatVersionSnapshot,
  FileNode,
  Message,
  WorkspaceRoot,
} from '@/types';
import { DEFAULT_SETTINGS, canDeleteChat, canWriteChat, normalizeChat } from '@/types';
import { loadSettings, saveSettings } from '@/lib/storage';
import { loadWorkspaceSession, saveWorkspaceSession, deleteWorkspaceSession } from '@/lib/storage';
import { buildWorkspaceTree } from '@/lib/fsWorkspace';
import {
  getChatPersistenceMode,
  persistenceCreateChat,
  persistenceDeleteChat,
  persistenceLoadChat,
  persistenceLoadChats,
  persistenceSaveChat,
} from '@/lib/chatPersistence';

export interface EditorTab {
  path: string;
  content: string;
  savedContent: string;
}

interface AppState {
  // Settings
  settings: AppSettings;
  setSettings: (s: Partial<AppSettings>) => void;
  initSettings: () => Promise<void>;

  // Connection
  isLMConnected: boolean;
  setLMConnected: (v: boolean) => void;
  isOnline: boolean;
  setOnline: (v: boolean) => void;

  // Chats
  chats: Chat[];
  activeChatId: string | null;
  initChats: () => Promise<void>;
  resetChats: () => void;
  createChat: () => Promise<string>;
  refreshChat: (id: string) => Promise<void>;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => Promise<void>;
  renameChat: (id: string, title: string) => void;
  addMessage: (chatId: string, msg: Message) => void;
  updateLastAssistantMessage: (chatId: string, content: string) => void;
  updateChatFields: (chatId: string, patch: Partial<Chat>) => void;
  setChatMode: (chatId: string, mode: ChatMode) => void;
  saveVersionSnapshot: (chatId: string, label?: string) => void;
  restoreVersionSnapshot: (chatId: string, snapshotId: string) => void;

  // Workspace
  workspaceRoots: WorkspaceRoot[];
  setWorkspaceRoots: (roots: WorkspaceRoot[]) => void;
  addWorkspaceRoot: (root: WorkspaceRoot) => void;
  removeWorkspaceRoot: (rootId: string) => void;
  clearWorkspace: () => void;
  workspaceHandle: FileSystemDirectoryHandle | null;
  setWorkspaceHandle: (h: FileSystemDirectoryHandle | null) => void;
  fileTree: FileNode[];
  setFileTree: (t: FileNode[]) => void;
  contextFiles: string[];
  toggleContextFile: (path: string) => void;
  clearContextFiles: () => void;
  removeWorkspacePathReferences: (path: string) => void;

  // Workspace session (per chat, local)
  hydrateWorkspaceSession: (chatId: string) => Promise<void>;
  persistWorkspaceSession: (chatId: string) => Promise<void>;

  // Editor
  openEditorTabs: EditorTab[];
  activeFilePath: string | null;
  activeFileContent: string;
  /** Bumps whenever editor/workspace session changes (used for autosave). */
  workspaceSessionRevision: number;
  setActiveFile: (path: string | null, content: string) => void;
  setActiveEditorFile: (path: string) => void;
  setActiveFileContent: (content: string) => void;
  markEditorFileSaved: (path: string, content: string) => void;
  syncEditorFileContent: (path: string, content: string) => void;
  closeEditorFile: (path: string) => void;
  renameEditorFile: (oldPath: string, newPath: string, content?: string) => void;
  renameWorkspacePathReferences: (oldPath: string, newPath: string) => void;

  // UI
  showSettings: boolean;
  setShowSettings: (v: boolean) => void;
  rightPaneTab: 'files' | 'editor' | 'context' | 'prompt';
  setRightPaneTab: (t: 'files' | 'editor' | 'context' | 'prompt') => void;
  showSidebar: boolean;
  setShowSidebar: (v: boolean) => void;
  showRightPane: boolean;
  setShowRightPane: (v: boolean) => void;

  // Streaming
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  setSettings: (s) => {
    const newSettings = { ...get().settings, ...s };
    set({ settings: newSettings });
    saveSettings(newSettings);
  },
  initSettings: async () => {
    const s = await loadSettings();
    set({ settings: s });
  },

  isLMConnected: false,
  setLMConnected: (v) => set({ isLMConnected: v }),
  isOnline: navigator.onLine,
  setOnline: (v) => set({ isOnline: v }),

  chats: [],
  activeChatId: null,
  initChats: async () => {
    try {
      const raw = await persistenceLoadChats();
      const chats = raw.map((c) => normalizeChat(c));
      chats.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ chats });
      if (chats.length > 0) {
        set({ activeChatId: chats[0].id });
        void get().hydrateWorkspaceSession(chats[0].id);
      }
      if (getChatPersistenceMode() === 'server' && chats.length > 0) {
        void get().refreshChat(chats[0].id);
      }
    } catch (e) {
      console.error('[EvigStudio] initChats failed', e);
      set({ chats: [], activeChatId: null });
    }
  },
  resetChats: () =>
    set({
      chats: [],
      activeChatId: null,
      workspaceRoots: [],
      workspaceHandle: null,
      fileTree: [],
      contextFiles: [],
      openEditorTabs: [],
      activeFilePath: null,
      activeFileContent: '',
    }),
  createChat: async () => {
    const prevActive = get().activeChatId;
    const modeBefore = getChatPersistenceMode();
    const chat = normalizeChat(await persistenceCreateChat());
    const modeAfter = getChatPersistenceMode();
    if (modeBefore === 'server' && modeAfter === 'idb') {
      try {
        await get().initChats();
      } catch (e) {
        console.error('[EvigStudio] initChats after offline fallback', e);
        if (prevActive && prevActive !== chat.id) {
          void get().persistWorkspaceSession(prevActive);
        }
        set((s) => ({ chats: [chat, ...s.chats], activeChatId: chat.id }));
        void get().hydrateWorkspaceSession(chat.id);
        return chat.id;
      }
      if (prevActive && prevActive !== chat.id) {
        void get().persistWorkspaceSession(prevActive);
      }
      set({ activeChatId: chat.id });
      void get().hydrateWorkspaceSession(chat.id);
      return chat.id;
    }
    if (prevActive && prevActive !== chat.id) {
      void get().persistWorkspaceSession(prevActive);
    }
    set((s) => ({ chats: [chat, ...s.chats], activeChatId: chat.id }));
    void get().hydrateWorkspaceSession(chat.id);
    return chat.id;
  },
  refreshChat: async (id) => {
    if (getChatPersistenceMode() !== 'server') return;
    try {
      const fresh = normalizeChat(await persistenceLoadChat(id));
      set((s) => {
        const existing = s.chats.some((c) => c.id === id);
        const chats = existing
          ? s.chats.map((c) => (c.id === id ? fresh : c))
          : [fresh, ...s.chats];
        chats.sort((a, b) => b.updatedAt - a.updatedAt);
        return { chats };
      });
    } catch (e) {
      console.error('[EvigStudio] refreshChat failed', e);
    }
  },
  selectChat: (id) => {
    const prev = get().activeChatId;
    if (prev && prev !== id) {
      void get().persistWorkspaceSession(prev);
    }
    set({ activeChatId: id });
    void get().hydrateWorkspaceSession(id);
    if (getChatPersistenceMode() === 'server') {
      void get().refreshChat(id);
    }
  },
  deleteChat: async (id) => {
    try {
      const chat = get().chats.find((c) => c.id === id);
      if (chat && !canDeleteChat(chat)) {
        toast.error('This conversation is locked. Only the owner can delete it.');
        return;
      }
      await persistenceDeleteChat(id);
      await deleteWorkspaceSession(id).catch(() => undefined);
      const prevActive = get().activeChatId;
      const nextActive =
        prevActive === id ? (get().chats.find((c) => c.id !== id)?.id ?? null) : prevActive;

      set((s) => ({
        chats: s.chats.filter((c) => c.id !== id),
        activeChatId: nextActive,
      }));

      if (prevActive === id) {
        if (nextActive) {
          void get().hydrateWorkspaceSession(nextActive);
        } else {
          // No chats left
          set({
            workspaceRoots: [],
            workspaceHandle: null,
            fileTree: [],
            contextFiles: [],
            openEditorTabs: [],
            activeFilePath: null,
            activeFileContent: '',
          });
        }
      }
    } catch (e) {
      console.error('[EvigStudio] deleteChat failed', e);
      toast.error(
        'Could not delete this chat. You can only remove chats you own, or it may still be visible to your team.',
      );
      await get().initChats();
    }
  },
  renameChat: (id, title) => {
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== id) return c;
        if (!canWriteChat(c)) return c;
        const updated = normalizeChat({ ...c, title, updatedAt: Date.now() });
        void persistenceSaveChat(updated).catch((err) => console.error('[EvigStudio] rename save', err));
        return updated;
      });
      return { chats };
    });
  },
  addMessage: (chatId, msg) => {
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== chatId) return c;
        if (!canWriteChat(c)) return c;
        const updated = normalizeChat({
          ...c,
          messages: [...c.messages, msg],
          updatedAt: Date.now(),
          title:
            c.messages.length === 0 && msg.role === 'user'
              ? (typeof msg.content === 'string' ? msg.content : 'New Chat').slice(0, 40)
              : c.title,
        });
        void persistenceSaveChat(updated).catch((err) => console.error('[EvigStudio] addMessage save', err));
        return updated;
      });
      return { chats };
    });
  },
  updateLastAssistantMessage: (chatId, content) => {
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== chatId) return c;
        const msgs = [...c.messages];
        const lastIdx = msgs.length - 1;
        if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
          msgs[lastIdx] = { ...msgs[lastIdx], content };
        }
        const updated = normalizeChat({ ...c, messages: msgs, updatedAt: Date.now() });
        return updated;
      });
      return { chats };
    });
  },
  updateChatFields: (chatId, patch) => {
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== chatId) return c;
        if (!canWriteChat(c)) return c;
        const merged = { ...c, ...patch, updatedAt: Date.now() };
        const updated = normalizeChat(merged);
        void persistenceSaveChat(updated).catch((err) =>
          console.error('[EvigStudio] updateChatFields save', err),
        );
        return updated;
      });
      return { chats };
    });
  },
  setChatMode: (chatId, mode) => {
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== chatId) return c;
        if (!canWriteChat(c)) return c;
        const updated = normalizeChat({ ...c, mode, updatedAt: Date.now() });
        void persistenceSaveChat(updated).catch((err) =>
          console.error('[EvigStudio] setChatMode save', err),
        );
        return updated;
      });
      return { chats };
    });
  },
  saveVersionSnapshot: (chatId, label) => {
    const MAX = 40;
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== chatId) return c;
        if (!canWriteChat(c)) return c;
        const snap: ChatVersionSnapshot = {
          id: crypto.randomUUID(),
          savedAt: Date.now(),
          label,
          title: c.title,
          messages: JSON.parse(JSON.stringify(c.messages)) as Message[],
        };
        const versionHistory = [...(c.versionHistory ?? []), snap].slice(-MAX);
        const updated = normalizeChat({ ...c, versionHistory, updatedAt: Date.now() });
        void persistenceSaveChat(updated).catch((err) =>
          console.error('[EvigStudio] saveVersionSnapshot', err),
        );
        return updated;
      });
      return { chats };
    });
  },
  restoreVersionSnapshot: (chatId, snapshotId) => {
    set((s) => {
      const chats = s.chats.map((c) => {
        if (c.id !== chatId) return c;
        if (!canWriteChat(c)) return c;
        const snap = c.versionHistory?.find((v) => v.id === snapshotId);
        if (!snap) return c;
        const updated = normalizeChat({
          ...c,
          title: snap.title,
          messages: JSON.parse(JSON.stringify(snap.messages)) as Message[],
          updatedAt: Date.now(),
        });
        void persistenceSaveChat(updated).catch((err) =>
          console.error('[EvigStudio] restoreVersionSnapshot', err),
        );
        return updated;
      });
      return { chats };
    });
  },

  workspaceRoots: [],
  setWorkspaceRoots: (roots) =>
    set({
      workspaceRoots: roots,
      workspaceHandle: roots[0]?.handle ?? null,
    }),
  addWorkspaceRoot: (root) =>
    set((s) => {
      const workspaceRoots = [...s.workspaceRoots, root];
      return {
        workspaceRoots,
        workspaceHandle: workspaceRoots[0]?.handle ?? null,
      };
    }),
  removeWorkspaceRoot: (rootId) =>
    set((s) => {
      const workspaceRoots = s.workspaceRoots.filter((root) => root.id !== rootId);
      return {
        workspaceRoots,
        workspaceHandle: workspaceRoots[0]?.handle ?? null,
      };
    }),
  clearWorkspace: () =>
    set({
      workspaceRoots: [],
      workspaceHandle: null,
      fileTree: [],
      contextFiles: [],
      openEditorTabs: [],
      activeFilePath: null,
      activeFileContent: '',
    }),
  workspaceHandle: null,
  setWorkspaceHandle: (h) =>
    set({
      workspaceHandle: h,
      workspaceRoots: h
        ? [
            {
              id: crypto.randomUUID(),
              label: h.name,
              handle: h,
            },
          ]
        : [],
    }),
  fileTree: [],
  setFileTree: (t) => set({ fileTree: t }),
  contextFiles: [],
  toggleContextFile: (path) =>
    set((s) => ({
      contextFiles: s.contextFiles.includes(path)
        ? s.contextFiles.filter((p) => p !== path)
        : [...s.contextFiles, path],
    })),
  clearContextFiles: () => set({ contextFiles: [] }),
  removeWorkspacePathReferences: (path) =>
    set((s) => {
      const matchesPath = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
      const nextTabs = s.openEditorTabs.filter((tab) => !matchesPath(tab.path));
      const activeWasRemoved = s.activeFilePath ? matchesPath(s.activeFilePath) : false;
      const nextActive = activeWasRemoved ? nextTabs[nextTabs.length - 1] ?? null : null;

      return {
        openEditorTabs: nextTabs,
        contextFiles: s.contextFiles.filter((item) => !matchesPath(item)),
        ...(activeWasRemoved
          ? {
              activeFilePath: nextActive?.path ?? null,
              activeFileContent: nextActive?.content ?? '',
            }
          : {}),
      };
    }),

  openEditorTabs: [],
  activeFilePath: null,
  activeFileContent: '',
  workspaceSessionRevision: 0,
  setActiveFile: (path, content) =>
    set((s) => {
      if (!path) {
        return {
          activeFilePath: null,
          activeFileContent: '',
          rightPaneTab: 'editor',
          workspaceSessionRevision: s.workspaceSessionRevision + 1,
        };
      }

      const existingTab = s.openEditorTabs.find((tab) => tab.path === path);
      return {
        openEditorTabs: existingTab ? s.openEditorTabs : [...s.openEditorTabs, { path, content, savedContent: content }],
        activeFilePath: path,
        activeFileContent: existingTab?.content ?? content,
        rightPaneTab: 'editor',
        workspaceSessionRevision: s.workspaceSessionRevision + 1,
      };
    }),
  setActiveEditorFile: (path) =>
    set((s) => {
      const tab = s.openEditorTabs.find((item) => item.path === path);
      if (!tab) return {};
      return {
        activeFilePath: tab.path,
        activeFileContent: tab.content,
        rightPaneTab: 'editor',
      };
    }),
  setActiveFileContent: (content) =>
    set((s) => {
      if (!s.activeFilePath) return { activeFileContent: content };
      return {
        activeFileContent: content,
        openEditorTabs: s.openEditorTabs.map((tab) =>
          tab.path === s.activeFilePath ? { ...tab, content } : tab,
        ),
        workspaceSessionRevision: s.workspaceSessionRevision + 1,
      };
    }),
  markEditorFileSaved: (path, content) =>
    set((s) => ({
      openEditorTabs: s.openEditorTabs.map((tab) =>
        tab.path === path ? { ...tab, content, savedContent: content } : tab,
      ),
      ...(s.activeFilePath === path ? { activeFileContent: content } : {}),
      workspaceSessionRevision: s.workspaceSessionRevision + 1,
    })),
  syncEditorFileContent: (path, content) =>
    set((s) => {
      const hasOpenTab = s.openEditorTabs.some((tab) => tab.path === path);
      if (!hasOpenTab) return {};
      return {
        openEditorTabs: s.openEditorTabs.map((tab) =>
          tab.path === path ? { ...tab, content, savedContent: content } : tab,
        ),
        ...(s.activeFilePath === path ? { activeFileContent: content } : {}),
        workspaceSessionRevision: s.workspaceSessionRevision + 1,
      };
    }),
  closeEditorFile: (path) =>
    set((s) => {
      const nextTabs = s.openEditorTabs.filter((tab) => tab.path !== path);
      if (s.activeFilePath !== path) {
        return { openEditorTabs: nextTabs };
      }
      const nextActive = nextTabs[nextTabs.length - 1] ?? null;
      return {
        openEditorTabs: nextTabs,
        activeFilePath: nextActive?.path ?? null,
        activeFileContent: nextActive?.content ?? '',
      };
    }),
  renameEditorFile: (oldPath, newPath, content) =>
    set((s) => {
      const updatedTabs = s.openEditorTabs.map((tab) =>
        tab.path === oldPath
          ? {
              ...tab,
              path: newPath,
              content: content ?? tab.content,
              savedContent: content ?? tab.savedContent,
            }
          : tab,
      );
      if (!updatedTabs.some((tab) => tab.path === newPath)) return {};
      const renamedTab = updatedTabs.find((tab) => tab.path === newPath);
      return {
        openEditorTabs: updatedTabs,
        ...(s.activeFilePath === oldPath
          ? {
              activeFilePath: newPath,
              activeFileContent: renamedTab?.content ?? content ?? s.activeFileContent,
            }
          : {}),
      };
    }),
  renameWorkspacePathReferences: (oldPath, newPath) =>
    set((s) => {
      const withSlash = `${oldPath}/`;
      const mapPath = (path: string) => {
        if (path === oldPath) return newPath;
        if (path.startsWith(withSlash)) {
          return `${newPath}/${path.slice(withSlash.length)}`;
        }
        return path;
      };

      return {
        openEditorTabs: s.openEditorTabs.map((tab) => ({
          ...tab,
          path: mapPath(tab.path),
        })),
        activeFilePath: s.activeFilePath ? mapPath(s.activeFilePath) : null,
        contextFiles: s.contextFiles.map(mapPath),
      };
    }),

  hydrateWorkspaceSession: async (chatId) => {
    try {
      const session = await loadWorkspaceSession(chatId);
      if (!session) {
        // No session for this chat: start clean.
        set({
          workspaceRoots: [],
          workspaceHandle: null,
          fileTree: [],
          contextFiles: [],
          openEditorTabs: [],
          activeFilePath: null,
          activeFileContent: '',
        });
        return;
      }

      // Restore UI state first (even if FS permissions are missing, tabs stay visible).
      const hydratedRoots = (session.workspaceRoots ?? [])
        .filter((root) => !!root.handle)
        .map((root) => ({ id: root.id, label: root.label, handle: root.handle! }));
      set({
        workspaceRoots: hydratedRoots,
        workspaceHandle: hydratedRoots[0]?.handle ?? null,
        contextFiles: session.contextFiles ?? [],
        openEditorTabs: session.openEditorTabs ?? [],
        activeFilePath: session.activeFilePath ?? null,
        activeFileContent:
          (session.activeFilePath
            ? (session.openEditorTabs ?? []).find((t) => t.path === session.activeFilePath)?.content
            : (session.openEditorTabs ?? [])[0]?.content) ??
          '',
      });

      // Try to rebuild file tree; if permission is revoked, keep tree empty.
      const roots = hydratedRoots;
      if (roots.length > 0) {
        try {
          const tree = await buildWorkspaceTree(roots);
          set({ fileTree: tree });
        } catch (e) {
          console.warn('[EvigStudio] workspace hydrate: could not rebuild file tree', e);
          set({ fileTree: [] });
        }
      } else {
        set({ fileTree: [] });
      }
    } catch (e) {
      console.warn('[EvigStudio] hydrateWorkspaceSession failed', e);
    }
  },

  persistWorkspaceSession: async (chatId) => {
    const s = get();
    if (!chatId) return;
    if (s.activeChatId && s.activeChatId !== chatId) return;

    // Cap payload size to avoid runaway IndexedDB growth.
    const MAX_TABS = 25;
    const MAX_TAB_CHARS = 200_000;
    const tabs = s.openEditorTabs.slice(-MAX_TABS).map((tab) => ({
      path: tab.path,
      content: tab.content.length > MAX_TAB_CHARS ? `${tab.content.slice(0, MAX_TAB_CHARS)}\n\n… [truncated]` : tab.content,
      savedContent: tab.savedContent.length > MAX_TAB_CHARS ? `${tab.savedContent.slice(0, MAX_TAB_CHARS)}\n\n… [truncated]` : tab.savedContent,
    }));

    const rootsForStorage = s.workspaceRoots.map((root) => ({
      id: root.id,
      label: root.label,
      handle: root.handle,
    }));

    try {
      await saveWorkspaceSession({
        chatId,
        updatedAt: Date.now(),
        workspaceRoots: rootsForStorage,
        openEditorTabs: tabs,
        activeFilePath: s.activeFilePath,
        contextFiles: s.contextFiles,
      });
    } catch (e) {
      // FileSystemDirectoryHandle may not be serializable in some environments.
      console.warn('[EvigStudio] persistWorkspaceSession failed; retrying without handles', e);
      try {
        await saveWorkspaceSession({
          chatId,
          updatedAt: Date.now(),
          workspaceRoots: rootsForStorage.map((root) => ({ ...root, handle: null })),
          openEditorTabs: tabs,
          activeFilePath: s.activeFilePath,
          contextFiles: s.contextFiles,
        });
      } catch (e2) {
        console.warn('[EvigStudio] persistWorkspaceSession failed (no-handles)', e2);
      }
    }
  },

  showSettings: false,
  setShowSettings: (v) => set({ showSettings: v }),
  rightPaneTab: 'files',
  setRightPaneTab: (t) => set({ rightPaneTab: t }),
  showSidebar: true,
  setShowSidebar: (v) => set({ showSidebar: v }),
  showRightPane: true,
  setShowRightPane: (v) => set({ showRightPane: v }),

  isStreaming: false,
  setIsStreaming: (v) => set({ isStreaming: v }),
}));

// Debounced autosave of per-chat workspace session.
let workspaceSessionTimer: number | null = null;
let lastWorkspaceSessionKey = '';
useAppStore.subscribe((state) => {
  const chatId = state.activeChatId;
  if (!chatId) return;
  const rootsSig = state.workspaceRoots.map((r) => `${r.id}:${r.label}`).join('|');
  const tabsSig = state.openEditorTabs.map((t) => `${t.path}:${t.content !== t.savedContent ? 1 : 0}`).join('|');
  const ctxSig = state.contextFiles.join('|');
  const activeSig = state.activeFilePath ?? '';
  const key = `${chatId}::${rootsSig}::${tabsSig}::${ctxSig}::${activeSig}::${state.workspaceSessionRevision}`;
  if (key === lastWorkspaceSessionKey) return;
  lastWorkspaceSessionKey = key;

  if (workspaceSessionTimer) window.clearTimeout(workspaceSessionTimer);
  workspaceSessionTimer = window.setTimeout(() => {
    void useAppStore.getState().persistWorkspaceSession(chatId);
  }, 350);
});

if (typeof window !== 'undefined') {
  const flush = () => {
    const st = useAppStore.getState();
    if (st.activeChatId) {
      void st.persistWorkspaceSession(st.activeChatId);
    }
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
