import { useAppStore } from '@/store/useAppStore';
import type { FileNode } from '@/types';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Plus, BookOpen, Pencil, Trash2, FilePlus, FolderPlus } from 'lucide-react';
import { useState, useCallback } from 'react';
import { readFile, deleteFileOrDir, renameFileOrDir, buildFileTree, createFile, createDirectory } from '@/lib/fsWorkspace';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function FileTree() {
  const { fileTree, workspaceHandle, contextFiles, toggleContextFile, setActiveFile, setFileTree, activeFilePath } = useAppStore();

  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileNode | null>(null);
  const [renameName, setRenameName] = useState('');
  // Create state: { type, parentPath }
  const [createState, setCreateState] = useState<{ type: 'file' | 'folder'; parentPath: string } | null>(null);
  const [createName, setCreateName] = useState('');

  const handleFileClick = useCallback(async (node: FileNode) => {
    if (node.type !== 'file' || !workspaceHandle) return;
    try {
      const content = await readFile(workspaceHandle, node.path);
      setActiveFile(node.path, content);
    } catch (err: any) {
      setActiveFile(node.path, `// Error reading file: ${err.message}`);
    }
  }, [workspaceHandle, setActiveFile]);

  const refreshTree = useCallback(async () => {
    if (!workspaceHandle) return;
    const tree = await buildFileTree(workspaceHandle);
    setFileTree(tree);
  }, [workspaceHandle, setFileTree]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget || !workspaceHandle) return;
    try {
      await deleteFileOrDir(workspaceHandle, deleteTarget.path);
      if (activeFilePath === deleteTarget.path) setActiveFile(null, '');
      await refreshTree();
    } catch (err: any) {
      console.error('Delete failed:', err);
    }
    setDeleteTarget(null);
  }, [deleteTarget, workspaceHandle, activeFilePath, setActiveFile, refreshTree]);

  const handleRename = useCallback(async () => {
    if (!renameTarget || !workspaceHandle || !renameName.trim()) return;
    try {
      await renameFileOrDir(workspaceHandle, renameTarget.path, renameName.trim());
      if (activeFilePath === renameTarget.path) {
        const parts = renameTarget.path.split('/');
        parts[parts.length - 1] = renameName.trim();
        const newPath = parts.join('/');
        const content = await readFile(workspaceHandle, newPath);
        setActiveFile(newPath, content);
      }
      await refreshTree();
    } catch (err: any) {
      console.error('Rename failed:', err);
    }
    setRenameTarget(null);
    setRenameName('');
  }, [renameTarget, workspaceHandle, renameName, activeFilePath, setActiveFile, refreshTree]);

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
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground p-4 text-center">
        <div className="space-y-2">
          <Folder className="w-8 h-8 mx-auto opacity-30" />
          <p>No workspace open</p>
          <p className="text-[10px]">Click "Open Folder" to browse files</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="text-xs overflow-y-auto p-1">
        {/* Root-level create buttons */}
        <div className="flex items-center justify-end gap-1 px-1 pb-1 mb-1 border-b border-border">
          <button onClick={() => openCreate('file', '')} className="p-1 rounded text-muted-foreground hover:text-primary transition-colors" title="New file">
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => openCreate('folder', '')} className="p-1 rounded text-muted-foreground hover:text-primary transition-colors" title="New folder">
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </div>
        {fileTree.map(node => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            onFileClick={handleFileClick}
            contextFiles={contextFiles}
            onToggleContext={toggleContextFile}
            onDelete={setDeleteTarget}
            onRename={openRename}
            onCreate={openCreate}
          />
        ))}
      </div>

      {/* Delete confirmation */}
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

      {/* Rename dialog */}
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

      {/* Create dialog */}
      <Dialog open={!!createState} onOpenChange={(open) => { if (!open) { setCreateState(null); setCreateName(''); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New {createState?.type === 'folder' ? 'Folder' : 'File'}</DialogTitle>
            <DialogDescription>
              {createState?.parentPath
                ? <>Create in <strong>{createState.parentPath}/</strong></>
                : 'Create in workspace root'}
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

function TreeNode({ node, depth, onFileClick, contextFiles, onToggleContext, onDelete, onRename, onCreate }: {
  node: FileNode;
  depth: number;
  onFileClick: (n: FileNode) => void;
  contextFiles: string[];
  onToggleContext: (path: string) => void;
  onDelete: (n: FileNode) => void;
  onRename: (n: FileNode) => void;
  onCreate: (type: 'file' | 'folder', parentPath: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isContext = contextFiles.includes(node.path);

  if (node.type === 'directory') {
    return (
      <div>
        <div className="group flex items-center">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex-1 flex items-center gap-1 px-1 py-0.5 rounded hover:bg-secondary/50 transition-colors"
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            {expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
            {expanded ? <FolderOpen className="w-3.5 h-3.5 text-primary shrink-0" /> : <Folder className="w-3.5 h-3.5 text-primary shrink-0" />}
            <span className="truncate">{node.name}</span>
          </button>
          <div className="flex items-center opacity-0 group-hover:opacity-100 transition-all pr-1">
            <button onClick={() => onCreate('file', node.path)} className="p-0.5 rounded text-muted-foreground hover:text-primary transition-colors" title="New file here">
              <FilePlus className="w-3 h-3" />
            </button>
            <button onClick={() => onCreate('folder', node.path)} className="p-0.5 rounded text-muted-foreground hover:text-primary transition-colors" title="New folder here">
              <FolderPlus className="w-3 h-3" />
            </button>
            <button onClick={() => onDelete(node)} className="p-0.5 rounded text-muted-foreground hover:text-destructive transition-colors" title="Delete folder">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
        {expanded && node.children?.map(child => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
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

  return (
    <div
      className="group flex items-center gap-1 px-1 py-0.5 rounded hover:bg-secondary/50 transition-colors cursor-pointer"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <File className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <button onClick={() => onFileClick(node)} className="flex-1 text-left truncate hover:text-primary transition-colors">
        {node.name}
      </button>
      <div className="flex items-center gap-0.5">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleContext(node.path); }}
          className={`p-0.5 rounded transition-all ${
            isContext
              ? 'text-accent opacity-100'
              : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary'
          }`}
          title={isContext ? 'Remove from context' : 'Add to context'}
        >
          {isContext ? <BookOpen className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRename(node); }}
          className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all"
          title="Rename file"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(node); }}
          className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
          title="Delete file"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}