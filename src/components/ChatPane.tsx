import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { chatCompletion, type ChatMessage as LLMMessage } from '@/lib/llmClient';
import {
  buildWorkspacePath,
  buildWorkspaceTree,
  deleteWorkspacePath,
  isWorkspacePathIgnored,
  readWorkspaceFile,
  serializeFileTree,
  STALE_WORKSPACE_WRITE_RECOVERY_MESSAGE,
  writeWorkspaceFile,
} from '@/lib/fsWorkspace';
import { DEFAULT_CONTEXT_RULES, isAllowedContextPath } from '@/lib/contextRules';
import {
  parseToolCalls,
  hasAgentTools,
  hasGatherTools,
  hasMutationTools,
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
import { getLastUserContextRefPaths, getMessageContextRefPaths } from '@/lib/chatContext';
import { collectDirectoryFilePaths, findMentionNode, summarizeDirectory, type MentionEntry } from '@/lib/fileMentions';
import { isWorkspaceEditRequest } from '@/lib/workspaceIntent';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  buildActiveDocumentAudit,
  buildWorkspaceRootSummaries,
  normalizeAuditPaths,
  workspaceFolderLabels,
} from '@/lib/auditClient';
import { useSpeechDictation } from '@/hooks/useSpeechDictation';
import { Send, ImagePlus, Loader2, StopCircle, FileCode, X, Mic, Bot, MessageSquare, Lock, FolderOpen, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';

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
const INPUT_MIN_HEIGHT_PX = 56;
const INPUT_MAX_HEIGHT_PX = 220;

export function ChatPane() {
  const {
    chats, activeChatId, createChat, addMessage, updateLastAssistantMessage, updateChatFields, saveVersionSnapshot,
    settings, contextFiles, fileTree, isStreaming, setIsStreaming, workspaceRoots, contextUsedChars, contextBudgetChars,
    serverContextRules,
  } = useAppStore();

  const [autoAppliedPathsByMessageId, setAutoAppliedPathsByMessageId] = useState<Record<string, string[]>>({});
  const [agentActionsByMessageId, setAgentActionsByMessageId] = useState<Record<string, AgentAction[]>>({});
  const patchedPathsRef = useRef<Set<string>>(new Set());
  const [agentGatherStep, setAgentGatherStep] = useState<number | null>(null);
  const [showContextActionsDialog, setShowContextActionsDialog] = useState(false);
  const [isCondensingChat, setIsCondensingChat] = useState(false);
  const pendingContextActionInputRef = useRef<{
    input: string;
    images: string[];
    mentionedFiles: string[];
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

  const activeChat = chats.find(c => c.id === activeChatId);
  const isLocked = activeChat ? !canWriteChat(activeChat) : false;
  const chatMode = activeChat?.mode ?? 'agent';
  const isAgent = chatMode === 'agent';
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

  useEffect(() => {
    if (fileTree.length === 0 || mentionedFiles.length === 0) return;
    setMentionedFiles((prev) => prev.filter((path) => !!findMentionNode(fileTree, path)));
  }, [fileTree, mentionedFiles.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const BOTTOM_THRESHOLD_PX = 96;
    const onScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const scrolledUp = distFromBottom > BOTTOM_THRESHOLD_PX;
      userScrolledUp.current = scrolledUp;
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
    requestAnimationFrame(() => scrollToBottom('auto'));
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
    const historyChars = messages.reduce((sum, message) => sum + getMessageText(message).length + 48, 0);
    const pendingChars = Math.max(0, pendingText.length) + Math.max(0, pendingImageCount) * 8_000 + 512;
    const workspaceChars = Math.max(0, contextUsedChars || 0);
    const budgetChars = Math.max(40_000, contextBudgetChars || 120_000);
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
  }, [contextBudgetChars, contextUsedChars]);

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
    const budgetChars = Math.max(40_000, contextBudgetChars || 120_000);
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

  const buildCondenseTranscript = useCallback((messages: Message[], maxChars = 90_000) => {
    const chunks: string[] = [];
    let used = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user' && message.role !== 'assistant') continue;

      const baseText = getMessageText(message).trim();
      const fallback = hasImages(message) ? '[Image attachment]' : '(empty)';
      const messageText = baseText || fallback;
      const linePrefix = message.role === 'user' ? 'User' : 'Assistant';
      const line = `${linePrefix}: ${messageText}`;

      if (used + line.length <= maxChars) {
        chunks.push(line);
        used += line.length;
        continue;
      }

      const remaining = maxChars - used;
      if (remaining > 24) {
        chunks.push(`${line.slice(0, remaining)}…`);
      }
      break;
    }

    return chunks.reverse().join('\n\n').trim();
  }, []);

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

  const extractAutoSummaryBody = useCallback((content: string): string | null => {
    const markerIndex = content.indexOf(AUTO_SUMMARY_HEADER);
    if (markerIndex < 0) return null;
    let body = content.slice(markerIndex + AUTO_SUMMARY_HEADER.length).trim();
    if (!body) return null;
    if (body.endsWith(AUTO_SUMMARY_FOOTER)) {
      body = body.slice(0, -AUTO_SUMMARY_FOOTER.length).trim();
    }
    return body || null;
  }, []);

  const findLatestAutoSummaryBody = useCallback((messages: Message[]): string | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant' || typeof message.content !== 'string') continue;
      const body = extractAutoSummaryBody(message.content);
      if (body) return body;
    }
    return null;
  }, [extractAutoSummaryBody]);

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
    ).map((match) => (match[0] ?? '').trim());

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

    const findMissing = (older: string[], newer: string[]) => {
      const newerSet = new Set(newer.map((value) => normalizeSummaryEntity(value)).filter(Boolean));
      return older.filter((entry) => {
        const normalized = normalizeSummaryEntity(entry);
        if (!normalized) return false;
        if (newerSet.has(normalized)) return false;
        return !normalizedNewSummary.includes(normalized);
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
      useAppStore.getState().setContextUsage(0, Math.max(40_000, contextBudgetChars || 120_000));
      return [];
    }

    const included = new Set<string>();
    const parts: string[] = [];
    const stats = { attachedFiles: 0, attachedFolders: 0, staleRefs: 0, truncatedFiles: 0, omittedFiles: 0 };

    const MAX_TREE_CHARS = 30_000;
    const MAX_FILE_CHARS_AUTO = 2_000;
    const MAX_FILE_CHARS_EXPLICIT = 60_000;
    const MAX_FOLDER_FILE_CONTENTS = 8;
    const MAX_TOTAL_CONTEXT_CHARS = Math.max(40_000, contextBudgetChars || 120_000);

    const truncate = (content: string, maxChars: number) => ({
      text: content.length > maxChars ? `${content.slice(0, maxChars)}\n\n... [truncated]` : content,
      truncated: content.length > maxChars,
    });

    const totalChars = () => parts.reduce((sum, part) => sum + part.length, 0);
    const canAdd = (nextPart: string) => totalChars() + nextPart.length <= MAX_TOTAL_CONTEXT_CHARS;

    const rules = serverContextRules ?? DEFAULT_CONTEXT_RULES;
    const isContextFilePath = (p: string) => isAllowedContextPath(p, rules);

    const addFileContext = async (path: string, heading: string, maxChars: number, required = false) => {
      if (included.has(path)) return true;
      if (isWorkspacePathIgnored(path)) {
        stats.omittedFiles += 1;
        return false;
      }

      if (!isContextFilePath(path)) {
        // Keep non-code assets (images, videos, etc.) out of the LLM context.
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
      // Summarize the folder but keep non-code files out of the listing.
      const listing = summarizeDirectory(node)
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('file ')) return true;
          const p = trimmed.slice('file '.length).trim();
          return isContextFilePath(p);
        })
        .join('\n');
      const block = `### Folder: ${path}\n\`\`\`\n${listing || '(empty)'}\n\`\`\``;
      if (canAdd(block)) {
        parts.push(block);
      }

      const folderFiles = collectDirectoryFilePaths(node, MAX_FOLDER_FILE_CONTENTS).filter(isContextFilePath);
      for (const filePath of folderFiles) {
        await addFileContext(filePath, `File from @folder ${path}`, MAX_FILE_CHARS_AUTO);
      }
    };

    const mentionedRefs = [...new Set(messageMentionedFiles)];
    for (const path of mentionedRefs) {
      const node = findMentionNode(fileTree, path);
      if (!node) {
        const readFromPath = await addFileContext(path, '@ file (not in current tree)', MAX_FILE_CHARS_EXPLICIT, true);
        if (!readFromPath) stats.staleRefs += 1;
        continue;
      }
      if (node.type === 'directory') {
        await addFolderContext(path);
      } else {
        await addFileContext(path, '@ file', MAX_FILE_CHARS_EXPLICIT, true);
      }
    }

    const pinnedContextFiles = contextFiles.filter((path) => !mentionedRefs.includes(path));
    for (const path of pinnedContextFiles) {
      await addFileContext(path, 'Pinned context file', MAX_FILE_CHARS_EXPLICIT);
    }

    const hasExplicitContext = mentionedRefs.length > 0 || pinnedContextFiles.length > 0;
    if (!hasExplicitContext) {
      const treeStr = fileTree.length
        ? serializeFileTree(fileTree, {
            fileFilter: (n) => isContextFilePath(n.path),
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
      useAppStore.getState().setContextUsage(0, MAX_TOTAL_CONTEXT_CHARS);
      return [];
    }
    const summary = `Context summary: ${stats.attachedFiles} @ file(s), ${stats.attachedFolders} @ folder(s), ${stats.truncatedFiles} truncated file(s), ${stats.staleRefs} stale reference(s). Use the provided file contents and workspace tools; do not ask the user to provide these files again.`;
    const content = `Workspace context (use paths below as ground truth; do not invent paths that are not listed):\n${summary}\n\n${parts.join('\n\n')}`;
    useAppStore.getState().setContextUsage(content.length, MAX_TOTAL_CONTEXT_CHARS);
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

    // Re-check context pressure using the actual messages we will send.
    // The UI pre-check uses cached workspace context size and can be stale when context pins/@mentions change.
    const toApi = (message: Message): LLMMessage => ({ role: message.role, content: message.content });

    const messageChars = (m: LLMMessage) => {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content
            .map((p) => (p.type === 'text' ? p.text : '[image]'))
            .join(' ');
      return content.length + 48;
    };

    const candidateMessages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...contextMsgs,
      ...baseMessages.map(toApi),
      { role: 'assistant', content: '' },
    ];
    const apiPressure = estimateContextPressureForApi(candidateMessages);
    if (apiPressure.shouldPrompt) {
      const systemChars = messageChars({ role: 'system', content: systemPrompt });
      const workspaceChars = contextMsgs.reduce((sum, m) => sum + messageChars(m), 0);
      const baseChars = baseMessages.map(toApi).reduce((sum, m) => sum + messageChars(m), 0);
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

    setIsStreaming(true);
    abortRef.current = new AbortController();

    const maxIter = isAgentMode
      ? Math.min(10, Math.max(1, settings.agentMaxIterations ?? 5))
      : 1;

    useAppStore.getState().setAgentStepProgress(0, isAgentMode ? maxIter : 0);

    let loopMessages: LLMMessage[] = candidateMessages;

    try {
      let streamedContent = '';
      const allActions: AgentAction[] = [];

      for (let iter = 1; iter <= maxIter; iter++) {
        if (isAgentMode) {
          useAppStore.getState().setAgentStepProgress(iter, maxIter);
        }
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

        loopMessages = [
          { role: 'system', content: systemPrompt },
          ...contextMsgs,
          ...baseMessages.map(toApi),
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
        if (isContextLengthError(errorMsg)) {
          // Provider rejected due to context size: prompt user with summarize/clear/new chat actions.
          const p = estimateContextPressureForApi(loopMessages);
          setContextPressure({
            usedChars: p.usedChars,
            budgetChars: p.budgetChars,
            historyChars: p.usedChars,
            workspaceChars: 0,
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
      setAgentGatherStep(null);
      setIsStreaming(false);
      useAppStore.getState().setAgentStepProgress(0, 0);
      abortRef.current = null;
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
      mentionedFilePaths: lastPrompt?.role === 'user' ? getMessageContextRefPaths(lastPrompt) : [],
    });
  }, [deriveChatTitle, isStreaming, runAssistantTurn, saveVersionSnapshot, trimMessageUiState, updateChatFields]);

  const sendCurrentInput = useCallback(async () => {
    if ((!input.trim() && images.length === 0) || isStreaming) return;

    // If we end up prompting for context actions after this send (due to a more accurate
    // context size check in the LLM pipeline), we can restore and re-send this input.
    pendingContextActionInputRef.current = { input, images, mentionedFiles };

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

    const hasVision = images.length > 0;
    const rawInput = input;
    const mentionedFilePaths = mentionedFiles;
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
      for (const img of images) {
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
      ...(contextRefs.length > 0 ? { contextRefs } : {}),
    };

    // Mark this pending input as already appended to history.
    pendingContextActionInputRef.current = {
      input: rawInput,
      images,
      mentionedFiles: mentionedFilePaths,
      sentUserMessageId: userMsg.id,
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
            chatMode: effectiveMode,
            model: settings.textModel,
              preview: getMessageText(userMsg).slice(0, 500),
              promptLength: getMessageText(userMsg).length,
              imageCount: images.length,
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
    activeChat,
    activeChatId,
    contextFiles.length,
    fileTree,
    isStreaming,
    workspaceRoots.length,
    settings,
    createChat,
    addMessage,
    runAssistantTurn,
  ]);

  const summarizeActiveChat = useCallback(async (): Promise<boolean> => {
    const state = useAppStore.getState();
    const chatId = state.activeChatId;
    if (!chatId) return false;

    const chat = state.chats.find((entry) => entry.id === chatId);
    if (!chat || !canWriteChat(chat)) return false;
    const previousSummary = findLatestAutoSummaryBody(chat.messages);

    const transcript = buildCondenseTranscript(chat.messages);
    if (!transcript) {
      toast.error('Not possible to summarize right now. Please use Clear chat or New chat.');
      return false;
    }

    setIsCondensingChat(true);
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
              `Summarize the conversation below for future context carry-over. Output plain text with short headings and bullets.\n\nConversation:\n${transcript}`,
          },
        ],
        settings: {
          ...settings,
          stream: false,
          maxTokens: Math.min(2048, Math.max(512, Math.floor(settings.maxTokens / 2))),
        },
        useVision: false,
      })).trim();

      if (!summary) {
        toast.error('Not possible to summarize right now. Please use Clear chat or New chat.');
        return false;
      }

      const { mergedSummary, retainedCount } = mergeSummaryWithEntityRetention(previousSummary, summary);

      saveVersionSnapshot(chat.id, 'Before auto-summary condense');

      const summaryMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `${AUTO_SUMMARY_HEADER}\n\n${mergedSummary}\n\n${AUTO_SUMMARY_FOOTER}`,
        timestamp: Date.now(),
      };

      trimMessageUiState([summaryMessage]);
      updateChatFields(chat.id, {
        messages: [summaryMessage],
      });
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
      toast.error('Not possible to summarize right now. Please use Clear chat or New chat.');
      return false;
    } finally {
      setIsCondensingChat(false);
    }
  }, [
    buildCondenseTranscript,
    findLatestAutoSummaryBody,
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
    userScrolledUp.current = false;
    setShowScrollToLatest(false);
    toast.success('Chat cleared. Start a fresh conversation.');
    return true;
  }, [saveVersionSnapshot, trimMessageUiState, updateChatFields]);

  const handleContextActionSummarize = useCallback(async () => {
    // If we already captured a pending input (because the turn was blocked by context),
    // remove the last user message so the transcript doesn't double-count it.
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
    }
    const ok = await summarizeActiveChat();
    if (!ok) return;
    setShowContextActionsDialog(false);
    if (pendingContextActionInputRef.current) {
      const pending = pendingContextActionInputRef.current;
      pendingContextActionInputRef.current = null;
      setInput(pending.input);
      setImages(pending.images);
      setMentionedFiles(pending.mentionedFiles);
    }
    await sendCurrentInput();
  }, [sendCurrentInput, summarizeActiveChat]);

  const handleContextActionClear = useCallback(async () => {
    const ok = clearActiveChat();
    if (!ok) return;
    setShowContextActionsDialog(false);
    if (pendingContextActionInputRef.current) {
      const pending = pendingContextActionInputRef.current;
      pendingContextActionInputRef.current = null;
      setInput(pending.input);
      setImages(pending.images);
      setMentionedFiles(pending.mentionedFiles);
    }
    await sendCurrentInput();
  }, [clearActiveChat, sendCurrentInput]);

  const handleContextActionNewChat = useCallback(async () => {
    try {
      await createChat();
      setShowContextActionsDialog(false);
      if (pendingContextActionInputRef.current) {
        const pending = pendingContextActionInputRef.current;
        pendingContextActionInputRef.current = null;
        setInput(pending.input);
        setImages(pending.images);
        setMentionedFiles(pending.mentionedFiles);
      }
      await sendCurrentInput();
    } catch (e) {
      console.error('[EvigStudio] createChat for context action', e);
      const msg = e instanceof Error && e.message ? e.message : 'Could not create a new chat.';
      toast.error(msg);
    }
  }, [createChat, sendCurrentInput]);

  const handleSend = useCallback(async () => {
    if ((!input.trim() && images.length === 0) || isStreaming) return;

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
        pendingContextActionInputRef.current = { input, images, mentionedFiles };
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
  }, [estimateContextPressure, images.length, input, isStreaming, sendCurrentInput]);

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

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
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
              className="min-h-[56px] w-full resize-none rounded-lg border border-border/80 bg-input px-3 py-3 text-base leading-snug outline-none ring-2 ring-transparent transition-shadow placeholder:text-muted-foreground focus:border-primary/40 focus:ring-primary/30 sm:min-h-[48px] sm:py-2.5 sm:text-sm"
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
