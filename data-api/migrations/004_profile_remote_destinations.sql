ALTER TABLE remote_destinations
  ADD COLUMN profile_id UUID;

CREATE TEMP TABLE remote_destination_owners ON COMMIT DROP AS
WITH affected_workspaces AS (
  SELECT workspace_id FROM remote_destinations
  UNION
  SELECT scope_id AS workspace_id
  FROM extension_state_values
  WHERE scope_type = 'workspace'
    AND storage_key = 'remoteCreateDestinations'
)
SELECT affected.workspace_id,
       COALESCE(
         (
           SELECT changes.actor_profile_id
           FROM workspace_change_log AS changes
           WHERE changes.workspace_id = affected.workspace_id
             AND changes.event_type = 'state_changed'
             AND (
               (changes.entity_key::jsonb -> 'keys') ? 'remoteCreateDestinations'
               OR (changes.entity_key::jsonb -> 'removes') ? 'remoteCreateDestinations'
             )
             AND changes.actor_profile_id IS NOT NULL
           ORDER BY changes.revision DESC
           LIMIT 1
         ),
         (
           SELECT profiles.profile_id
           FROM extension_profiles AS profiles
           WHERE profiles.workspace_id = affected.workspace_id
             AND profiles.is_workspace_admin
           ORDER BY profiles.enrolled_at_ms, profiles.profile_id
           LIMIT 1
         )
       ) AS profile_id
FROM affected_workspaces AS affected;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM remote_destination_owners WHERE profile_id IS NULL) THEN
    RAISE EXCEPTION 'No se pudo determinar el perfil propietario de destinos remotos existentes.';
  END IF;
END
$$;

UPDATE remote_destinations AS destinations
SET profile_id = owners.profile_id
FROM remote_destination_owners AS owners
WHERE destinations.workspace_id = owners.workspace_id;

UPDATE extension_state_values AS state_values
SET scope_type = 'profile',
    scope_id = owners.profile_id
FROM remote_destination_owners AS owners
WHERE state_values.scope_type = 'workspace'
  AND state_values.scope_id = owners.workspace_id
  AND state_values.storage_key = 'remoteCreateDestinations';

INSERT INTO app_secrets (scope_type, scope_id, secret_key, ciphertext, updated_at_ms)
SELECT 'profile', scope_id, 'remoteCreateDestinations', value_ciphertext, updated_at_ms
FROM extension_state_values
WHERE scope_type = 'profile'
  AND storage_key = 'remoteCreateDestinations'
  AND value_ciphertext IS NOT NULL
ON CONFLICT (scope_type, scope_id, secret_key) DO NOTHING;

ALTER TABLE remote_destinations
  ALTER COLUMN profile_id SET NOT NULL,
  DROP CONSTRAINT remote_destinations_pkey,
  DROP CONSTRAINT remote_destinations_workspace_id_ordinal_key,
  ADD CONSTRAINT remote_destinations_profile_workspace_fkey
    FOREIGN KEY (profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id),
  ADD PRIMARY KEY (workspace_id, profile_id, destination_id),
  ADD UNIQUE (workspace_id, profile_id, ordinal);
