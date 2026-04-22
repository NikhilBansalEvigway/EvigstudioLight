import { useState, useRef, useCallback, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { chatCompletion, type ChatMessage as LLMMessage } from '@/lib/llmClient';
import {
  buildWorkspacePath,
  buildWorkspaceTree,
  deleteWorkspacePath,
  readWorkspaceFile,
  serializeFileTree,
  writeWorkspaceFile,
} from '@/lib/fsWorkspace';
import {
  parseToolCalls,
  hasAgentTools,
  hasGatherTools,
  executeAgentTools,
  type AgentAction,
} from '@/lib/agentTools';
import { applyPatch, containsPatches, parsePatches } from '@/lib/patchApply';
import { ChatMessage } from '@/components/ChatMessage';
import { ChatModeToggle } from '@/components/ChatModeToggle';
import { FileMentionPopover } from '@/components/FileMentionPopover';
import {
  AGENT_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  canWriteChat,
  hasImages,
  getMessageText,
  type ChatMode,
  type Message,
  type ContentPart,
  type ParsedPatch,
} from '@/types';
import { getChatPersistenceMode, persistenceSaveChat } from '@/lib/chatPersistence';
import { ChatToolbar } from '@/components/ChatToolbar';
import { useSpeechDictation } from '@/hooks/useSpeechDictation';
import { Send, ImagePlus, Loader2, StopCircle, FileCode, X, Mic, Bot, MessageSquare, Lock } from 'lucide-react';
import { toast } from 'sonner';

const KEY_PROJECT_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'vite.config.ts',
  'README.md',
  '.env.example',
];

