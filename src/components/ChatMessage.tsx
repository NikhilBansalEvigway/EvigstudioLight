import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Message, ParsedPatch, ChatMode } from '@/types';
import { getMessageText, getImages, hasImages } from '@/types';
import { containsPatches, parsePatches } from '@/lib/patchApply';
import { extractThinkingBlocks, stripToolMarkers, stripChannelTokens, wrapLooseCodeBlocks, repairCodeFences, normalizeToolMarkerLineBreaks, type AgentAction } from '@/lib/agentTools';
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
  FileEdit,
  Trash2,
  ArrowRightLeft,
  FolderOpen,
  FileSearch,
  Brain,
  Eye,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useState, useCallback, useEffect, useLayoutEffect, useRef, memo } from 'react';
import { MessageTtsBar } from '@/components/MessageTtsBar';

function preprocessLatex(text: string): string {

  const protectedRe = /(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g;
  const parts = text.split(protectedRe);
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
    
      let result = part.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `$$${inner}$$`);

      result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner}$`);
      return result;
    })
    .join('');
}


// LaTeX command -> Unicode fallback. Used both for non-math prose and as a
// best-effort renderer inside inline-code chips (where KaTeX cannot run).
// Word boundaries (\b) keep longer commands from being clobbered by shorter
// prefixes (e.g. \leftrightarrow is never partially matched by \le).
const LATEX_SYMBOL_MAP: Array<[RegExp, string]> = [
  // Arrows
  [/\\rightarrow\b/g, '→'],
  [/\\longrightarrow\b/g, '⟶'],
  [/\\to\b/g, '→'],
  [/\\Rightarrow\b/g, '⇒'],
  [/\\implies\b/g, '⇒'],
  [/\\Longrightarrow\b/g, '⟹'],
  [/\\leftarrow\b/g, '←'],
  [/\\longleftarrow\b/g, '⟵'],
  [/\\Leftarrow\b/g, '⇐'],
  [/\\gets\b/g, '←'],
  [/\\leftrightarrow\b/g, '↔'],
  [/\\Leftrightarrow\b/g, '⇔'],
  [/\\iff\b/g, '⇔'],
  [/\\uparrow\b/g, '↑'],
  [/\\downarrow\b/g, '↓'],
  [/\\updownarrow\b/g, '↕'],
  [/\\mapsto\b/g, '↦'],
  [/\\hookrightarrow\b/g, '↪'],
  // Relations
  [/\\leq\b/g, '≤'],
  [/\\le\b/g, '≤'],
  [/\\geq\b/g, '≥'],
  [/\\ge\b/g, '≥'],
  [/\\neq\b/g, '≠'],
  [/\\ne\b/g, '≠'],
  [/\\approx\b/g, '≈'],
  [/\\equiv\b/g, '≡'],
  [/\\sim\b/g, '∼'],
  [/\\cong\b/g, '≅'],
  [/\\propto\b/g, '∝'],
  [/\\subseteq\b/g, '⊆'],
  [/\\subset\b/g, '⊂'],
  [/\\supseteq\b/g, '⊇'],
  [/\\supset\b/g, '⊃'],
  [/\\in\b/g, '∈'],
  [/\\notin\b/g, '∉'],
  [/\\ni\b/g, '∋'],
  // Operators & symbols
  [/\\times\b/g, '×'],
  [/\\div\b/g, '÷'],
  [/\\cdot\b/g, '·'],
  [/\\ast\b/g, '∗'],
  [/\\pm\b/g, '±'],
  [/\\mp\b/g, '∓'],
  [/\\cup\b/g, '∪'],
  [/\\cap\b/g, '∩'],
  [/\\setminus\b/g, '∖'],
  [/\\emptyset\b/g, '∅'],
  [/\\varnothing\b/g, '∅'],
  [/\\infty\b/g, '∞'],
  [/\\partial\b/g, '∂'],
  [/\\nabla\b/g, '∇'],
  [/\\sum\b/g, '∑'],
  [/\\prod\b/g, '∏'],
  [/\\int\b/g, '∫'],
  [/\\sqrt\b/g, '√'],
  [/\\forall\b/g, '∀'],
  [/\\exists\b/g, '∃'],
  [/\\neg\b/g, '¬'],
  [/\\land\b/g, '∧'],
  [/\\wedge\b/g, '∧'],
  [/\\lor\b/g, '∨'],
  [/\\vee\b/g, '∨'],
  [/\\oplus\b/g, '⊕'],
  [/\\otimes\b/g, '⊗'],
  [/\\circ\b/g, '∘'],
  [/\\bullet\b/g, '•'],
  [/\\angle\b/g, '∠'],
  [/\\degree\b/g, '°'],
  [/\\prime\b/g, '′'],
  [/\\dots\b/g, '…'],
  [/\\ldots\b/g, '…'],
  [/\\cdots\b/g, '⋯'],
  // Greek (lowercase)
  [/\\alpha\b/g, 'α'],
  [/\\beta\b/g, 'β'],
  [/\\gamma\b/g, 'γ'],
  [/\\delta\b/g, 'δ'],
  [/\\epsilon\b/g, 'ε'],
  [/\\varepsilon\b/g, 'ε'],
  [/\\zeta\b/g, 'ζ'],
  [/\\eta\b/g, 'η'],
  [/\\theta\b/g, 'θ'],
  [/\\iota\b/g, 'ι'],
  [/\\kappa\b/g, 'κ'],
  [/\\lambda\b/g, 'λ'],
  [/\\mu\b/g, 'μ'],
  [/\\nu\b/g, 'ν'],
  [/\\xi\b/g, 'ξ'],
  [/\\pi\b/g, 'π'],
  [/\\rho\b/g, 'ρ'],
  [/\\sigma\b/g, 'σ'],
  [/\\tau\b/g, 'τ'],
  [/\\upsilon\b/g, 'υ'],
  [/\\phi\b/g, 'φ'],
  [/\\varphi\b/g, 'φ'],
  [/\\chi\b/g, 'χ'],
  [/\\psi\b/g, 'ψ'],
  [/\\omega\b/g, 'ω'],
  // Greek (uppercase)
  [/\\Gamma\b/g, 'Γ'],
  [/\\Delta\b/g, 'Δ'],
  [/\\Theta\b/g, 'Θ'],
  [/\\Lambda\b/g, 'Λ'],
  [/\\Xi\b/g, 'Ξ'],
  [/\\Pi\b/g, 'Π'],
  [/\\Sigma\b/g, 'Σ'],
  [/\\Phi\b/g, 'Φ'],
  [/\\Psi\b/g, 'Ψ'],
  [/\\Omega\b/g, 'Ω'],
];

function applyLatexSymbolMap(text: string): string {
  let chunk = text;
  for (const [re, value] of LATEX_SYMBOL_MAP) chunk = chunk.replace(re, value);
  return chunk;
}

// Best-effort rendering of LaTeX that the model wrapped inside an inline-code
// chip (e.g. `... $\rightarrow$ ...`). KaTeX never runs inside <code>, so we
// unwrap $...$ / $$...$$ spans that contain a backslash command, then apply the
// symbol map. Shell-style single `$VAR` or `$a $b` (no backslash) is left alone.
function normalizeInlineCodeLatex(codeChunk: string): string {
  if (!codeChunk.startsWith('`') || codeChunk.startsWith('```')) return codeChunk;
  // Only touch chips that actually look like they contain LaTeX intent.
  if (!/\\[A-Za-z]/.test(codeChunk)) return codeChunk;
  let inner = codeChunk.slice(1, -1);
  inner = inner.replace(/\$\$?([^$\n]*\\[^$\n]*?)\$\$?/g, (_m, body) => body);
  inner = applyLatexSymbolMap(inner);
  return `\`${inner}\``;
}

