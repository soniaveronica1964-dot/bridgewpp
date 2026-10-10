ALTER TABLE contact_flow_counted_numbers
  ADD COLUMN counted_at_ms BIGINT NOT NULL
    DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;

ALTER TABLE contact_flow_counted_numbers
  ALTER COLUMN counted_at_ms DROP DEFAULT;

ALTER TABLE contact_flow_panel_counted_numbers
  ADD COLUMN counted_at_ms BIGINT NOT NULL
    DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;

ALTER TABLE contact_flow_panel_counted_numbers
  ALTER COLUMN counted_at_ms DROP DEFAULT;
