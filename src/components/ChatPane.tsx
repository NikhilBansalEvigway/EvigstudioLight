import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { chatCompletion, type ChatMessage as LLMMessage } from '@/lib/llmClient';
import {
  buildWorkspacePath,
  buildWorkspaceTree,
  deleteWorkspacePath,
  isWorkspacePathIgnored,
  listWorkspaceDirectoryContents,
  readWorkspaceFile,
  resolveWorkspacePath,
  serializeFileTree,
  STALE_WORKSPACE_WRITE_RECOVERY_MESSAGE,
  workspacePathExists,
  writeWorkspaceFile,
} from '@/lib/fsWorkspace';
import { DEFAULT_CONTEXT_RULES, isAllowedContextPath } from '@/lib/contextRules';
import {
  parseToolCalls,
  hasAgentTools,
  hasGatherTools,
  hasMutationTools,
  executeAgentTools,
  extractThinkingBlocks,
  stripChannelTokens,
  stripToolMarkers,
  normalizeToolMarkerLineBreaks,
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
import { getLastUserContextRefPaths, getMessageContextRefPaths } from '@/lib/chatContext';
import { collectDirectoryFilePaths, findMentionNode, summarizeDirectory, type MentionEntry } from '@/lib/fileMentions';
import { isWorkspaceEditRequest } from '@/lib/workspaceIntent';
import {
  buildCondenseTranscript as buildCondenseTranscriptForSummary,
  collectChatContextRefPaths as collectChatContextRefPathsForSummary,
  extractAutoSummaryBody as extractAutoSummaryBodyForSummary,
} from '@/lib/chatSummarization';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  buildActiveDocumentAudit,
  buildWorkspaceRootSummaries,
  normalizeAuditPaths,
  workspaceFolderLabels,
} from '@/lib/auditClient';
import { useSpeechDictation } from '@/hooks/useSpeechDictation';
import {
  Send,
  ImagePlus,
  Loader2,
  StopCircle,
  FileCode,
  X,
  Mic,
  Bot,
  MessageSquare,
  Lock,
  FolderOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { toast } from 'sonner';

function deriveThinkingFromUserPrompt(userText: string): string {
  const text = userText.trim().slice(0, 300);
  if (!text) return '';
  const lower = text.toLowerCase();
  let plan: string;
  if (/\b(fix|bug|error|crash|issue|broken|fail|wrong|not working)\b/.test(lower)) {
    plan = 'diagnose the problem and propose a targeted fix';
  } else if (/\b(create|write|make|build|generate|add|implement|scaffold|new)\b/.test(lower)) {
    plan = 'implement the requested feature or content';
  } else if (/\b(refactor|clean|improve|optimize|simplify|restructure|rewrite)\b/.test(lower)) {
    plan = 'refactor the code while preserving behavior';
  } else if (/\b(explain|what is|what are|why|how does|how do|tell me|describe|understand|mean)\b/.test(lower)) {
    plan = 'explain the concept clearly with relevant details';
  } else if (/\b(test|spec|unit test|coverage|testing)\b/.test(lower)) {
    plan = 'write the requested tests';
  } else if (/\b(review|check|audit|look at|inspect|is this|is it)\b/.test(lower)) {
    plan = 'review and provide feedback';
  } else if (/\b(update|change|modify|edit|replace|rename)\b/.test(lower)) {
    plan = 'apply the requested change';
  } else if (/\b(delete|remove|clean up|get rid)\b/.test(lower)) {
    plan = 'remove the specified code or content';
  } else {
    plan = 'understand the request and formulate a response';
  }
  const preview = text.length > 150 ? `${text.slice(0, 150)}…` : text;
  return `**Request:** "${preview}"\n\n**Approach:** ${plan}.`;
}

const KEY_PROJECT_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'vite.config.ts',
  'README.md',
  '.env.example',
];

const CONTEXT_WARNING_RATIO = 0.86;
const AUTO_SUMMARY_HEADER = 'Conversation summary (auto-generated):';
const AUTO_SUMMARY_FOOTER = 'Continue chatting with this summary as context.';
const SUMMARY_TEMP = 0.1;
const SUMMARY_MAX_TOKENS = 2048;
// Hard ceiling so a stalled local model can never leave the UI stuck on "Summarizing…".
const SUMMARY_TIMEOUT_MS = 3 * 60_000;
const INPUT_MIN_HEIGHT_PX = 56;
const INPUT_MAX_HEIGHT_PX = 220;