function normalizeLatexSymbols(text: string): string {
  const protectedRe = /(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g;
  const parts = text.split(protectedRe);
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) {
        // Protected: math spans and fenced blocks stay untouched (KaTeX / code).
        // Inline-code chips get a best-effort symbol pass since KaTeX can't reach them.
        return normalizeInlineCodeLatex(part);
      }
      return applyLatexSymbolMap(part);
    })
    .join('');
}

function normalizeHtmlCodeBlocks(text: string): string {
  const unescapeHtml = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

  const toCodeBlock = (content: string) =>
    content.includes('\n') ? `\`\`\`\n${content}\n\`\`\`` : `\`${content.replace(/`/g, "'")}\``;

  let result = text;
  
  result = result.replace(/<div\s[^>]*data-bbox[^>]*>([\s\S]*?)<\/div>/gi, '$1');

  result = result.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_m, content: string) =>
    toCodeBlock(unescapeHtml(content.trim())),
  );

  result = result.replace(/<code>([\s\S]*?)<\/code>/gi, (_m, content: string) =>
    toCodeBlock(content),
  );
  return result;
}

function stripResidualThinkTags(text: string): string {
  const TAG = 'think(?:ing)?|reasoning|thought|reflection|internal_thought';
  return text
    .replace(new RegExp(`<(?:${TAG})>[\\s\\S]*?<\\/(?:${TAG})>`, 'gi'), '')
    .replace(new RegExp(`<(?:${TAG})>[\\s\\S]*$`, 'i'), '')
    .trim();
}


