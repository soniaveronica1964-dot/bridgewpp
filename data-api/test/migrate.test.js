const assert = require("node:assert/strict");
const test = require("node:test");
const { getDatabaseConfig, loadMigrations } = require("../migrate");
const {
  createDeviceAssertionNonceCleanup,
  getServerConfig,
  mergeContactFlowCounterSnapshots,
  validateCounterSnapshot
} = require("../server");

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

test("coalesces expired device nonce cleanup during concurrent requests", async () => {
  let cleanupQueries = 0;
  const cleanup = createDeviceAssertionNonceCleanup({
    async query() {
      cleanupQueries++;
    }
  });

  await Promise.all(Array.from({ length: 25 }, () => cleanup()));
  await cleanup();

  assert.equal(cleanupQueries, 1);
});

test("retries expired device nonce cleanup after a database error", async () => {
  let cleanupQueries = 0;
  const cleanup = createDeviceAssertionNonceCleanup({
    async query() {
      cleanupQueries++;
      if (cleanupQueries === 1) throw new Error("database unavailable");
    }
  });

  await assert.rejects(cleanup(), /database unavailable/);
  await cleanup();

  assert.equal(cleanupQueries, 2);
});

test("loads unique versioned SQL migrations in numeric order", async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })), [
    { version: 1, name: "initial" },
    { version: 2, name: "runtime_state" },
    { version: 3, name: "device_proof" },
    { version: 4, name: "profile_remote_destinations" },
    { version: 5, name: "contact_flow_counted_at" },
    { version: 6, name: "profile_active_bonus" }
  ]);
  assert.match(migrations[0].sql, /CREATE TABLE agent_movements/);
  assert.match(migrations[0].sql, /value_ciphertext BYTEA NOT NULL/);
  assert.match(migrations[1].sql, /CREATE TABLE extension_state_values/);
  assert.match(migrations[2].sql, /device_proof_ciphertext BYTEA/);
  assert.match(migrations[3].sql, /storage_key = 'remoteCreateDestinations'/);
  assert.match(migrations[3].sql, /PRIMARY KEY \(workspace_id, profile_id, destination_id\)/);
  assert.match(migrations[4].sql, /contact_flow_counted_numbers/);
  assert.match(migrations[4].sql, /counted_at_ms BIGINT NOT NULL/);
  assert.match(migrations[5].sql, /storage_key = 'activeBonusConfig'/);
  assert.match(migrations[5].sql, /setting_key = 'bridgeRole'/);
  assert.match(migrations[5].sql, /scope_type = 'profile'/);
});

test("validates timestamped contact-flow numbers and keeps legacy number strings usable", () => {
  const now = Date.now();
  const snapshot = validateCounterSnapshot({
    arrived: 2,
    countedNumbers: [
      { number: "5491111111111", countedAt: now - 1000 },
      "5491222222222",
      { number: "invalid", countedAt: now }
    ],
    panels: [{
      id: "panel-1",
      keyword: "sale",
      destinationId: "remote-1",
      countedNumbers: [{ number: "5491333333333", countedAt: now - 2000 }]
    }]
  });

  assert.equal(snapshot.countedNumbers.length, 2);
  assert.deepEqual(snapshot.countedNumbers[0], {
    number: "5491111111111",
    countedAt: now - 1000
  });
  assert.equal(snapshot.countedNumbers[1].number, "5491222222222");
  assert.ok(Number.isSafeInteger(snapshot.countedNumbers[1].countedAt));
  assert.deepEqual(snapshot.panels[0].countedNumbers, [{
    number: "5491333333333",
    countedAt: now - 2000
  }]);
});

test("merges concurrent contact-flow snapshots without double-counting duplicate numbers", () => {
  const now = Date.now();
  const current = {
    arrived: 10,
    derived: { "remote-1": 4 },
    countedNumbers: [{ number: "5491111111111", countedAt: now - 1000 }],
    panels: [{
      id: "panel-1",
      keyword: "sale",
      destinationId: "remote-1",
      count: 4,
      countedNumbers: [{ number: "5491222222222", countedAt: now - 1000 }]
    }]
  };
  const first = {
    arrived: 11,
    derived: { "remote-1": 5 },
    countedNumbers: [
      ...current.countedNumbers,
      { number: "5491333333333", countedAt: now - 500 }
    ],
    panels: [{
      ...current.panels[0],
      count: 5,
      countedNumbers: [
        ...current.panels[0].countedNumbers,
        { number: "5491444444444", countedAt: now - 500 }
      ]
    }]
  };
  const concurrent = {
    arrived: 11,
    derived: { "remote-1": 5 },
    countedNumbers: [
      ...current.countedNumbers,
      { number: "5491555555555", countedAt: now - 250 }
    ],
    panels: [{
      ...current.panels[0],
      count: 5,
      countedNumbers: [
        ...current.panels[0].countedNumbers,
        { number: "5491666666666", countedAt: now - 250 }
      ]
    }]
  };
  const afterFirst = mergeContactFlowCounterSnapshots(current, first, now);
  const merged = mergeContactFlowCounterSnapshots(afterFirst, concurrent, now);

  assert.equal(merged.arrived, 12);
  assert.equal(merged.derived["remote-1"], 6);
  assert.equal(merged.panels[0].count, 6);
  assert.deepEqual(
    merged.countedNumbers.map(({ number }) => number).sort(),
    ["5491111111111", "5491333333333", "5491555555555"].sort()
  );
  const repeatedNumber = mergeContactFlowCounterSnapshots(
    merged,
    {
      ...concurrent,
      countedNumbers: [
        ...current.countedNumbers,
        { number: "5491555555555", countedAt: now }
      ],
      panels: [{
        ...concurrent.panels[0],
        countedNumbers: [
          ...current.panels[0].countedNumbers,
          { number: "5491666666666", countedAt: now }
        ]
      }]
    },
    now
  );
  assert.equal(repeatedNumber.arrived, merged.arrived);
  assert.equal(repeatedNumber.derived["remote-1"], merged.derived["remote-1"]);
  assert.equal(repeatedNumber.panels[0].count, merged.panels[0].count);
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
