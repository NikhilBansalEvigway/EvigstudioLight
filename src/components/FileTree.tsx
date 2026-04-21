import { useDeferredValue, useState, useCallback } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  BookOpen,
  Braces,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  buildFileTree,
  createDirectory,
  createFile,
  deleteFileOrDir,
  getFileExtension,
  readFile,
  renameFileOrDir,
} from '@/lib/fsWorkspace';
import { useAppStore } from '@/store/useAppStore';
import type { FileNode } from '@/types';

type TreeStats = {
  files: number;
  directories: number;
};

function countTreeStats(nodes: FileNode[]): TreeStats {
  let files = 0;
  let directories = 0;

  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'directory') {
        directories += 1;
        if (node.children?.length) walk(node.children);
      } else {
        files += 1;
      }
    }
  };

  walk(nodes);
  return { files, directories };
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const filterNode = (node: FileNode): FileNode | null => {
    const selfMatches = node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q);

    if (node.type === 'file') {
      return selfMatches ? node : null;
    }

    const children = node.children?.map(filterNode).filter((child): child is FileNode => child !== null) ?? [];
    if (selfMatches || children.length > 0) {
      return { ...node, children };
    }
    return null;
  };

  return nodes.map(filterNode).filter((node): node is FileNode => node !== null);
}