export function processMarkdown(text: string): string {
  return normalizeHtmlCodeBlocks(
    normalizeLatexSymbols(
      preprocessLatex(
        // Strip leaked channel/harmony tokens, repair malformed/stray code fences, then
        // recover any remaining unfenced code into proper code blocks.
        wrapLooseCodeBlocks(
          repairCodeFences(stripResidualThinkTags(stripChannelTokens(text))),
        ),
      ),
    ),
  );
}

/** Strip thinking blocks and agent tool markers from a raw assistant output for display. */
function cleanAssistantText(raw: string): string {
  const normalized = normalizeToolMarkerLineBreaks(raw);
  const { rest } = extractThinkingBlocks(normalized);
  return stripToolMarkers(rest);
}

// ---------------------------------------------------------------------------

interface ChatMessageProps {
  message: Message;
  chatMode?: ChatMode;
  onApplyPatch?: (patch: ParsedPatch) => void;
  onGetOriginal?: (filePath: string) => Promise<string>;
  autoAppliedPaths?: string[];
  agentActions?: AgentAction[];
  agentThoughts?: string[];
 
  fallbackThinking?: string;
  onOpenFile?: (filePath: string) => void;
  onSubmitEdit?: (messageId: string, text: string) => Promise<void>;
  onRegenerate?: (messageId: string) => Promise<void>;
  busy?: boolean;
}

