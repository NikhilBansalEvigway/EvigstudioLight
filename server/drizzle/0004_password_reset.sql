ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_token_hash" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_expires_at" timestamptz;
CREATE INDEX IF NOT EXISTS "users_password_reset_token_hash_idx" ON "users" ("password_reset_token_hash");
