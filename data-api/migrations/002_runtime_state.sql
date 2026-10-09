CREATE TABLE extension_state_values (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('profile', 'workspace')),
  scope_id UUID NOT NULL,
  storage_key TEXT NOT NULL,
  value_json JSONB,
  value_ciphertext BYTEA,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope_type, scope_id, storage_key),
  CHECK (
    (value_json IS NOT NULL AND value_ciphertext IS NULL) OR
    (value_json IS NULL AND value_ciphertext IS NOT NULL)
  )
);

CREATE TABLE extension_state_revisions (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id),
  revision BIGINT NOT NULL DEFAULT 0
);

INSERT INTO extension_state_revisions (workspace_id, revision)
SELECT workspace_id, revision FROM workspace_revisions
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO extension_state_values (
  scope_type, scope_id, storage_key, value_json, updated_at_ms
)
SELECT 'profile', profile_id, setting_key, value_json, updated_at_ms
FROM app_settings
ON CONFLICT DO NOTHING;

INSERT INTO extension_state_values (
  scope_type, scope_id, storage_key, value_json, updated_at_ms
)
SELECT 'workspace', workspace_id, setting_key, value_json, updated_at_ms
FROM workspace_settings
ON CONFLICT DO NOTHING;
