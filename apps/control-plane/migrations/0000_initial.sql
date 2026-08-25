CREATE TYPE "user_role" AS ENUM ('admin', 'member');
CREATE TYPE "device_state" AS ENUM (
  'pending_approval',
  'verifying_syncthing_identity',
  'active',
  'suspended',
  'revoking',
  'revoked'
);
CREATE TYPE "space_state" AS ENUM (
  'draft',
  'provisioning',
  'active',
  'paused',
  'deleting',
  'retained',
  'deleted',
  'degraded'
);
CREATE TYPE "share_state" AS ENUM ('invited', 'accepted', 'revoked');
CREATE TYPE "binding_state" AS ENUM (
  'offered',
  'awaiting_directory',
  'provisioning',
  'syncing',
  'paused',
  'removing',
  'removed',
  'degraded'
);
CREATE TYPE "job_state" AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY,
  "username" text NOT NULL,
  "display_name" text NOT NULL,
  "role" user_role NOT NULL,
  "password_hash" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "users_username_unique" ON "users" ("username");

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "csrf_token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" ("token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");

CREATE TABLE "hubs" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL,
  "syncthing_device_id" text NOT NULL,
  "endpoint" text NOT NULL,
  "state" text NOT NULL DEFAULT 'provisioning',
  "generation" uuid NOT NULL,
  "desired_revision" integer NOT NULL DEFAULT 0,
  "observed_revision" integer NOT NULL DEFAULT 0,
  "capacity_bytes" bigint NOT NULL,
  "used_bytes" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "devices" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "hub_id" uuid REFERENCES "hubs" ("id"),
  "display_name" text NOT NULL,
  "platform" text NOT NULL,
  "product_public_key" text NOT NULL,
  "syncthing_device_id" text NOT NULL,
  "state" device_state NOT NULL DEFAULT 'pending_approval',
  "revision" integer NOT NULL DEFAULT 1,
  "last_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "devices_product_key_unique" ON "devices" ("product_public_key");
CREATE UNIQUE INDEX "devices_syncthing_id_unique" ON "devices" ("syncthing_device_id");
CREATE INDEX "devices_user_id_idx" ON "devices" ("user_id");

CREATE TABLE "sync_spaces" (
  "id" uuid PRIMARY KEY,
  "owner_user_id" uuid NOT NULL REFERENCES "users" ("id"),
  "hub_id" uuid NOT NULL REFERENCES "hubs" ("id"),
  "label" text NOT NULL,
  "syncthing_folder_id" text NOT NULL,
  "quota_bytes" bigint NOT NULL,
  "used_bytes" bigint NOT NULL DEFAULT 0,
  "state" space_state NOT NULL DEFAULT 'provisioning',
  "revision" integer NOT NULL DEFAULT 1,
  "delete_after" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "sync_spaces_folder_id_unique" ON "sync_spaces" ("syncthing_folder_id");
CREATE INDEX "sync_spaces_owner_idx" ON "sync_spaces" ("owner_user_id");

CREATE TABLE "space_shares" (
  "id" uuid PRIMARY KEY,
  "sync_space_id" uuid NOT NULL REFERENCES "sync_spaces" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "state" share_state NOT NULL DEFAULT 'invited',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "space_shares_space_user_unique" ON "space_shares" ("sync_space_id", "user_id");

CREATE TABLE "device_space_bindings" (
  "id" uuid PRIMARY KEY,
  "sync_space_id" uuid NOT NULL REFERENCES "sync_spaces" ("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
  "state" binding_state NOT NULL DEFAULT 'offered',
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "device_space_binding_unique" ON "device_space_bindings" ("sync_space_id", "device_id");

CREATE TABLE "reconciliation_jobs" (
  "id" uuid PRIMARY KEY,
  "aggregate_type" text NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "desired_revision" integer NOT NULL,
  "state" job_state NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "locked_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "reconciliation_jobs_queue_idx" ON "reconciliation_jobs" ("state", "next_attempt_at");

CREATE TABLE "domain_events" (
  "cursor" bigserial PRIMARY KEY,
  "id" uuid NOT NULL,
  "type" text NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "producer" text NOT NULL,
  "aggregate_id" uuid,
  "payload" jsonb NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "domain_events_id_unique" ON "domain_events" ("id");
CREATE INDEX "domain_events_type_idx" ON "domain_events" ("type");

CREATE TABLE "audit_events" (
  "id" uuid PRIMARY KEY,
  "actor_user_id" uuid REFERENCES "users" ("id"),
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid,
  "trace_id" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "idempotency_records" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid REFERENCES "users" ("id"),
  "key" text NOT NULL,
  "operation_id" text NOT NULL,
  "request_hash" text NOT NULL,
  "response_status" integer NOT NULL,
  "response_body" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "idempotency_user_key_unique" ON "idempotency_records" ("user_id", "key");

CREATE TABLE "update_releases" (
  "id" uuid PRIMARY KEY,
  "version" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'stable',
  "minimum_client_version" text,
  "manifest" jsonb NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "backup_runs" (
  "id" uuid PRIMARY KEY,
  "type" text NOT NULL,
  "state" text NOT NULL,
  "snapshot_revision" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO "hubs" (
  "id",
  "name",
  "syncthing_device_id",
  "endpoint",
  "generation",
  "capacity_bytes"
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Development Hub',
  'PENDING-SYNCTHING-DEVICE-ID',
  'tcp://127.0.0.1:22000',
  '00000000-0000-4000-8000-000000000002',
  10995116277760
);
