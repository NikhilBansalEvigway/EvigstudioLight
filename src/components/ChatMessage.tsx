import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Message, ParsedPatch, ChatMode } from '@/types';
import { getMessageText, getImages, hasImages } from '@/types';
import { applyPatch, containsPatches, parsePatches } from '@/lib/patchApply';
import { stripThinkingBlocks, stripToolMarkers, type AgentAction } from '@/lib/agentTools';
import {
  Copy,
  Check,
  Bot,
  User,
  Pencil,
  RotateCcw,
  Loader2,
  FileCode,
  Play,
  Eye,
  FilePlus,
  FileEdit,
  Trash2,
  ArrowRightLeft,
  FolderOpen,
  FileSearch,
} from 'lucide-react';
import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { DiffViewer } from '@/components/DiffViewer';
import { MessageTtsBar } from '@/components/MessageTtsBar';

interface ChatMessageProps {
  message: Message;
  chatMode?: ChatMode;
  onApplyPatch?: (patch: ParsedPatch) => void;
  onGetOriginal?: (filePath: string) => Promise<string>;
  autoAppliedPaths?: string[];
  agentActions?: AgentAction[];
  onOpenFile?: (filePath: string) => void;
  onSubmitEdit?: (messageId: string, text: string) => Promise<void>;
  onRegenerate?: (messageId: string) => Promise<void>;
  busy?: boolean;
}

