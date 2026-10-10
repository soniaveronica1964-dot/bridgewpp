WITH bonus_workspaces AS (
  SELECT scope_id AS workspace_id
  FROM extension_state_values
  WHERE scope_type = 'workspace' AND storage_key = 'activeBonusConfig'
  UNION
  SELECT workspace_id
  FROM workspace_settings
  WHERE setting_key = 'activeBonusConfig'
),
workspace_bonus AS (
  SELECT bonus_workspaces.workspace_id,
         COALESCE(
           (
             SELECT value_json
             FROM extension_state_values
             WHERE scope_type = 'workspace'
               AND scope_id = bonus_workspaces.workspace_id
               AND storage_key = 'activeBonusConfig'
           ),
           (
             SELECT value_json
             FROM workspace_settings
             WHERE workspace_id = bonus_workspaces.workspace_id
               AND setting_key = 'activeBonusConfig'
           )
         ) AS value_json
  FROM bonus_workspaces
),
primary_profiles AS (
  SELECT settings.profile_id, profiles.workspace_id
  FROM app_settings AS settings
  JOIN extension_profiles AS profiles USING (profile_id)
  WHERE settings.setting_key = 'bridgeRole'
    AND settings.value_json = '"primary"'::jsonb
  UNION
  SELECT state_values.scope_id AS profile_id, profiles.workspace_id
  FROM extension_state_values AS state_values
  JOIN extension_profiles AS profiles ON profiles.profile_id = state_values.scope_id
  WHERE state_values.scope_type = 'profile'
    AND state_values.storage_key = 'bridgeRole'
    AND state_values.value_json = '"primary"'::jsonb
)
INSERT INTO extension_state_values (
  scope_type, scope_id, storage_key, value_json, value_ciphertext, updated_at_ms
)
SELECT 'profile', primary_profiles.profile_id, 'activeBonusConfig',
       workspace_bonus.value_json, NULL,
       floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM primary_profiles
JOIN workspace_bonus USING (workspace_id)
WHERE workspace_bonus.value_json IS NOT NULL
ON CONFLICT (scope_type, scope_id, storage_key) DO NOTHING;

INSERT INTO app_settings (profile_id, setting_key, value_json, updated_at_ms)
SELECT state_values.scope_id, 'activeBonusConfig', state_values.value_json,
       state_values.updated_at_ms
FROM extension_state_values AS state_values
JOIN app_settings AS roles
  ON roles.profile_id = state_values.scope_id
 AND roles.setting_key = 'bridgeRole'
 AND roles.value_json = '"primary"'::jsonb
WHERE state_values.scope_type = 'profile'
  AND state_values.storage_key = 'activeBonusConfig'
  AND state_values.value_json IS NOT NULL
ON CONFLICT (profile_id, setting_key) DO NOTHING;

WITH deleted_state AS (
  DELETE FROM extension_state_values
  WHERE scope_type = 'workspace' AND storage_key = 'activeBonusConfig'
  RETURNING scope_id AS workspace_id
),
deleted_settings AS (
  DELETE FROM workspace_settings
  WHERE setting_key = 'activeBonusConfig'
  RETURNING workspace_id
),
affected_workspaces AS (
  SELECT workspace_id FROM deleted_state
  UNION
  SELECT workspace_id FROM deleted_settings
),
updated_state_revisions AS (
  UPDATE extension_state_revisions AS revisions
  SET revision = revision + 1
  FROM affected_workspaces
  WHERE revisions.workspace_id = affected_workspaces.workspace_id
  RETURNING revisions.workspace_id
),
updated_workspace_revisions AS (
  UPDATE workspace_revisions AS revisions
  SET revision = revision + 1
  FROM affected_workspaces
  WHERE revisions.workspace_id = affected_workspaces.workspace_id
  RETURNING revisions.workspace_id, revisions.revision
)
INSERT INTO workspace_change_log (
  workspace_id, revision, event_type, entity_key, actor_profile_id, created_at_ms
)
SELECT workspace_id, revision, 'state_changed',
       '{"keys":["activeBonusConfig"],"removes":[]}',
       NULL, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM updated_workspace_revisions;
