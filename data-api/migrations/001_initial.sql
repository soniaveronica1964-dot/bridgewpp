CREATE TABLE workspaces (
  workspace_id UUID PRIMARY KEY,
  server_id UUID NOT NULL,
  name TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE enrolled_devices (
  device_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  display_name TEXT NOT NULL,
  enrolled_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT,
  UNIQUE (device_id, workspace_id)
);

CREATE TABLE extension_profiles (
  profile_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  device_id UUID NOT NULL,
  is_workspace_admin BOOLEAN NOT NULL DEFAULT FALSE,
  installation_id UUID NOT NULL UNIQUE,
  source_extension TEXT NOT NULL,
  enrolled_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT,
  UNIQUE (profile_id, workspace_id),
  FOREIGN KEY (device_id, workspace_id)
    REFERENCES enrolled_devices(device_id, workspace_id)
);

CREATE TABLE profile_credentials (
  credential_id UUID PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES extension_profiles(profile_id),
  credential_hash BYTEA NOT NULL UNIQUE,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT,
  revoked_at_ms BIGINT
);

CREATE TABLE enrollment_codes (
  code_hash BYTEA PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  device_name TEXT NOT NULL,
  grants_workspace_admin BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT
);

CREATE TABLE data_migrations (
  profile_id UUID NOT NULL REFERENCES extension_profiles(profile_id),
  migration_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('staging', 'validated', 'committed', 'failed')
  ),
  source_extension TEXT NOT NULL,
  source_key_count BIGINT NOT NULL,
  movement_count BIGINT NOT NULL,
  source_sha256 TEXT NOT NULL,
  report_json JSONB,
  started_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT,
  PRIMARY KEY (profile_id, migration_id)
);

CREATE TABLE workspace_migration_imports (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id),
  migration_id UUID NOT NULL,
  source_profile_id UUID NOT NULL,
  source_sha256 TEXT NOT NULL,
  committed_at_ms BIGINT NOT NULL,
  FOREIGN KEY (source_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id)
);

CREATE TABLE migration_staging_entries (
  profile_id UUID NOT NULL,
  migration_id UUID NOT NULL,
  storage_key TEXT NOT NULL,
  value_ciphertext BYTEA NOT NULL,
  value_sha256 TEXT NOT NULL,
  PRIMARY KEY (profile_id, migration_id, storage_key),
  FOREIGN KEY (profile_id, migration_id)
    REFERENCES data_migrations(profile_id, migration_id)
    ON DELETE CASCADE
);

CREATE TABLE app_settings (
  profile_id UUID NOT NULL REFERENCES extension_profiles(profile_id),
  setting_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (profile_id, setting_key)
);

CREATE TABLE workspace_settings (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  setting_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL,
  updated_by_profile_id UUID,
  PRIMARY KEY (workspace_id, setting_key),
  FOREIGN KEY (updated_by_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id)
);

CREATE TABLE app_secrets (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('profile', 'workspace')),
  scope_id UUID NOT NULL,
  secret_key TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope_type, scope_id, secret_key)
);

CREATE TABLE remote_destinations (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  destination_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token_ciphertext BYTEA,
  ganamos_suffix TEXT NOT NULL,
  multipanel_suffix TEXT NOT NULL,
  legacy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, destination_id),
  UNIQUE (workspace_id, ordinal)
);

CREATE TABLE contact_flow_state (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id),
  arrived BIGINT NOT NULL DEFAULT 0 CHECK (arrived >= 0),
  legacy_unknown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE contact_flow_derived (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  destination_id TEXT NOT NULL,
  count BIGINT NOT NULL CHECK (count >= 0),
  PRIMARY KEY (workspace_id, destination_id)
);

CREATE TABLE contact_flow_counted_numbers (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  phone TEXT NOT NULL,
  PRIMARY KEY (workspace_id, phone)
);

CREATE TABLE contact_flow_panels (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  panel_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  keyword TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  count BIGINT NOT NULL CHECK (count >= 0),
  legacy_json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, panel_id),
  UNIQUE (workspace_id, ordinal)
);

CREATE TABLE contact_flow_panel_counted_numbers (
  workspace_id UUID NOT NULL,
  panel_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  PRIMARY KEY (workspace_id, panel_id, phone),
  FOREIGN KEY (workspace_id, panel_id)
    REFERENCES contact_flow_panels(workspace_id, panel_id)
    ON DELETE CASCADE
);

CREATE TABLE applied_workspace_operations (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  operation_id UUID NOT NULL,
  operation_type TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE TABLE agent_movements (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  source_profile_id UUID NOT NULL,
  source_device_id UUID NOT NULL,
  operation_id UUID,
  legacy_storage_key TEXT NOT NULL,
  timestamp_ms BIGINT,
  contact_key TEXT,
  operation TEXT,
  amount_minor BIGINT,
  platform TEXT,
  username TEXT,
  transaction_minor BIGINT,
  bonus_minor BIGINT,
  from_platform TEXT,
  to_platform TEXT,
  status TEXT,
  verification_json JSONB,
  legacy_record_json JSONB NOT NULL,
  imported_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, source_profile_id, legacy_storage_key),
  FOREIGN KEY (source_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id),
  FOREIGN KEY (source_device_id, workspace_id)
    REFERENCES enrolled_devices(device_id, workspace_id),
  UNIQUE (workspace_id, operation_id)
);

CREATE TABLE financial_operation_results (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  operation_id UUID NOT NULL,
  source_profile_id UUID NOT NULL,
  source_device_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'succeeded', 'failed', 'uncertain')
  ),
  result_ciphertext BYTEA,
  result_sha256 TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (source_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id),
  FOREIGN KEY (source_device_id, workspace_id)
    REFERENCES enrolled_devices(device_id, workspace_id)
);

CREATE INDEX agent_movements_by_contact_time
  ON agent_movements(workspace_id, contact_key, timestamp_ms DESC);
CREATE INDEX agent_movements_by_time
  ON agent_movements(workspace_id, timestamp_ms DESC);
CREATE INDEX agent_movements_withdrawals
  ON agent_movements(workspace_id, contact_key, operation, timestamp_ms DESC);

CREATE TABLE legacy_extension_values (
  profile_id UUID NOT NULL REFERENCES extension_profiles(profile_id),
  storage_key TEXT NOT NULL,
  value_ciphertext BYTEA NOT NULL,
  imported_at_ms BIGINT NOT NULL,
  source_sha256 TEXT NOT NULL,
  PRIMARY KEY (profile_id, storage_key)
);

CREATE TABLE workspace_revisions (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id),
  revision BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE workspace_change_log (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  revision BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  actor_profile_id UUID,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, revision),
  FOREIGN KEY (actor_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id)
);
