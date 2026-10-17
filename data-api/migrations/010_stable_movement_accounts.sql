ALTER TABLE agent_movements
  ADD COLUMN account_ids TEXT[] NOT NULL DEFAULT '{}';

WITH legacy_accounts AS (
  SELECT workspace_id, source_profile_id, legacy_storage_key,
         legacy_record_json->>'platform' AS platform,
         operation,
         legacy_record_json->>'fromPlatform' AS from_platform,
         legacy_record_json->>'toPlatform' AS to_platform,
         substring(
           legacy_record_json->>'contactKey'
           FROM '"phone"\s*:\s*"([0-9]{4,20})"'
         ) AS contact_phone
  FROM agent_movements
), account_links AS (
  SELECT movements.workspace_id, movements.source_profile_id, movements.legacy_storage_key,
         array_agg(DISTINCT platforms.platform || ':' || legacy_accounts.contact_phone)
           FILTER (WHERE platforms.platform IN ('ganamos', 'multipanel')) AS account_ids
  FROM agent_movements AS movements
  JOIN legacy_accounts USING (workspace_id, source_profile_id, legacy_storage_key)
  CROSS JOIN LATERAL unnest(
    CASE
      WHEN legacy_accounts.operation = 'exchange'
        THEN ARRAY[legacy_accounts.from_platform, legacy_accounts.to_platform]
      ELSE ARRAY[legacy_accounts.platform]
    END
  ) AS platforms(platform)
  WHERE legacy_accounts.contact_phone IS NOT NULL
  GROUP BY movements.workspace_id, movements.source_profile_id, movements.legacy_storage_key
)
UPDATE agent_movements AS movements
SET account_ids = account_links.account_ids,
    legacy_record_json = movements.legacy_record_json ||
      jsonb_build_object('accountIds', account_links.account_ids)
FROM account_links
WHERE movements.workspace_id = account_links.workspace_id
  AND movements.source_profile_id = account_links.source_profile_id
  AND movements.legacy_storage_key = account_links.legacy_storage_key
  AND cardinality(account_links.account_ids) > 0;

CREATE INDEX agent_movements_by_account_time
  ON agent_movements USING GIN (account_ids);