export function ChatMessage({
  message,
  chatMode = 'agent',
  onApplyPatch,
  onGetOriginal,
  autoAppliedPaths,
  agentActions,
  onOpenFile,
  onSubmitEdit,
  onRegenerate,
  busy = false,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const rawText = getMessageText(message);
  const images = getImages(message);
  const isAgent = chatMode === 'agent';

  const displayText =
    isAgent && message.role === 'assistant'
      ? stripToolMarkers(stripThinkingBlocks(rawText))
      : rawText;

  const normalizeLatexSymbols = (text: string) => {
    // We don't render LaTeX in chat; convert common tokens to their Unicode equivalents.
    // This prevents raw strings like `$\\rightarrow$` from showing up in normal prose.
    const map: Array<[RegExp, string]> = [
      [/\$\s*\\rightarrow\s*\$/g, '→'],
      [/\$\s*\\to\s*\$/g, '→'],
      [/\\rightarrow\b/g, '→'],
      [/\\to\b/g, '→'],
      [/\$\s*\\Rightarrow\s*\$/g, '⇒'],
      [/\\Rightarrow\b/g, '⇒'],
      [/\\implies\b/g, '⇒'],
      [/\$\s*\\leftarrow\s*\$/g, '←'],
      [/\\leftarrow\b/g, '←'],
      [/\\gets\b/g, '←'],
      [/\\leftrightarrow\b/g, '↔'],
      [/\\mapsto\b/g, '↦'],
      [/\$\s*\\leq?\s*\$/g, '≤'],
      [/\\leq?\b/g, '≤'],
      [/\$\s*\\geq?\s*\$/g, '≥'],
      [/\\geq?\b/g, '≥'],
      [/\$\s*\\neq\s*\$/g, '≠'],
      [/\\neq\b/g, '≠'],
      [/\$\s*\\approx\s*\$/g, '≈'],
      [/\\approx\b/g, '≈'],
      [/\$\s*\\infty\s*\$/g, '∞'],
      [/\\infty\b/g, '∞'],
      [/\$\s*\\times\s*\$/g, '×'],
      [/\\times\b/g, '×'],
      [/\$\s*\\cdot\s*\$/g, '·'],
      [/\\cdot\b/g, '·'],
      [/\$\s*\\pm\s*\$/g, '±'],
      [/\\pm\b/g, '±'],
      [/\\ldots\b/g, '…'],
    ];

    // Avoid rewriting inside fenced code blocks.
    const parts = text.split(/(```[\s\S]*?```)/g);
    let out = '';
    for (const part of parts) {
      if (part.startsWith('```')) {
        out += part;
        continue;
      }
      let chunk = part;
      for (const [re, value] of map) chunk = chunk.replace(re, value);
      out += chunk;
    }
    return out;
  };

  const markdownToRender =
    message.role === 'assistant' ? normalizeLatexSymbols(displayText) : displayText;

  const hasPatch = message.role === 'assistant' && containsPatches(rawText);
  const patches = hasPatch ? parsePatches(rawText) : [];

  const showPatchActions = !isAgent && patches.length > 0;
  const showAgentActionBadges =
    isAgent && message.role === 'assistant' && (agentActions?.length ?? 0) > 0;
  const showAutoAppliedBadges =
    isAgent && message.role === 'assistant' && !showAgentActionBadges && (autoAppliedPaths?.length ?? 0) > 0;
  const contextRefs = message.contextRefs ?? [];
  const selectionRef = message.selectionRef;
  const canCopyMessage = displayText.trim().length > 0 && !isEditing;
  const canEditMessage =
    !busy &&
    message.role === 'user' &&
    typeof message.content === 'string' &&
    !hasImages(message) &&
    !!onSubmitEdit &&
    rawText.trim().length > 0;
  const canRegenerateMessage = !busy && message.role === 'assistant' && !!onRegenerate;

  useEffect(() => {
    if (!isEditing) {
      setDraftText(rawText);
    }
  }, [isEditing, rawText]);

  const handleCopyMessage = useCallback(() => {
    const text = displayText || rawText;
    if (!text) return;
    const fallbackCopy = () => {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    };

    const copyPromise = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(text).catch(() => {
          fallbackCopy();
        })
      : Promise.resolve().then(() => {
          fallbackCopy();
        });

    void copyPromise.finally(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [displayText, rawText]);

  const handleSubmitEdit = useCallback(async () => {
    if (!onSubmitEdit || !draftText.trim() || draftText === rawText) {
      setIsEditing(false);
      return;
    }

    setIsSavingEdit(true);
    try {
      await onSubmitEdit(message.id, draftText);
      setIsEditing(false);
    } finally {
      setIsSavingEdit(false);
    }
  }, [draftText, message.id, onSubmitEdit, rawText]);

  const handleRegenerate = useCallback(async () => {
    if (!onRegenerate) return;
    setIsRegenerating(true);
    try {
      await onRegenerate(message.id);
    } finally {
      setIsRegenerating(false);
    }
  }, [message.id, onRegenerate]);

  return (
    <div className={`group flex gap-3 animate-fade-in ${message.role === 'user' ? 'justify-end' : ''}`}>
      {message.role === 'assistant' && (
        <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center shrink-0 mt-1">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
      )}

      <div
        className={`max-w-[min(92%,56rem)] sm:max-w-[85%] ${
          message.role === 'user'
            ? 'rounded-lg bg-secondary px-3 py-2'
            : 'min-w-0 flex-1'
        }`}
      >
        {hasImages(message) && (
          <div className="flex gap-2 flex-wrap mb-2">
            {images.map((src, i) => (
              <img key={i} src={src} alt="attachment" className="max-h-40 rounded border border-border" />
            ))}
          </div>
        )}

        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void handleSubmitEdit();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setIsEditing(false);
                  setDraftText(rawText);
                }
              }}
              rows={Math.min(10, Math.max(3, draftText.split('\n').length))}
              className="min-h-[96px] w-full resize-y rounded-lg border border-border/80 bg-background px-3 py-2 text-sm leading-relaxed outline-none ring-2 ring-transparent transition-shadow focus:border-primary/40 focus:ring-primary/30"
            />
            <div className="flex items-center justify-end gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setDraftText(rawText);
                }}
                disabled={isSavingEdit}
                className="rounded-md border border-border/60 px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitEdit()}
                disabled={isSavingEdit || !draftText.trim() || draftText === rawText}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingEdit ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pencil className="h-3 w-3" />}
                Save and resend
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">This replaces this turn and regenerates the conversation from here.</p>
          </div>
        ) : displayText.trim().length > 0 && (
          message.role === 'user' ? (
            <pre className="whitespace-pre-wrap break-words text-sm sm:text-[15px] leading-relaxed font-mono">
              {displayText}
            </pre>
          ) : (
            <div
              className="prose prose-sm max-w-none leading-relaxed dark:prose-invert
              [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1
              [&_a]:text-primary [&_a]:no-underline hover:[&_a]:underline
              [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground
              [&_blockquote]:border-l-primary [&_blockquote]:text-muted-foreground
              [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_table]:my-3
              [&_th]:border [&_th]:border-border [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-foreground [&_th]:font-semibold
              [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:text-foreground
              [&_tr:nth-child(even)]:bg-muted/20
              text-sm sm:text-[15px]
            "
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  pre: ({ children }) => <ExpandablePre>{children}</ExpandablePre>,
                  code: ({ children, className }) => {
                    const isInline = !className;
                    if (isInline) {
                      return <code className="rounded bg-secondary px-1 py-0.5 text-[0.85em]">{children}</code>;
                    }
                    return <code className={className}>{children}</code>;
                  },
                }}
              >
                {markdownToRender}
              </ReactMarkdown>
            </div>
          )
        )}

        {message.role === 'user' && selectionRef?.text?.trim().length > 0 && (
          <div className="mt-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-2">
            <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <Eye className="h-3 w-3" />
              <span>Selection</span>
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/40 px-2 py-1.5 text-[12px] leading-relaxed text-muted-foreground">
              {selectionRef.text}
            </pre>
          </div>
        )}

        {message.role === 'assistant' && markdownToRender.trim().length > 0 && (
          <MessageTtsBar rawMarkdown={markdownToRender} />
        )}

        {message.role === 'user' && contextRefs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/60 pt-2">
            <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Context
            </span>
            {contextRefs.map((ref) => {
              const isFolder = ref.type === 'directory';
              const missing = ref.type === 'missing';
              return (
                <button
                  key={ref.path}
                  type="button"
                  onClick={() => !missing && !isFolder && onOpenFile?.(ref.path)}
                  disabled={missing || isFolder || !onOpenFile}
                  className={`inline-flex max-w-[260px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${missing
                    ? 'border-warning/30 bg-warning/10 text-warning'
                    : 'border-primary/20 bg-primary/10 text-primary hover:bg-primary/15 disabled:hover:bg-primary/10'}`}
                  title={missing ? `${ref.path} is no longer in the workspace tree` : ref.path}
                >
                  {isFolder ? <FolderOpen className="h-3 w-3" /> : <FileCode className="h-3 w-3" />}
                  <span className="truncate">{ref.label ?? ref.path}{isFolder ? '/' : ''}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Agent mode: compact action badges */}
        {showAgentActionBadges && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {agentActions!.map((action, i) => (
              <AgentActionBadge key={`${action.path}-${i}`} action={action} onOpenFile={onOpenFile} />
            ))}
          </div>
        )}

        {/* Agent mode: auto-applied patch badges (fallback if no explicit actions tracked) */}
        {showAutoAppliedBadges && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {autoAppliedPaths!.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => onOpenFile?.(path)}
                className="inline-flex items-center gap-1 rounded-full border border-accent/20 bg-accent/15 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/25 disabled:cursor-default disabled:hover:bg-accent/15"
                disabled={!onOpenFile}
                title={onOpenFile ? `Open ${path}` : path}
              >
                <Check className="h-3 w-3" />
                <span className="max-w-[200px] truncate">{path}</span>
              </button>
            ))}
          </div>
        )}

        {/* Chat mode: full patch actions with preview / apply */}
        {showPatchActions && (
          <div className="mt-3 space-y-2">
            {patches.map((patch, i) => (
              <PatchAction
                key={`${patch.filePath}-${i}`}
                patch={patch}
                autoApplied={autoAppliedPaths?.includes(patch.filePath)}
                onApply={() => onApplyPatch?.(patch)}
                onGetOriginal={onGetOriginal}
              />
            ))}
          </div>
        )}

        {(canCopyMessage || canEditMessage || canRegenerateMessage) && (
          <div className="mt-2 flex items-center gap-1 text-[11px] opacity-70 transition-opacity group-hover:opacity-100">
            {canCopyMessage && (
              <MessageActionButton
                label={copied ? 'Copied' : 'Copy'}
                title="Copy message"
                onClick={handleCopyMessage}
                icon={copied ? Check : Copy}
              />
            )}
            {canEditMessage && (
              <MessageActionButton
                label="Edit"
                title="Edit this message in place"
                onClick={() => {
                  setDraftText(rawText);
                  setIsEditing(true);
                }}
                icon={Pencil}
              />
            )}
            {canRegenerateMessage && (
              <MessageActionButton
                label={isRegenerating ? 'Regenerating' : 'Regenerate'}
                title="Regenerate from this point"
                onClick={() => void handleRegenerate()}
                icon={isRegenerating ? Loader2 : RotateCcw}
                spinning={isRegenerating}
              />
            )}
          </div>
        )}
      </div>

      {message.role === 'user' && (
        <div className="w-6 h-6 rounded bg-secondary flex items-center justify-center shrink-0 mt-1">
          <User className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

const ACTION_ICONS: Record<AgentAction['type'], React.ElementType> = {
  read: FileSearch,
  edit: FileEdit,
  write: FileEdit,
  delete: Trash2,
  rename: ArrowRightLeft,
  list: FolderOpen,
};

const ACTION_LABELS: Record<AgentAction['type'], string> = {
  read: 'Read',
  edit: 'Edited',
  write: 'Wrote',
  delete: 'Deleted',
  rename: 'Renamed',
  list: 'Listed',
};

function getOpenableActionPath(action: AgentAction): string | null {
  if (!action.success) return null;
  if (action.type === 'read' || action.type === 'edit' || action.type === 'write') return action.path;
  if (action.type === 'rename') {
    const parts = action.path.split(/\s*->\s*/);
    return parts[1] ?? null;
  }
  return null;
}

function AgentActionBadge({ action, onOpenFile }: { action: AgentAction; onOpenFile?: (filePath: string) => void }) {
  const Icon = ACTION_ICONS[action.type] ?? FileCode;
  const label = ACTION_LABELS[action.type] ?? action.type;
  const shortPath = action.path.split('/').pop() ?? action.path;
  const openablePath = getOpenableActionPath(action);

  if (!action.success) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 border border-destructive/20 px-2 py-0.5 text-[11px] text-destructive">
        <Icon className="h-3 w-3" />
        <span className="max-w-[180px] truncate" title={action.path}>
          {label} {shortPath}
        </span>
        <span className="text-[10px] opacity-70">failed</span>
      </span>
    );
  }

  const colorClass =
    action.type === 'delete'
      ? 'bg-warning/10 border-warning/20 text-warning'
      : action.type === 'edit' || action.type === 'write'
        ? 'bg-accent/15 border-accent/20 text-accent'
        : 'bg-muted border-border text-muted-foreground';

  if (openablePath && onOpenFile) {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(openablePath)}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] border transition-colors hover:bg-background/70 ${colorClass}`}
        title={`Open ${openablePath}`}
      >
        <Icon className="h-3 w-3" />
        <span className="max-w-[180px] truncate" title={action.path}>
          {label} {shortPath}
        </span>
      </button>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] border ${colorClass}`}
    >
      <Icon className="h-3 w-3" />
      <span className="max-w-[180px] truncate" title={action.path}>
        {label} {shortPath}
      </span>
    </span>
  );
}

