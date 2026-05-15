import { DiffEditor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { monacoLanguageFromPath } from '@/lib/monacoLanguageFromPath';

loader.config({ monaco });

/** Cheap stable fingerprint so Monaco remounts when either side’s text changes (DiffEditor can otherwise stay stale). */
function fnv1a32(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export type FileDiffViewerProps = {
  filePath: string;
  /** Left: last saved / baseline (e.g. `savedContent`). */
  original: string;
  /** Right: current buffer (e.g. editor `content`). */
  modified: string;
  /** Visual theme from app shell. */
  colorMode: 'dark' | 'light';
  /** Outer height (Monaco needs a numeric or px height). */
  height?: string | number;
  className?: string;
};

function defineDiffThemes(m: typeof monaco) {
  m.editor.defineTheme('evig-diff-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'diffEditor.insertedTextBackground': '#23782355',
      'diffEditor.insertedLineBackground': '#23782333',
      'diffEditor.removedTextBackground': '#8b1e1e55',
      'diffEditor.removedLineBackground': '#8b1e1e33',
      'diffEditor.border': '#3c3c3c',
      'diffEditor.diagonalFill': '#33333388',
    },
  });
  m.editor.defineTheme('evig-diff-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'diffEditor.insertedTextBackground': '#abf2bc99',
      'diffEditor.insertedLineBackground': '#e6ffedcc',
      'diffEditor.removedTextBackground': '#ffb3b399',
      'diffEditor.removedLineBackground': '#ffebe9cc',
      'diffEditor.border': '#d0d7de',
      'diffEditor.diagonalFill': '#e8e8e888',
    },
  });
}

/**
 * Side-by-side Monaco diff (GitHub-style insert/remove backgrounds).
 */
export function FileDiffViewer({
  filePath,
  original,
  modified,
  colorMode,
  height = 320,
  className = '',
}: FileDiffViewerProps) {
  const language = monacoLanguageFromPath(filePath);
  const theme = colorMode === 'dark' ? 'evig-diff-dark' : 'evig-diff-light';
  const modelKey = `${filePath}:${fnv1a32(original)}:${fnv1a32(modified)}`;

  return (
    <div className={`min-h-0 min-w-0 overflow-hidden rounded-md border border-border ${className}`}>
      <DiffEditor
        key={modelKey}
        height={height}
        width="100%"
        theme={theme}
        language={language}
        original={original}
        modified={modified}
        loading={<div className="p-4 text-xs text-muted-foreground">Loading diff…</div>}
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineNumbers: 'on',
          originalEditable: false,
          modifiedEditable: false,
        }}
        beforeMount={(m) => {
          defineDiffThemes(m);
        }}
      />
    </div>
  );
}