export function ChatPane() {
  const {
    chats, activeChatId, createChat, addMessage, updateLastAssistantMessage, updateChatFields, saveVersionSnapshot,
    settings, contextFiles, fileTree, isStreaming, streamingChatId, setIsStreaming, workspaceRoots,
    workspaceContextUsedChars, contextBudgetChars,
    serverContextRules,
    setHistoryContextUsage,
  } = useAppStore();

  const isActiveChatStreaming = isStreaming && streamingChatId === activeChatId;

  const [autoAppliedPathsByMessageId, setAutoAppliedPathsByMessageId] = useState<Record<string, string[]>>({});
  const [agentActionsByMessageId, setAgentActionsByMessageId] = useState<Record<string, AgentAction[]>>({});
  const [agentThoughtsByMessageId, setAgentThoughtsByMessageId] = useState<Record<string, string[]>>({});
  const patchedPathsRef = useRef<Set<string>>(new Set());
  const [agentGatherStep, setAgentGatherStep] = useState<number | null>(null);
  const [showContextActionsDialog, setShowContextActionsDialog] = useState(false);
  const [isCondensingChat, setIsCondensingChat] = useState(false);
  const [showSummarizeDialog, setShowSummarizeDialog] = useState(false);
  const [summarizePinContext, setSummarizePinContext] = useState(true);
  const pendingContextActionInputRef = useRef<{
    input: string;
    images: string[];
    mentionedFiles: string[];
    selectionRef: Message['selectionRef'] | null;
    /** Present when the input was already appended to chat history. */
    sentUserMessageId?: string;
  } | null>(null);
  const [contextPressure, setContextPressure] = useState<{
    usedChars: number;
    budgetChars: number;
    historyChars: number;
    workspaceChars: number;
    pendingChars: number;
    ratio: number;
  } | null>(null);

  useEffect(() => {
    patchedPathsRef.current = new Set();
  }, [activeChatId]);

  
  useEffect(() => {
    if (!isActiveChatStreaming) return;
    const id = window.setTimeout(() => {
      if (useAppStore.getState().isStreaming) {
        setIsStreaming(false);
        setAgentGatherStep(null);
        useAppStore.getState().setAgentStepProgress(0, 0);
      }
    }, 12 * 60 * 1000);
    return () => window.clearTimeout(id);
  }, [isActiveChatStreaming, setIsStreaming]);

  const activeChat = chats.find(c => c.id === activeChatId);
  const isLocked = activeChat ? !canWriteChat(activeChat) : false;
  const chatMode = activeChat?.mode ?? 'agent';
  const isAgent = chatMode === 'agent';

  // Keep the context usage indicator tied to the active chat.
  useEffect(() => {
    if (!activeChat) {
      setHistoryContextUsage(0);
      return;
    }
    const historyChars = activeChat.messages
      .filter((m) => !m.excludedFromContext && (m.role === 'user' || m.role === 'assistant'))
      .reduce((sum, m) => sum + getMessageText(m).length + 48, 0);
    setHistoryContextUsage(historyChars);
  }, [activeChatId, activeChat?.messages, setHistoryContextUsage]);

  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);
  const [selectionAttachment, setSelectionAttachment] = useState<Message['selectionRef'] | null>(null);
  const [selectionPopover, setSelectionPopover] = useState<{
    text: string;
    left: number;
    top: number;
    sourceMessageId?: string;
    sourceRole?: Message['role'];
    sourceTimestamp?: number;
  } | null>(null);
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStartIdx, setMentionStartIdx] = useState(-1);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const abortReasonRef = useRef<'user' | 'stall' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Used to pass explicit values to sendCurrentInput when React state is stale (context-action re-send flow).
  const forcedSendRef = useRef<{
    input: string;
    images: string[];
    mentionedFiles: string[];
    selectionRef: Message['selectionRef'] | null;
  } | null>(null);

  const [showCompactedHistory, setShowCompactedHistory] = useState(true);

  useEffect(() => {
    setShowCompactedHistory(false);
  }, [activeChatId]);

  useEffect(() => {
    let codeblockDebounceTimer: number | null = null;

    const resolveSelection = () => {
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        if (codeblockDebounceTimer != null) {
          window.clearTimeout(codeblockDebounceTimer);
          codeblockDebounceTimer = null;
        }
        setSelectionPopover(null);
        return;
      }

      const range = sel.getRangeAt(0);
      const rawText = sel.toString();
      if (!rawText.trim()) {
        setSelectionPopover(null);
        return;
      }

      const anchorNode = sel.anchorNode;
      const anchorEl =
        anchorNode && anchorNode.nodeType === Node.ELEMENT_NODE
          ? (anchorNode as Element)
          : anchorNode?.parentElement ?? null;
      const container = scrollContainerRef.current;
      if (!anchorEl || !container || !container.contains(anchorEl)) {
        setSelectionPopover(null);
        return;
      }

      // Don’t trigger on selections inside the composer.
      if (anchorEl.closest('[data-evig-composer]')) {
        setSelectionPopover(null);
        return;
      }

      const inCodeBlock = !!anchorEl.closest('[data-evig-codeblock]');
      const text = inCodeBlock ? rawText : rawText.trim();

      const msgEl = anchorEl.closest('[data-evig-message-id]') as HTMLElement | null;
      const sourceMessageId = msgEl?.dataset.evigMessageId;
      const sourceRole = (msgEl?.dataset.evigMessageRole as Message['role'] | undefined) ?? undefined;
      const sourceTimestamp = msgEl?.dataset.evigMessageTimestamp
        ? Number(msgEl.dataset.evigMessageTimestamp)
        : undefined;

      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setSelectionPopover(null);
        return;
      }

      const nextLeft = rect.left + rect.width / 2;
      const nextTop = rect.bottom + 10;
      const left = Math.max(12, Math.min(window.innerWidth - 12, nextLeft));
      const top = Math.max(12, Math.min(window.innerHeight - 12, nextTop));

      const apply = () => {
        setSelectionPopover((prev) => {
          // Avoid spamming state updates while the user is actively selecting.
          if (
            prev &&
            prev.text === text &&
            Math.abs(prev.left - left) < 1 &&
            Math.abs(prev.top - top) < 1 &&
            prev.sourceMessageId === sourceMessageId &&
            prev.sourceRole === sourceRole &&
            prev.sourceTimestamp === sourceTimestamp
          ) {
            return prev;
          }
          return { text, left, top, sourceMessageId, sourceRole, sourceTimestamp };
        });
      };

      // Updating popover state while dragging a selection inside a highlighted code block can
      // cause DOM churn that drops the browser selection. Debounce until the user pauses.
      if (inCodeBlock) {
        if (codeblockDebounceTimer != null) window.clearTimeout(codeblockDebounceTimer);
        codeblockDebounceTimer = window.setTimeout(() => {
          codeblockDebounceTimer = null;
          apply();
        }, 120);
        return;
      }

      if (codeblockDebounceTimer != null) {
        window.clearTimeout(codeblockDebounceTimer);
        codeblockDebounceTimer = null;
      }
      apply();
    };

    document.addEventListener('selectionchange', resolveSelection);
    window.addEventListener('resize', resolveSelection);
    // Capture scrolls from nested containers (chat list scroll, etc.).
    window.addEventListener('scroll', resolveSelection, true);
    return () => {
      if (codeblockDebounceTimer != null) {
        window.clearTimeout(codeblockDebounceTimer);
        codeblockDebounceTimer = null;
      }
      document.removeEventListener('selectionchange', resolveSelection);
      window.removeEventListener('resize', resolveSelection);
      window.removeEventListener('scroll', resolveSelection, true);
    };
  }, []);

  const resizeInputTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const nextHeight = Math.max(INPUT_MIN_HEIGHT_PX, Math.min(textarea.scrollHeight, INPUT_MAX_HEIGHT_PX));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > INPUT_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    resizeInputTextarea();
  }, [input, resizeInputTextarea]);

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

  const mentionStats = useMemo(() => {
    let files = 0;
    let folders = 0;
    let stale = 0;
    let folderFiles = 0;
    for (const path of mentionedFiles) {
      const node = findMentionNode(fileTree, path);
      if (!node) {
        stale += 1;
      } else if (node.type === 'directory') {
        folders += 1;
        folderFiles += collectDirectoryFilePaths(node, 1_000).length;
      } else {
        files += 1;
      }
    }
    return { files, folders, stale, folderFiles };
  }, [fileTree, mentionedFiles]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const isInitializingScroll = useRef(false);
  const [isAtTop, setIsAtTop] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    try {
      container.scrollTo({ top: container.scrollHeight, behavior });
    } catch {
      container.scrollTop = container.scrollHeight;
    }
    userScrolledUp.current = false;
    setShowScrollToLatest(false);
  }, []);

  const scrollToTop = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    try {
      container.scrollTo({ top: 0, behavior });
    } catch {
      container.scrollTop = 0;
    }
  }, []);

 
  useEffect(() => {
    if (workspaceRoots.length === 0 || mentionedFiles.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const checks = await Promise.all(
        mentionedFiles.map(async (path) => ({
          path,
          exists: await workspacePathExists(workspaceRoots, path).catch(() => true),
        })),
      );
      if (cancelled) return;
      const missing = new Set(checks.filter((c) => !c.exists).map((c) => c.path));
      if (missing.size === 0) return;
      setMentionedFiles((prev) => prev.filter((path) => !missing.has(path)));
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workspaceRoots, mentionedFiles]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const BOTTOM_THRESHOLD_PX = 96;
    const onScroll = () => {
      
      if (isInitializingScroll.current) {
        userScrolledUp.current = false;
        setShowScrollToLatest(false);
        setIsAtTop(true);
        setIsAtBottom(true);
        return;
      }
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const scrolledUp = distFromBottom > BOTTOM_THRESHOLD_PX;
      userScrolledUp.current = scrolledUp;

      const TOP_EPS = 8;
      const BOTTOM_EPS = 8;
      setIsAtTop(container.scrollTop <= TOP_EPS);
      setIsAtBottom(distFromBottom <= BOTTOM_EPS);

      if (scrolledUp && isStreaming) {
        setShowScrollToLatest(true);
      }
      if (!scrolledUp) {
        setShowScrollToLatest(false);
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener('scroll', onScroll);
  }, [isStreaming]);

  useEffect(() => {
    if (!activeChat) return;
    if (!userScrolledUp.current) {
      scrollToBottom('auto');
      return;
    }
    setShowScrollToLatest(true);
  }, [activeChat?.messages, activeChat, scrollToBottom]);

  useEffect(() => {
    if (!activeChatId) {
      setShowScrollToLatest(false);
      return;
    }
    isInitializingScroll.current = true;
    userScrolledUp.current = false;
    setShowScrollToLatest(false);
    
    requestAnimationFrame(() => scrollToBottom('auto'));
   
    const id0 = window.setTimeout(() => { scrollToBottom('auto'); }, 0);
   
    const id1 = window.setTimeout(() => { scrollToBottom('auto'); }, 120);
    const id2 = window.setTimeout(() => {
      scrollToBottom('auto');
      isInitializingScroll.current = false;
    }, 400);
    return () => {
      window.clearTimeout(id0);
      window.clearTimeout(id1);
      window.clearTimeout(id2);
      isInitializingScroll.current = false;
    };
  }, [activeChatId, scrollToBottom]);

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
    setAgentThoughtsByMessageId((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([messageId]) => keepIds.has(messageId))),
    );
  }, []);

  const deriveChatTitle = useCallback((messages: Message[], fallbackTitle: string) => {
    const firstUserMessage = messages.find((message) => message.role === 'user');
    const text = firstUserMessage ? getMessageText(firstUserMessage).trim() : '';
    return text ? text.slice(0, 40) : fallbackTitle;
  }, []);

  const formatCharCount = useCallback((value: number) => {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
    return `${Math.round(value)}`;
  }, []);

  const estimateContextPressure = useCallback((messages: Message[], pendingText: string, pendingImageCount: number) => {
    const historyChars = messages
      .filter((m) => !m.excludedFromContext)
      .reduce((sum, message) => sum + getMessageText(message).length + 48, 0);
    const pendingChars = Math.max(0, pendingText.length) + Math.max(0, pendingImageCount) * 8_000 + 512;
    const workspaceChars = Math.max(0, workspaceContextUsedChars || 0);
    const budgetChars = Math.max(10_000, contextBudgetChars || 200_000);
    const usedChars = historyChars + workspaceChars + pendingChars;
    const ratio = budgetChars > 0 ? usedChars / budgetChars : 0;
    return {
      historyChars,
      workspaceChars,
      pendingChars,
      usedChars,
      budgetChars,
      ratio,
      shouldPrompt: ratio >= CONTEXT_WARNING_RATIO,
    };
  }, [contextBudgetChars, workspaceContextUsedChars]);

  const estimateContextPressureForApi = useCallback((apiMessages: LLMMessage[]) => {
    // Rough (but consistent) approximation: chars ~ tokens*4.
    // Intentionally over-count slightly with per-message overhead.
    const usedChars = apiMessages.reduce((sum, message) => {
      const content = typeof message.content === 'string'
        ? message.content
        : message.content
            .map((p) => (p.type === 'text' ? p.text : '[image]'))
            .join(' ');
      return sum + content.length + 48;
    }, 0);
    const budgetChars = Math.max(10_000, contextBudgetChars || 200_000);
    const ratio = budgetChars > 0 ? usedChars / budgetChars : 0;
    return {
      usedChars,
      budgetChars,
      ratio,
      shouldPrompt: ratio >= CONTEXT_WARNING_RATIO,
    };
  }, [contextBudgetChars]);

  const isContextLengthError = useCallback((msg: string) => {
    const t = msg.toLowerCase();
    return (
      t.includes('context length') ||
      t.includes('maximum context') ||
      t.includes('max context') ||
      t.includes('prompt is too long') ||
      t.includes('too many tokens') ||
      t.includes('token limit') ||
      t.includes('context window')
    );
  }, []);

  const getSummarizeTranscriptBudget = useCallback(() => {
    const budget = Math.max(10_000, contextBudgetChars || 200_000);
    // Leave room for system prompt + instructions + completion.
    return Math.max(8_000, Math.min(90_000, Math.floor(budget * 0.55)));
  }, [contextBudgetChars]);

  const normalizeSummaryEntity = useCallback((value: string) => {
    return value
      .toLowerCase()
      .replace(/[`"']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }, []);

  const uniqueSummaryEntities = useCallback((values: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of values) {
      const value = raw.trim();
      if (!value) continue;
      const key = normalizeSummaryEntity(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }, [normalizeSummaryEntity]);

  const findLatestAutoSummaryBody = useCallback((messages: Message[]): string | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant' || typeof message.content !== 'string') continue;
      const body = extractAutoSummaryBodyForSummary(message.content);
      if (body) return body;
    }
    return null;
  }, []);

  const extractSummaryEntities = useCallback((text: string) => {
    const inlineCode = Array.from(text.matchAll(/`([^`]+)`/g)).map((match) => (match[1] ?? '').trim());

    const fileLikeFromCode = inlineCode.filter((token) => {
      if (!token || token.startsWith('http://') || token.startsWith('https://')) return false;
      return token.includes('/') || /\.[A-Za-z0-9]+$/.test(token);
    });

    const fileLikeFromText = Array.from(
      text.matchAll(
        /(?:^|[\s(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9]+)?|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|py|java|go|rs|c|cpp|h|hpp|sql|css|scss|html|sh|ps1|bat|toml|env))/g,
      ),
    ).map((match) => (match[1] ?? '').trim());

    const apiEndpoints = Array.from(
      text.matchAll(/(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/[A-Za-z0-9._~\-/:?#[\]@!$&'()*+,;=%]{2,})/g),
    ).map((match) => (match[1] ?? match[0] ?? '').trim());

    const apiSymbols = Array.from(text.matchAll(/\b[a-z][A-Za-z0-9_]*(?:\.[a-zA-Z0-9_]+)*\s*\(/g)).map((match) => {
      const token = (match[0] ?? '').trim();
      return token.endsWith('(') ? token.slice(0, -1).trim() : token;
    });

    const constraintPattern = /\b(must|should|do not|don't|cannot|can't|only|required|constraint|limit|maximum|min(?:imum)?|offline|browser|firefox|chrome|edge)\b/i;
    const causePattern = /\b(root cause|caused by|because|due to|issue|bug|failure|regression|glitch)\b/i;

    const sentenceCandidates = text
      .split(/\n+|[.!?]\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    return {
      files: uniqueSummaryEntities([...fileLikeFromCode, ...fileLikeFromText]),
      apis: uniqueSummaryEntities([...apiEndpoints, ...apiSymbols]),
      constraints: uniqueSummaryEntities(sentenceCandidates.filter((entry) => constraintPattern.test(entry))),
      bugCauses: uniqueSummaryEntities(sentenceCandidates.filter((entry) => causePattern.test(entry))),
    };
  }, [uniqueSummaryEntities]);

  const mergeSummaryWithEntityRetention = useCallback((oldSummary: string | null, newSummary: string) => {
    if (!oldSummary || !oldSummary.trim()) {
      return { mergedSummary: newSummary, retainedCount: 0 };
    }

    const oldEntities = extractSummaryEntities(oldSummary);
    const newEntities = extractSummaryEntities(newSummary);
    const normalizedNewSummary = normalizeSummaryEntity(newSummary);

    const appearsAsWholeToken = (haystack: string, needle: string) => {
      if (!needle) return false;
      if (needle.includes(' ')) {
        return haystack.includes(needle);
      }
      // Compare on whitespace token boundaries to reduce false positives like `/users` vs `/user`.
      const tokens = haystack.split(/\s+/).filter(Boolean);
      return tokens.includes(needle);
    };

    const findMissing = (older: string[], newer: string[]) => {
      const newerSet = new Set(newer.map((value) => normalizeSummaryEntity(value)).filter(Boolean));
      return older.filter((entry) => {
        const normalized = normalizeSummaryEntity(entry);
        if (!normalized) return false;
        if (newerSet.has(normalized)) return false;
        return !appearsAsWholeToken(normalizedNewSummary, normalized);
      });
    };

    const missing = {
      files: findMissing(oldEntities.files, newEntities.files),
      apis: findMissing(oldEntities.apis, newEntities.apis),
      constraints: findMissing(oldEntities.constraints, newEntities.constraints),
      bugCauses: findMissing(oldEntities.bugCauses, newEntities.bugCauses),
    };

    const retainedCount =
      missing.files.length +
      missing.apis.length +
      missing.constraints.length +
      missing.bugCauses.length;

    if (retainedCount === 0) {
      return { mergedSummary: newSummary, retainedCount: 0 };
    }

    const section = (title: string, values: string[]) => {
      if (values.length === 0) return null;
      const bullets = values.slice(0, 8).map((value) => `- ${value}`).join('\n');
      return `${title}:\n${bullets}`;
    };

    const retainedSections = [
      section('Files', missing.files),
      section('APIs', missing.apis),
      section('Constraints', missing.constraints),
      section('Bug causes', missing.bugCauses),
    ].filter((entry): entry is string => Boolean(entry));

    const retainedBlock = `Retained from previous summary (diff check):\n${retainedSections.join('\n\n')}`;
    return {
      mergedSummary: `${newSummary}\n\n${retainedBlock}`,
      retainedCount,
    };
  }, [extractSummaryEntities, normalizeSummaryEntity]);

  const buildContextMessages = useCallback(async (messageMentionedFiles: string[] = []): Promise<{ role: 'user'; content: string }[]> => {
    if (workspaceRoots.length === 0) {
     
      const _histChars1 = useAppStore.getState().historyContextUsedChars;
      useAppStore.getState().setContextUsage(0, Math.max(10_000, contextBudgetChars || 200_000), _histChars1);
      return [];
    }

    const included = new Set<string>();
    const parts: string[] = [];
    const stats = { attachedFiles: 0, attachedFolders: 0, staleRefs: 0, truncatedFiles: 0, omittedFiles: 0 };

    const MAX_TOTAL_CONTEXT_CHARS = Math.max(10_000, contextBudgetChars || 200_000);
   
    const WORKSPACE_CONTEXT_LIMIT = Math.min(
      MAX_TOTAL_CONTEXT_CHARS,
      Math.max(24_000, Math.floor(MAX_TOTAL_CONTEXT_CHARS * 0.6)),
    );
    const MAX_TREE_CHARS = Math.min(16_000, Math.floor(WORKSPACE_CONTEXT_LIMIT * 0.4));
    const MAX_FILE_CHARS_AUTO = 2_000;
    const MAX_FILE_CHARS_EXPLICIT = 60_000;
   
    const MAX_FILE_CHARS_FOLDER = 20_000;
    const MAX_FOLDER_FILES_SCAN = 300;
    const MAX_FOLDER_LISTING_ENTRIES = 400;

    const truncate = (content: string, maxChars: number) => ({
      text: content.length > maxChars ? `${content.slice(0, maxChars)}\n\n... [truncated]` : content,
      truncated: content.length > maxChars,
    });

    const totalChars = () => parts.reduce((sum, part) => sum + part.length, 0);
    const canAdd = (nextPart: string) => totalChars() + nextPart.length <= WORKSPACE_CONTEXT_LIMIT;

    const rules = serverContextRules ?? DEFAULT_CONTEXT_RULES;
    const isContextFilePath = (p: string) => isAllowedContextPath(p, rules);

    
    const addFileContext = async (path: string, heading: string, maxChars: number, required = false, explicit = false) => {
      if (included.has(path)) return true;
      if (!explicit && isWorkspacePathIgnored(path)) {
        stats.omittedFiles += 1;
        return false;
      }

      if (!explicit && !isContextFilePath(path)) {
      
        const block = `### ${heading}: ${path}\n(Skipped: non-code file)`;
        if (canAdd(block)) {
          parts.push(block);
        } else {
          stats.omittedFiles += 1;
        }
        return false;
      }

      included.add(path);
      try {
        const content = await readWorkspaceFile(workspaceRoots, path);
        const truncated = truncate(content, maxChars);
        if (truncated.truncated) stats.truncatedFiles += 1;
        const block = `### ${heading}: ${path}\n\`\`\`\n${truncated.text}\n\`\`\``;
        if (!canAdd(block)) {
          stats.omittedFiles += 1;
          return false;
        }
        parts.push(block);
        if (required) stats.attachedFiles += 1;
        return true;
      } catch {
        const block = `### ${heading}: ${path}\n(Could not read file)`;
        if (!canAdd(block)) {
          stats.omittedFiles += 1;
          return false;
        }
        parts.push(block);
        return false;
      }
    };

    const addFolderContext = async (path: string) => {
      if (isWorkspacePathIgnored(path)) {
        stats.omittedFiles += 1;
        return;
      }
      const node = findMentionNode(fileTree, path);
      if (!node || node.type !== 'directory') {
        stats.staleRefs += 1;
        return;
      }

      stats.attachedFolders += 1;

     
      const listing = summarizeDirectory(node, MAX_FOLDER_LISTING_ENTRIES)
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('file ')) return true;
          const p = trimmed.slice('file '.length).trim();
          return isContextFilePath(p);
        })
        .join('\n');
      const listingBlock = `### Folder: ${path}\n\`\`\`\n${listing || '(empty)'}\n\`\`\``;
      if (canAdd(listingBlock)) {
        parts.push(listingBlock);
      }

      
      const folderFiles = collectDirectoryFilePaths(node, MAX_FOLDER_FILES_SCAN).filter(isContextFilePath);
      let inlined = 0;
      for (const filePath of folderFiles) {
        const ok = await addFileContext(filePath, `File from folder ${path}`, MAX_FILE_CHARS_FOLDER);
        if (ok) {
          inlined += 1;
        } else if (totalChars() >= WORKSPACE_CONTEXT_LIMIT) {
          break; // budget exhausted (large folder) — rely on the listing + on-demand reads
        }
      }
      const remaining = folderFiles.length - inlined;
      if (remaining > 0 && totalChars() >= WORKSPACE_CONTEXT_LIMIT) {
        parts.push(
          `(Folder "${path}" is large: inlined ${inlined} file(s) in full; ${remaining}+ more are listed above. Read any of them with *** Read File: path.)`,
        );
      }
    };

    const mentionedRefs = [...new Set(messageMentionedFiles)];
    for (const path of mentionedRefs) {
      const node = findMentionNode(fileTree, path);
      if (!node) {
       
        let dirListing: string[] | null = null;
        try {
          dirListing = await listWorkspaceDirectoryContents(workspaceRoots, path);
        } catch {
          dirListing = null;
        }
        if (dirListing) {
          const listing = dirListing
            .filter((name) => name.endsWith('/') || isContextFilePath(`${path}/${name}`))
            .join('\n');
          const block = `### @ folder: ${path}\n\`\`\`\n${listing || '(empty)'}\n\`\`\``;
          if (canAdd(block)) {
            parts.push(block);
            stats.attachedFolders += 1;
          } else {
            stats.staleRefs += 1;
          }
        } else {
          const readFromPath = await addFileContext(path, '@ file (not in current tree)', MAX_FILE_CHARS_EXPLICIT, true, true);
          if (!readFromPath) stats.staleRefs += 1;
        }
        continue;
      }
      if (node.type === 'directory') {
        await addFolderContext(path);
      } else {
        await addFileContext(path, '@ file', MAX_FILE_CHARS_EXPLICIT, true, true);
      }
    }

    const pinnedContextEntries = contextFiles.filter((path) => !mentionedRefs.includes(path));
    for (const path of pinnedContextEntries) {
    
      const node = findMentionNode(fileTree, path);
      if (node?.type === 'directory') {
        await addFolderContext(path);
      } else {
        await addFileContext(path, 'Pinned context file', MAX_FILE_CHARS_EXPLICIT, true, true);
      }
    }

    const hasExplicitContext = mentionedRefs.length > 0 || pinnedContextEntries.length > 0;
    if (!hasExplicitContext) {
      const treeStr = fileTree.length
        ? serializeFileTree(fileTree, {
            fileFilter: (n) => isContextFilePath(n.path),
            maxChars: MAX_TREE_CHARS,
          })
        : '';
      if (treeStr) {
        const tree = truncate(treeStr, MAX_TREE_CHARS);
        const block = `## Project structure (file paths)\n\`\`\`\n${tree.text}\n\`\`\``;
        if (canAdd(block)) {
          parts.push(block);
        }
      }
    }

    const keyProjectPaths = workspaceRoots.flatMap((root) =>
      KEY_PROJECT_FILES.map((rel) => buildWorkspacePath(root.label, rel)),
    );
    for (const path of keyProjectPaths) {
      await addFileContext(path, 'Key file', MAX_FILE_CHARS_AUTO);
    }

    for (const path of patchedPathsRef.current) {
      await addFileContext(path, 'Recently edited in this chat', MAX_FILE_CHARS_AUTO);
    }

    if (stats.omittedFiles > 0) {
      parts.push(`(Omitted ${stats.omittedFiles} file(s) from context due to size limits. Add fewer files or mention specific paths/sections.)`);
    }

    if (stats.truncatedFiles > 0) {
      parts.push('(One or more referenced files were truncated. If exact missing lines are needed, use *** Read File: path#Lstart-Lend. Do not ask the user to paste the file.)');
    }

    if (parts.length === 0) {
      const _histChars2 = useAppStore.getState().historyContextUsedChars;
      useAppStore.getState().setContextUsage(0, MAX_TOTAL_CONTEXT_CHARS, _histChars2);
      return [];
    }
    const summary = `Context summary: ${stats.attachedFiles} @ file(s), ${stats.attachedFolders} @ folder(s), ${stats.truncatedFiles} truncated file(s), ${stats.staleRefs} stale reference(s). Use the provided file contents and workspace tools; do not ask the user to provide these files again.`;
    const content = `Workspace context (use paths below as ground truth; do not invent paths that are not listed):\n${summary}\n\n${parts.join('\n\n')}`;
    const _histChars3 = useAppStore.getState().historyContextUsedChars;
    useAppStore.getState().setContextUsage(content.length, MAX_TOTAL_CONTEXT_CHARS, _histChars3);
    return [{ role: 'user' as const, content }];
  }, [workspaceRoots, fileTree, contextFiles, contextBudgetChars, serverContextRules]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart ?? value.length;
    setInput(value);

    const textBeforeCursor = value.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/(^|\s)@([^@\n]*)$/);

    if (mentionMatch) {
      const prefix = mentionMatch[1] ?? '';
      setShowMention(true);
      setMentionQuery(mentionMatch[2] ?? '');
      setMentionStartIdx(textBeforeCursor.length - (mentionMatch[2]?.length ?? 0) - 1);
      if (prefix && !/\s/.test(prefix)) setMentionStartIdx(-1);
      return;
    }

    setShowMention(false);
    setMentionQuery('');
    setMentionStartIdx(-1);
  }, []);

  const handleMentionSelect = useCallback((entry: MentionEntry) => {
    setMentionedFiles(prev => prev.includes(entry.path) ? prev : [...prev, entry.path]);

    // Also pin the reference into the persistent context list so it shows in the right-pane
    // "Injected Files" panel and stays available on later turns (works for files and folders).
    if (!useAppStore.getState().contextFiles.includes(entry.path)) {
      useAppStore.getState().toggleContextFile(entry.path);
    }

    if (mentionStartIdx >= 0) {
      const before = input.slice(0, mentionStartIdx);
      const cursorPos = textareaRef.current?.selectionStart ?? input.length;
      const after = input.slice(cursorPos);
      const nextValue = `${before}${after}`;
      setInput(nextValue);
    }

    setShowMention(false);
    setMentionQuery('');
    setMentionStartIdx(-1);

    setTimeout(() => textareaRef.current?.focus(), 0);
    toast.success(`Added @${entry.name}${entry.type === 'directory' ? '/' : ''} to context`);
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

    const { filePath, operation = 'update' } = patch;

   
    let normalizedPath: string;
    try {
      normalizedPath = resolveWorkspacePath(roots, filePath).workspacePath;
    } catch {
      normalizedPath = filePath;
    }

    if (operation === 'delete') {
      await deleteWorkspacePath(roots, filePath);
      useAppStore.getState().removeWorkspacePathReferences(normalizedPath);
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
    useAppStore.getState().syncEditorFileContent(normalizedPath, result);
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
          
          let normalizedPath = p.filePath;
          try {
            const roots = useAppStore.getState().workspaceRoots;
            normalizedPath = resolveWorkspacePath(roots, p.filePath).workspacePath;
          } catch {
            normalizedPath = p.filePath;
          }
          appliedPaths.push(normalizedPath);
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

        const actions: AgentAction[] = appliedPaths.map((normalizedPath) => {
          const patch = patches.find((p) => {
            let np = p.filePath;
            try { np = resolveWorkspacePath(useAppStore.getState().workspaceRoots, p.filePath).workspacePath; } catch {}
            return np === normalizedPath;
          });
          const type = patch?.operation === 'create' ? 'write' : patch?.operation === 'delete' ? 'delete' : 'write';
          return { type, path: normalizedPath, success: true };
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
          let normalizedPath = p.filePath;
          try {
            const roots = useAppStore.getState().workspaceRoots;
            normalizedPath = resolveWorkspacePath(roots, p.filePath).workspacePath;
          } catch {
            normalizedPath = p.filePath;
          }
          appliedPaths.push(normalizedPath);
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
  }): Promise<boolean> => {
    if (getChatPersistenceMode() === 'server') {
      await useAppStore.getState().refreshServerSystemPrompts();
      await useAppStore.getState().refreshServerContextRules();
      await useAppStore.getState().refreshServerChatLimits();
    }
    const isAgentMode = chatMode === 'agent';
    const sp = useAppStore.getState().serverSystemPrompts;
    const systemPrompt = isAgentMode
      ? (sp?.agent ?? AGENT_SYSTEM_PROMPT)
      : (sp?.chat ?? CHAT_SYSTEM_PROMPT);
    const turnContextPaths = mentionedFilePaths.length > 0
      ? mentionedFilePaths
      : getLastUserContextRefPaths(baseMessages);
    const shouldIncludeWorkspaceContext =
      workspaceRoots.length > 0 && (isAgentMode || turnContextPaths.length > 0 || contextFiles.length > 0);
    const contextMsgs = shouldIncludeWorkspaceContext ? await buildContextMessages(turnContextPaths) : [];

    let needsContextAction = false;


    const toApi = (message: Message): LLMMessage => {
      const selection = message.selectionRef?.text?.trim();
      if (!selection || message.role !== 'user') {
        return { role: message.role, content: message.content };
      }

      const header = `Selected text:\n"""\n${selection}\n"""\n\n`;

      if (typeof message.content === 'string') {
        return {
          role: 'user',
          content: header + (message.content ? `Question:\n${message.content}` : 'Question: (none)'),
        };
      }

      const parts = message.content;
      const nextParts: ContentPart[] = [];
      let injected = false;
      for (const part of parts) {
        if (!injected && part.type === 'text') {
          nextParts.push({
            type: 'text',
            text: header + (part.text ? `Question:\n${part.text}` : 'Question: (none)'),
          });
          injected = true;
          continue;
        }
        nextParts.push(part);
      }

      if (!injected) {
        nextParts.unshift({ type: 'text', text: header + 'Question: (none)' });
      }

      return { role: 'user', content: nextParts };
    };

    const messageChars = (m: LLMMessage) => {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content
            .map((p) => (p.type === 'text' ? p.text : '[image]'))
            .join(' ');
      return content.length + 48;
    };

    
    const baseMessagesForContext = baseMessages.filter((m) => !m.excludedFromContext);

    const candidateMessages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...contextMsgs,
      ...baseMessagesForContext.map(toApi),
      { role: 'assistant', content: '' },
    ];
    const apiPressure = estimateContextPressureForApi(candidateMessages);
    if (apiPressure.shouldPrompt) {
      const systemChars = messageChars({ role: 'system', content: systemPrompt });
      const workspaceChars = contextMsgs.reduce((sum, m) => sum + messageChars(m), 0);
      const baseChars = baseMessagesForContext.map(toApi).reduce((sum, m) => sum + messageChars(m), 0);
      const assistantStubChars = messageChars({ role: 'assistant', content: '' });
      const historyChars = systemChars + baseChars + assistantStubChars;
      setContextPressure((prev) => {
        if (prev) {
          return {
            ...prev,
            usedChars: apiPressure.usedChars,
            budgetChars: apiPressure.budgetChars,
            historyChars,
            workspaceChars,
            pendingChars: 0,
            ratio: apiPressure.ratio,
          };
        }
        return {
          usedChars: apiPressure.usedChars,
          budgetChars: apiPressure.budgetChars,
          historyChars,
          workspaceChars,
          pendingChars: 0,
          ratio: apiPressure.ratio,
        };
      });
      setShowContextActionsDialog(true);
      needsContextAction = true;
      return false;
    }

    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    addMessage(chatId, assistantMsg);

    setIsStreaming(true, chatId);
    abortReasonRef.current = null;
    abortRef.current = new AbortController();

    const maxIter = isAgentMode
      ? (settings.agentLoop === false ? 1 : Math.min(10, Math.max(1, settings.agentMaxIterations ?? 5)))
      : 1;

    useAppStore.getState().setAgentStepProgress(0, isAgentMode ? maxIter : 0);

    const chatForContext = useAppStore.getState().chats.find((c) => c.id === chatId) ?? null;
    const requestContext = {
      chatId,
      orgId: chatForContext?.groupId ?? null,
      orgName: chatForContext?.groupName ?? null,
    };

    let loopMessages: LLMMessage[] = candidateMessages;

   
    let streamedContent = '';
    let lastCompleteStreamedContent = '';
    const allActions: AgentAction[] = [];
    const allThoughts: string[] = [];
    // Each tool-using iteration overwrites the visible assistant message; remember the
    // superseded outputs so the UI can still show every earlier attempt.
    const priorAttempts: Array<{ content: string; createdAt: number }> = [];

    try {

      for (let iter = 1; iter <= maxIter; iter++) {
        if (isAgentMode) {
          useAppStore.getState().setAgentStepProgress(iter, maxIter);
        }
        if (isAgentMode && iter > 1) {
          setAgentGatherStep(iter);
        }

        const startedAt = Date.now();
        let lastTokenAt = startedAt;
        let receivedAnyToken = false;
        const STALL_FIRST_TOKEN_MS = 120_000;
        const STALL_BETWEEN_TOKENS_MS = 45_000;
        const STALL_OVERALL_MS = 6 * 60_000;
        const stallIntervalId = window.setInterval(() => {
          const ctrl = abortRef.current;
          if (!ctrl || ctrl.signal.aborted) return;
          const now = Date.now();
          const age = now - startedAt;
          const silence = now - lastTokenAt;
          const exceeded =
            age > STALL_OVERALL_MS ||
            (!receivedAnyToken && silence > STALL_FIRST_TOKEN_MS) ||
            (receivedAnyToken && silence > STALL_BETWEEN_TOKENS_MS);
          if (!exceeded) return;
          abortReasonRef.current = 'stall';
          try {
            ctrl.abort();
          } catch {
            /* ignore */
          }
        }, 2500);

        try {
          streamedContent = await chatCompletion({
            messages: loopMessages,
            settings,
            useVision: hasVision && iter === 1,
            onToken: (full) => {
              receivedAnyToken = true;
              lastTokenAt = Date.now();
              updateLastAssistantMessage(chatId, full);
            },
            signal: abortRef.current!.signal,
            requestContext,
          });
        } finally {
          window.clearInterval(stallIntervalId);
        }


        lastCompleteStreamedContent = streamedContent;

        if (!isAgentMode) break;
        if (iter >= maxIter) break;

       
        const normalizedContent = normalizeToolMarkerLineBreaks(streamedContent);
        const tools = parseToolCalls(stripChannelTokens(normalizedContent));
        if (!hasAgentTools(tools)) break;

        const strippedForThought = stripToolMarkers(normalizedContent);
        const { thinking: iterThinking } = extractThinkingBlocks(strippedForThought);
        // Keep the Reasoning panel focused on the model's thinking; the full intermediate
        // response body is preserved separately as a "Previous attempt" on the message.
        const intermediateThought = iterThinking.trim();
        if (intermediateThought) allThoughts.push(intermediateThought);

        const roots = useAppStore.getState().workspaceRoots;
        if (roots.length === 0) {
          toast.error('Open a workspace folder to use agent tools');
          break;
        }

        const { textFeedback, actions } = await executeAgentTools(roots, tools, {
          onFileWritten: (path, content) => useAppStore.getState().syncEditorFileContent(path, content),
          onPathDeleted: (path) => useAppStore.getState().removeWorkspacePathReferences(path),
          onPathRenamed: (oldPath, newPath) => useAppStore.getState().renameWorkspacePathReferences(oldPath, newPath),
        });
        allActions.push(...actions);

        const staleWriteFailure = actions.find(
          (action) => !action.success && action.error?.includes(STALE_WORKSPACE_WRITE_RECOVERY_MESSAGE),
        );
        if (staleWriteFailure) {
          toast.error(STALE_WORKSPACE_WRITE_RECOVERY_MESSAGE);
        }

        if (actions.some((action) => action.type === 'edit' || action.type === 'write' || action.type === 'delete' || action.type === 'rename')) {
          addPatchedPaths(
            actions.flatMap((action) => {
              if (!action.success) return [];
              if (action.type === 'edit' || action.type === 'write' || action.type === 'delete') return [action.path];
              if (action.type === 'rename') return [action.path.split(/\s*->\s*/)[1]].filter(Boolean) as string[];
              return [];
            }),
          );
          await refreshFileTree();
        }

        const continueAfterTools = hasGatherTools(tools) || hasMutationTools(tools);
        if (!continueAfterTools) break;

        // This iteration's output is about to be replaced by the next one — preserve it.
        if (streamedContent.trim()) {
          priorAttempts.push({ content: streamedContent, createdAt: Date.now() });
        }

         loopMessages = [
           { role: 'system', content: systemPrompt },
           ...contextMsgs,
           ...baseMessagesForContext.map(toApi),
           { role: 'assistant', content: streamedContent },
           {
             role: 'user',
             content:
              'Tool results (inspect these results, then continue. If changes succeeded, summarize them briefly. If a tool failed, retry with corrected tool calls or explain the blocker. Do not output patch text for changes already applied by tools.):\n\n' +
              textFeedback,
          },
          { role: 'assistant', content: '' },
        ];
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
      if (name === 'AbortError') {
        // On manual stop, keep partial output silently. On stalled streams, auto-retry up to 2 times.
        if (abortReasonRef.current === 'stall') {
          const stallRetries = (runAssistantTurn as any)._stallRetries ?? 0;
          if (stallRetries < 2 && abortRef.current && !abortRef.current.signal.aborted) {
           
            (runAssistantTurn as any)._stallRetries = stallRetries + 1;
            abortRef.current = new AbortController();
            abortReasonRef.current = null;
            updateLastAssistantMessage(chatId, '');
            toast.info(`Connection stalled — retrying (${stallRetries + 1}/2)…`);
            void runAssistantTurn({ chatId, chatMode, baseMessages, hasVision, mentionedFilePaths });
            return !needsContextAction;
          }
          (runAssistantTurn as any)._stallRetries = 0;
          useAppStore.getState().setLMConnected(false);
          const st = useAppStore.getState();
          const chat = st.chats.find((c) => c.id === chatId);
          const last = chat?.messages[chat.messages.length - 1];
          const existing = last && last.role === 'assistant' ? getMessageText(last) : '';
          const suffix = existing.trim().length > 0 ? '\n\n' : '';
          updateLastAssistantMessage(
            chatId,
            `${existing}${suffix}[Generation stopped: connection stalled after 2 retries. Press Regenerate to try again.]`,
          );
          toast.error('Local AI connection stalled');
        }
      } else {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
       
        if (lastCompleteStreamedContent && !isContextLengthError(errorMsg)) {
          updateLastAssistantMessage(chatId, lastCompleteStreamedContent);
        }
        if (isContextLengthError(errorMsg)) {
          // Provider rejected due to context size: prompt user with summarize/clear/new chat actions.
          const p = estimateContextPressureForApi(loopMessages);
          const workspaceChars = loopMessages
            .filter((m) => {
              if (m.role !== 'user') return false;
              if (typeof m.content !== 'string') return false;
              return m.content.startsWith('Workspace context');
            })
            .reduce((sum, m) => sum + messageChars(m), 0);
          setContextPressure({
            usedChars: p.usedChars,
            budgetChars: p.budgetChars,
            historyChars: Math.max(0, p.usedChars - workspaceChars),
            workspaceChars,
            pendingChars: 0,
            ratio: p.ratio,
          });
          setShowContextActionsDialog(true);
          needsContextAction = true;
        }
        updateLastAssistantMessage(chatId, `Error: ${errorMsg}\n\nTips:\n- Check your local AI server is running\n- Verify the base URL in settings\n- Enable CORS in your AI server\n- Try a different model`);
        toast.error('Local AI request failed');
      }
    } finally {
      
      if (allActions.length > 0) {
        setAgentActionsByMessageId((prev) => ({
          ...prev,
          [assistantMsg.id]: [...(prev[assistantMsg.id] ?? []), ...allActions],
        }));
      }
      if (allThoughts.length > 0) {
        setAgentThoughtsByMessageId((prev) => ({
          ...prev,
          [assistantMsg.id]: [...(prev[assistantMsg.id] ?? []), ...allThoughts],
        }));
      }
      // Attach the superseded iteration outputs to the message so earlier attempts stay visible.
      if (priorAttempts.length > 0) {
        const store = useAppStore.getState();
        const chat = store.chats.find((c) => c.id === chatId);
        if (chat) {
          const messages = chat.messages.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, meta: { ...(m.meta ?? {}), attempts: priorAttempts } }
              : m,
          );
          store.updateChatFields(chatId, { messages });
        }
      }
      setAgentGatherStep(null);
      setIsStreaming(false);
      useAppStore.getState().setAgentStepProgress(0, 0);
      abortRef.current = null;
      abortReasonRef.current = null;
    }

    return !needsContextAction;
  }, [addMessage, addPatchedPaths, buildContextMessages, contextFiles.length, estimateContextPressureForApi, isContextLengthError, refreshFileTree, runAgentAutoApply, runDirectEditAutoApply, setIsStreaming, settings, updateLastAssistantMessage, workspaceRoots.length]);

  const handleSubmitMessageEdit = useCallback(async (messageId: string, nextText: string) => {
    const chatId = useAppStore.getState().activeChatId;
    if (!chatId || isStreaming) return;

    const chat = useAppStore.getState().chats.find((entry) => entry.id === chatId);
    if (!chat || !canWriteChat(chat)) return;

    const messageIndex = chat.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;

    const originalMessage = chat.messages[messageIndex];
    if (originalMessage.role !== 'user' || typeof originalMessage.content !== 'string') return;

    if (!nextText.trim() || nextText === originalMessage.content) return;

    saveVersionSnapshot(chat.id, `Before editing message ${messageIndex + 1}`);

    const updatedMessage: Message = {
      ...originalMessage,
      content: nextText,
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
      mentionedFilePaths: getMessageContextRefPaths(updatedMessage),
    });
  }, [deriveChatTitle, isStreaming, runAssistantTurn, saveVersionSnapshot, trimMessageUiState, updateChatFields]);

  const handleRegenerateMessage = useCallback(async (messageId: string) => {
    const chatId = useAppStore.getState().activeChatId;
    if (!chatId) return;
    if (isStreaming) {
      toast.error('Please wait for the current response to finish before regenerating.');
      return;
    }

    const chat = useAppStore.getState().chats.find((entry) => entry.id === chatId);
    if (!chat) return;
    if (!canWriteChat(chat)) {
      toast.error('This conversation is locked and cannot be regenerated.');
      return;
    }

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
      mentionedFilePaths: lastPrompt?.role === 'user' ? getMessageContextRefPaths(lastPrompt) : [],
    });
  }, [deriveChatTitle, isStreaming, runAssistantTurn, saveVersionSnapshot, trimMessageUiState, updateChatFields]);

  const sendCurrentInput = useCallback(async () => {
    // Consume any forced values set by context-action re-send handlers to avoid stale closure.
    const forced = forcedSendRef.current;
    forcedSendRef.current = null;
    const effectiveInput = forced !== null ? forced.input : input;
    const effectiveImages = forced !== null ? forced.images : images;
    const effectiveMentionedFiles = forced !== null ? forced.mentionedFiles : mentionedFiles;
    const effectiveSelectionAttachment = forced !== null ? forced.selectionRef : selectionAttachment;

    if ((!effectiveInput.trim() && effectiveImages.length === 0 && !effectiveSelectionAttachment) || isStreaming) return;
    const state = useAppStore.getState();
    const currentActiveChat = state.activeChatId
      ? state.chats.find((chat) => chat.id === state.activeChatId) ?? null
      : null;
    if (currentActiveChat && !canWriteChat(currentActiveChat)) {
      toast.error('This conversation is locked. Start a new chat to continue.');
      return;
    }

    const currentMode = currentActiveChat?.mode ?? 'agent';

    let chatId = state.activeChatId;
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

    const hasVision = effectiveImages.length > 0;
    const rawInput = effectiveInput;
    const selectionRef = effectiveSelectionAttachment;
    const mentionedFilePaths = effectiveMentionedFiles;
    const hasWorkspaceContext = mentionedFilePaths.length > 0 || contextFiles.length > 0;
    const shouldUseAgentForEdit =
      currentMode === 'chat' &&
      workspaceRoots.length > 0 &&
      hasWorkspaceContext &&
      isWorkspaceEditRequest(rawInput);
    const effectiveMode: ChatMode = shouldUseAgentForEdit ? 'agent' : currentMode;

    if (shouldUseAgentForEdit) {
      useAppStore.getState().setChatMode(chatId, 'agent');
      toast.message('Switched to Agent mode so EvigStudio can edit the referenced file.');
    }

    const contextRefs = mentionedFilePaths.map((path) => {
      const node = findMentionNode(fileTree, path);
      return {
        path,
        type: node?.type ?? 'missing',
        label: node?.name ?? path.split('/').pop() ?? path,
      } satisfies NonNullable<Message['contextRefs']>[number];
    });
    let userContent: string | ContentPart[];
    if (hasVision) {
      const parts: ContentPart[] = [];
      if (rawInput.trim()) parts.push({ type: 'text', text: rawInput });
      for (const img of effectiveImages) {
        parts.push({ type: 'image_url', image_url: { url: img } });
      }
      userContent = parts;
    } else {
      userContent = rawInput;
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
      ...(selectionRef ? { selectionRef } : {}),
      ...(contextRefs.length > 0 ? { contextRefs } : {}),
    };

    // Mark this pending input as already appended to history.
    pendingContextActionInputRef.current = {
      input: rawInput,
      images,
      mentionedFiles: mentionedFilePaths,
      selectionRef,
      sentUserMessageId: userMsg.id,
    };

    addMessage(chatId, userMsg);
    userScrolledUp.current = false;
    setInput('');
    setImages([]);
    setMentionedFiles([]);
    setSelectionAttachment(null);

    if (getChatPersistenceMode() === 'server') {
      try {
        await fetch('/api/audit/query', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId,
            chatTitle: useAppStore.getState().chats.find((c) => c.id === chatId)?.title ?? null,
            chatMode: effectiveMode,
            model: settings.textModel,
              preview: getMessageText(userMsg).slice(0, 500),
              promptLength: getMessageText(userMsg).length,
              imageCount: effectiveImages.length,
              mentionedFileCount: mentionedFilePaths.length,
              workspaceFolders: workspaceFolderLabels(workspaceRoots),
              contextFiles: normalizeAuditPaths(contextFiles, 50),
              mentionedFiles: normalizeAuditPaths(mentionedFilePaths, 50),
              workspaceRootSummaries: buildWorkspaceRootSummaries(workspaceRoots, fileTree),
              activeDocument: buildActiveDocumentAudit(useAppStore.getState().activeFilePath),
            }),
          });
      } catch {
        /* optional audit */
      }
    }

    const baseMessages = useAppStore.getState().chats.find((c) => c.id === chatId)?.messages ?? [userMsg];
    const turnOk = await runAssistantTurn({
      chatId,
      chatMode: effectiveMode,
      baseMessages,
      hasVision,
      mentionedFilePaths,
    });

    // If the turn completed without requiring context actions, discard the pending re-send.
    if (turnOk) {
      pendingContextActionInputRef.current = null;
    }
  }, [
    input,
    images,
    mentionedFiles,
    selectionAttachment,
    activeChat,
    activeChatId,
    contextFiles,
    fileTree,
    isStreaming,
    workspaceRoots,
    settings,
    createChat,
    addMessage,
    runAssistantTurn,
  ]);

  const summarizeActiveChat = useCallback(async (opts?: { pinContext?: boolean }): Promise<boolean> => {
    const state = useAppStore.getState();
    const chatId = state.activeChatId;
    if (!chatId) return false;

    // Avoid compacting while a generation is in-flight.
    if (state.isStreaming) {
      toast.error('Please wait for the current generation to finish before summarizing.');
      return false;
    }

    const chat = state.chats.find((entry) => entry.id === chatId);
    if (!chat || !canWriteChat(chat)) return false;
    const previousSummary = findLatestAutoSummaryBody(chat.messages);

    // Guard first — before any side effects — so contextFiles aren't mutated when there's nothing to summarize.
    const transcript = buildCondenseTranscriptForSummary(chat.messages, getSummarizeTranscriptBudget());
    if (!transcript) {
      toast.error('No conversation to summarize yet. Send a few messages first.');
      return false;
    }

    const pinContext = opts?.pinContext ?? false;

    // If requested, keep the currently referenced files available after condensing.
    if (pinContext) {
      const refs = collectChatContextRefPathsForSummary(chat.messages);
      if (refs.length > 0) {
        const st = useAppStore.getState();
        const nextPinned = [...new Set([...(st.contextFiles ?? []), ...refs])];
        useAppStore.setState({ contextFiles: nextPinned });
      }
    }

    // Compaction policy: keep the full transcript in the UI, but exclude older messages from future model context.
    // Keep at least a small tail of recent turns unsummarized.
    const KEEP_TAIL_MESSAGES = 16;
    const notExcludedIdxs = chat.messages
      .map((m, idx) => ({ m, idx }))
      .filter(({ m }) => !m.excludedFromContext)
      .map(({ idx }) => idx);
    const cutoffIdx =
      notExcludedIdxs.length > KEEP_TAIL_MESSAGES
        ? notExcludedIdxs[notExcludedIdxs.length - KEEP_TAIL_MESSAGES]
        : null;
    const toExclude = cutoffIdx == null ? [] : chat.messages.filter((_, idx) => idx < cutoffIdx && !chat.messages[idx].excludedFromContext);
    // Track which messages to compact by id, not index: the chat may change during the
    // (potentially slow) summary request, and ids stay stable while indices do not.
    const toExcludeIds = new Set(toExclude.map((m) => m.id));
    const compactedMessageCount = toExclude.length;
    const compactedCharCount = toExclude.reduce((sum, m) => sum + getMessageText(m).length + 48, 0);
    const previousCompactionCount = chat.messages.filter((m) => m.meta?.kind === 'auto_summary').length;
    const compactionDepth = previousCompactionCount + 1;

    setIsCondensingChat(true);
    const abortController = new AbortController();
    const timeoutId = window.setTimeout(() => abortController.abort(), SUMMARY_TIMEOUT_MS);
    try {
      const summary = (await chatCompletion({
        messages: [
          {
            role: 'system',
            content:
              'You are a conversation condenser. Create a compact continuity summary of the provided chat. Include goals, decisions, constraints, pending tasks, and important file paths or entities. Keep it concise and actionable.',
          },
          {
            role: 'user',
            content:
              `Summarize the conversation below for future context carry-over. Use markdown formatting: ## headings, **bold** for key terms, and - bullet lists.\n\nConversation:\n${transcript}`,
          },
        ],
        settings: {
          ...settings,
          stream: false,
          temperature: SUMMARY_TEMP,
          maxTokens: Math.min(SUMMARY_MAX_TOKENS, Math.max(256, Math.floor(settings.maxTokens / 2))),
        },
        useVision: false,
        signal: abortController.signal,
        requestContext: {
          chatId,
          orgId: chat.groupId ?? null,
          orgName: chat.groupName ?? null,
        },
      })).trim();

      if (!summary) {
        toast.error('The AI returned an empty summary. Check your model settings and try again.');
        return false;
      }

      // Re-read the chat from the store: it may have gained messages (or been edited) while
      // the summary was generating. Building from a stale snapshot here would silently drop
      // anything added in the meantime.
      const freshChat = useAppStore.getState().chats.find((entry) => entry.id === chatId);
      if (!freshChat || !canWriteChat(freshChat)) {
        toast.error('The conversation is no longer available to summarize.');
        return false;
      }

      const { mergedSummary, retainedCount } = mergeSummaryWithEntityRetention(previousSummary, summary);

      saveVersionSnapshot(chatId, 'Before auto-summary condense');

      const summaryMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `${AUTO_SUMMARY_HEADER}\n\n${mergedSummary}\n\n${AUTO_SUMMARY_FOOTER}`,
        timestamp: Date.now(),
        meta: {
          kind: 'auto_summary',
          compactedMessageCount,
          compactedCharCount,
          compactionDepth,
        },
      };

      // Mark older messages as excluded from future model context, but keep them visible in the UI.
      // Match by id so messages appended during the request stay live and uncompacted.
      const nextMessages = freshChat.messages.map((m) => {
        if (toExcludeIds.has(m.id)) {
          return { ...m, excludedFromContext: true };
        }
        // Exclude previous auto-summaries from context so only the latest summary is used.
        if (m.meta?.kind === 'auto_summary') {
          return { ...m, excludedFromContext: true };
        }
        return m;
      });


      nextMessages.push(summaryMessage);

      trimMessageUiState(nextMessages);
      updateChatFields(chatId, { messages: nextMessages });

      useAppStore.getState().resetContextUsageMeter();
      userScrolledUp.current = false;
      setShowScrollToLatest(false);
      toast.success(
        retainedCount > 0
          ? `Conversation summarized. Retained ${retainedCount} key item(s) from previous summary.`
          : 'Conversation summarized. You can continue chatting.',
      );
      return true;
    } catch (err) {
      console.error('[EvigStudio] summarize conversation failed', err);
      const errName = (err as { name?: string } | null)?.name;
      const aborted = errName === 'AbortError' || errName === 'TimeoutError';
      if (aborted) {
        toast.error('Summarization timed out. The AI server did not respond — check it is running and try again.');
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        toast.error(`Summarization failed: ${errMsg}. Check your AI server is running and try again.`);
      }
      return false;
    } finally {
      window.clearTimeout(timeoutId);
      setIsCondensingChat(false);
    }
  }, [
    findLatestAutoSummaryBody,
    getSummarizeTranscriptBudget,
    mergeSummaryWithEntityRetention,
    saveVersionSnapshot,
    settings,
    trimMessageUiState,
    updateChatFields,
  ]);

  const clearActiveChat = useCallback((): boolean => {
    const state = useAppStore.getState();
    const chatId = state.activeChatId;
    if (!chatId) return false;

    const chat = state.chats.find((entry) => entry.id === chatId);
    if (!chat || !canWriteChat(chat)) return false;

    saveVersionSnapshot(chat.id, 'Before clearing conversation');
    trimMessageUiState([]);
    updateChatFields(chat.id, {
      messages: [],
      title: 'New Chat',
    });
   
    useAppStore.getState().resetContextUsageMeter();
    userScrolledUp.current = false;
    setShowScrollToLatest(false);
    toast.success('Chat cleared. Start a fresh conversation.');
    return true;
  }, [saveVersionSnapshot, trimMessageUiState, updateChatFields]);

  const handleContextActionSummarize = useCallback(async () => {
    setShowContextActionsDialog(false);
    setSummarizePinContext(true);
    setShowSummarizeDialog(true);
  }, []);

  const handleConfirmSummarize = useCallback(async () => {
    // If this prompt was triggered after we already appended the user's message,
    // remove it so the transcript doesn't double-count it.
    if (pendingContextActionInputRef.current?.sentUserMessageId) {
      const st = useAppStore.getState();
      const chatId = st.activeChatId;
      const chat = chatId ? st.chats.find((c) => c.id === chatId) : null;
      if (chat && canWriteChat(chat)) {
        const id = pendingContextActionInputRef.current.sentUserMessageId;
        const idx = chat.messages.findIndex((m) => m.id === id);
        if (idx >= 0 && chat.messages[idx]?.role === 'user') {
          updateChatFields(chat.id, { messages: [...chat.messages.slice(0, idx), ...chat.messages.slice(idx + 1)] });
        }
      }
    }

    const ok = await summarizeActiveChat({ pinContext: summarizePinContext });

    // Always close the summarize dialog — whether it succeeded or failed.
    setShowSummarizeDialog(false);

    if (!ok) {
      // If this was triggered from the context-pressure dialog, send the user back
      // so they can try Clear chat or New chat instead.
      if (pendingContextActionInputRef.current) {
        setShowContextActionsDialog(true);
      }
      return;
    }

    // If this summarize was part of a context-pressure continuation flow, restore and re-send.
    if (pendingContextActionInputRef.current) {
      const pending = pendingContextActionInputRef.current;
      pendingContextActionInputRef.current = null;
      // Set forced values BEFORE calling sendCurrentInput so its stale closure is bypassed.
      forcedSendRef.current = {
        input: pending.input,
        images: pending.images,
        mentionedFiles: pending.mentionedFiles,
        selectionRef: pending.selectionRef,
      };
      setInput(pending.input);
      setImages(pending.images);
      setMentionedFiles(pending.mentionedFiles);
      setSelectionAttachment(pending.selectionRef);
      await sendCurrentInput();
    }
  }, [sendCurrentInput, summarizePinContext, summarizeActiveChat, updateChatFields]);

  const handleContextActionClear = useCallback(async () => {
    const ok = clearActiveChat();
    if (!ok) return;
    setShowContextActionsDialog(false);
    if (pendingContextActionInputRef.current) {
      const pending = pendingContextActionInputRef.current;
      pendingContextActionInputRef.current = null;
      // Set forced values BEFORE calling sendCurrentInput so its stale closure is bypassed.
      forcedSendRef.current = {
        input: pending.input,
        images: pending.images,
        mentionedFiles: pending.mentionedFiles,
        selectionRef: pending.selectionRef,
      };
      setInput(pending.input);
      setImages(pending.images);
      setMentionedFiles(pending.mentionedFiles);
      setSelectionAttachment(pending.selectionRef);
    }
    await sendCurrentInput();
  }, [clearActiveChat, sendCurrentInput]);

  const handleContextActionNewChat = useCallback(async () => {
    try {
      // Preserve the current workspace/context when moving to a fresh chat.
      // This is especially important in the "context almost full" flow, where the user
      // expects the same files/folder to remain available.
      const before = useAppStore.getState();
      const workspaceSnapshot = {
        workspaceRoots: before.workspaceRoots,
        workspaceHandle: before.workspaceHandle,
        fileTree: before.fileTree,
        contextFiles: before.contextFiles,
        openEditorTabs: before.openEditorTabs,
        activeFilePath: before.activeFilePath,
        activeFileContent: before.activeFileContent,
        workspaceContextUsedChars: before.workspaceContextUsedChars,
      };

      const newChatId = await createChat();

      // Re-apply workspace snapshot onto the new chat and persist it.
      useAppStore.setState({
        ...workspaceSnapshot,
        workspaceSessionRevision: before.workspaceSessionRevision + 1,
      });
      await useAppStore.getState().persistWorkspaceSession(newChatId);

      setShowContextActionsDialog(false);
      if (pendingContextActionInputRef.current) {
        const pending = pendingContextActionInputRef.current;
        pendingContextActionInputRef.current = null;
        // Set forced values BEFORE calling sendCurrentInput so its stale closure is bypassed.
        forcedSendRef.current = {
          input: pending.input,
          images: pending.images,
          mentionedFiles: pending.mentionedFiles,
          selectionRef: pending.selectionRef,
        };
        setInput(pending.input);
        setImages(pending.images);
        setMentionedFiles(pending.mentionedFiles);
        setSelectionAttachment(pending.selectionRef);
      }
      await sendCurrentInput();
    } catch (e) {
      console.error('[EvigStudio] createChat for context action', e);
      const msg = e instanceof Error && e.message ? e.message : 'Could not create a new chat.';
      toast.error(msg);
    }
  }, [createChat, sendCurrentInput]);

  const handleSend = useCallback(async () => {
    if ((!input.trim() && images.length === 0 && !selectionAttachment) || isStreaming) return;
    if (isCondensingChat) {
      toast.error('Please wait for the summary to finish before sending a new message.');
      return;
    }

    const state = useAppStore.getState();
    const currentActiveChat = state.activeChatId
      ? state.chats.find((chat) => chat.id === state.activeChatId) ?? null
      : null;

    if (currentActiveChat && !canWriteChat(currentActiveChat)) {
      toast.error('This conversation is locked. Start a new chat to continue.');
      return;
    }

    if (currentActiveChat) {
      const pressure = estimateContextPressure(currentActiveChat.messages, input, images.length);
      if (pressure.shouldPrompt) {
        pendingContextActionInputRef.current = { input, images, mentionedFiles, selectionRef: selectionAttachment };
        setContextPressure({
          usedChars: pressure.usedChars,
          budgetChars: pressure.budgetChars,
          historyChars: pressure.historyChars,
          workspaceChars: pressure.workspaceChars,
          pendingChars: pressure.pendingChars,
          ratio: pressure.ratio,
        });
        setShowContextActionsDialog(true);
        return;
      }
    }

    await sendCurrentInput();
  }, [estimateContextPressure, images, input, isStreaming, isCondensingChat, mentionedFiles, selectionAttachment, sendCurrentInput]);

  const handleStop = () => {
    abortReasonRef.current = 'user';
    abortRef.current?.abort();
  };

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
        {activeChat && (
          <ChatToolbar
            chat={activeChat}
            onSummarize={() => {
              setSummarizePinContext(true);
              setShowSummarizeDialog(true);
            }}
            summarizing={isCondensingChat}
          />
        )}
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

      <Dialog
        open={showContextActionsDialog}
        onOpenChange={(open) => {
          setShowContextActionsDialog(open);
          if (!open) {
            setContextPressure(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Context is almost full</DialogTitle>
            <DialogDescription>
              This chat is nearing the context window. Choose how you want to continue.
            </DialogDescription>
          </DialogHeader>

          {contextPressure && (
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Total usage</span>
                <span className="font-medium text-foreground">
                  {formatCharCount(contextPressure.usedChars)} / {formatCharCount(contextPressure.budgetChars)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span>History</span>
                <span>{formatCharCount(contextPressure.historyChars)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Workspace context</span>
                <span>{formatCharCount(contextPressure.workspaceChars)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Current input</span>
                <span>{formatCharCount(contextPressure.pendingChars)}</span>
              </div>
              <div className="mt-1 text-[11px]">
                Usage: {Math.round(contextPressure.ratio * 100)}%
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                // If this prompt was triggered after we already appended the user's message,
                // treat Cancel as "undo send" and restore the input.
                if (pendingContextActionInputRef.current?.sentUserMessageId) {
                  const st = useAppStore.getState();
                  const chatId = st.activeChatId;
                  const chat = chatId ? st.chats.find((c) => c.id === chatId) : null;
                  if (chat && canWriteChat(chat)) {
                    const last = chat.messages[chat.messages.length - 1];
                    if (last?.role === 'user' && last.id === pendingContextActionInputRef.current.sentUserMessageId) {
                      updateChatFields(chat.id, { messages: chat.messages.slice(0, -1) });
                    }
                  }

                  const pending = pendingContextActionInputRef.current;
                  pendingContextActionInputRef.current = null;
                  setInput(pending.input);
                  setImages(pending.images);
                  setMentionedFiles(pending.mentionedFiles);
                  setSelectionAttachment(pending.selectionRef);
                }

                if (pendingContextActionInputRef.current && !pendingContextActionInputRef.current.sentUserMessageId) {
                  pendingContextActionInputRef.current = null;
                }
                setShowContextActionsDialog(false);
                setContextPressure(null);
              }}
              disabled={isCondensingChat}
            >
              Cancel
            </Button>
            <Button type="button" variant="secondary" onClick={() => void handleContextActionClear()} disabled={isCondensingChat}>
              Clear chat
            </Button>
            <Button type="button" variant="secondary" onClick={() => void handleContextActionNewChat()} disabled={isCondensingChat}>
              New chat
            </Button>
            <Button type="button" onClick={() => void handleContextActionSummarize()} disabled={isCondensingChat}>
              {isCondensingChat ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Summarizing…
                </>
              ) : (
                'Summarize'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showSummarizeDialog}
        onOpenChange={(open) => {
          setShowSummarizeDialog(open);
          if (!open) {
            // Reset to a sane default each time.
            setSummarizePinContext(true);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Summarize conversation</DialogTitle>
            <DialogDescription>
              Condense the chat into a compact continuity summary so you can keep going without hitting the context window.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="flex items-start gap-2">
              <Checkbox
                checked={summarizePinContext}
                onCheckedChange={(v) => setSummarizePinContext(v === true)}
                disabled={isCondensingChat}
              />
              <div className="grid gap-0.5">
                <Label className="text-sm">Keep referenced files in context</Label>
                <p className="text-xs text-muted-foreground">
                  Recommended for coding chats. EvigStudio will add files you referenced in this conversation to “Injected Files”, so the next turn still has the right code context.
                </p>
              </div>
            </label>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowSummarizeDialog(false);
                // If we opened this from the context-pressure flow, send the user back.
                if (pendingContextActionInputRef.current) {
                  setShowContextActionsDialog(true);
                }
              }}
              disabled={isCondensingChat}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleConfirmSummarize()} disabled={isCondensingChat}>
              {isCondensingChat ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Summarizing…
                </>
              ) : (
                'Summarize'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        {selectionPopover && !isLocked && !isStreaming && (
          <div
            className="pointer-events-none fixed z-50"
            style={{ left: selectionPopover.left, top: selectionPopover.top, transform: 'translateX(-50%)' }}
          >
            <div className="pointer-events-auto rounded-md border border-border/70 bg-background/95 px-2 py-1 shadow-sm backdrop-blur">
              <button
                type="button"
                onClick={() => {
                  const cap = 8_000;
                  const capped =
                    selectionPopover.text.length > cap
                      ? selectionPopover.text.slice(0, cap) + '\n\n[Selection truncated]'
                      : selectionPopover.text;
                  setSelectionAttachment({
                    text: capped,
                    sourceMessageId: selectionPopover.sourceMessageId,
                    sourceRole: selectionPopover.sourceRole,
                    sourceTimestamp: selectionPopover.sourceTimestamp,
                  });
                  setSelectionPopover(null);
                  try {
                    window.getSelection?.()?.removeAllRanges();
                  } catch {
                    /* ignore */
                  }
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                className="rounded px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-secondary"
                title="Ask a question about the selected text"
              >
                Ask about this
              </button>
            </div>
          </div>
        )}
        <div ref={scrollContainerRef} className="h-full space-y-4 overflow-y-auto px-3 py-3 sm:px-5">
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
            (() => {
              const compacted = activeChat.messages.filter((m) => m.excludedFromContext);
              const visible = activeChat.messages.filter((m) => !m.excludedFromContext);
              const compactedCount = compacted.length;

              return (
                <>
                  {compactedCount > 0 && (
                    <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">Compacted history</div>
                          <div className="text-[11px] text-muted-foreground">
                            {compactedCount} message{compactedCount === 1 ? '' : 's'} summarized (kept in view, omitted from model context).
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowCompactedHistory((v) => !v)}
                          className="shrink-0 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {showCompactedHistory ? 'Hide' : 'Show'}
                        </button>
                      </div>
                      {showCompactedHistory && (
                        <div className="mt-3 space-y-4">
                          {compacted.map((msg) => (
                            <div
                              key={msg.id}
                              data-evig-message-id={msg.id}
                              data-evig-message-role={msg.role}
                              data-evig-message-timestamp={msg.timestamp}
                              className="opacity-80"
                            >
                              <ChatMessage
                                message={msg}
                                chatMode={chatMode}
                                onApplyPatch={handleApplyPatch}
                                onGetOriginal={handleGetOriginal}
                                autoAppliedPaths={autoAppliedPathsByMessageId[msg.id]}
                                agentActions={agentActionsByMessageId[msg.id]}
                                agentThoughts={agentThoughtsByMessageId[msg.id]}
                                onOpenFile={handleOpenEditorFile}
                                onSubmitEdit={isLocked ? undefined : handleSubmitMessageEdit}
                                onRegenerate={isLocked ? undefined : handleRegenerateMessage}
                                busy={isStreaming}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {visible.map((msg, idx) => {
                   
                    const precedingUser =
                      msg.role === 'assistant'
                        ? [...visible.slice(0, idx)].reverse().find((m) => m.role === 'user')
                        : undefined;
                    const fallbackThinking = precedingUser
                      ? deriveThinkingFromUserPrompt(getMessageText(precedingUser))
                      : undefined;
                    return (
                      <div
                        key={msg.id}
                        data-evig-message-id={msg.id}
                        data-evig-message-role={msg.role}
                        data-evig-message-timestamp={msg.timestamp}
                      >
                        <ChatMessage
                          message={msg}
                          chatMode={chatMode}
                          onApplyPatch={handleApplyPatch}
                          onGetOriginal={handleGetOriginal}
                          autoAppliedPaths={autoAppliedPathsByMessageId[msg.id]}
                          agentActions={agentActionsByMessageId[msg.id]}
                          agentThoughts={agentThoughtsByMessageId[msg.id]}
                          fallbackThinking={fallbackThinking}
                          onOpenFile={handleOpenEditorFile}
                          onSubmitEdit={isLocked ? undefined : handleSubmitMessageEdit}
                          onRegenerate={isLocked ? undefined : handleRegenerateMessage}
                          busy={isStreaming}
                        />
                      </div>
                    );
                  })}
                </>
              );
            })()
          )}
          {isActiveChatStreaming && (
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
          {!isActiveChatStreaming && isCondensingChat && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Summarizing conversation…</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {activeChat && activeChat.messages.length > 0 && (!isAtTop || !isAtBottom) && (
          <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex flex-col gap-2">
            {!isAtTop && (
              <button
                type="button"
                onClick={() => scrollToTop('smooth')}
                className="pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
                title="Go to top"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
            )}
            {!isAtBottom && (
              <button
                type="button"
                onClick={() => scrollToBottom('smooth')}
                className="pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
                title="Go to bottom"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {showScrollToLatest && (
          <div className="pointer-events-none absolute bottom-3 left-0 right-0 z-10 flex justify-center px-3 sm:px-5">
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-primary/35 bg-background/95 px-3 py-1.5 text-xs text-primary shadow-sm backdrop-blur hover:bg-background"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              New content below
            </button>
          </div>
        )}
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
        <div className="space-y-1 border-t border-border px-4 py-2">
          <div className="text-[10px] text-muted-foreground">
            Context ready: {mentionStats.files} file{mentionStats.files === 1 ? '' : 's'}
            {mentionStats.folders > 0 ? `, ${mentionStats.folders} folder${mentionStats.folders === 1 ? '' : 's'} (${mentionStats.folderFiles} files)` : ''}
            {mentionStats.stale > 0 ? `, ${mentionStats.stale} stale reference${mentionStats.stale === 1 ? '' : 's'} will be skipped` : ''}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {mentionedFiles.map(filePath => {
              const node = findMentionNode(fileTree, filePath);
              const isFolder = node?.type === 'directory';
              const label = node?.name ?? filePath.split('/').pop() ?? filePath;
              return (
                <span
                  key={filePath}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] animate-fade-in ${node
                    ? 'border-primary/20 bg-primary/10 text-primary'
                    : 'border-warning/30 bg-warning/10 text-warning'}`}
                  title={node ? filePath : `${filePath} was not found in the current workspace tree`}
                >
                  {isFolder ? <FolderOpen className="w-3 h-3" /> : <FileCode className="w-3 h-3" />}
                  <span className="max-w-[220px] truncate">{label}{isFolder ? '/' : ''}</span>
                  <span className="hidden max-w-[280px] truncate text-[10px] opacity-70 sm:inline">{filePath}</span>
                  <button
                    onClick={() => removeMentionedFile(filePath)}
                    className="ml-0.5 hover:text-destructive transition-colors"
                    title={`Remove ${filePath}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Input area */}
      <div
        data-evig-composer
        className="border-t border-border bg-card/90 p-3 shadow-[0_-8px_32px_hsl(var(--background)/0.45)] backdrop-blur-md sm:p-4"
      >
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
            {selectionAttachment && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Selection
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectionAttachment(null)}
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      title="Remove selection"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    {selectionAttachment.text}
                  </pre>
                </div>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={isLocked || isCondensingChat}
              placeholder={isCondensingChat ? 'Summarizing… please wait' : isAgent ? 'Describe what to build, fix, or change… (@ file)' : 'Ask anything…'}
              rows={2}
              className="min-h-[56px] w-full resize-none rounded-lg border border-border/80 bg-input px-3 py-3 text-base leading-snug outline-none ring-2 ring-transparent transition-shadow placeholder:text-muted-foreground focus:border-primary/40 focus:ring-primary/30 sm:min-h-[48px] sm:py-2.5 sm:text-sm"
            />
          </div>
          {isActiveChatStreaming ? (
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
              disabled={isLocked || isCondensingChat || (!input.trim() && images.length === 0 && mentionedFiles.length === 0 && !selectionAttachment)}
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