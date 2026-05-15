-- Per-chat workspace snapshot for server-side recovery (tabs, paths, root metadata).
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "workspace_session" jsonb;
