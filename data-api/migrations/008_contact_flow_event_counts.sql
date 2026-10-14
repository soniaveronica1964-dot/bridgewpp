ALTER TABLE contact_flow_state
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN generation_started_at_ms BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN arrived_adjustment BIGINT NOT NULL DEFAULT 0;

UPDATE contact_flow_state
SET arrived_adjustment = arrived,
    generation_started_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;

ALTER TABLE contact_flow_state
  ALTER COLUMN generation_started_at_ms DROP DEFAULT;

ALTER TABLE contact_flow_derived
  ADD COLUMN manual_adjustment BIGINT NOT NULL DEFAULT 0;

UPDATE contact_flow_derived
SET manual_adjustment = count;

ALTER TABLE contact_flow_panels
  ADD COLUMN manual_adjustment BIGINT NOT NULL DEFAULT 0;

UPDATE contact_flow_panels
SET manual_adjustment = count;

CREATE TABLE contact_flow_count_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  generation BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('arrived', 'derived')),
  panel_id TEXT,
  destination_id TEXT,
  phone TEXT NOT NULL,
  counted_at_ms BIGINT NOT NULL,
  CHECK (
    (event_type = 'arrived' AND panel_id IS NULL AND destination_id IS NULL) OR
    (event_type = 'derived' AND panel_id IS NOT NULL AND destination_id IS NOT NULL)
  )
);

CREATE INDEX contact_flow_count_events_by_generation
  ON contact_flow_count_events(workspace_id, generation, event_type);

CREATE INDEX contact_flow_count_events_by_destination
  ON contact_flow_count_events(workspace_id, generation, destination_id)
  WHERE event_type = 'derived';

CREATE INDEX contact_flow_count_events_by_panel
  ON contact_flow_count_events(workspace_id, generation, panel_id)
  WHERE event_type = 'derived';

CREATE TABLE contact_flow_adjustment_events (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  operation_id UUID NOT NULL,
  generation BIGINT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('arrived', 'destination')),
  target_id TEXT,
  delta BIGINT NOT NULL CHECK (delta <> 0),
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id),
  CHECK (
    (target_type = 'arrived' AND target_id IS NULL) OR
    (target_type = 'destination' AND target_id IS NOT NULL)
  )
);

CREATE INDEX contact_flow_adjustment_events_by_target
  ON contact_flow_adjustment_events(workspace_id, generation, target_type, target_id);

CREATE TABLE contact_flow_reset_operations (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  operation_id UUID NOT NULL,
  generation BIGINT NOT NULL,
  clear_counted_numbers BOOLEAN NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);
