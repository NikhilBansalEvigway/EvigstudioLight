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
  buildWorkspaceTree,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspacePath,
  trashWorkspacePath,
  getFileExtension,
  readWorkspaceFile,
  renameWorkspacePath,
} from '@/lib/fsWorkspace';
import { useAppStore } from '@/store/useAppStore';
import type { FileNode } from '@/types';
import { toast } from 'sonner';

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

function countNodeDescendants(node: FileNode): TreeStats {
  if (node.type === 'file') {
    return { files: 1, directories: 0 };
  }

  let files = 0;
  let directories = 0;
  const walk = (list: FileNode[]) => {
    for (const child of list) {
      if (child.type === 'directory') {
        directories += 1;
        if (child.children?.length) walk(child.children);
      } else {
        files += 1;
      }
    }
  };

  walk(node.children ?? []);
  return { files, directories };
}

function resolveRenamePath(currentPath: string, nextValue: string): string {
  const trimmed = nextValue.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return currentPath;
  if (trimmed.includes('/')) return trimmed;

  const parts = currentPath.split('/');
  parts[parts.length - 1] = trimmed;
  return parts.join('/');
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
      contextFiles,
      fileTree,
      openEditorTabs,
      removeWorkspacePathReferences,
      removeWorkspaceRoot,
      renameWorkspacePathReferences,
      setActiveFile,
      clearWorkspace,
      setFileTree,
      toggleContextFile,
      workspaceRoots,
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
  const deleteStats = deleteTarget ? countNodeDescendants(deleteTarget) : null;
  const deleteMatchesPath = useCallback(
    (candidate: string) => !!deleteTarget && (candidate === deleteTarget.path || candidate.startsWith(`${deleteTarget.path}/`)),
    [deleteTarget],
  );
  const affectedOpenTabs = deleteTarget ? openEditorTabs.filter((tab) => deleteMatchesPath(tab.path)) : [];
  const affectedDirtyTabs = affectedOpenTabs.filter((tab) => tab.content !== tab.savedContent);
  const affectedContextFiles = deleteTarget ? contextFiles.filter((path) => deleteMatchesPath(path)) : [];

  const handleFileClick = useCallback(
    async (node: FileNode) => {
      if (node.type !== 'file' || workspaceRoots.length === 0) return;
      try {
        const content = await readWorkspaceFile(workspaceRoots, node.path);
        setActiveFile(node.path, content);
      } catch (err: any) {
        setActiveFile(node.path, `// Error reading file: ${err.message}`);
      }
    },
    [workspaceRoots, setActiveFile],
  );

  const refreshTree = useCallback(async () => {
    if (workspaceRoots.length === 0) {
      setFileTree([]);
      return;
    }
    try {
      const tree = await buildWorkspaceTree(workspaceRoots);
      setFileTree(tree);
    } catch (err: any) {
      console.error('Refresh tree failed:', err);
      toast.error(`Could not refresh file tree: ${err?.message ?? String(err)}`);
      setFileTree([]);
    }
  }, [workspaceRoots, setFileTree]);

  const handleDelete = useCallback(async (mode: 'trash' | 'delete') => {
    if (!deleteTarget) return;

    if (affectedDirtyTabs.length > 0) {
      const confirmed = window.confirm(
        `Close ${affectedDirtyTabs.length} unsaved tab${affectedDirtyTabs.length === 1 ? '' : 's'} under ${deleteTarget.name}?`,
      );
      if (!confirmed) return;
    }

    try {
      if (deleteTarget.isWorkspaceRoot) {
        if (workspaceRoots.length === 1) {
          clearWorkspace();
        } else {
          removeWorkspacePathReferences(deleteTarget.path);
          removeWorkspaceRoot(deleteTarget.workspaceRootId ?? '');
          const nextRoots = workspaceRoots.filter((root) => root.id !== deleteTarget.workspaceRootId);
          const tree = await buildWorkspaceTree(nextRoots);
          setFileTree(tree);
        }
        toast.success(`Removed ${deleteTarget.name} from the workspace`);
      } else {
        if (mode === 'trash') {
          await trashWorkspacePath(workspaceRoots, deleteTarget.path);
          toast.success(`Moved ${deleteTarget.name} to Trash`);
        } else {
          await deleteWorkspacePath(workspaceRoots, deleteTarget.path);
          toast.success(`Deleted ${deleteTarget.name}`);
        }
        removeWorkspacePathReferences(deleteTarget.path);
        await refreshTree();
      }
    } catch (err: any) {
      console.error('Delete failed:', err);
      toast.error(`Delete failed: ${err.message}`);
    }
    setDeleteTarget(null);
  }, [
    affectedDirtyTabs.length,
    clearWorkspace,
    deleteTarget,
    refreshTree,
    removeWorkspacePathReferences,
    removeWorkspaceRoot,
    setFileTree,
    workspaceRoots,
  ]);

  const handleRename = useCallback(async () => {
    if (!renameTarget || workspaceRoots.length === 0 || !renameName.trim()) return;
    const nextPath = resolveRenamePath(renameTarget.path, renameName);
    try {
      await renameWorkspacePath(workspaceRoots, renameTarget.path, nextPath);
      renameWorkspacePathReferences(renameTarget.path, nextPath);
      if (renameTarget.type === 'file' && activeFilePath === renameTarget.path) {
        const content = await readWorkspaceFile(workspaceRoots, nextPath);
        setActiveFile(nextPath, content);
      }
      await refreshTree();
      toast.success(`Renamed ${renameTarget.name}`);
    } catch (err: any) {
      console.error('Rename failed:', err);
      toast.error(`Rename failed: ${err.message}`);
    }
    setRenameTarget(null);
    setRenameName('');
  }, [renameTarget, workspaceRoots, renameName, activeFilePath, renameWorkspacePathReferences, setActiveFile, refreshTree]);

  const handleCreate = useCallback(async () => {
    if (!createState || workspaceRoots.length === 0 || !createName.trim()) return;
    const fullPath = createState.parentPath ? `${createState.parentPath}/${createName.trim()}` : createName.trim();
    try {
      if (createState.type === 'file') {
        await createWorkspaceFile(workspaceRoots, fullPath);
        await refreshTree();
        const content = await readWorkspaceFile(workspaceRoots, fullPath);
        setActiveFile(fullPath, content);
      } else {
        await createWorkspaceDirectory(workspaceRoots, fullPath);
        await refreshTree();
      }
      toast.success(`Created ${createName.trim()}`);
    } catch (err: any) {
      console.error('Create failed:', err);
      toast.error(`Create failed: ${err.message}`);
    }
    setCreateState(null);
    setCreateName('');
  }, [createState, workspaceRoots, createName, refreshTree, setActiveFile]);

  const openCreate = useCallback((type: 'file' | 'folder', parentPath: string) => {
    setCreateState({ type, parentPath });
    setCreateName('');
  }, []);

  const openRename = useCallback((node: FileNode) => {
    setRenameTarget(node);
    setRenameName(node.name);
  }, []);

  if (fileTree.length === 0) {
    if (workspaceRoots.length > 0) {
      return (
        <div className="flex h-full items-center justify-center p-4 text-center">
          <div className="w-full max-w-[260px] rounded-2xl border border-dashed border-border/70 bg-gradient-to-b from-card via-card to-muted/30 px-5 py-7 shadow-[inset_0_1px_0_hsl(var(--background)/0.9)]">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/15 bg-primary/8 text-primary shadow-sm">
              <FolderOpen className="h-6 w-6 opacity-90" />
            </div>
            <p className="text-sm font-semibold text-foreground">Workspace restored</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Your folders and open tabs were restored for this chat. Click refresh to rebuild the file tree if it is empty.
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void refreshTree()}
                className="rounded-xl border border-border/70 bg-background px-3 py-2 text-[10px] font-medium text-muted-foreground transition-all hover:border-primary/20 hover:text-foreground"
              >
                Refresh tree
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div className="w-full max-w-[240px] rounded-2xl border border-dashed border-border/70 bg-gradient-to-b from-card via-card to-muted/30 px-5 py-7 shadow-[inset_0_1px_0_hsl(var(--background)/0.9)]">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/15 bg-primary/8 text-primary shadow-sm">
            <Folder className="h-6 w-6 opacity-90" />
          </div>
          <p className="text-sm font-semibold text-foreground">No workspace open</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
               Open one or more folders to search files, browse the tree, and jump into the editor.
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
            <AlertDialogTitle>
              {deleteTarget?.isWorkspaceRoot
                ? 'Remove folder from workspace'
                : `Delete ${deleteTarget?.type === 'directory' ? 'folder' : 'file'}`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.isWorkspaceRoot ? (
                <span>
                  Remove <strong>{deleteTarget?.name}</strong> from this workspace? Files stay on disk.
                </span>
              ) : (
                <span>
                  Move <strong>{deleteTarget?.name}</strong> to Trash (recoverable from the workspace folder on disk).
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
              <span className="font-medium text-foreground">Path:</span> {deleteTarget?.path}
            </div>
            {!deleteTarget?.isWorkspaceRoot && deleteTarget?.type === 'directory' && deleteStats && (
              <div>
                Deletes {deleteStats.files} file{deleteStats.files === 1 ? '' : 's'} and {deleteStats.directories} folder{deleteStats.directories === 1 ? '' : 's'} inside this folder.
              </div>
            )}
            {affectedOpenTabs.length > 0 && (
              <div>
                Closes {affectedOpenTabs.length} open tab{affectedOpenTabs.length === 1 ? '' : 's'}{affectedDirtyTabs.length > 0 ? `, including ${affectedDirtyTabs.length} with unsaved changes` : ''}.
              </div>
            )}
            {affectedContextFiles.length > 0 && (
              <div>
                Removes {affectedContextFiles.length} context file{affectedContextFiles.length === 1 ? '' : 's'} from the next agent request.
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {deleteTarget?.isWorkspaceRoot ? (
              <AlertDialogAction onClick={() => handleDelete('trash')}>
                Remove
              </AlertDialogAction>
            ) : (
              <>
                <AlertDialogAction
                  onClick={() => handleDelete('delete')}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete permanently
                </AlertDialogAction>
                <AlertDialogAction onClick={() => handleDelete('trash')}>
                  Move to Trash
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) { setRenameTarget(null); setRenameName(''); } }}>
        <DialogContent className="sm:max-w-sm">
            <DialogHeader>
             <DialogTitle>Rename {renameTarget?.type === 'directory' ? 'folder' : 'file'}</DialogTitle>
            <DialogDescription>
              Use a new name to rename in place, or enter a workspace-relative path to move <strong>{renameTarget?.name}</strong>.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            placeholder={renameTarget?.type === 'directory' ? 'new-folder or src/new-folder' : 'new-name.ext or src/new-name.ext'}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRenameTarget(null); setRenameName(''); }}>Cancel</Button>
            <Button
              onClick={handleRename}
              disabled={!renameName.trim() || resolveRenamePath(renameTarget?.path ?? '', renameName) === (renameTarget?.path ?? '')}
            >
              Rename / Move
            </Button>
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
  const isWorkspaceRoot = node.isWorkspaceRoot === true;

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
            {isWorkspaceRoot && (
              <span className="rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-primary">
                Workspace
              </span>
            )}
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
            {!isWorkspaceRoot && (
              <button
                type="button"
                onClick={() => onRename(node)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
                title="Rename or move folder"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onDelete(node)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
              title={isWorkspaceRoot ? 'Remove folder from workspace' : 'Delete folder'}
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
            title="Rename or move file"
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
