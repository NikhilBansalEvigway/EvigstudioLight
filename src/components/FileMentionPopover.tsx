import { useState, useEffect, useRef, useMemo } from 'react';
import type { FileNode } from '@/types';
import { File, Folder, Hash } from 'lucide-react';

interface FileMentionPopoverProps {
    fileTree: FileNode[];
    query: string;
    onSelect: (filePath: string) => void;
    onClose: () => void;
    visible: boolean;
}

/** Flatten a FileNode tree into a list of file paths */
function flattenFileTree(nodes: FileNode[], result: { name: string; path: string; type: string }[] = []): { name: string; path: string; type: string }[] {
    for (const node of nodes) {
        if (node.type === 'file') {
            result.push({ name: node.name, path: node.path, type: 'file' });
        }
        if (node.type === 'directory' && node.children) {
            flattenFileTree(node.children, result);
        }
    }
    return result;
}

function getFileIcon(name: string) {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const codeExts = ['ts', 'tsx', 'js', 'jsx', 'py', 'c', 'cpp', 'h', 'hpp', 'v', 'sv', 'vhd', 'vhdl', 'm'];
    const configExts = ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'xml'];

    if (codeExts.includes(ext)) return <Hash className="w-3 h-3 text-primary shrink-0" />;
    if (configExts.includes(ext)) return <File className="w-3 h-3 text-yellow-500 shrink-0" />;
    return <File className="w-3 h-3 text-muted-foreground shrink-0" />;
}

export function FileMentionPopover({ fileTree, query, onSelect, onClose, visible }: FileMentionPopoverProps) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    const allFiles = useMemo(() => flattenFileTree(fileTree), [fileTree]);

    const filtered = useMemo(() => {
        if (!query) return allFiles.slice(0, 15);
        const q = query.toLowerCase();
        return allFiles
            .filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
            .slice(0, 15);
    }, [allFiles, query]);

    // Reset selection when query changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [query]);

    // Scroll selected item into view
    useEffect(() => {
        if (!listRef.current) return;
        const items = listRef.current.querySelectorAll('[data-mention-item]');
        items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    // Keyboard navigation
    useEffect(() => {
        if (!visible) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedIndex(prev => Math.max(prev - 1, 0));
            } else if (e.key === 'Enter' && filtered.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                onSelect(filtered[selectedIndex].path);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };

        // Use capture phase to intercept before textarea
        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [visible, filtered, selectedIndex, onSelect, onClose]);

    if (!visible || allFiles.length === 0) return null;

    return (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-50 animate-fade-in">
            <div className="bg-popover border border-border rounded-lg shadow-2xl overflow-hidden max-h-60">
                {/* Header */}
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-secondary/30">
                    <span className="text-[10px] font-semibold text-primary">@</span>
                    <span className="text-[10px] text-muted-foreground">
                        {query ? `Searching "${query}"` : 'Select a file to add as context'}
                    </span>
                    <span className="ml-auto text-[9px] text-muted-foreground/60">
                        ↑↓ navigate · Enter select · Esc close
                    </span>
                </div>

                {/* File list */}
                <div ref={listRef} className="overflow-y-auto max-h-48 py-1">
                    {filtered.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                            No files matching "<span className="text-foreground">{query}</span>"
                        </div>
                    ) : (
                        filtered.map((file, index) => {
                            const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
                            return (
                                <button
                                    key={file.path}
                                    data-mention-item
                                    onClick={() => onSelect(file.path)}
                                    onMouseEnter={() => setSelectedIndex(index)}
                                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${index === selectedIndex
                                            ? 'bg-primary/15 text-foreground'
                                            : 'text-muted-foreground hover:bg-secondary/50'
                                        }`}
                                >
                                    {getFileIcon(file.name)}
                                    <span className="text-xs font-medium truncate">{file.name}</span>
                                    {dirPath && (
                                        <span className="text-[10px] text-muted-foreground/60 truncate ml-auto">{dirPath}/</span>
                                    )}
                                </button>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
