CREATE TABLE completed_withdrawals (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  withdrawal_id TEXT NOT NULL CHECK (
    char_length(withdrawal_id) BETWEEN 1 AND 512
  ),
  source_profile_id UUID NOT NULL,
  username TEXT NOT NULL CHECK (
    char_length(username) BETWEEN 1 AND 512
  ),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  completed_at_ms BIGINT NOT NULL CHECK (completed_at_ms >= created_at_ms),
  recorded_at_ms BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, withdrawal_id),
  FOREIGN KEY (source_profile_id, workspace_id)
    REFERENCES extension_profiles(profile_id, workspace_id)
);

CREATE INDEX completed_withdrawals_by_creation
  ON completed_withdrawals(workspace_id, created_at_ms DESC);
