ALTER TABLE agent_movements
  ADD COLUMN is_advertising BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX agent_movements_advertising_by_time
  ON agent_movements(workspace_id, timestamp_ms DESC)
  WHERE is_advertising;