function ChatMessageImpl({
  message,
  chatMode = 'agent',
  onApplyPatch,
  onGetOriginal,
  autoAppliedPaths,
  agentActions,
  agentThoughts,
  fallbackThinking,
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
  const [showThinking, setShowThinking] = useState(true);
  
  const rawText = message.role === 'assistant'
    ? normalizeToolMarkerLineBreaks(getMessageText(message))
    : getMessageText(message);
  const images = getImages(message);
  const isAgent = chatMode === 'agent';

 
  const { thinking: thinkingContent, rest: rawTextWithoutThinking } =
    message.role === 'assistant'
      ? extractThinkingBlocks(rawText)
      : { thinking: '', rest: rawText };

  const displayText =
    message.role === 'assistant'
      // Strip leaked channel/harmony tokens first so tool-marker stripping sees clean boundaries.
      ? stripToolMarkers(stripChannelTokens(rawTextWithoutThinking))
      : rawText;

  const effectiveThinkingContent = (() => {
    
    if (!isAgent || message.role !== 'assistant') return '';
  
    if (agentThoughts?.length) return agentThoughts.join('\n\n---\n\n');
    
    if (thinkingContent) return thinkingContent;
    
    if (agentActions?.length) {
      const labelMap: Record<string, string> = {
        read: 'Read', edit: 'Edited', write: 'Wrote',
        delete: 'Deleted', rename: 'Renamed', list: 'Listed',
      };
      const lines = agentActions.map(action => {
        const label = labelMap[action.type] ?? action.type;
        const status = action.success ? '' : ` *(failed${action.error ? `: ${action.error}` : ''})*`;
        return `- **${label}** \`${action.path}\`${status}`;
      });
      return `**Agent actions:**\n\n${lines.join('\n')}`;
    }
  
    if (fallbackThinking) return fallbackThinking;
    return '';
  })();

  const markdownToRender =
    message.role === 'assistant'
      ? processMarkdown(displayText)
      : displayText;

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
  const successfulMutationActions = (agentActions ?? []).filter(
    (action) => action.success && (action.type === 'edit' || action.type === 'write' || action.type === 'delete' || action.type === 'rename'),
  );
  const executionBadge = (() => {
    if (successfulMutationActions.length > 0) {
      const first = successfulMutationActions[0];
      if (successfulMutationActions.length === 1) {
        if (first.type === 'delete') return { label: 'File removed', tone: 'warning' as const };
        if (first.type === 'rename') return { label: 'File renamed', tone: 'accent' as const };
        return { label: 'File updated', tone: 'accent' as const };
      }
      return { label: `${successfulMutationActions.length} workspace changes`, tone: 'accent' as const };
    }

    if (showAutoAppliedBadges && (autoAppliedPaths?.length ?? 0) > 0) {
      return {
        label: autoAppliedPaths!.length === 1 ? 'Patch applied' : `${autoAppliedPaths!.length} patches applied`,
        tone: 'accent' as const,
      };
    }

    return null;
  })();

  const priorAttempts =
    message.role === 'assistant' ? (message.meta?.attempts ?? []) : [];
  const hasPriorAttempts = priorAttempts.length > 0;

  const isAutoSummary = message.meta?.kind === 'auto_summary' && message.role === 'assistant';
  const compactedCount = message.meta?.compactedMessageCount ?? null;
  const compactedChars = message.meta?.compactedCharCount ?? null;
  const compactionDepth = message.meta?.compactionDepth ?? null;

  
  const summaryBody = isAutoSummary
    ? (() => {
        const HEADER = 'Conversation summary (auto-generated):';
        const FOOTER = 'Continue chatting with this summary as context.';
        let t = markdownToRender.trim();
        if (t.startsWith(HEADER)) t = t.slice(HEADER.length).trim();
        if (t.endsWith(FOOTER)) t = t.slice(0, -FOOTER.length).trim();
        return t;
      })()
    : null;

  
  const [expandedCodeBlocks, setExpandedCodeBlocks] = useState<Record<string, boolean>>({});

  const getCodeBlockKey = useCallback(
    (node: any) => {
      const pos = node?.position?.start;
      if (pos && typeof pos.line === 'number' && typeof pos.column === 'number') {
        return `${message.id}:${pos.line}:${pos.column}`;
      }
      // Fallback: stable-ish key.
      return `${message.id}:pre:unknown`;
    },
    [message.id],
  );

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
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 shadow-sm">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
      )}

      <div
        className={`max-w-[min(94%,58rem)] sm:max-w-[88%] ${
          message.role === 'user'
            ? 'rounded-2xl border border-primary/15 bg-primary/[0.07] px-4 py-3 shadow-[0_10px_24px_hsl(var(--background)/0.12)]'
            : 'min-w-0 flex-1 rounded-2xl border border-border/70 bg-card/65 px-4 py-3 shadow-[0_12px_28px_hsl(var(--background)/0.12)] backdrop-blur-sm'
        }`}
      >
        {hasImages(message) && (
          <div className="flex gap-2 flex-wrap mb-2">
            {images.map((src, i) => (
              <img key={i} src={src} alt="attachment" className="max-h-40 rounded border border-border" />
            ))}
          </div>
        )}

        {executionBadge && message.role === 'assistant' && (
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${executionBadge.tone === 'warning'
              ? 'border-warning/25 bg-warning/10 text-warning'
              : 'border-accent/20 bg-accent/10 text-accent'}`}>
              <Check className="h-3 w-3" />
              {executionBadge.label}
            </span>
          </div>
        )}

        {effectiveThinkingContent && message.role === 'assistant' && (
          <div className="mb-3 overflow-hidden rounded-xl border border-border/60 bg-muted/45 shadow-[inset_0_1px_0_hsl(var(--background)/0.6)]">
            <button
              type="button"
              onClick={() => setShowThinking(!showThinking)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-background/30 hover:text-foreground"
            >
              <Brain className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium">
                {agentThoughts?.length
                  ? 'Reasoning'
                  : thinkingContent
                    ? 'Thinking'
                    : agentActions?.length
                      ? 'Agent Actions'
                      : 'Thinking'}
              </span>
              {showThinking ? (
                <ChevronUp className="ml-auto h-3 w-3 shrink-0" />
              ) : (
                <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
              )}
            </button>
            {showThinking && (
              <div className="border-t border-border/50 bg-background/20 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}>
                  {processMarkdown(stripToolMarkers(effectiveThinkingContent))}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {hasPriorAttempts && message.role === 'assistant' && (
          <PreviousAttempts attempts={priorAttempts} />
        )}

        {hasPriorAttempts && message.role === 'assistant' && !isEditing && displayText.trim().length > 0 && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-primary">
            <Check className="h-3 w-3 shrink-0" />
            <span>Final response</span>
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
            <pre className="whitespace-pre-wrap break-words text-sm sm:text-[15px] leading-relaxed font-sans text-foreground">
              {displayText}
            </pre>
          ) : (
             <div
               className="prose prose-sm max-w-none leading-relaxed dark:prose-invert
              [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5
              [&_a]:text-primary [&_a]:no-underline hover:[&_a]:underline
              [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:mt-3 [&_h3]:mb-1.5
              [&_h1]:text-xl sm:[&_h1]:text-2xl [&_h2]:text-lg sm:[&_h2]:text-xl [&_h3]:text-base
              [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold
              [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground
              [&_h2]:border-b [&_h2]:border-border/60 [&_h2]:pb-1
              [&_hr]:my-4
              [&_blockquote]:border-l-primary [&_blockquote]:text-muted-foreground
              [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_table]:my-3
              [&_th]:border [&_th]:border-border [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-foreground [&_th]:font-semibold
              [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:text-foreground
              [&_tr:nth-child(even)]:bg-muted/20
              text-sm sm:text-[15px]
            "
             >
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeHighlight, [rehypeKatex, { throwOnError: false }]]}
                components={{
                  pre: ({ node, children }) => {
                    const key = getCodeBlockKey(node);
                    const expanded = expandedCodeBlocks[key] === true;
                    return (
                      <ExpandablePre
                        expanded={expanded}
                        onToggle={() =>
                          setExpandedCodeBlocks((prev) => ({
                            ...prev,
                            [key]: !(prev[key] === true),
                          }))
                        }
                      >
                        {children}
                      </ExpandablePre>
                    );
                  },
                  code: ({ children, className }) => {
                    const isInline = !className;
                    if (isInline) {
                      return <code className="rounded bg-secondary px-1 py-0.5 text-[0.85em]">{children}</code>;
                    }
                    return <code className={className}>{children}</code>;
                  },
                }}
              >
                {summaryBody ?? markdownToRender}
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

        {isAutoSummary && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              Summary{compactionDepth != null ? ` (compaction #${compactionDepth})` : ''}
            </span>
            {compactedCount != null && (
              <span>
                Summarized {compactedCount} message{compactedCount === 1 ? '' : 's'}
              </span>
            )}
            {compactedChars != null && compactedChars > 0 && (
              <span>
                ({Math.round(compactedChars / 1000)}k chars)
              </span>
            )}
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

        {/* Chat mode: patch apply actions (no diff preview) */}
        {showPatchActions && (
          <div className="mt-3 space-y-2">
            {patches.map((patch, i) => (
              <PatchAction
                key={`${patch.filePath}-${i}`}
                patch={patch}
                autoApplied={autoAppliedPaths?.includes(patch.filePath)}
                onApply={() => onApplyPatch?.(patch)}
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
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-background shadow-sm">
          <User className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

export const ChatMessage = memo(ChatMessageImpl);

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

function PreviousAttempts({
  attempts,
}: {
  attempts: NonNullable<Message['meta']>['attempts'];
}) {
  const [open, setOpen] = useState(false);
  const items = attempts ?? [];
  if (items.length === 0) return null;

  return (
    <div className="mb-3 overflow-hidden rounded-md border border-border/50 bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <RotateCcw className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          Previous {items.length === 1 ? 'attempt' : 'attempts'} ({items.length})
        </span>
        {open ? (
          <ChevronUp className="ml-auto h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/50 px-3 py-2.5">
          {items.map((attempt, idx) => {
            const body = processMarkdown(cleanAssistantText(attempt.content));
            return (
              <div key={`${attempt.createdAt}-${idx}`} className="space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  <span>Attempt {idx + 1}</span>
                </div>
                {body.trim().length > 0 ? (
                  <div className="prose prose-sm max-w-none text-[12px] leading-relaxed text-muted-foreground opacity-80 dark:prose-invert">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
                    >
                      {body}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-[11px] italic text-muted-foreground/70">
                    (No text — this step ran tools and continued.)
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
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

function ExpandablePre({
  children,
  expanded,
  onToggle,
}: {
  children: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

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
    if (!t) return;
    const fallback = () => {
      const el = document.createElement('textarea');
      el.value = t;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(el);
    };
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(t).catch(fallback);
      } else {
        fallback();
      }
    } catch {
      fallback();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const preClass =
    '!mb-0 !mt-0 overflow-x-auto p-3 text-xs leading-relaxed select-text [&_code]:bg-transparent [&_code]:text-[13px]';

  return (
    <div data-evig-codeblock className="my-2 overflow-hidden rounded-md border border-border/60 bg-secondary/50 select-text">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/30 px-2 py-1 select-none">
        <span className="text-[10px] font-medium text-muted-foreground">Code</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
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
        className={expanded ? 'max-h-[min(70vh,560px)] overflow-y-auto select-text' : 'max-h-[5.5rem] overflow-y-auto select-text'}
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
  autoApplied,
}: {
  patch: ParsedPatch;
  onApply: () => void;
  autoApplied?: boolean;
}) {
  const { filePath, operation = 'update' } = patch;
  const [userApplied, setUserApplied] = useState(false);
  const done = userApplied || autoApplied;
  const applyLabel = operation === 'delete' ? 'Remove' : 'Apply';

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded bg-secondary/80 border border-border text-xs">
      <FileCode className="w-3.5 h-3.5 text-primary shrink-0" />
      <span className="flex-1 truncate text-foreground">{filePath}</span>
      {operation === 'delete' && (
        <span className="text-[10px] text-destructive shrink-0">delete</span>
      )}
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
  );
}
