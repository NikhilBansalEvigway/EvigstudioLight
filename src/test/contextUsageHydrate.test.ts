import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock storage so hydrateWorkspaceSession runs without IndexedDB. A session with roots that have
// no FS handle hydrates to zero roots, so buildWorkspaceTree is never invoked.
const loadWorkspaceSession = vi.fn();
vi.mock('@/lib/storage', () => ({
  loadSettings: vi.fn(async () => ({})),
  saveSettings: vi.fn(),
  loadWorkspaceSession: (...args: unknown[]) => loadWorkspaceSession(...args),
  saveWorkspaceSession: vi.fn(async () => undefined),
  deleteWorkspaceSession: vi.fn(async () => undefined),
}));

vi.mock('@/lib/fsWorkspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/fsWorkspace')>()),
  buildWorkspaceTree: vi.fn(async () => []),
}));

import { useAppStore } from '@/store/useAppStore';

describe('context usage meter on re-hydrate', () => {
  beforeEach(() => {
    loadWorkspaceSession.mockReset();
    useAppStore.setState({
      activeChatId: 'chat-1',
      workspaceContextUsedChars: 0,
      historyContextUsedChars: 0,
      contextUsedChars: 0,
      contextUsageChatId: null,
    } as any);
  });

  it('does NOT drop the meter when the same active chat is re-hydrated (reconnect/focus)', async () => {
    // Build up a high-water mark for chat-1: 30k history + 20k workspace.
    const st = useAppStore.getState();
    st.setHistoryContextUsage(30_000);
    st.setContextUsage(20_000, 200_000, 30_000);
    const peak = useAppStore.getState().contextUsedChars;
    expect(peak).toBe(50_000);

    // A reconnect/tab-focus re-hydrates the SAME chat; the persisted workspace measurement is small.
    loadWorkspaceSession.mockResolvedValue({
      chatId: 'chat-1',
      workspaceRoots: [],
      contextFiles: [],
      openEditorTabs: [],
      activeFilePath: null,
      workspaceContextUsedChars: 0,
    });
    await useAppStore.getState().hydrateWorkspaceSession('chat-1');

    // The high-water must be preserved — "context left" must not jump up.
    expect(useAppStore.getState().contextUsedChars).toBe(peak);
  });

  it('DOES reset the meter when switching to a different chat', async () => {
    const st = useAppStore.getState();
    st.setHistoryContextUsage(30_000);
    st.setContextUsage(20_000, 200_000, 30_000);
    expect(useAppStore.getState().contextUsedChars).toBe(50_000);

    loadWorkspaceSession.mockResolvedValue({
      chatId: 'chat-2',
      workspaceRoots: [],
      contextFiles: [],
      openEditorTabs: [],
      activeFilePath: null,
      workspaceContextUsedChars: 0,
    });
    useAppStore.setState({ activeChatId: 'chat-2' } as any);
    await useAppStore.getState().hydrateWorkspaceSession('chat-2');

    // Different chat: the previous chat's high-water must not carry over.
    expect(useAppStore.getState().contextUsedChars).toBe(0);
  });
});
