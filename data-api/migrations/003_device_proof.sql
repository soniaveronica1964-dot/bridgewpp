ALTER TABLE enrolled_devices
  ADD COLUMN device_proof_ciphertext BYTEA;

CREATE TABLE device_assertion_nonces (
  device_id UUID NOT NULL REFERENCES enrolled_devices(device_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

CREATE INDEX device_assertion_nonces_expiry
  ON device_assertion_nonces(expires_at_ms);
