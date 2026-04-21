import { useCallback, useEffect, useState } from 'react';
import type { Chat, ChatPrivacy } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { useAuth } from '@/contexts/AuthContext';
import { getChatPersistenceMode } from '@/lib/chatPersistence';
import { exportChatAsTxt, exportChatAsPdf, exportChatAsDocx } from '@/lib/chatExport';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Download, History, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';

type GroupRow = { id: string; name: string };

export function ChatToolbar({ chat }: { chat: Chat }) {
  const { user } = useAuth();
  const updateChatFields = useAppStore((s) => s.updateChatFields);
  const saveVersionSnapshot = useAppStore((s) => s.saveVersionSnapshot);
  const restoreVersionSnapshot = useAppStore((s) => s.restoreVersionSnapshot);

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [threadTitle, setThreadTitle] = useState(chat.threadTitle ?? '');
  const [tagsStr, setTagsStr] = useState((chat.tags ?? []).join(', '));
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);

  const serverMode = getChatPersistenceMode() === 'server' && !!user;

  useEffect(() => {
    setThreadTitle(chat.threadTitle ?? '');
    setTagsStr((chat.tags ?? []).join(', '));
  }, [chat.id, chat.threadTitle, chat.tags]);

  useEffect(() => {
    if (!serverMode) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/groups', { credentials: 'include' });
        const data = (await r.json()) as { groups?: GroupRow[] };
        if (!cancelled && r.ok && data.groups) setGroups(data.groups);
      } catch {
        if (!cancelled) setGroups([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverMode]);

  const privacy = (chat.privacy ?? 'private') as ChatPrivacy;

  const onThreadBlur = useCallback(() => {
    const t = threadTitle.trim();
    if (!t) {
      updateChatFields(chat.id, { threadId: null, threadTitle: null });
      return;
    }
    const tid = chat.threadId ?? crypto.randomUUID();
    updateChatFields(chat.id, { threadId: tid, threadTitle: t });
  }, [chat.id, chat.threadId, threadTitle, updateChatFields]);

  const onTagsBlur = useCallback(() => {
    const tags = tagsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    updateChatFields(chat.id, { tags });
  }, [chat.id, tagsStr, updateChatFields]);

  const runExport = async (kind: 'txt' | 'pdf' | 'docx') => {
    try {
      if (kind === 'pdf' || kind === 'docx') setExporting(kind);
      if (kind === 'txt') await exportChatAsTxt(chat);
      else if (kind === 'pdf') await exportChatAsPdf(chat);
      else await exportChatAsDocx(chat);
      toast.success('Export ready');
    } catch (e) {
      console.error(e);
      toast.error('Export failed');
    } finally {
      setExporting(null);
    }
  };

  const versions = [...(chat.versionHistory ?? [])].sort((a, b) => b.savedAt - a.savedAt);

  return (
    <div className="flex flex-col gap-1.5 w-full min-w-0">
      <div className="flex flex-wrap items-center gap-1 justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] gap-1"
              disabled={!!exporting}
            >
              {exporting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Download className="w-3 h-3" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs">
            <DropdownMenuItem onClick={() => void runExport('txt')}>Plain text (.txt)</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void runExport('pdf')} disabled={exporting === 'pdf'}>
              PDF (.pdf)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void runExport('docx')} disabled={exporting === 'docx'}>
              Word (.docx)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px] gap-1">
              <History className="w-3 h-3" />
              History ({versions.length})
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm">Conversation versions</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">
              Save a snapshot before large edits. Each snapshot stores the full message list with a
              timestamp.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="w-full text-xs"
              onClick={() => {
                saveVersionSnapshot(chat.id);
                toast.success('Snapshot saved');
              }}
            >
              Save current as snapshot
            </Button>
            <div className="max-h-56 overflow-y-auto space-y-1 border border-border rounded-md p-2">
              {versions.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No snapshots yet</p>
              ) : (
                versions.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between gap-2 text-xs py-1 border-b border-border/50 last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{v.label || v.title}</div>
                      <div className="text-muted-foreground">
                        {format(v.savedAt, 'PPp')} · {v.messages.length} messages
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 h-7 text-[10px]"
                      onClick={() => {
                        restoreVersionSnapshot(chat.id, v.id);
                        toast.success('Restored snapshot');
                      }}
                    >
                      Restore
                    </Button>
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>

        {serverMode && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground hidden sm:inline">Visibility</span>
            <Select
              value={privacy}
              onValueChange={(v) => {
                const next = v as ChatPrivacy;
                if (next === 'private') {
                  updateChatFields(chat.id, { privacy: 'private', groupId: null });
                  return;
                }
                if (next === 'shared') {
                  updateChatFields(chat.id, { privacy: 'shared', groupId: null });
                  return;
                }
                const gid = chat.groupId ?? groups[0]?.id;
                if (!gid) {
                  toast.error('Join or create a team first');
                  return;
                }
                updateChatFields(chat.id, { privacy: 'group', groupId: gid });
              }}
            >
              <SelectTrigger className="h-7 w-[130px] text-[11px] px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private (only you)</SelectItem>
                <SelectItem value="shared">Shared (org)</SelectItem>
                <SelectItem value="group">Team…</SelectItem>
              </SelectContent>
            </Select>
            {privacy === 'group' && (
              <Select
                value={chat.groupId ?? ''}
                onValueChange={(gid) =>
                  updateChatFields(chat.id, { privacy: 'group', groupId: gid })
                }
              >
                <SelectTrigger className="h-7 min-w-[140px] max-w-[180px] text-[11px] px-2">
                  <SelectValue placeholder="Choose team" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <label className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-muted-foreground shrink-0">Thread</span>
          <input
            value={threadTitle}
            onChange={(e) => setThreadTitle(e.target.value)}
            onBlur={onThreadBlur}
            placeholder="Topic / session name"
            className="flex-1 min-w-0 bg-input rounded px-2 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-muted-foreground shrink-0">Tags</span>
          <input
            value={tagsStr}
            onChange={(e) => setTagsStr(e.target.value)}
            onBlur={onTagsBlur}
            placeholder="comma, separated"
            className="flex-1 min-w-0 bg-input rounded px-2 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
      </div>
    </div>
  );
}
