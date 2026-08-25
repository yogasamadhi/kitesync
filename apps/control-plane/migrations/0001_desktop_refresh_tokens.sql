CREATE TABLE "desktop_refresh_tokens" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "family_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "rotated_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "desktop_refresh_token_hash_unique" ON "desktop_refresh_tokens" ("token_hash");
CREATE INDEX "desktop_refresh_token_family_idx" ON "desktop_refresh_tokens" ("family_id");
