import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['admin', 'member']);
export const deviceState = pgEnum('device_state', [
  'pending_approval',
  'verifying_syncthing_identity',
  'active',
  'suspended',
  'revoking',
  'revoked',
]);
export const spaceState = pgEnum('space_state', [
  'draft',
  'provisioning',
  'active',
  'paused',
  'deleting',
  'retained',
  'deleted',
  'degraded',
]);
export const shareState = pgEnum('share_state', ['invited', 'accepted', 'revoked']);
export const bindingState = pgEnum('binding_state', [
  'offered',
  'awaiting_directory',
  'provisioning',
  'syncing',
  'paused',
  'removing',
  'removed',
  'degraded',
]);
export const jobState = pgEnum('job_state', ['queued', 'running', 'succeeded', 'failed']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    role: userRole('role').notNull(),
    passwordHash: text('password_hash').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_username_unique').on(table.username)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
  ],
);

export const desktopRefreshTokens = pgTable(
  'desktop_refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('desktop_refresh_token_hash_unique').on(table.tokenHash),
    index('desktop_refresh_token_family_idx').on(table.familyId),
  ],
);

export const accountTokens = pgTable(
  'account_tokens',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('account_tokens_token_hash_unique').on(table.tokenHash),
    index('account_tokens_user_id_idx').on(table.userId),
  ],
);

export const hubs = pgTable('hubs', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  syncthingDeviceId: text('syncthing_device_id').notNull(),
  endpoint: text('endpoint').notNull(),
  state: text('state').notNull().default('provisioning'),
  generation: uuid('generation').notNull(),
  desiredRevision: integer('desired_revision').notNull().default(0),
  observedRevision: integer('observed_revision').notNull().default(0),
  capacityBytes: bigint('capacity_bytes', { mode: 'number' }).notNull(),
  usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hubId: uuid('hub_id').references(() => hubs.id),
    displayName: text('display_name').notNull(),
    platform: text('platform').notNull(),
    productPublicKey: text('product_public_key').notNull(),
    syncthingDeviceId: text('syncthing_device_id').notNull(),
    state: deviceState('state').notNull().default('pending_approval'),
    revision: integer('revision').notNull().default(1),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('devices_product_key_unique').on(table.productPublicKey),
    uniqueIndex('devices_syncthing_id_unique').on(table.syncthingDeviceId),
    index('devices_user_id_idx').on(table.userId),
  ],
);

export const syncthingIdentityBindings = pgTable(
  'syncthing_identity_bindings',
  {
    id: uuid('id').primaryKey(),
    productDeviceId: uuid('product_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    hubId: uuid('hub_id')
      .notNull()
      .references(() => hubs.id),
    syncthingDeviceId: text('syncthing_device_id').notNull(),
    state: text('state').notNull().default('verified'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('syncthing_identity_product_device_unique').on(table.productDeviceId),
    uniqueIndex('syncthing_identity_device_id_unique').on(table.syncthingDeviceId),
  ],
);

export const syncSpaces = pgTable(
  'sync_spaces',
  {
    id: uuid('id').primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    hubId: uuid('hub_id')
      .notNull()
      .references(() => hubs.id),
    label: text('label').notNull(),
    syncthingFolderId: text('syncthing_folder_id').notNull(),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull(),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    state: spaceState('state').notNull().default('provisioning'),
    revision: integer('revision').notNull().default(1),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sync_spaces_folder_id_unique').on(table.syncthingFolderId),
    index('sync_spaces_owner_idx').on(table.ownerUserId),
  ],
);

export const spaceShares = pgTable(
  'space_shares',
  {
    id: uuid('id').primaryKey(),
    syncSpaceId: uuid('sync_space_id')
      .notNull()
      .references(() => syncSpaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: shareState('state').notNull().default('invited'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('space_shares_space_user_unique').on(table.syncSpaceId, table.userId)],
);

export const deviceSpaceBindings = pgTable(
  'device_space_bindings',
  {
    id: uuid('id').primaryKey(),
    syncSpaceId: uuid('sync_space_id')
      .notNull()
      .references(() => syncSpaces.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    state: bindingState('state').notNull().default('offered'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('device_space_binding_unique').on(table.syncSpaceId, table.deviceId)],
);

export const reconciliationJobs = pgTable(
  'reconciliation_jobs',
  {
    id: uuid('id').primaryKey(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    desiredRevision: integer('desired_revision').notNull(),
    state: jobState('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('reconciliation_jobs_queue_idx').on(table.state, table.nextAttemptAt)],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    cursor: bigserial('cursor', { mode: 'number' }).primaryKey(),
    id: uuid('id').notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    producer: text('producer').notNull(),
    aggregateId: uuid('aggregate_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('domain_events_id_unique').on(table.id),
    index('domain_events_type_idx').on(table.type),
  ],
);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  traceId: text('trace_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    key: text('key').notNull(),
    operationId: text('operation_id').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idempotency_user_key_unique').on(table.userId, table.key)],
);

export const updateReleases = pgTable('update_releases', {
  id: uuid('id').primaryKey(),
  version: text('version').notNull(),
  channel: text('channel').notNull().default('stable'),
  minimumClientVersion: text('minimum_client_version'),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
});

export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey(),
  type: text('type').notNull(),
  state: text('state').notNull(),
  snapshotRevision: text('snapshot_revision'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
});
