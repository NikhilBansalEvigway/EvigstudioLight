import type { Message } from '@/types';

export function getMessageContextRefPaths(message: Pick<Message, 'contextRefs'> | null | undefined): string[] {
  return [...new Set((message?.contextRefs ?? []).map((ref) => ref.path).filter(Boolean))];
}

export function getLastUserContextRefPaths(messages: Pick<Message, 'role' | 'contextRefs'>[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      return getMessageContextRefPaths(message);
    }
  }
  return [];
}
