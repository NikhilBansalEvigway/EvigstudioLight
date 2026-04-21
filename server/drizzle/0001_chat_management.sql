-- Run against your EvigStudio Postgres when upgrading an existing database.
-- New installs can use `npm run db:push` from the server folder instead.

ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "privacy" text NOT NULL DEFAULT 'private';
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "thread_id" uuid;
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "thread_title" text;
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "version_history" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS "chats_thread_idx" ON "chats" ("thread_id");
