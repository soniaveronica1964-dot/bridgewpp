ALTER TABLE contact_flow_count_events
  ADD COLUMN source_profile_id UUID REFERENCES extension_profiles(profile_id);
