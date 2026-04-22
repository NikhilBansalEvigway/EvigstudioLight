import { useAppStore } from '@/store/useAppStore';
import { chatMatchesSearch, groupChatsForSidebar } from '@/lib/chatFilters';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Plus, MessageSquare, Trash2, Search, Pencil, Check, X, Lock, Globe2, Users } from 'lucide-react';
import { useState, useRef, useEffect, useCallback } from 'react';
import { canDeleteChat, canWriteChat, type Chat } from '@/types';
import { format } from 'date-fns';

type SidebarFilter = 'all' | 'mine' | 'shared' | 'group' | 'locked';

const SIDEBAR_FILTERS: Array<{ id: SidebarFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'shared', label: 'Shared' },
  { id: 'group', label: 'Team' },
  { id: 'locked', label: 'Locked' },
];

function matchesSidebarFilter(chat: Chat, filter: SidebarFilter, userId: string | null): boolean {
  const privacy = chat.privacy ?? 'private';

  switch (filter) {
    case 'mine':
      return chat.ownerId ? chat.ownerId === userId : canWriteChat(chat);
    case 'shared':
      return privacy === 'shared';
    case 'group':
      return privacy === 'group';
    case 'locked':
      return !canWriteChat(chat);
    default:
      return true;
  }
}

type ChatRowProps = {
  chat: Chat;
  activeChatId: string | null;
  editingId: string | null;
  editValue: string;
  editInputRef: React.RefObject<HTMLInputElement>;
  setEditValue: (v: string) => void;
  confirmRename: () => void;
  cancelRename: () => void;
  selectChat: (id: string) => void;
  startRename: (chatId: string, title: string) => void;
  deleteChat: (id: string) => Promise<void>;
};

function ChatRow({
  chat,
  activeChatId,
  editingId,
  editValue,
  editInputRef,
  setEditValue,
  confirmRename,
  cancelRename,
  selectChat,
  startRename,
  deleteChat,
}: ChatRowProps) {
  const canWrite = canWriteChat(chat);
  const canDelete = canDeleteChat(chat);
  const privacy = chat.privacy ?? 'private';

  return (
    <div
      onClick={() => editingId !== chat.id && selectChat(chat.id)}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors cursor-pointer ${
        chat.id === activeChatId
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
      }`}
    >
      <MessageSquare className="w-3 h-3 shrink-0" />

      {editingId === chat.id ? (
        <div className="flex-1 flex items-center gap-1 animate-fade-in">
          <input
            ref={editInputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRename();
              if (e.key === 'Escape') cancelRename();
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 bg-input rounded px-1.5 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring min-w-0"
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              confirmRename();
            }}
            className="p-0.5 hover:text-accent transition-colors"
            title="Confirm"
          >
            <Check className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              cancelRename();
            }}
            className="p-0.5 hover:text-destructive transition-colors"
            title="Cancel"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <span className="block truncate">{chat.title}</span>
            <span className="block text-[10px] text-muted-foreground/80">
              {chat.ownerDisplayName ? `${chat.ownerDisplayName} · ` : ''}
              {format(chat.updatedAt, 'MMM d, HH:mm')}
            </span>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                {privacy === 'shared' ? <Globe2 className="h-2.5 w-2.5" /> : privacy === 'group' ? <Users className="h-2.5 w-2.5" /> : <Lock className="h-2.5 w-2.5" />}
                {privacy === 'shared' ? 'Shared' : privacy === 'group' ? 'Team' : 'Private'}
              </span>
              {chat.groupName && (
                <span className="rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                  {chat.groupName}
                </span>
              )}
              {!canWrite && (
                <span className="rounded-full border border-border/70 bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  Read only
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            {!canWrite && <Lock className="w-3 h-3 text-muted-foreground" />}
            {canWrite && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(chat.id, chat.title);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-primary transition-all"
                title="Rename chat"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
            {canDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteChat(chat.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive transition-all"
                title="Delete chat"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function Sidebar() {
  const { user } = useAuth();
  const { chats, activeChatId, createChat, selectChat, deleteChat, renameChat } = useAppStore();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  const filtered = chats.filter((c) => {
    if (!matchesSidebarFilter(c, filter, user?.id ?? null)) return false;
    return search.trim() ? chatMatchesSearch(c, search) : true;
  });
  const { noThread, threads } = groupChatsForSidebar(filtered);

  const startRename = useCallback((chatId: string, currentTitle: string) => {
    setEditingId(chatId);
    setEditValue(currentTitle);
  }, []);

  const confirmRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      renameChat(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue('');
  }, [editingId, editValue, renameChat]);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditValue('');
  }, []);

  // Auto-focus the input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  return (
    <div className="flex flex-col h-full bg-sidebar">
      <div className="pane-header justify-between">
        <span>Chats</span>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              try {
                await createChat();
              } catch (e) {
                console.error('[EvigStudio] createChat', e);
                const msg =
                  e instanceof Error && e.message
                    ? e.message
                    : 'Could not create a new chat.';
                toast.error(msg);
              }
            })();
          }}
          className="p-1 hover:text-primary transition-colors"
          title="New Chat"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-2 py-1.5">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-input rounded text-xs">
          <Search className="w-3 h-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, tags, messages…"
            className="bg-transparent outline-none flex-1 text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {SIDEBAR_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                filter === option.id
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border/70 bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1 space-y-0.5">
        {filtered.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-8">
            {chats.length === 0 ? 'No chats yet' : 'No matches'}
          </div>
        )}
        {noThread.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            activeChatId={activeChatId}
            editingId={editingId}
            editValue={editValue}
            editInputRef={editInputRef}
            setEditValue={setEditValue}
            confirmRename={confirmRename}
            cancelRename={cancelRename}
            selectChat={selectChat}
            startRename={startRename}
            deleteChat={deleteChat}
          />
        ))}
        {threads.map((t) => (
          <div key={t.threadId} className="space-y-0.5 pt-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium truncate">
              {t.title}
            </div>
            {t.chats.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                activeChatId={activeChatId}
                editingId={editingId}
                editValue={editValue}
                editInputRef={editInputRef}
                setEditValue={setEditValue}
                confirmRename={confirmRename}
                cancelRename={cancelRename}
                selectChat={selectChat}
                startRename={startRename}
                deleteChat={deleteChat}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
