const assert = require("node:assert/strict");
const test = require("node:test");
const { getDatabaseConfig, loadMigrations } = require("../migrate");
const { getServerConfig } = require("../server");

function withDatabaseEnvironment(values, callback) {
  const names = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (Object.hasOwn(values, name)) process.env[name] = values[name];
    else delete process.env[name];
  }
  try {
    return callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("database configuration requires credentials and loopback only", () => {
  assert.throws(
    () => withDatabaseEnvironment({}, getDatabaseConfig),
    /Definí PGDATABASE, PGUSER y PGPASSWORD/
  );

  const config = withDatabaseEnvironment({
    PGHOST: "127.0.0.1",
    PGPORT: "5432",
    PGDATABASE: "bridgewpp",
    PGUSER: "bridgewpp_migrator",
    PGPASSWORD: "local-test-value"
  }, getDatabaseConfig);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.database, "bridgewpp");

  assert.throws(
    () => withDatabaseEnvironment({
      PGHOST: "192.168.1.10",
      PGDATABASE: "bridgewpp",
      PGUSER: "bridgewpp_migrator",
      PGPASSWORD: "local-test-value"
    }, getDatabaseConfig),
    /solo admite una conexión a PostgreSQL local/
  );
});

test("loads unique versioned SQL migrations in numeric order", async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })), [
    { version: 1, name: "initial" },
    { version: 2, name: "runtime_state" },
    { version: 3, name: "device_proof" },
    { version: 4, name: "profile_remote_destinations" }
  ]);
  assert.match(migrations[0].sql, /CREATE TABLE agent_movements/);
  assert.match(migrations[0].sql, /value_ciphertext BYTEA NOT NULL/);
  assert.match(migrations[1].sql, /CREATE TABLE extension_state_values/);
  assert.match(migrations[2].sql, /device_proof_ciphertext BYTEA/);
  assert.match(migrations[3].sql, /storage_key = 'remoteCreateDestinations'/);
  assert.match(migrations[3].sql, /PRIMARY KEY \(workspace_id, profile_id, destination_id\)/);
});

test("API permits only explicit private interface binding", () => {
  const names = [
    "DATA_API_HOST", "DATA_ENCRYPTION_KEY", "DATA_ALLOWED_EXTENSION_IDS",
    "DATA_TLS_CERT_FILE", "DATA_TLS_KEY_FILE", "DATA_WORKSPACE_ID"
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.DATA_API_HOST = "192.168.1.20";
    for (const name of names.slice(1)) delete process.env[name];
    assert.throws(() => getServerConfig(), /Falta la variable de entorno DATA_ENCRYPTION_KEY/);
    process.env.DATA_API_HOST = "0.0.0.0";
    assert.throws(
      () => getServerConfig(),
      /dirección de loopback o privada específica/
    );
    process.env.DATA_API_HOST = "203.0.113.20";
    assert.throws(
      () => getServerConfig(),
      /dirección de loopback o privada específica/
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
