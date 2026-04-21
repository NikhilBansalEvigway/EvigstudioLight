import { useAppStore } from '@/store/useAppStore';
import { FileTree } from '@/components/FileTree';
import { pickDirectory, buildFileTree, isFileSystemAccessSupported, writeFile, getFileExtension } from '@/lib/fsWorkspace';
import { SYSTEM_PROMPT } from '@/types';
import { FolderOpen, FileCode, BookOpen, Terminal, Save, AlertTriangle, FilePlus } from 'lucide-react';
import { toast } from 'sonner';
import { useState, useCallback } from 'react';
import { useTheme } from 'next-themes';
import Editor from '@monaco-editor/react';

function getMonacoLanguage(filePath: string): string {
  const ext = getFileExtension(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.m': 'matlab', '.vhd': 'vhdl', '.vhdl': 'vhdl',
    '.js': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.json': 'json', '.md': 'markdown', '.py': 'python',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.html': 'html', '.css': 'css', '.xml': 'xml',
    '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shell',
    '.v': 'systemverilog', '.sv': 'systemverilog',
    '.txt': 'plaintext', '.ini': 'ini', '.toml': 'plaintext',
  };
  return map[ext] || 'plaintext';
}

export function WorkspacePane() {
  const {
    rightPaneTab, setRightPaneTab,
    workspaceHandle, setWorkspaceHandle, setFileTree,
    activeFilePath, activeFileContent, setActiveFileContent,
    contextFiles, toggleContextFile, clearContextFiles,
  } = useAppStore();

  const { resolvedTheme } = useTheme();
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);

  const fsSupported = isFileSystemAccessSupported();

  const handleOpenFolder = async () => {
    if (!fsSupported) {
      toast.error('File System Access API not supported. Use Chrome or Edge.');
      return;
    }
    const handle = await pickDirectory();
    if (handle) {
      setWorkspaceHandle(handle);
      const tree = await buildFileTree(handle);
      setFileTree(tree);
      toast.success(`Opened: ${handle.name}`);
    }
  };

  const handleRefresh = async () => {
    if (workspaceHandle) {
      const tree = await buildFileTree(workspaceHandle);
      setFileTree(tree);
    }
  };

  const handleSave = async () => {
    if (!workspaceHandle || !activeFilePath) return;
    try {
      await writeFile(workspaceHandle, activeFilePath, activeFileContent);
      toast.success(`Saved ${activeFilePath} ✅`);
      handleRefresh();
    } catch (err: any) {
      toast.error(`Save failed: ${err.message}`);
    }
  };

  const handleCreateFile = async () => {
    if (!workspaceHandle || !newFileName.trim()) return;
    try {
      await writeFile(workspaceHandle, newFileName.trim(), '');
      toast.success(`Created ${newFileName.trim()}`);
      setNewFileName('');
      setShowNewFile(false);
      handleRefresh();
    } catch (err: any) {
      toast.error(`Create failed: ${err.message}`);
    }
  };

  const tabs = [
    { id: 'files' as const, label: 'Files', icon: FolderOpen },
    { id: 'editor' as const, label: 'Editor', icon: FileCode },
    { id: 'context' as const, label: 'Context', icon: BookOpen },
  ];

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Tabs */}
      <div className="flex border-b border-border">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setRightPaneTab(tab.id)}
            className={`flex items-center gap-1 px-3 py-2 text-[10px] uppercase tracking-wider font-semibold transition-colors border-b-2 ${rightPaneTab === tab.id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
          >
            <tab.icon className="w-3 h-3" />
            {tab.label}
            {tab.id === 'context' && contextFiles.length > 0 && (
              <span className="ml-1 px-1 py-px rounded-full bg-accent/20 text-accent text-[9px]">{contextFiles.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {rightPaneTab === 'files' && (
          <div className="flex flex-col h-full">
            <div className="border-b border-border bg-gradient-to-b from-card via-card to-muted/20 px-2 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={handleOpenFolder}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary transition-all hover:-translate-y-0.5 hover:bg-primary/15"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {workspaceHandle ? 'Change Folder' : 'Open Folder'}
                </button>
                {workspaceHandle && (
                  <>
                    <button
                      onClick={handleRefresh}
                      className="rounded-xl border border-border/70 bg-background px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground transition-all hover:border-primary/20 hover:text-foreground"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={() => setShowNewFile(!showNewFile)}
                      className={`rounded-xl border px-2.5 py-1.5 text-[10px] font-medium transition-all ${showNewFile
                        ? 'border-primary/20 bg-primary/10 text-primary'
                        : 'border-border/70 bg-background text-muted-foreground hover:border-primary/20 hover:text-primary'}`}
                      title="Quick create file"
                    >
                      <span className="inline-flex items-center gap-1">
                        <FilePlus className="h-3.5 w-3.5" />
                        Quick file
                      </span>
                    </button>
                  </>
                )}
              </div>
            </div>
            {!fsSupported && (
              <div className="flex items-start gap-2 border-b border-warning/20 bg-warning/10 px-3 py-2 text-[10px]">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                <span className="text-warning">File System Access requires Chrome or Edge. Firefox/Safari not supported.</span>
              </div>
            )}
            {showNewFile && workspaceHandle && (
              <div className="flex items-center gap-1.5 border-b border-border px-2 py-2 animate-fade-in">
                <input
                  value={newFileName}
                  onChange={e => setNewFileName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateFile()}
                  placeholder="path/to/file.vhd"
                  className="flex-1 rounded-xl border border-border/70 bg-input px-3 py-2 text-[10px] outline-none focus:ring-1 focus:ring-ring"
                />
                <button onClick={handleCreateFile} className="rounded-xl bg-accent/15 px-3 py-2 text-[10px] font-semibold text-accent transition-colors hover:bg-accent/25">Create</button>
              </div>
            )}
            {workspaceHandle && (
              <div className="border-b border-border/60 px-2 py-1.5 text-[10px] text-muted-foreground">
                <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1">
                  <FolderOpen className="h-3 w-3 text-primary" />
                  <span className="max-w-[220px] truncate font-medium text-foreground/90">{workspaceHandle.name}</span>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              <FileTree />
            </div>
          </div>
        )}

        {rightPaneTab === 'editor' && (
          <div className="flex flex-col h-full">
            {activeFilePath ? (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
                  <span className="text-[10px] text-muted-foreground truncate">{activeFilePath}</span>
                  <button
                    onClick={handleSave}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent text-[10px] hover:bg-accent/25 transition-colors"
                  >
                    <Save className="w-3 h-3" /> Save
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <Editor
                    height="100%"
                    language={getMonacoLanguage(activeFilePath)}
                    value={activeFileContent}
                    onChange={(v) => setActiveFileContent(v ?? '')}
                    theme={resolvedTheme === 'dark' ? 'agent-dark' : 'agent-light'}
                    beforeMount={(monaco) => {
                      monaco.editor.defineTheme('agent-dark', {
                        base: 'vs-dark',
                        inherit: true,
                        rules: [
                          { token: 'comment', foreground: '546E7A', fontStyle: 'italic' },
                          { token: 'keyword', foreground: '17b8a6' },
                          { token: 'string', foreground: '4ade80' },
                          { token: 'number', foreground: 'f59e0b' },
                          { token: 'type', foreground: '60a5fa' },
                        ],
                        colors: {
                          'editor.background': '#0d1017',
                          'editor.foreground': '#d4d8e0',
                          'editor.lineHighlightBackground': '#141b24',
                          'editorCursor.foreground': '#17b8a6',
                          'editor.selectionBackground': '#17b8a633',
                          'editorLineNumber.foreground': '#374151',
                          'editorLineNumber.activeForeground': '#6b7280',
                          'editorGutter.background': '#0d1017',
                          'editorWidget.background': '#141b24',
                          'input.background': '#141b24',
                          'input.foreground': '#d4d8e0',
                          'input.border': '#1e2a36',
                        },
                      });
                      monaco.editor.defineTheme('agent-light', {
                        base: 'vs',
                        inherit: true,
                        rules: [
                          { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
                          { token: 'keyword', foreground: '0d9488' },
                          { token: 'string', foreground: '16a34a' },
                          { token: 'number', foreground: 'd97706' },
                          { token: 'type', foreground: '2563eb' },
                        ],
                        colors: {
                          'editor.background': '#f5f6f8',
                          'editor.foreground': '#1e293b',
                          'editor.lineHighlightBackground': '#e8ecf1',
                          'editorCursor.foreground': '#0d9488',
                          'editor.selectionBackground': '#0d948833',
                          'editorLineNumber.foreground': '#94a3b8',
                          'editorLineNumber.activeForeground': '#64748b',
                          'editorGutter.background': '#f5f6f8',
                          'editorWidget.background': '#eef0f4',
                          'input.background': '#eef0f4',
                          'input.foreground': '#1e293b',
                          'input.border': '#d1d5db',
                        },
                      });
                    }}
                    onMount={(editor, monaco) => {
                      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handleSave());
                    }}
                    options={{
                      fontSize: 12,
                      fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace",
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      padding: { top: 8 },
                      lineNumbers: 'on',
                      renderLineHighlight: 'line',
                      bracketPairColorization: { enabled: true },
                      automaticLayout: true,
                      wordWrap: 'on',
                      tabSize: 2,
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Select a file to edit
              </div>
            )}
          </div>
        )}

        {rightPaneTab === 'context' && (
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Injected Files</span>
              {contextFiles.length > 0 && (
                <button onClick={clearContextFiles} className="text-[10px] text-destructive hover:underline">Clear all</button>
              )}
            </div>
            {contextFiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No files in context. Click the + icon next to files in the file tree to add them.
              </p>
            ) : (
              <div className="space-y-1">
                {contextFiles.map(path => (
                  <div key={path} className="flex items-center gap-2 px-2 py-1 rounded bg-secondary text-xs">
                    <FileCode className="w-3 h-3 text-primary shrink-0" />
                    <span className="flex-1 truncate">{path}</span>
                    <button onClick={() => toggleContextFile(path)} className="text-muted-foreground hover:text-destructive">×</button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-4">
              Context files are injected into the agent's next request so it can read and edit them.
            </p>
          </div>
        )}

        {rightPaneTab === 'prompt' && (
          <div className="p-3">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">System Prompt (Read-Only)</span>
            <pre className="mt-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap bg-secondary rounded p-3 max-h-[calc(100vh-200px)] overflow-y-auto">
              {SYSTEM_PROMPT}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
