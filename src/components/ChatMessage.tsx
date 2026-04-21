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
import { useState, useCallback, useLayoutEffect, useRef } from 'react';
import { DiffViewer } from '@/components/DiffViewer';
import { MessageTtsBar } from '@/components/MessageTtsBar';

interface ChatMessageProps {
  message: Message;
  chatMode?: ChatMode;
  onApplyPatch?: (patch: ParsedPatch) => void;
  onGetOriginal?: (filePath: string) => Promise<string>;
  autoAppliedPaths?: string[];
  agentActions?: AgentAction[];
}

export function ChatMessage({
  message,
  chatMode = 'agent',
  onApplyPatch,
  onGetOriginal,
  autoAppliedPaths,
  agentActions,
}: ChatMessageProps) {
  const rawText = getMessageText(message);
  const images = getImages(message);
  const isAgent = chatMode === 'agent';

  const displayText =
    isAgent && message.role === 'assistant'
      ? stripToolMarkers(stripThinkingBlocks(rawText))
      : rawText;

  const hasPatch = message.role === 'assistant' && containsPatches(rawText);
  const patches = hasPatch ? parsePatches(rawText) : [];

  const showPatchActions = !isAgent && patches.length > 0;
  const showAgentActionBadges =
    isAgent && message.role === 'assistant' && (agentActions?.length ?? 0) > 0;
  const showAutoAppliedBadges =
    isAgent && message.role === 'assistant' && !showAgentActionBadges && (autoAppliedPaths?.length ?? 0) > 0;

  return (
    <div className={`flex gap-3 animate-fade-in ${message.role === 'user' ? 'justify-end' : ''}`}>
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

        {displayText.trim().length > 0 && (
          <div
            className="prose prose-sm max-w-none leading-relaxed dark:prose-invert
            [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1
            [&_a]:text-primary [&_a]:no-underline hover:[&_a]:underline
            [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground
            [&_blockquote]:border-l-primary [&_blockquote]:text-muted-foreground
            [&_table]:text-xs [&_th]:text-foreground
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
              {displayText}
            </ReactMarkdown>
          </div>
        )}

        {message.role === 'assistant' && displayText.trim().length > 0 && (
          <MessageTtsBar rawMarkdown={displayText} />
        )}

        {/* Agent mode: compact action badges */}
        {showAgentActionBadges && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {agentActions!.map((action, i) => (
              <AgentActionBadge key={`${action.path}-${i}`} action={action} />
            ))}
          </div>
        )}

        {/* Agent mode: auto-applied patch badges (fallback if no explicit actions tracked) */}
        {showAutoAppliedBadges && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {autoAppliedPaths!.map((path) => (
              <span
                key={path}
                className="inline-flex items-center gap-1 rounded-full bg-accent/15 border border-accent/20 px-2 py-0.5 text-[11px] text-accent"
              >
                <Check className="h-3 w-3" />
                <span className="max-w-[200px] truncate">{path}</span>
              </span>
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
  write: FileEdit,
  delete: Trash2,
  rename: ArrowRightLeft,
  list: FolderOpen,
};

const ACTION_LABELS: Record<AgentAction['type'], string> = {
  read: 'Read',
  write: 'Wrote',
  delete: 'Deleted',
  rename: 'Renamed',
  list: 'Listed',
};

function AgentActionBadge({ action }: { action: AgentAction }) {
  const Icon = ACTION_ICONS[action.type] ?? FileCode;
  const label = ACTION_LABELS[action.type] ?? action.type;
  const shortPath = action.path.split('/').pop() ?? action.path;

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
      : action.type === 'write'
        ? 'bg-accent/15 border-accent/20 text-accent'
        : 'bg-muted border-border text-muted-foreground';

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

function ExpandablePre({ children }: { children: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || expanded) return;
    el.scrollTop = el.scrollHeight;
  }, [children, expanded]);

  const handleCopy = useCallback(() => {
    const t = preRef.current?.textContent || '';
    void navigator.clipboard.writeText(t);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const preClass =
    '!mb-0 !mt-0 overflow-x-auto p-3 text-xs leading-relaxed [&_code]:bg-transparent [&_code]:text-[13px]';

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