export function ChatPane() {
  const {
    chats, activeChatId, createChat, addMessage, updateLastAssistantMessage, updateChatFields, saveVersionSnapshot,
    settings, contextFiles, fileTree, isStreaming, setIsStreaming, workspaceRoots,
  } = useAppStore();

  const [autoAppliedPathsByMessageId, setAutoAppliedPathsByMessageId] = useState<Record<string, string[]>>({});
  const [agentActionsByMessageId, setAgentActionsByMessageId] = useState<Record<string, AgentAction[]>>({});
  const patchedPathsRef = useRef<Set<string>>(new Set());
  const [agentGatherStep, setAgentGatherStep] = useState<number | null>(null);

  useEffect(() => {
    patchedPathsRef.current = new Set();
  }, [activeChatId]);

  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStartIdx, setMentionStartIdx] = useState(-1);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onDictationFinal = useCallback((t: string) => {
    setInput((prev) => {
      const sep = prev && !/\s$/.test(prev) ? ' ' : '';
      return `${prev}${sep}${t}`;
    });
  }, []);

  const onDictationError = useCallback((msg: string) => {
    toast.error(msg);
  }, []);

  const sttLang = settings.sttLanguage?.trim() || 'en-US';
  const { listening: dictating, supported: sttSupported, toggle: toggleDictation } = useSpeechDictation(
    sttLang,
    onDictationFinal,
    onDictationError,
  );

  const activeChat = chats.find(c => c.id === activeChatId);
  const isLocked = activeChat ? !canWriteChat(activeChat) : false;
  const chatMode = activeChat?.mode ?? 'agent';
  const isAgent = chatMode === 'agent';
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      userScrolledUp.current = distFromBottom > 120;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!userScrolledUp.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeChat?.messages]);

  const addPatchedPaths = useCallback((paths: string[]) => {
    for (const p of paths) {
      patchedPathsRef.current.add(p);
    }
  }, []);

  const trimMessageUiState = useCallback((messages: Message[]) => {
    const keepIds = new Set(messages.map((message) => message.id));
    setAutoAppliedPathsByMessageId((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([messageId]) => keepIds.has(messageId))),
    );
    setAgentActionsByMessageId((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([messageId]) => keepIds.has(messageId))),
    );
  }, []);

  const deriveChatTitle = useCallback((messages: Message[], fallbackTitle: string) => {
    const firstUserMessage = messages.find((message) => message.role === 'user');
    const text = firstUserMessage ? getMessageText(firstUserMessage).trim() : '';
    return text ? text.slice(0, 40) : fallbackTitle;
  }, []);

  const buildContextMessages = useCallback(async (messageMentionedFiles: string[] = []): Promise<{ role: 'user'; content: string }[]> => {
    if (workspaceRoots.length === 0) return [];

    const included = new Set<string>();
    const parts: string[] = [];

    const MAX_TREE_CHARS = 30_000;
    const MAX_FILE_CHARS_AUTO = 2_000;
    const MAX_FILE_CHARS_EXPLICIT = 8_000;
    const MAX_TOTAL_CONTEXT_CHARS = 120_000;

    const truncate = (content: string, maxChars: number) =>
      content.length > maxChars ? `${content.slice(0, maxChars)}\n\n… [truncated]` : content;

    const totalChars = () => parts.reduce((sum, part) => sum + part.length, 0);
    const canAdd = (nextPart: string) => totalChars() + nextPart.length <= MAX_TOTAL_CONTEXT_CHARS;

    const treeStr = fileTree.length ? serializeFileTree(fileTree) : '';
    if (treeStr) {
      const tree = truncate(treeStr, MAX_TREE_CHARS);
      const block = `## Project structure (file paths)\n\`\`\`\n${tree}\n\`\`\``;
      if (canAdd(block)) {
        parts.push(block);
      }
    }

    const keyProjectPaths = workspaceRoots.flatMap((root) =>
      KEY_PROJECT_FILES.map((rel) => buildWorkspacePath(root.label, rel)),
    );
    for (const path of keyProjectPaths) {
      try {
        let content = await readWorkspaceFile(workspaceRoots, path);
        included.add(path);
        content = truncate(content, MAX_FILE_CHARS_AUTO);
        const block = `### Key file: ${path}\n\`\`\`\n${content}\n\`\`\``;
        if (!canAdd(block)) break;
        parts.push(block);
      } catch {
        /* optional */
      }
    }

    for (const path of patchedPathsRef.current) {
      if (included.has(path)) continue;
      try {
        let content = await readWorkspaceFile(workspaceRoots, path);
        included.add(path);
        content = truncate(content, MAX_FILE_CHARS_AUTO);
        const block = `### Recently edited in this chat: ${path}\n\`\`\`\n${content}\n\`\`\``;
        if (!canAdd(block)) break;
        parts.push(block);
      } catch {
        /* skip */
      }
    }

    const allFiles = [...new Set([...contextFiles, ...messageMentionedFiles])];
    let omittedFiles = 0;
    for (const path of allFiles) {
      if (included.has(path)) continue;
      included.add(path);
      try {
        let content = await readWorkspaceFile(workspaceRoots, path);
        content = truncate(content, MAX_FILE_CHARS_EXPLICIT);
        const block = `### File: ${path}\n\`\`\`\n${content}\n\`\`\`\n`;
        if (!canAdd(block)) {
          omittedFiles += 1;
          continue;
        }
        parts.push(block.trimEnd());
      } catch {
        const block = `### File: ${path}\n(Could not read file)`;
        if (!canAdd(block)) {
          omittedFiles += 1;
          continue;
        }
        parts.push(block);
      }
    }

    if (omittedFiles > 0) {
      parts.push(`(Omitted ${omittedFiles} file(s) from context due to size limits. Add fewer files or mention specific paths/sections.)`);
    }

    if (parts.length === 0) return [];
    return [
      {
        role: 'user' as const,
        content: `Workspace context (use paths below as ground truth; do not invent paths that are not listed):\n\n${parts.join('\n\n')}`,
      },
    ];
  }, [workspaceRoots, fileTree, contextFiles]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart ?? value.length;
    setInput(value);

    const textBeforeCursor = value.slice(0, cursorPos);
    const lastAtIdx = textBeforeCursor.lastIndexOf('@');

    if (lastAtIdx >= 0) {
      const afterAt = textBeforeCursor.slice(lastAtIdx + 1);
      if (!afterAt.includes('\n')) {
        setShowMention(true);
        setMentionQuery(afterAt);
        setMentionStartIdx(lastAtIdx);
        return;
      }
    }

    setShowMention(false);
    setMentionQuery('');
    setMentionStartIdx(-1);
  }, []);

  const handleMentionSelect = useCallback((filePath: string) => {
    setMentionedFiles(prev => prev.includes(filePath) ? prev : [...prev, filePath]);

    if (mentionStartIdx >= 0) {
      const before = input.slice(0, mentionStartIdx);
      const cursorPos = textareaRef.current?.selectionStart ?? input.length;
      const after = input.slice(cursorPos);
      setInput(before + after);
    }

    setShowMention(false);
    setMentionQuery('');
    setMentionStartIdx(-1);

    setTimeout(() => textareaRef.current?.focus(), 0);
    toast.success(`Added @${filePath.split('/').pop()} to context`);
  }, [input, mentionStartIdx]);

  const removeMentionedFile = useCallback((filePath: string) => {
    setMentionedFiles(prev => prev.filter(f => f !== filePath));
  }, []);

  const refreshFileTree = useCallback(async () => {
    const roots = useAppStore.getState().workspaceRoots;
    if (roots.length === 0) return;
    const tree = await buildWorkspaceTree(roots);
    useAppStore.getState().setFileTree(tree);
  }, []);

  const applyPatchToWorkspace = useCallback(async (patch: ParsedPatch) => {
    const roots = useAppStore.getState().workspaceRoots;
    if (roots.length === 0) throw new Error('No workspace folder open');

    const { filePath, content, operation = 'update' } = patch;

    if (operation === 'delete') {
      await deleteWorkspacePath(roots, filePath);
      useAppStore.getState().removeWorkspacePathReferences(filePath);
      return;
    }

    let original = '';
    try {
      original = await readWorkspaceFile(roots, filePath);
    } catch {
      /* new or missing file */
    }
    const result = applyPatch(original, patch);
    await writeWorkspaceFile(roots, filePath, result);
    useAppStore.getState().syncEditorFileContent(filePath, result);
  }, []);

  const handleOpenEditorFile = useCallback(async (filePath: string) => {
    const state = useAppStore.getState();
    if (state.workspaceRoots.length === 0) {
      toast.error('Open a workspace folder to view files');
      return;
    }

    try {
      const content = await readWorkspaceFile(state.workspaceRoots, filePath);
      state.setShowRightPane(true);
      state.setActiveFile(filePath, content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not open ${filePath}: ${msg}`);
    }
  }, []);

  const handleApplyPatch = useCallback(
    async (patch: ParsedPatch) => {
      if (useAppStore.getState().workspaceRoots.length === 0) {
        toast.error('No workspace folder open');
        return;
      }
      try {
        await applyPatchToWorkspace(patch);
        addPatchedPaths([patch.filePath]);
        toast.success(
          patch.operation === 'delete' ? `Removed ${patch.filePath}` : `Saved ${patch.filePath}`,
        );
        await refreshFileTree();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to apply patch: ${msg}`);
      }
    },
    [applyPatchToWorkspace, refreshFileTree, addPatchedPaths],
  );

  const runAgentAutoApply = useCallback(
    async (assistantMessageId: string, text: string) => {
      const st = useAppStore.getState();
      if (st.workspaceRoots.length === 0) return;
      if (!containsPatches(text)) return;
      const patches = parsePatches(text);
      if (patches.length === 0) return;

      const appliedPaths: string[] = [];
      const errors: string[] = [];
      for (const p of patches) {
        try {
          await applyPatchToWorkspace(p);
          appliedPaths.push(p.filePath);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${p.filePath}: ${msg}`);
        }
      }

      if (appliedPaths.length > 0) {
        addPatchedPaths(appliedPaths);
        await refreshFileTree();
        setAutoAppliedPathsByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: [...new Set([...(prev[assistantMessageId] ?? []), ...appliedPaths])],
        }));

        const actions: AgentAction[] = appliedPaths.map((path) => {
          const patch = patches.find((p) => p.filePath === path);
          const type = patch?.operation === 'create' ? 'write' : patch?.operation === 'delete' ? 'delete' : 'write';
          return { type, path, success: true };
        });
        setAgentActionsByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: [...(prev[assistantMessageId] ?? []), ...actions],
        }));

        toast.success(`Applied ${appliedPaths.length} change(s)`);
      }
      if (errors.length > 0) {
        toast.error(
          `Some patches failed: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}`,
        );
      }
    },
    [applyPatchToWorkspace, refreshFileTree, addPatchedPaths],
  );

  const runDirectEditAutoApply = useCallback(
    async (assistantMessageId: string, text: string) => {
      const st = useAppStore.getState();
      if (!st.settings.directEditMode || st.workspaceRoots.length === 0) return;
      if (!containsPatches(text)) return;
      const patches = parsePatches(text);
      if (patches.length === 0) return;

      const appliedPaths: string[] = [];
      const errors: string[] = [];
      for (const p of patches) {
        try {
          await applyPatchToWorkspace(p);
          appliedPaths.push(p.filePath);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${p.filePath}: ${msg}`);
        }
      }

      if (appliedPaths.length > 0) {
        addPatchedPaths(appliedPaths);
        await refreshFileTree();
        setAutoAppliedPathsByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: [...new Set([...(prev[assistantMessageId] ?? []), ...appliedPaths])],
        }));
        toast.success(`Direct edit: applied ${appliedPaths.length} change(s) to the folder`);
      }
      if (errors.length > 0) {
        toast.error(
          `Some patches failed: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}`,
        );
      }
    },
    [applyPatchToWorkspace, refreshFileTree, addPatchedPaths],
  );

  const runAssistantTurn = useCallback(async ({
    chatId,
    chatMode,
    baseMessages,
    hasVision,
    mentionedFilePaths = [],
  }: {
    chatId: string;
    chatMode: ChatMode;
    baseMessages: Message[];
    hasVision: boolean;
    mentionedFilePaths?: string[];
  }) => {
    const isAgentMode = chatMode === 'agent';
    const systemPrompt = isAgentMode ? AGENT_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT;
    const contextMsgs = isAgentMode ? await buildContextMessages(mentionedFilePaths) : [];

    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    addMessage(chatId, assistantMsg);

    setIsStreaming(true);
    abortRef.current = new AbortController();

    const maxIter = isAgentMode
      ? Math.min(10, Math.max(1, settings.agentMaxIterations ?? 5))
      : 1;

    const toApi = (message: Message): LLMMessage => ({ role: message.role, content: message.content });

    let loopMessages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...contextMsgs,
      ...baseMessages.map(toApi),
      { role: 'assistant', content: '' },
    ];

    try {
      let streamedContent = '';
      const allActions: AgentAction[] = [];

      for (let iter = 1; iter <= maxIter; iter++) {
        if (isAgentMode && iter > 1) {
          setAgentGatherStep(iter);
        }
        if (iter > 1) {
          updateLastAssistantMessage(chatId, '');
        }

        streamedContent = await chatCompletion({
          messages: loopMessages,
          settings,
          useVision: hasVision && iter === 1,
          onToken: (full) => updateLastAssistantMessage(chatId, full),
          signal: abortRef.current!.signal,
        });

        if (!isAgentMode) break;
        if (iter >= maxIter) break;

        const tools = parseToolCalls(streamedContent);
        if (!hasAgentTools(tools)) break;

        const roots = useAppStore.getState().workspaceRoots;
        if (roots.length === 0) {
          toast.error('Open a workspace folder to use agent tools');
          break;
        }

        const { textFeedback, actions } = await executeAgentTools(roots, tools);
        allActions.push(...actions);

        if (actions.some((action) => action.type === 'write' || action.type === 'delete' || action.type === 'rename')) {
          await refreshFileTree();
        }

        if (!hasGatherTools(tools)) break;

        loopMessages = [
          { role: 'system', content: systemPrompt },
          ...contextMsgs,
          ...baseMessages.map(toApi),
          { role: 'assistant', content: streamedContent },
          {
            role: 'user',
            content:
              'Tool results (use to continue; when ready, output patches in the required format):\n\n' +
              textFeedback,
          },
          { role: 'assistant', content: '' },
        ];
      }

      setAgentGatherStep(null);

      if (allActions.length > 0) {
        setAgentActionsByMessageId((prev) => ({
          ...prev,
          [assistantMsg.id]: [...(prev[assistantMsg.id] ?? []), ...allActions],
        }));
      }

      const finalChat = useAppStore.getState().chats.find((chat) => chat.id === chatId);
      if (finalChat) {
        try {
          await persistenceSaveChat(finalChat);
        } catch (err) {
          console.error('[EvigStudio] Failed to persist chat after stream', err);
        }
      }

      if (typeof streamedContent === 'string' && streamedContent.length > 0) {
        try {
          if (isAgentMode) {
            await runAgentAutoApply(assistantMsg.id, streamedContent);
          } else {
            await runDirectEditAutoApply(assistantMsg.id, streamedContent);
          }
        } catch (e) {
          console.error('[EvigStudio] auto-apply', e);
        }
      }
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'AbortError') {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        updateLastAssistantMessage(chatId, `Error: ${errorMsg}\n\nTips:\n- Check your local AI server is running\n- Verify the base URL in settings\n- Enable CORS in your AI server\n- Try a different model`);
        toast.error('Local AI request failed');
      }
    } finally {
      setAgentGatherStep(null);
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [addMessage, buildContextMessages, refreshFileTree, runAgentAutoApply, runDirectEditAutoApply, setIsStreaming, settings, updateLastAssistantMessage]);

  const handleSubmitMessageEdit = useCallback(async (messageId: string, nextText: string) => {
    const chatId = useAppStore.getState().activeChatId;
    if (!chatId || isStreaming) return;

    const chat = useAppStore.getState().chats.find((entry) => entry.id === chatId);
    if (!chat || !canWriteChat(chat)) return;

    const messageIndex = chat.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;

    const originalMessage = chat.messages[messageIndex];
    if (originalMessage.role !== 'user' || typeof originalMessage.content !== 'string') return;

    const trimmed = nextText.trim();
    if (!trimmed || trimmed === originalMessage.content.trim()) return;

    saveVersionSnapshot(chat.id, `Before editing message ${messageIndex + 1}`);

    const updatedMessage: Message = {
      ...originalMessage,
      content: trimmed,
      timestamp: Date.now(),
    };
    const nextMessages = [...chat.messages.slice(0, messageIndex), updatedMessage];

    trimMessageUiState(nextMessages);
    updateChatFields(chat.id, {
      messages: nextMessages,
      title: deriveChatTitle(nextMessages, chat.title),
    });

    userScrolledUp.current = false;
    await runAssistantTurn({
      chatId: chat.id,
      chatMode: chat.mode,
      baseMessages: nextMessages,
      hasVision: false,
      mentionedFilePaths: [],
    });
  }, [deriveChatTitle, isStreaming, runAssistantTurn, saveVersionSnapshot, trimMessageUiState, updateChatFields]);

  const handleRegenerateMessage = useCallback(async (messageId: string) => {
    const chatId = useAppStore.getState().activeChatId;
    if (!chatId || isStreaming) return;

    const chat = useAppStore.getState().chats.find((entry) => entry.id === chatId);
    if (!chat || !canWriteChat(chat)) return;

    const messageIndex = chat.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;

    const targetMessage = chat.messages[messageIndex];
    if (targetMessage.role !== 'assistant') return;

    const nextMessages = chat.messages.slice(0, messageIndex);
    if (nextMessages.length === 0) return;

    saveVersionSnapshot(chat.id, `Before regenerating response ${messageIndex + 1}`);

    trimMessageUiState(nextMessages);
    updateChatFields(chat.id, {
      messages: nextMessages,
      title: deriveChatTitle(nextMessages, chat.title),
    });

    const lastPrompt = nextMessages[nextMessages.length - 1];
    userScrolledUp.current = false;
    await runAssistantTurn({
      chatId: chat.id,
      chatMode: chat.mode,
      baseMessages: nextMessages,
      hasVision: lastPrompt?.role === 'user' ? hasImages(lastPrompt) : false,
      mentionedFilePaths: [],
    });
  }, [deriveChatTitle, isStreaming, runAssistantTurn, saveVersionSnapshot, trimMessageUiState, updateChatFields]);

  const handleSend = useCallback(async () => {
    if ((!input.trim() && images.length === 0) || isStreaming) return;
    if (activeChat && !canWriteChat(activeChat)) {
      toast.error('This conversation is locked. Start a new chat to continue.');
      return;
    }

    const currentMode = useAppStore.getState().chats.find((c) => c.id === activeChatId)?.mode ?? 'agent';

    let chatId = activeChatId;
    if (!chatId) {
      try {
        chatId = await createChat();
      } catch (e) {
        console.error('[EvigStudio] createChat failed', e);
        const msg =
          e instanceof Error && e.message
            ? e.message
            : 'Could not create a new chat. Check your connection or sign in again.';
        toast.error(msg);
        return;
      }
    }

    const hasVision = images.length > 0;
    const mentionedFilePaths = mentionedFiles;
    let userContent: string | ContentPart[];
    if (hasVision) {
      const parts: ContentPart[] = [];
      if (input.trim()) parts.push({ type: 'text', text: input.trim() });
      for (const img of images) {
        parts.push({ type: 'image_url', image_url: { url: img } });
      }
      userContent = parts;
    } else {
      userContent = input.trim();
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    };

    addMessage(chatId, userMsg);
    userScrolledUp.current = false;
    setInput('');
    setImages([]);
    setMentionedFiles([]);

    if (getChatPersistenceMode() === 'server') {
      try {
        await fetch('/api/audit/query', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId,
            chatTitle: useAppStore.getState().chats.find((c) => c.id === chatId)?.title ?? null,
            chatMode: currentMode,
            model: settings.textModel,
            preview: getMessageText(userMsg).slice(0, 500),
            promptLength: getMessageText(userMsg).length,
            imageCount: images.length,
            mentionedFileCount: mentionedFilePaths.length,
          }),
        });
      } catch {
        /* optional audit */
      }
    }

    const baseMessages = useAppStore.getState().chats.find((c) => c.id === chatId)?.messages ?? [userMsg];
    await runAssistantTurn({
      chatId,
      chatMode: currentMode,
      baseMessages,
      hasVision,
      mentionedFilePaths,
    });
  }, [
    input,
    images,
    mentionedFiles,
    activeChat,
    activeChatId,
    isStreaming,
    settings,
    createChat,
    addMessage,
    runAssistantTurn,
  ]);

  const handleStop = () => abortRef.current?.abort();

  const handleImageAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setImages(prev => [...prev, reader.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const handleGetOriginal = useCallback(async (filePath: string): Promise<string> => {
    if (workspaceRoots.length === 0) return '';
    try {
      return await readWorkspaceFile(workspaceRoots, filePath);
    } catch {
      return '';
    }
  }, [workspaceRoots]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMention) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="pane-header flex-col items-stretch gap-2">
        <div className="flex items-center gap-2 w-full min-w-0">
          {isAgent ? (
            <Bot className="w-3.5 h-3.5 text-primary shrink-0" />
          ) : (
            <MessageSquare className="w-3.5 h-3.5 text-primary shrink-0" />
          )}
          <span className="truncate min-w-0">{activeChat?.title || 'New Chat'}</span>
          <div className="ml-auto shrink-0">
            {activeChat && (
              <ChatModeToggle chatId={activeChat.id} mode={chatMode} disabled={isLocked} />
            )}
          </div>
        </div>
        {activeChat && <ChatToolbar chat={activeChat} />}
      </div>

      {activeChat && isLocked && (
        <div className="border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground sm:px-5">
          <div className="flex items-center gap-2">
            <Lock className="h-3 w-3 shrink-0" />
            <span>
              Read-only conversation{activeChat.ownerDisplayName ? ` from ${activeChat.ownerDisplayName}` : ''}.
              Only the owner can continue or edit it.
            </span>
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 space-y-4 overflow-y-auto px-3 py-3 sm:px-5">
        {!activeChat || activeChat.messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
              <div className="text-4xl">{isAgent ? '🤖' : '💬'}</div>
              <h2 className="text-lg font-semibold text-foreground">
                {isAgent ? 'Agent Mode' : 'Chat Mode'}
              </h2>
              <p className="text-xs text-muted-foreground max-w-sm">
                {isAgent
                  ? 'Full coding agent : reads, edits, creates, and deletes files in your workspace. Open a folder to get started.'
                  : 'Plain conversation with your local AI. Ask questions, brainstorm, or discuss code.'}
              </p>
            </div>
          </div>
        ) : (
          activeChat.messages.map(msg => (
            <ChatMessage
              key={msg.id}
              message={msg}
              chatMode={chatMode}
              onApplyPatch={handleApplyPatch}
              onGetOriginal={handleGetOriginal}
              autoAppliedPaths={autoAppliedPathsByMessageId[msg.id]}
              agentActions={agentActionsByMessageId[msg.id]}
              onOpenFile={handleOpenEditorFile}
              onSubmitEdit={isLocked ? undefined : handleSubmitMessageEdit}
              onRegenerate={isLocked ? undefined : handleRegenerateMessage}
              busy={isStreaming}
            />
          ))
        )}
        {isStreaming && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>
              {agentGatherStep != null && agentGatherStep > 1 && isAgent
                ? `Gathering context… (step ${agentGatherStep - 1}/${Math.min(10, Math.max(1, settings.agentMaxIterations ?? 5)) - 1})`
                : 'Generating…'}
            </span>
            <span className="animate-blink">▋</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 px-4 py-2 border-t border-border">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img src={img} alt="" className="h-16 rounded border border-border" />
              <button
                onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* Mentioned files pills */}
      {mentionedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 py-2 border-t border-border">
          {mentionedFiles.map(filePath => (
            <span
              key={filePath}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-[11px] text-primary animate-fade-in"
            >
              <FileCode className="w-3 h-3" />
              <span className="max-w-[120px] truncate">{filePath.split('/').pop()}</span>
              <button
                onClick={() => removeMentionedFile(filePath)}
                className="ml-0.5 hover:text-destructive transition-colors"
                title={`Remove ${filePath}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-border bg-card/90 p-3 shadow-[0_-8px_32px_hsl(var(--background)/0.45)] backdrop-blur-md sm:p-4">
        <p className="mb-2 hidden text-[11px] text-muted-foreground sm:block">
          {isAgent
            ? 'Describe what to build or fix : the agent will read and edit files directly.'
            : 'Type a question or start a conversation.'}
        </p>
        <div className="relative flex items-end gap-2">
          <button
            type="button"
            onClick={() => toggleDictation()}
            disabled={!sttSupported || isStreaming || isLocked}
            className={`shrink-0 rounded p-2 transition-colors hover:bg-secondary ${
              dictating
                ? 'bg-primary/15 text-primary ring-2 ring-primary/40'
                : 'text-muted-foreground hover:text-foreground'
            } disabled:cursor-not-allowed disabled:opacity-40`}
            title={sttSupported ? (dictating ? 'Stop dictation' : 'Dictate (speech-to-text)') : 'Speech input not supported'}
          >
            <Mic className={`h-5 w-5 sm:h-4 sm:w-4 ${dictating ? 'animate-pulse' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLocked}
            className="shrink-0 rounded p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Attach image for vision"
          >
            <ImagePlus className="h-5 w-5 sm:h-4 sm:w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={handleImageAttach}
          />
          <div className="relative min-w-0 flex-1">
            <FileMentionPopover
              fileTree={fileTree}
              query={mentionQuery}
              onSelect={handleMentionSelect}
              onClose={() => { setShowMention(false); setMentionQuery(''); setMentionStartIdx(-1); }}
              visible={showMention}
            />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={isLocked}
              placeholder={isAgent ? 'Describe what to build, fix, or change… (@ file)' : 'Ask anything…'}
              rows={2}
              className="min-h-[48px] w-full resize-none rounded-lg border border-border/80 bg-input px-3 py-3 text-base leading-snug outline-none ring-2 ring-transparent transition-shadow placeholder:text-muted-foreground focus:border-primary/40 focus:ring-primary/30 sm:min-h-[44px] sm:py-2.5 sm:text-sm"
            />
          </div>
          {isStreaming ? (
            <button
              type="button"
              onClick={handleStop}
              className="shrink-0 rounded bg-destructive/20 p-2.5 text-destructive hover:bg-destructive/30 sm:p-2"
            >
              <StopCircle className="h-5 w-5 sm:h-4 sm:w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={isLocked || (!input.trim() && images.length === 0 && mentionedFiles.length === 0)}
              className="glow-primary shrink-0 rounded bg-primary p-2.5 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-30 sm:p-2"
            >
              <Send className="h-5 w-5 sm:h-4 sm:w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
