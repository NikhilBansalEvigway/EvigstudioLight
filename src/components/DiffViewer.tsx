import { useState } from 'react';
import { diffLines, type Change } from 'diff';
import { X, Columns2, AlignJustify } from 'lucide-react';

interface DiffViewerProps {
  filePath: string;
  original: string;
  modified: string;
  onClose: () => void;
  onApply?: () => void;
}

export function DiffViewer({ filePath, original, modified, onClose, onApply }: DiffViewerProps) {
  const [mode, setMode] = useState<'inline' | 'side'>('inline');
  const changes = diffLines(original, modified);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[90vw] max-w-5xl max-h-[85vh] flex flex-col bg-card border border-border rounded-lg shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-foreground">{filePath}</span>
            <span className="text-[10px] text-muted-foreground">
              {countChanges(changes)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-border rounded overflow-hidden">
              <button
                onClick={() => setMode('inline')}
                className={`flex items-center gap-1 px-2 py-1 text-[10px] transition-colors ${
                  mode === 'inline' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
                title="Inline diff"
              >
                <AlignJustify className="w-3 h-3" /> Inline
              </button>
              <button
                onClick={() => setMode('side')}
                className={`flex items-center gap-1 px-2 py-1 text-[10px] transition-colors ${
                  mode === 'side' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
                title="Side-by-side diff"
              >
                <Columns2 className="w-3 h-3" /> Side by Side
              </button>
            </div>
            {onApply && (
              <button
                onClick={onApply}
                className="px-3 py-1 rounded bg-accent/20 text-accent text-[10px] font-semibold hover:bg-accent/30 transition-colors"
              >
                Apply Changes
              </button>
            )}
            <button onClick={onClose} className="p-1 hover:text-primary transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-auto">
          {mode === 'inline' ? (
            <InlineDiff changes={changes} />
          ) : (
            <SideBySideDiff changes={changes} />
          )}
        </div>
      </div>
    </div>
  );
}

function InlineDiff({ changes }: { changes: Change[] }) {
  let lineNum = 0;

  return (
    <div className="text-xs font-mono">
      {changes.map((change, i) => {
        const lines = change.value.replace(/\n$/, '').split('\n');
        return lines.map((line, j) => {
          if (!change.added) lineNum++;
          const num = change.added ? '' : lineNum;

          return (
            <div
              key={`${i}-${j}`}
              className={`flex ${getDiffRowClass(change)}`}
            >
              <span className="w-12 shrink-0 text-right pr-3 py-px select-none text-muted-foreground/50 border-r border-border/50">
                {num}
              </span>
              <span className={`w-5 shrink-0 text-center py-px select-none ${getDiffSymbolClass(change)}`}>
                {change.added ? '+' : change.removed ? '−' : ' '}
              </span>
              <span className="flex-1 px-3 py-px whitespace-pre-wrap break-all">
                {line || ' '}
              </span>
            </div>
          );
        });
      })}
    </div>
  );
}

function SideBySideDiff({ changes }: { changes: Change[] }) {
  const leftLines: DiffLine[] = [];
  const rightLines: DiffLine[] = [];

  let leftNum = 0;
  let rightNum = 0;

  for (const change of changes) {
    const lines = change.value.replace(/\n$/, '').split('\n');

    if (change.removed) {
      for (const line of lines) {
        leftNum++;
        leftLines.push({ num: leftNum, text: line, type: 'removed' });
      }
    } else if (change.added) {
      for (const line of lines) {
        rightNum++;
        rightLines.push({ num: rightNum, text: line, type: 'added' });
      }
    } else {
      // Pad shorter side
      while (leftLines.length < rightLines.length) {
        leftLines.push({ num: null, text: '', type: 'pad' });
      }
      while (rightLines.length < leftLines.length) {
        rightLines.push({ num: null, text: '', type: 'pad' });
      }
      for (const line of lines) {
        leftNum++;
        rightNum++;
        leftLines.push({ num: leftNum, text: line, type: 'unchanged' });
        rightLines.push({ num: rightNum, text: line, type: 'unchanged' });
      }
    }
  }

  // Final pad
  while (leftLines.length < rightLines.length) {
    leftLines.push({ num: null, text: '', type: 'pad' });
  }
  while (rightLines.length < leftLines.length) {
    rightLines.push({ num: null, text: '', type: 'pad' });
  }

  return (
    <div className="flex text-xs font-mono min-w-0">
      {/* Left (original) */}
      <div className="flex-1 border-r border-border min-w-0">
        <div className="px-3 py-1 border-b border-border text-[10px] text-muted-foreground font-semibold uppercase tracking-wider bg-secondary/50">
          Original
        </div>
        {leftLines.map((line, i) => (
          <div key={i} className={`flex ${getSideClass(line.type)}`}>
            <span className="w-10 shrink-0 text-right pr-2 py-px select-none text-muted-foreground/50">
              {line.num ?? ''}
            </span>
            <span className="flex-1 px-2 py-px whitespace-pre-wrap break-all min-w-0">
              {line.text || ' '}
            </span>
          </div>
        ))}
      </div>

      {/* Right (modified) */}
      <div className="flex-1 min-w-0">
        <div className="px-3 py-1 border-b border-border text-[10px] text-muted-foreground font-semibold uppercase tracking-wider bg-secondary/50">
          Modified
        </div>
        {rightLines.map((line, i) => (
          <div key={i} className={`flex ${getSideClass(line.type)}`}>
            <span className="w-10 shrink-0 text-right pr-2 py-px select-none text-muted-foreground/50">
              {line.num ?? ''}
            </span>
            <span className="flex-1 px-2 py-px whitespace-pre-wrap break-all min-w-0">
              {line.text || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DiffLine {
  num: number | null;
  text: string;
  type: 'added' | 'removed' | 'unchanged' | 'pad';
}

function getDiffRowClass(change: Change): string {
  if (change.added) return 'bg-accent/10';
  if (change.removed) return 'bg-destructive/10';
  return '';
}

function getDiffSymbolClass(change: Change): string {
  if (change.added) return 'text-accent';
  if (change.removed) return 'text-destructive';
  return 'text-muted-foreground/30';
}

function getSideClass(type: string): string {
  if (type === 'added') return 'bg-accent/10';
  if (type === 'removed') return 'bg-destructive/10';
  if (type === 'pad') return 'bg-muted/30';
  return '';
}

function countChanges(changes: Change[]): string {
  let added = 0, removed = 0;
  for (const c of changes) {
    const lines = c.value.replace(/\n$/, '').split('\n').length;
    if (c.added) added += lines;
    if (c.removed) removed += lines;
  }
  return `+${added} −${removed}`;
}
