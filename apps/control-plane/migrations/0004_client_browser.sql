DROP TABLE "desktop_refresh_tokens";

ALTER TABLE "devices" ADD COLUMN "client_version" text;
ALTER TABLE "devices" ADD COLUMN "last_heartbeat_at" timestamptz;
ALTER TABLE "devices" ADD COLUMN "last_observation" jsonb;

CREATE TABLE "client_enrollments" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "device_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "client_enrollments_code_hash_unique" ON "client_enrollments" ("code_hash");
CREATE INDEX "client_enrollments_user_id_idx" ON "client_enrollments" ("user_id");

CREATE TABLE "client_auth_challenges" (
  "id" uuid PRIMARY KEY,
  "device_id" uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
  "challenge_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "client_auth_challenges_hash_unique" ON "client_auth_challenges" ("challenge_hash");

CREATE TABLE "client_sessions" (
  "id" uuid PRIMARY KEY,
  "device_id" uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "client_sessions_token_hash_unique" ON "client_sessions" ("token_hash");
CREATE INDEX "client_sessions_device_id_idx" ON "client_sessions" ("device_id");

CREATE TABLE "hub_browser_projections" (
  "hub_id" uuid PRIMARY KEY REFERENCES "hubs" ("id") ON DELETE CASCADE,
  "desired_revision" integer NOT NULL DEFAULT 0,
  "observed_revision" integer NOT NULL DEFAULT 0,
  "desired_hash" text,
  "healthy" boolean NOT NULL DEFAULT false,
  "last_error" text,
  "observed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "client_enrollments"
  ADD CONSTRAINT "client_enrollments_device_id_devices_id_fk"
  FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE SET NULL;