function MessageActionButton({
  label,
  title,
  onClick,
  icon: Icon,
  spinning = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  icon: React.ElementType;
  spinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className={`h-3 w-3 ${spinning ? 'animate-spin' : ''}`} />
      <span>{label}</span>
    </button>
  );
}

function ExpandablePre({ children }: { children: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || expanded) return;
    // Only auto-follow when the user was already near the bottom, and don't fight text selection.
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distFromBottom < 24;
    const sel = window.getSelection?.();
    const selectingInside =
      !!sel &&
      sel.rangeCount > 0 &&
      !sel.isCollapsed &&
      !!preRef.current &&
      (preRef.current.contains(sel.anchorNode) || preRef.current.contains(sel.focusNode));
    if (nearBottom && !selectingInside) {
      el.scrollTop = el.scrollHeight;
    }
  }, [children, expanded]);

  const handleCopy = useCallback(() => {
    const t = preRef.current?.textContent || '';
    void navigator.clipboard.writeText(t);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const preClass =
    '!mb-0 !mt-0 overflow-x-auto p-3 text-xs leading-relaxed select-text [&_code]:bg-transparent [&_code]:text-[13px]';

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border/60 bg-secondary/50">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/30 px-2 py-1">
        <span className="text-[10px] font-medium text-muted-foreground">Code</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
          <button type="button" onClick={handleCopy} className="shrink-0 text-[10px] text-primary hover:underline">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className={expanded ? 'max-h-[min(70vh,560px)] overflow-y-auto' : 'max-h-[5.5rem] overflow-y-auto'}
      >
        <pre ref={preRef} className={preClass}>
          {children}
        </pre>
      </div>
    </div>
  );
}

