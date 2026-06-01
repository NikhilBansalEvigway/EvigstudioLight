import { useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { langs } from '@uiw/codemirror-extensions-langs';
import { EditorView, keymap } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';

/**
 * Offline-friendly code editor built on CodeMirror 6 (no web workers, no CDN loader),
 * replacing the previous Monaco editor which failed to run from a self-hosted image.
 */

type LangFactory = () => Extension;

// Map common file extensions to a CodeMirror language extension. Falls back to plain text.
const EXT_TO_LANG: Record<string, LangFactory> = {
  js: langs.js, mjs: langs.js, cjs: langs.js,
  jsx: langs.jsx,
  ts: langs.ts, mts: langs.ts, cts: langs.ts,
  tsx: langs.tsx,
  py: langs.python, pyw: langs.python, pyi: langs.python,
  c: langs.c, h: langs.c,
  cpp: langs.cpp, cc: langs.cpp, cxx: langs.cpp, hpp: langs.cpp, hh: langs.cpp, hxx: langs.cpp,
  java: langs.java,
  json: langs.json, jsonc: langs.json,
  md: langs.markdown, markdown: langs.markdown,
  html: langs.html, htm: langs.html,
  css: langs.css,
  scss: langs.scss, sass: langs.sass, less: langs.less,
  xml: langs.xml, svg: langs.xml, xsd: langs.xml, xsl: langs.xml, xslt: langs.xml,
  yaml: langs.yaml, yml: langs.yaml,
  sql: langs.sql,
  rs: langs.rs,
  go: langs.go,
  php: langs.php, php3: langs.php, php4: langs.php, php5: langs.php, phtml: langs.php,
  sh: langs.sh, bash: langs.sh, zsh: langs.sh, ksh: langs.sh,
  kt: langs.kt, kts: langs.kt,
  rb: langs.rb,
  swift: langs.swift,
  toml: langs.toml,
  lua: langs.lua,
  dart: langs.dart,
  vue: langs.vue,
  svelte: langs.svelte,
  vhd: langs.vhdl, vhdl: langs.vhdl,
  v: langs.sv, sv: langs.sv, svh: langs.sv,
  m: langs.cpp, mm: langs.cpp,
};

function getExtension(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function languageExtensions(filePath: string): Extension[] {
  const factory = EXT_TO_LANG[getExtension(filePath)];
  if (!factory) return [];
  try {
    return [factory()];
  } catch {
    return [];
  }
}

// Make the editor fill its container and scroll internally (mirrors Monaco's height="100%").
const fillHeightTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace",
  },
  '.cm-content': { paddingTop: '8px' },
});

interface CodeMirrorEditorProps {
  filePath: string;
  value: string;
  onChange: (value: string) => void;
  theme: 'dark' | 'light';
  readOnly?: boolean;
  onSave?: () => void;
  onSaveAll?: () => void;
}

export function CodeMirrorEditor({
  filePath,
  value,
  onChange,
  theme,
  readOnly = false,
  onSave,
  onSaveAll,
}: CodeMirrorEditorProps) {
  // Keep save callbacks in refs so the keymap extension stays stable across renders.
  const onSaveRef = useRef(onSave);
  const onSaveAllRef = useRef(onSaveAll);
  onSaveRef.current = onSave;
  onSaveAllRef.current = onSaveAll;

  const saveKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          {
            key: 'Mod-Shift-s',
            preventDefault: true,
            run: () => {
              onSaveAllRef.current?.();
              return true;
            },
          },
        ]),
      ),
    [],
  );

  const extensions = useMemo(
    () => [...languageExtensions(filePath), saveKeymap, EditorView.lineWrapping, fillHeightTheme],
    [filePath, saveKeymap],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height="100%"
      theme={theme === 'dark' ? githubDark : githubLight}
      extensions={extensions}
      readOnly={readOnly}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
      }}
      style={{ height: '100%' }}
    />
  );
}
