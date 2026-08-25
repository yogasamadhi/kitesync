CREATE TABLE "account_tokens" (
  "id" uuid PRIMARY KEY,
  "type" text NOT NULL,
  "token_hash" text NOT NULL,
  "user_id" uuid REFERENCES "users" ("id") ON DELETE CASCADE,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_by" uuid REFERENCES "users" ("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "account_tokens_token_hash_unique" ON "account_tokens" ("token_hash");
CREATE INDEX "account_tokens_user_id_idx" ON "account_tokens" ("user_id");