function highlightLabel(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const start = text.toLowerCase().indexOf(q.toLowerCase());
  if (start === -1) return text;
  const end = start + q.length;
  return (
    <>
      {text.slice(0, start)}
      <span className="rounded bg-primary/15 px-0.5 text-primary">{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  );
}

function getFileVisual(name: string): { Icon: LucideIcon; iconClassName: string; accentClassName: string } {
  const ext = getFileExtension(name).toLowerCase();

  if (['.ts', '.tsx', '.js', '.jsx', '.c', '.cpp', '.h', '.hpp', '.java', '.cs', '.go', '.rs'].includes(ext)) {
    return {
      Icon: FileCode2,
      iconClassName: 'text-sky-500 dark:text-sky-400',
      accentClassName: 'from-sky-500/12 to-cyan-500/5 border-sky-500/15',
    };
  }
  if (['.json', '.yaml', '.yml', '.toml', '.xml'].includes(ext)) {
    return {
      Icon: Braces,
      iconClassName: 'text-violet-500 dark:text-violet-400',
      accentClassName: 'from-violet-500/12 to-fuchsia-500/5 border-violet-500/15',
    };
  }
  if (['.md', '.txt', '.ini', '.cfg'].includes(ext)) {
    return {
      Icon: FileText,
      iconClassName: 'text-amber-500 dark:text-amber-400',
      accentClassName: 'from-amber-500/12 to-orange-500/5 border-amber-500/15',
    };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
    return {
      Icon: FileImage,
      iconClassName: 'text-emerald-500 dark:text-emerald-400',
      accentClassName: 'from-emerald-500/12 to-lime-500/5 border-emerald-500/15',
    };
  }
  if (['.sh', '.bat', '.ps1', '.py'].includes(ext)) {
    return {
      Icon: Terminal,
      iconClassName: 'text-rose-500 dark:text-rose-400',
      accentClassName: 'from-rose-500/12 to-pink-500/5 border-rose-500/15',
    };
  }

  return {
    Icon: File,
    iconClassName: 'text-muted-foreground',
    accentClassName: 'from-muted/50 to-transparent border-border/70',
  };
}

export function FileTree() {
  const {
    activeFilePath,
    closeEditorFile,
    contextFiles,
    fileTree,
    renameEditorFile,
    setActiveFile,
    setFileTree,
    toggleContextFile,
    workspaceHandle,
  } = useAppStore();

  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileNode | null>(null);
  const [renameName, setRenameName] = useState('');
  const [createState, setCreateState] = useState<{ type: 'file' | 'folder'; parentPath: string } | null>(null);
  const [createName, setCreateName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const deferredQuery = useDeferredValue(searchQuery);
  const filteredTree = filterTree(fileTree, deferredQuery);
  const totalStats = countTreeStats(fileTree);
  const filteredStats = countTreeStats(filteredTree);
  const searching = deferredQuery.trim().length > 0;

  const handleFileClick = useCallback(
    async (node: FileNode) => {
      if (node.type !== 'file' || !workspaceHandle) return;
      try {
        const content = await readFile(workspaceHandle, node.path);
        setActiveFile(node.path, content);
      } catch (err: any) {
        setActiveFile(node.path, `// Error reading file: ${err.message}`);
      }
    },
    [workspaceHandle, setActiveFile],
  );

  const refreshTree = useCallback(async () => {
    if (!workspaceHandle) return;
    const tree = await buildFileTree(workspaceHandle);
    setFileTree(tree);
  }, [workspaceHandle, setFileTree]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget || !workspaceHandle) return;
    try {
      await deleteFileOrDir(workspaceHandle, deleteTarget.path);
      closeEditorFile(deleteTarget.path);
      await refreshTree();
    } catch (err: any) {
      console.error('Delete failed:', err);
    }
    setDeleteTarget(null);
  }, [deleteTarget, workspaceHandle, closeEditorFile, refreshTree]);

  const handleRename = useCallback(async () => {
    if (!renameTarget || !workspaceHandle || !renameName.trim()) return;
    try {
      await renameFileOrDir(workspaceHandle, renameTarget.path, renameName.trim());
      const parts = renameTarget.path.split('/');
      parts[parts.length - 1] = renameName.trim();
      const newPath = parts.join('/');
      const content = await readFile(workspaceHandle, newPath);
      renameEditorFile(renameTarget.path, newPath, content);
      if (activeFilePath === renameTarget.path) {
        setActiveFile(newPath, content);
      }
      await refreshTree();
    } catch (err: any) {
      console.error('Rename failed:', err);
    }
    setRenameTarget(null);
    setRenameName('');
  }, [renameTarget, workspaceHandle, renameName, activeFilePath, renameEditorFile, setActiveFile, refreshTree]);

  const handleCreate = useCallback(async () => {
    if (!createState || !workspaceHandle || !createName.trim()) return;
    const fullPath = createState.parentPath ? `${createState.parentPath}/${createName.trim()}` : createName.trim();
    try {
      if (createState.type === 'file') {
        await createFile(workspaceHandle, fullPath);
        await refreshTree();
        const content = await readFile(workspaceHandle, fullPath);
        setActiveFile(fullPath, content);
      } else {
        await createDirectory(workspaceHandle, fullPath);
        await refreshTree();
      }
    } catch (err: any) {
      console.error('Create failed:', err);
    }
    setCreateState(null);
    setCreateName('');
  }, [createState, workspaceHandle, createName, refreshTree, setActiveFile]);

  const openCreate = useCallback((type: 'file' | 'folder', parentPath: string) => {
    setCreateState({ type, parentPath });
    setCreateName('');
  }, []);

  const openRename = useCallback((node: FileNode) => {
    setRenameTarget(node);
    setRenameName(node.name);
  }, []);

  if (fileTree.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div className="w-full max-w-[240px] rounded-2xl border border-dashed border-border/70 bg-gradient-to-b from-card via-card to-muted/30 px-5 py-7 shadow-[inset_0_1px_0_hsl(var(--background)/0.9)]">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/15 bg-primary/8 text-primary shadow-sm">
            <Folder className="h-6 w-6 opacity-90" />
          </div>
          <p className="text-sm font-semibold text-foreground">No workspace open</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Open a folder to search files, browse the tree, and jump into the editor.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="border-b border-border/80 bg-gradient-to-b from-background via-background to-muted/20 px-2 pb-2 pt-2">
          <div className="rounded-2xl border border-border/70 bg-card/80 p-2 shadow-[0_10px_30px_hsl(var(--background)/0.16)] backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className={`pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-colors ${searching ? 'text-primary' : 'text-muted-foreground'}`} />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search files by name or path"
                  className="h-9 rounded-xl border-border/70 bg-muted/40 pl-9 pr-9 text-xs shadow-inner transition-all focus-visible:ring-1 focus-visible:ring-primary/50"
                />
                {searching ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    title="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <Sparkles className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-primary/60" />
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => openCreate('file', '')}
                  className="rounded-xl border border-border/70 bg-background px-2.5 py-2 text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:text-primary"
                  title="New file"
                >
                  <FilePlus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => openCreate('folder', '')}
                  className="rounded-xl border border-border/70 bg-background px-2.5 py-2 text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:text-primary"
                  title="New folder"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground animate-fade-in">
              <span className="rounded-full border border-border/70 bg-background px-2 py-1">
                {totalStats.files} files
              </span>
              <span className="rounded-full border border-border/70 bg-background px-2 py-1">
                {totalStats.directories} folders
              </span>
              {searching && (
                <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-primary">
                  {filteredStats.files} matching files
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 text-xs">
          {searching && filteredTree.length === 0 ? (
            <div className="mx-1 mt-3 rounded-2xl border border-dashed border-border/70 bg-muted/20 p-5 text-center animate-fade-in">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Search className="h-4 w-4" />
              </div>
              <div className="text-sm font-medium text-foreground">No files match</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Try a different filename, extension, or folder path.
              </div>
            </div>
          ) : (
            filteredTree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                searchQuery={deferredQuery}
                forceExpanded={searching}
                activeFilePath={activeFilePath}
                onFileClick={handleFileClick}
                contextFiles={contextFiles}
                onToggleContext={toggleContextFile}
                onDelete={setDeleteTarget}
                onRename={openRename}
                onCreate={openCreate}
              />
            ))
          )}
        </div>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.type === 'directory' ? 'folder' : 'file'}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) { setRenameTarget(null); setRenameName(''); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename {renameTarget?.type === 'directory' ? 'folder' : 'file'}</DialogTitle>
            <DialogDescription>Enter a new name for <strong>{renameTarget?.name}</strong></DialogDescription>
          </DialogHeader>
          <Input
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRenameTarget(null); setRenameName(''); }}>Cancel</Button>
            <Button onClick={handleRename} disabled={!renameName.trim() || renameName === renameTarget?.name}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!createState} onOpenChange={(open) => { if (!open) { setCreateState(null); setCreateName(''); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New {createState?.type === 'folder' ? 'Folder' : 'File'}</DialogTitle>
            <DialogDescription>
              {createState?.parentPath ? <>Create in <strong>{createState.parentPath}/</strong></> : 'Create in workspace root'}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={createState?.type === 'folder' ? 'folder-name' : 'filename.ext'}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateState(null); setCreateName(''); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!createName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TreeNode({
  node,
  depth,
  searchQuery,
  forceExpanded,
  activeFilePath,
  onFileClick,
  contextFiles,
  onToggleContext,
  onDelete,
  onRename,
  onCreate,
}: {
  node: FileNode;
  depth: number;
  searchQuery: string;
  forceExpanded: boolean;
  activeFilePath: string | null;
  onFileClick: (n: FileNode) => void;
  contextFiles: string[];
  onToggleContext: (path: string) => void;
  onDelete: (n: FileNode) => void;
  onRename: (n: FileNode) => void;
  onCreate: (type: 'file' | 'folder', parentPath: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isContext = contextFiles.includes(node.path);
  const isActive = activeFilePath === node.path;
  const isSearchMode = searchQuery.trim().length > 0;
  const isExpanded = forceExpanded || expanded;

  if (node.type === 'directory') {
    return (
      <div>
        <div className="group flex items-center gap-1 py-0.5">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-all hover:bg-secondary/60 hover:shadow-sm"
            style={{ marginLeft: `${depth * 12}px` }}
          >
            <span className={`rounded-md border border-border/60 bg-background/70 p-0.5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
              <ChevronRight className="h-3 w-3" />
            </span>
            <span className={`rounded-lg p-1 ${isExpanded ? 'bg-primary/12 text-primary' : 'bg-secondary/60 text-muted-foreground'}`}>
              {isExpanded ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
            </span>
            <span className="min-w-0 truncate font-medium text-foreground">{highlightLabel(node.name, searchQuery)}</span>
          </button>
          <div className="flex items-center gap-0.5 pr-1 opacity-0 transition-all group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onCreate('file', node.path)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
              title="New file here"
            >
              <FilePlus className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onCreate('folder', node.path)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
              title="New folder here"
            >
              <FolderPlus className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(node)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
              title="Delete folder"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
        {isExpanded &&
          node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              searchQuery={searchQuery}
              forceExpanded={forceExpanded}
              activeFilePath={activeFilePath}
              onFileClick={onFileClick}
              contextFiles={contextFiles}
              onToggleContext={onToggleContext}
              onDelete={onDelete}
              onRename={onRename}
              onCreate={onCreate}
            />
          ))}
      </div>
    );
  }

  const visual = getFileVisual(node.name);
  const Icon = visual.Icon;

  return (
    <div className="group py-0.5" style={{ marginLeft: `${depth * 12}px` }}>
      <div
        className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 transition-all ${isActive
          ? `bg-gradient-to-r ${visual.accentClassName} shadow-sm`
          : 'border-transparent hover:border-border/70 hover:bg-secondary/50'} ${isSearchMode ? 'animate-fade-in' : ''}`}
      >
        <button
          type="button"
          onClick={() => onFileClick(node)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className={`rounded-lg p-1 ${isActive ? 'bg-background/80 shadow-sm' : 'bg-background/50'} ${visual.iconClassName}`}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className={`truncate transition-colors ${isActive ? 'font-semibold text-foreground' : 'text-foreground/90 group-hover:text-foreground'}`}>
              {highlightLabel(node.name, searchQuery)}
            </div>
            {isSearchMode && (
              <div className="truncate text-[10px] text-muted-foreground">{highlightLabel(node.path, searchQuery)}</div>
            )}
          </div>
        </button>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleContext(node.path);
            }}
            className={`rounded-md p-1 transition-all ${isContext
              ? 'bg-primary/12 text-primary shadow-sm'
              : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-secondary hover:text-primary'}`}
            title={isContext ? 'Remove from context' : 'Add to context'}
          >
            <BookOpen className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRename(node);
            }}
            className="rounded-md p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-secondary hover:text-primary"
            title="Rename file"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node);
            }}
            className="rounded-md p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-secondary hover:text-destructive"
            title="Delete file"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
