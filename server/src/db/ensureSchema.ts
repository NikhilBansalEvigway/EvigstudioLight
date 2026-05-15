import { pgClient } from './client.js';

/**
 * Fresh Docker/Postgres installs start with an empty database. Bootstrap the
 * current schema before any startup tasks query tables such as audit_logs.
 */
export async function ensurePostgresSchema(): Promise<void> {
  await pgClient`CREATE EXTENSION IF NOT EXISTS pgcrypto`;

  await pgClient.unsafe(`
    DO $$
    BEGIN
      CREATE TYPE user_role AS ENUM ('admin', 'developer', 'tester', 'auditor');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;

    DO $$
    BEGIN
      CREATE TYPE prompt_type AS ENUM ('chat', 'agent');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pgClient.unsafe(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      display_name text NOT NULL,
      role user_role NOT NULL DEFAULT 'developer',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type prompt_type NOT NULL,
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS prompts_type_created_idx ON prompts (type, created_at DESC);

    CREATE TABLE IF NOT EXISTS groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_in_group text NOT NULL DEFAULT 'member',
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_workspaces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      label text NOT NULL,
      root_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id uuid REFERENCES groups(id) ON DELETE SET NULL,
      privacy text NOT NULL DEFAULT 'private',
      thread_id uuid,
      thread_title text,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      version_history jsonb NOT NULL DEFAULT '[]'::jsonb,
      title text NOT NULL,
      messages jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      metadata jsonb,
      ip text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE chats ADD COLUMN IF NOT EXISTS privacy text NOT NULL DEFAULT 'private';
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS thread_id uuid;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS thread_title text;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS version_history jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS workspace_session jsonb;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at timestamptz;
    CREATE INDEX IF NOT EXISTS users_password_reset_token_hash_idx ON users (password_reset_token_hash);

    CREATE INDEX IF NOT EXISTS group_workspaces_group_idx ON group_workspaces (group_id);
    CREATE INDEX IF NOT EXISTS chats_owner_idx ON chats (owner_id);
    CREATE INDEX IF NOT EXISTS chats_group_idx ON chats (group_id);
    CREATE INDEX IF NOT EXISTS chats_thread_idx ON chats (thread_id);
    CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at);
    CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id);
    CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);
    CREATE INDEX IF NOT EXISTS audit_logs_resource_type_idx ON audit_logs (resource_type);
  `);
}
