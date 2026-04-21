import { useAppStore } from '@/store/useAppStore';
import { MessageSquare, Bot } from 'lucide-react';
import type { ChatMode } from '@/types';

interface ChatModeToggleProps {
  chatId: string;
  mode: ChatMode;
}

export function ChatModeToggle({ chatId, mode }: ChatModeToggleProps) {
  const { setChatMode, isStreaming } = useAppStore();

  return (
    <div className="inline-flex items-center rounded-full border border-border bg-muted/40 p-0.5 text-[11px]">
      <button
        type="button"
        disabled={isStreaming}
        onClick={() => setChatMode(chatId, 'chat')}
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-all disabled:cursor-not-allowed ${
          mode === 'chat'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <MessageSquare className="h-3 w-3" />
        Chat
      </button>
      <button
        type="button"
        disabled={isStreaming}
        onClick={() => setChatMode(chatId, 'agent')}
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-all disabled:cursor-not-allowed ${
          mode === 'agent'
            ? 'bg-primary/15 text-primary shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Bot className="h-3 w-3" />
        Agent
      </button>
    </div>
  );
}
