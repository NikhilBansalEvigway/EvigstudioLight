import { useState, useRef, useCallback, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { chatCompletion, type ChatMessage as LLMMessage } from '@/lib/llmClient';
import { readFile, writeFile, buildFileTree, deleteFileOrDir, serializeFileTree } from '@/lib/fsWorkspace';
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
  getMessageText,
  type Message,
  type ContentPart,
  type ParsedPatch,
} from '@/types';
import { getChatPersistenceMode, persistenceSaveChat } from '@/lib/chatPersistence';
import { ChatToolbar } from '@/components/ChatToolbar';
import { useSpeechDictation } from '@/hooks/useSpeechDictation';
import { Send, ImagePlus, Loader2, StopCircle, Zap, FileCode, X, Mic, Bot, MessageSquare } from 'lucide-react';
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
    chats, activeChatId, createChat, addMessage, updateLastAssistantMessage,
    settings, contextFiles, workspaceHandle, fileTree, isStreaming, setIsStreaming,
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

  const buildContextMessages = useCallback(async (): Promise<{ role: 'user'; content: string }[]> => {
    if (!workspaceHandle) return [];

    const included = new Set<string>();
    const parts: string[] = [];

    const treeStr = fileTree.length ? serializeFileTree(fileTree) : '';
    if (treeStr) {
      parts.push(`## Project structure (file paths)\n\`\`\`\n${treeStr}\n\`\`\``);
    }

    for (const rel of KEY_PROJECT_FILES) {
      try {
        let content = await readFile(workspaceHandle, rel);
        included.add(rel);
        if (content.length > 2000) {
          content = `${content.slice(0, 2000)}\n\n… [truncated]`;
        }
        parts.push(`### Key file: ${rel}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        /* optional */
      }
    }

    for (const path of patchedPathsRef.current) {
      if (included.has(path)) continue;
      try {
        let content = await readFile(workspaceHandle, path);
        included.add(path);
        if (content.length > 2000) {
          content = `${content.slice(0, 2000)}\n\n… [truncated]`;
        }
        parts.push(`### Recently edited in this chat: ${path}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        /* skip */
      }
    }

    const allFiles = [...new Set([...contextFiles, ...mentionedFiles])];
    for (const path of allFiles) {
      if (included.has(path)) continue;
      included.add(path);
      try {
        const content = await readFile(workspaceHandle, path);
        parts.push(`### File: ${path}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        parts.push(`### File: ${path}\n(Could not read file)`);
      }
    }

    if (parts.length === 0) return [];
    return [
      {
        role: 'user' as const,
        content: `Workspace context (use paths below as ground truth; do not invent paths that are not listed):\n\n${parts.join('\n\n')}`,
      },
    ];
  }, [workspaceHandle, fileTree, contextFiles, mentionedFiles]);

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
    const handle = useAppStore.getState().workspaceHandle;
    if (!handle) return;
    const tree = await buildFileTree(handle);
    useAppStore.getState().setFileTree(tree);
  }, []);

  const applyPatchToWorkspace = useCallback(async (patch: ParsedPatch) => {
    const handle = useAppStore.getState().workspaceHandle;
    if (!handle) throw new Error('No workspace folder open');

    const { filePath, content, operation = 'update' } = patch;

    if (operation === 'delete') {
      await deleteFileOrDir(handle, filePath);
      const { activeFilePath, setActiveFile } = useAppStore.getState();
      if (activeFilePath === filePath) {
        setActiveFile(null, '');
      }
      return;
    }

    let original = '';
    try {
      original = await readFile(handle, filePath);
    } catch {
      /* new or missing file */
    }
    const result = applyPatch(original, patch);
    await writeFile(handle, filePath, result);
    const { activeFilePath, setActiveFileContent } = useAppStore.getState();
    if (activeFilePath === filePath) {
      setActiveFileContent(result);
    }
  }, []);

  const handleApplyPatch = useCallback(
    async (patch: ParsedPatch) => {
      if (!useAppStore.getState().workspaceHandle) {
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
      if (!st.workspaceHandle) return;
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
      if (!st.settings.directEditMode || !st.workspaceHandle) return;
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

  const handleSend = useCallback(async () => {
    if ((!input.trim() && images.length === 0) || isStreaming) return;

    const currentMode = useAppStore.getState().chats.find((c) => c.id === activeChatId)?.mode ?? 'agent';
    const isAgentMode = currentMode === 'agent';

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
            model: settings.textModel,
            preview: getMessageText(userMsg).slice(0, 500),
          }),
        });
      } catch {
        /* optional audit */
      }
    }

    const systemPrompt = isAgentMode ? AGENT_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT;
    const contextMsgs = isAgentMode ? await buildContextMessages() : [];

    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    addMessage(chatId, assistantMsg);

    const chatWithAssistant = useAppStore.getState().chats.find((c) => c.id === chatId);
    if (!chatWithAssistant) return;
    const baseForApi = chatWithAssistant.messages.slice(0, -1);

    setIsStreaming(true);
    abortRef.current = new AbortController();

    const maxIter = isAgentMode
      ? Math.min(10, Math.max(1, settings.agentMaxIterations ?? 5))
      : 1;

    const toApi = (m: Message): LLMMessage => ({ role: m.role, content: m.content });

    let loopMessages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...contextMsgs,
      ...baseForApi.map(toApi),
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
          updateLastAssistantMessage(chatId!, '');
        }

        streamedContent = await chatCompletion({
          messages: loopMessages,
          settings,
          useVision: hasVision && iter === 1,
          onToken: (full) => updateLastAssistantMessage(chatId!, full),
          signal: abortRef.current!.signal,
        });

        if (!isAgentMode) break;
        if (iter >= maxIter) break;

        const tools = parseToolCalls(streamedContent);
        if (!hasAgentTools(tools)) break;

        const wh = useAppStore.getState().workspaceHandle;
        if (!wh) {
          toast.error('Open a workspace folder to use agent tools');
          break;
        }

        const { textFeedback, actions } = await executeAgentTools(wh, tools);
        allActions.push(...actions);

        if (actions.some((a) => a.type === 'write' || a.type === 'delete' || a.type === 'rename')) {
          await refreshFileTree();
        }

        if (!hasGatherTools(tools)) break;

        loopMessages = [
          { role: 'system', content: systemPrompt },
          ...contextMsgs,
          ...baseForApi.map(toApi),
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

      const finalChat = useAppStore.getState().chats.find((c) => c.id === chatId);
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
        updateLastAssistantMessage(chatId!, `Error: ${errorMsg}\n\nTips:\n- Check your local AI server is running\n- Verify the base URL in settings\n- Enable CORS in your AI server\n- Try a different model`);
        toast.error('Local AI request failed');
      }
    } finally {
      setAgentGatherStep(null);
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [
    input,
    images,
    activeChatId,
    isStreaming,
    settings,
    createChat,
    addMessage,
    updateLastAssistantMessage,
    setIsStreaming,
    buildContextMessages,
    runAgentAutoApply,
    runDirectEditAutoApply,
    refreshFileTree,
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
    if (!workspaceHandle) return '';
    try {
      return await readFile(workspaceHandle, filePath);
    } catch {
      return '';
    }
  }, [workspaceHandle]);

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
              <ChatModeToggle chatId={activeChat.id} mode={chatMode} />
            )}
          </div>
        </div>
        {activeChat && <ChatToolbar chat={activeChat} />}
      </div>

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
            disabled={!sttSupported || isStreaming}
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
              disabled={!input.trim() && images.length === 0 && mentionedFiles.length === 0}
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