function PatchAction({
  patch,
  onApply,
  onGetOriginal,
  autoApplied,
}: {
  patch: ParsedPatch;
  onApply: () => void;
  onGetOriginal?: (filePath: string) => Promise<string>;
  autoApplied?: boolean;
}) {
  const { filePath, content, operation = 'update' } = patch;
  const [userApplied, setUserApplied] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [original, setOriginal] = useState('');
  const [modified, setModified] = useState('');

  const done = userApplied || autoApplied;

  const handlePreview = async () => {
    if (operation === 'delete') {
      if (onGetOriginal) {
        try {
          setOriginal(await onGetOriginal(filePath));
        } catch {
          setOriginal('');
        }
      } else {
        setOriginal('');
      }
      setModified('');
      setShowDiff(true);
      return;
    }
    if (onGetOriginal) {
      try {
        const orig = await onGetOriginal(filePath);
        setOriginal(orig);
        setModified(applyPatch(orig, { filePath, content, operation }));
      } catch {
        setOriginal('');
        setModified(content.split('\n').map((l) => (l.startsWith('+') ? l.slice(1) : l)).join('\n'));
      }
    } else {
      setOriginal('');
      setModified(content);
    }
    setShowDiff(true);
  };

  const applyLabel = operation === 'delete' ? 'Remove' : 'Apply';

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 rounded bg-secondary/80 border border-border text-xs">
        <FileCode className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="flex-1 truncate text-foreground">{filePath}</span>
        {operation === 'delete' && (
          <span className="text-[10px] text-destructive shrink-0">delete</span>
        )}
        <button onClick={handlePreview} className="flex items-center gap-1 px-2 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors">
          <Eye className="w-3 h-3" /> Preview
        </button>
        {!done ? (
          <button
            onClick={() => {
              onApply();
              setUserApplied(true);
            }}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          >
            <Play className="w-3 h-3" /> {applyLabel}
          </button>
        ) : (
          <span className="flex items-center gap-1 text-accent">
            <Check className="w-3 h-3" /> Applied
          </span>
        )}
      </div>

      {showDiff && (
        <DiffViewer
          filePath={filePath}
          original={original}
          modified={modified}
          onClose={() => setShowDiff(false)}
          onApply={() => {
            onApply();
            setUserApplied(true);
            setShowDiff(false);
          }}
        />
      )}
    </>
  );
}
