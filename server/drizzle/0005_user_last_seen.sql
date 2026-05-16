ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen timestamp with time zone;
