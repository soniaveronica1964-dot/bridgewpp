const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const https = require("node:https");
const net = require("node:net");
const test = require("node:test");
const { Client, Pool } = require("pg");
const { initializeServer, issueEnrollmentCode } = require("../admin");
const {
  canonicalJson,
  createCanonicalSha256,
  decryptValue,
  encryptValue,
  sha256Hex
} = require("../archive");
const { loadMigrations, migrate } = require("../migrate");
const { createDataApiServer } = require("../server");

const enabled = Boolean(
  process.env.TEST_PGUSER &&
  process.env.TEST_PGPASSWORD &&
  process.env.TEST_TLS_CERT_FILE &&
  process.env.TEST_TLS_KEY_FILE
);
const deviceProofsByCredential = new Map();

function request(port, method, route, body, token, extensionId, {
  tamperProof = false,
  proofNonce
} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const proofIdentity = deviceProofsByCredential.get(token);
    const proofHeaders = proofIdentity
      ? (() => {
          const timestamp = Date.now();
          const nonce = proofNonce || crypto.randomBytes(32).toString("base64url");
          const signedData = [method, route, String(timestamp), nonce].join("\n");
          const signature = crypto.createHmac("sha256", proofIdentity.key)
            .update(signedData)
            .digest("base64url");
          return {
            "x-bridge-device-id": proofIdentity.deviceId,
            "x-bridge-device-time": String(timestamp),
            "x-bridge-device-nonce": nonce,
            "x-bridge-device-signature": tamperProof
              ? `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`
              : signature
          };
        })()
      : {};
    const request = https.request({
      host: "127.0.0.1",
      port,
      path: route,
      method,
      rejectUnauthorized: false,
      headers: {
        ...(data ? {
          "content-type": "application/json",
          "content-length": data.length
        } : {}),
        ...proofHeaders,
        origin: `chrome-extension://${extensionId}`,
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: body ? JSON.parse(body) : null
        });
      });
    });
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

function makeEntries(values) {
  return Object.entries(values)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => ({
      key,
      value,
      valueSha256: sha256Hex(Buffer.from(canonicalJson(value), "utf8"))
    }));
}

async function enroll(port, extensionId, code, deviceName) {
  const deviceProofKey = crypto.randomBytes(32);
  const response = await request(port, "POST", "/v1/enroll", {
    code,
    deviceName,
    installationId: crypto.randomUUID(),
    extensionId,
    deviceProofKey: deviceProofKey.toString("base64")
  }, null, extensionId);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  deviceProofsByCredential.set(response.body.credential, {
    deviceId: response.body.identity.deviceId,
    key: deviceProofKey
  });
  return response.body;
}

async function stageAndValidate(port, extensionId, token, values) {
  const entries = makeEntries(values);
  const migrationId = crypto.randomUUID();
  const canonicalSha256 = createCanonicalSha256(entries);
  const start = await request(port, "POST", `/v1/migrations/${migrationId}`, {
    migrationId,
    extensionId,
    keyCount: entries.length,
    movementCount: entries.filter(({ key }) => key.startsWith("agentMovement:")).length,
    canonicalSha256
  }, token, extensionId);
  assert.equal(start.status, 200, JSON.stringify(start.body));

  const batch = await request(port, "POST", `/v1/migrations/${migrationId}/entries`, {
    entries
  }, token, extensionId);
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  const retry = await request(port, "POST", `/v1/migrations/${migrationId}/entries`, {
    entries
  }, token, extensionId);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));

  const validate = await request(port, "POST", `/v1/migrations/${migrationId}/validate`, {}, token, extensionId);
  assert.equal(validate.status, 200, JSON.stringify(validate.body));
  return migrationId;
}

test("HTTPS migration imports preserve private and shared data atomically", {
  skip: !enabled && "Set TEST_PGUSER, TEST_PGPASSWORD, TEST_TLS_CERT_FILE, and TEST_TLS_KEY_FILE to run the disposable database integration test."
}, async () => {
  const adminConfig = {
    host: process.env.TEST_PGHOST || "127.0.0.1",
    port: Number(process.env.TEST_PGPORT || 5432),
    user: process.env.TEST_PGUSER,
    password: process.env.TEST_PGPASSWORD
  };
  const databaseName = `bridgewpp_api_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseAdmin = new Client({ ...adminConfig, database: "postgres" });
  let databaseCreated = false;
  let pool;
  let server;
  try {
    await databaseAdmin.connect();
    await databaseAdmin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    pool = new Pool({ ...adminConfig, database: databaseName });
    const migrations = await loadMigrations();
    await migrate(pool, migrations.slice(0, 3));
    const initialized = await initializeServer(pool, "Integration Workspace", "Main Device");
    const extensionId = "a".repeat(32);
    const encryptionKey = crypto.randomBytes(32);
    const config = {
      host: "127.0.0.1",
      workspaceId: initialized.workspaceId,
      encryptionKey,
      extensionIds: [extensionId],
      cert: await fs.readFile(process.env.TEST_TLS_CERT_FILE),
      key: await fs.readFile(process.env.TEST_TLS_KEY_FILE)
    };
    server = createDataApiServer({ pool, config });
    const probe = net.createServer();
    const port = await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const selectedPort = probe.address().port;
        probe.close((error) => error ? reject(error) : resolve(selectedPort));
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });

    const health = await request(port, "GET", "/health", undefined, null, extensionId);
    assert.equal(health.status, 200);
    const serverInfo = await request(port, "GET", "/v1/server-info", undefined, null, extensionId);
    assert.equal(serverInfo.status, 200);
    assert.equal(serverInfo.body.workspaceId, initialized.workspaceId);
    const preflight = await request(port, "OPTIONS", "/v1/migrations/test", undefined, null, extensionId);
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers["access-control-allow-methods"], /\bDELETE\b/);

    const main = await enroll(port, extensionId, initialized.code, "Main Device");
    const legacyRemoteDestinations = [{
      id: "remote-1",
      name: "Other PC",
      url: "http://192.168.1.20:32146",
      token: "t".repeat(40),
      ganamosSuffix: "g",
      multiPanelSuffix: "m",
      legacyMarker: "preserve"
    }];
    const oldStateTimestamp = Date.now();
    await pool.query(`
      INSERT INTO extension_state_values (
        scope_type, scope_id, storage_key, value_json, value_ciphertext, revision, updated_at_ms
      ) VALUES ('workspace', $1, 'remoteCreateDestinations', NULL, $2, 1, $3)
    `, [
      initialized.workspaceId,
      encryptValue(canonicalJson(legacyRemoteDestinations), encryptionKey),
      oldStateTimestamp
    ]);
    await pool.query(`
      INSERT INTO remote_destinations (
        workspace_id, destination_id, ordinal, name, url, token_ciphertext,
        ganamos_suffix, multipanel_suffix, legacy_json, revision, updated_at_ms
      ) VALUES ($1, 'remote-1', 0, 'Other PC', 'http://192.168.1.20:32146',
        $2, 'g', 'm', '{"legacyMarker":"preserve"}'::jsonb, 1, $3)
    `, [
      initialized.workspaceId,
      encryptValue("t".repeat(40), encryptionKey),
      oldStateTimestamp
    ]);
    await pool.query(
      "UPDATE workspace_revisions SET revision = 1 WHERE workspace_id = $1",
      [initialized.workspaceId]
    );
    await pool.query(`
      INSERT INTO workspace_change_log (
        workspace_id, revision, event_type, entity_key, actor_profile_id, created_at_ms
      ) VALUES ($1, 1, 'state_changed', $2, $3, $4)
    `, [
      initialized.workspaceId,
      JSON.stringify({ keys: ["remoteCreateDestinations"], removes: [] }),
      main.identity.profileId,
      oldStateTimestamp
    ]);
    await migrate(pool, migrations);
    const migratedLegacyDestinations = await request(
      port,
      "GET",
      `/v1/state?keys=${encodeURIComponent(JSON.stringify(["remoteCreateDestinations"]))}`,
      undefined,
      main.credential,
      extensionId
    );
    assert.deepEqual(
      migratedLegacyDestinations.body.values.remoteCreateDestinations,
      legacyRemoteDestinations
    );
    const migratedLegacySecret = await pool.query(`
      SELECT ciphertext FROM app_secrets
      WHERE scope_type = 'profile' AND scope_id = $1
        AND secret_key = 'remoteCreateDestinations'
    `, [main.identity.profileId]);
    assert.equal(
      decryptValue(migratedLegacySecret.rows[0].ciphertext, encryptionKey),
      canonicalJson(legacyRemoteDestinations)
    );
    const deviceProof = deviceProofsByCredential.get(main.credential);
    const persistedDeviceProof = await pool.query(`
      SELECT device_proof_ciphertext FROM enrolled_devices WHERE device_id = $1
    `, [deviceProof.deviceId]);
    assert.equal(
      persistedDeviceProof.rows[0].device_proof_ciphertext.includes(deviceProof.key),
      false
    );
    assert.equal(
      Buffer.from(
        decryptValue(persistedDeviceProof.rows[0].device_proof_ciphertext, encryptionKey),
        "base64"
      ).equals(deviceProof.key),
      true
    );
    const invalidDeviceProof = await request(
      port,
      "GET",
      "/v1/identity",
      undefined,
      main.credential,
      extensionId,
      { tamperProof: true }
    );
    assert.equal(invalidDeviceProof.status, 401);
    assert.equal(invalidDeviceProof.body.code, "invalid_device_proof");
    const replayNonce = crypto.randomBytes(32).toString("base64url");
    const nonceClaim = await request(
      port,
      "GET",
      "/v1/identity",
      undefined,
      main.credential,
      extensionId,
      { proofNonce: replayNonce }
    );
    assert.equal(nonceClaim.status, 200);
    const replayedProof = await request(
      port,
      "GET",
      "/v1/identity",
      undefined,
      main.credential,
      extensionId,
      { proofNonce: replayNonce }
    );
    assert.equal(replayedProof.status, 401);
    assert.equal(replayedProof.body.code, "replayed_device_proof");
    const secretValues = {
      bridgeRole: "primary",
      bridgeToken: "secret-bridge-token",
      userCreationPassword: "secret-user-password",
      activeBonusConfig: { type: "none", enabled: false },
      remoteCreateDestinations: legacyRemoteDestinations,
      contactFlowCounters: {
        arrived: 5,
        derived: { "remote-1": 2 },
        countedNumbers: ["5491112345678"],
        panels: [{
          id: "panel-1",
          title: "Ventas",
          keyword: "venta",
          destinationId: "remote-1",
          count: 2,
          countedNumbers: ["5491112345678"],
          legacyMarker: "preserve"
        }]
      },
      largeLegacyPayload: "x".repeat(128 * 1024),
      "agentMovement:1760000000000:uuid-1": {
        operation: "deposit",
        amount: 10.55,
        transactionAmount: 10,
        bonusAmount: 0.55,
        platform: "ganamos",
        timestamp: 1760000000000,
        contactKey: "contact-key-1",
        username: "user-a",
        verification: { status: "verified" }
      },
      futureSetting: { keep: true, tokenLike: "secret-unknown-value" }
    };
    const firstMigrationId = await stageAndValidate(port, extensionId, main.credential, secretValues);
    const preview = await request(port, "GET", `/v1/migrations/${firstMigrationId}`, undefined, main.credential, extensionId);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.status, "validated");
    assert.equal(preview.body.report.sharedData.canInitializeFromThisProfile, true);
    assert.deepEqual(preview.body.report.conflicts, {
      profileSettings: 0,
      profileSecrets: 0,
      movements: 0,
      legacyKeys: 0
    });
    assert.equal(JSON.stringify(preview.body).includes("secret-bridge-token"), false);
    assert.equal(JSON.stringify(preview.body).includes("secret-user-password"), false);
    const unconfirmed = await request(port, "POST", `/v1/migrations/${firstMigrationId}/commit`, {
      confirm: false,
      sharedDataDecision: "initialize_shared"
    }, main.credential, extensionId);
    assert.equal(unconfirmed.status, 400);

    const firstCommit = await request(port, "POST", `/v1/migrations/${firstMigrationId}/commit`, {
      confirm: true,
      sharedDataDecision: "initialize_shared"
    }, main.credential, extensionId);
    assert.equal(firstCommit.status, 200, JSON.stringify(firstCommit.body));
    assert.equal(firstCommit.body.report.sharedData, "initialized");
    assert.equal(firstCommit.body.report.importedMovements, 1);
    assert.equal(firstCommit.body.report.preservedUnknownKeys, 2);
    const replay = await request(port, "POST", `/v1/migrations/${firstMigrationId}/commit`, {
      confirm: true,
      sharedDataDecision: "initialize_shared"
    }, main.credential, extensionId);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.report.sharedData, "initialized");
    const protectedCommittedImport = await request(
      port, "DELETE", `/v1/migrations/${firstMigrationId}`, undefined, main.credential, extensionId
    );
    assert.equal(protectedCommittedImport.status, 409);

    const conflictMigrationId = await stageAndValidate(port, extensionId, main.credential, {
      ...secretValues,
      bridgeRole: "secondary",
      bridgeToken: "different-bridge-token",
      futureSetting: { keep: false },
      "agentMovement:1760000000000:uuid-1": {
        ...secretValues["agentMovement:1760000000000:uuid-1"],
        amount: 11
      }
    });
    const conflictPreview = await request(
      port, "GET", `/v1/migrations/${conflictMigrationId}`, undefined, main.credential, extensionId
    );
    assert.equal(conflictPreview.status, 200);
    assert.deepEqual(conflictPreview.body.report.conflicts, {
      profileSettings: 1,
      profileSecrets: 1,
      movements: 1,
      legacyKeys: 1
    });
    assert.equal(JSON.stringify(conflictPreview.body).includes("different-bridge-token"), false);
    const discarded = await request(
      port, "DELETE", `/v1/migrations/${conflictMigrationId}`, undefined, main.credential, extensionId
    );
    assert.equal(discarded.status, 200);
    assert.equal(discarded.body.discarded, true);
    const discardedStatus = await request(
      port, "GET", `/v1/migrations/${conflictMigrationId}`, undefined, main.credential, extensionId
    );
    assert.equal(discardedStatus.status, 404);
    const leftoverStaging = await pool.query(
      "SELECT count(*)::int AS count FROM migration_staging_entries WHERE migration_id = $1",
      [conflictMigrationId]
    );
    assert.equal(leftoverStaging.rows[0].count, 0);

    const movement = await pool.query(`
      SELECT amount_minor, transaction_minor, bonus_minor, contact_key
      FROM agent_movements
    `);
    assert.deepEqual(movement.rows[0], {
      amount_minor: "1055",
      transaction_minor: "1000",
      bonus_minor: "55",
      contact_key: "contact-key-1"
    });
    const movementHistory = await request(
      port,
      "GET",
      "/v1/movements?contactKey=contact-key-1&operation=deposit&since=1759999999000&limit=1",
      undefined,
      main.credential,
      extensionId
    );
    assert.equal(movementHistory.status, 200, JSON.stringify(movementHistory.body));
    assert.equal(movementHistory.body.movements.length, 1);
    assert.equal(movementHistory.body.movements[0].username, "user-a");
    const invalidMovementQuery = await request(
      port,
      "GET",
      "/v1/movements?limit=0",
      undefined,
      main.credential,
      extensionId
    );
    assert.equal(invalidMovementQuery.status, 400);
    assert.equal(invalidMovementQuery.body.code, "invalid_movement_query");
    const bonus = await pool.query(`
      SELECT value_json FROM workspace_settings WHERE setting_key = 'activeBonusConfig'
    `);
    assert.deepEqual(bonus.rows[0].value_json, { type: "none", enabled: false });
    const destination = await pool.query(`
      SELECT legacy_json, token_ciphertext FROM remote_destinations
    `);
    assert.equal(destination.rows[0].legacy_json.legacyMarker, "preserve");
    assert.equal(destination.rows[0].token_ciphertext.includes(Buffer.from("t".repeat(40))), false);
    const counters = await pool.query("SELECT arrived FROM contact_flow_state");
    assert.equal(counters.rows[0].arrived, "5");
    const phone = await pool.query("SELECT phone FROM contact_flow_counted_numbers");
    assert.equal(phone.rows[0].phone, "5491112345678");
    const secret = await pool.query(`
      SELECT ciphertext FROM app_secrets
      WHERE scope_type = 'profile' AND secret_key = 'bridgeToken'
    `);
    assert.equal(decryptValue(secret.rows[0].ciphertext, encryptionKey), '"secret-bridge-token"');
    const legacy = await pool.query(`
      SELECT value_ciphertext FROM legacy_extension_values WHERE storage_key = 'futureSetting'
    `);
    assert.equal(
      decryptValue(legacy.rows[0].value_ciphertext, encryptionKey),
      canonicalJson(secretValues.futureSetting)
    );
    const largeLegacy = await pool.query(`
      SELECT value_ciphertext FROM legacy_extension_values WHERE storage_key = 'largeLegacyPayload'
    `);
    assert.equal(
      decryptValue(largeLegacy.rows[0].value_ciphertext, encryptionKey),
      JSON.stringify(secretValues.largeLegacyPayload)
    );
    const runtimeState = await request(
      port,
      "GET",
      `/v1/state?keys=${encodeURIComponent(JSON.stringify([
        "bridgeRole", "bridgeToken", "futureSetting", "remoteCreateDestinations",
        "agentMovement:1760000000000:uuid-1"
      ]))}`,
      undefined,
      main.credential,
      extensionId
    );
    assert.equal(runtimeState.status, 200);
    assert.equal(runtimeState.body.values.bridgeRole, "primary");
    assert.equal(runtimeState.body.values.bridgeToken, "secret-bridge-token");
    assert.deepEqual(runtimeState.body.values.futureSetting, secretValues.futureSetting);
    assert.equal(runtimeState.body.values.remoteCreateDestinations[0].token, "t".repeat(40));
    assert.deepEqual(
      runtimeState.body.values["agentMovement:1760000000000:uuid-1"],
      secretValues["agentMovement:1760000000000:uuid-1"]
    );
    const noStateChanges = await request(
      port,
      "GET",
      `/v1/state/changes?after=${runtimeState.body.changeRevision}`,
      undefined,
      main.credential,
      extensionId
    );
    assert.equal(noStateChanges.status, 200);
    assert.equal(noStateChanges.body.revision, runtimeState.body.changeRevision);
    assert.deepEqual(noStateChanges.body.keys, []);
    const unknownRuntimeValue = await pool.query(`
      SELECT value_json, value_ciphertext FROM extension_state_values
      WHERE scope_type = 'profile' AND storage_key = 'futureSetting'
    `);
    assert.equal(unknownRuntimeValue.rows[0].value_json, null);
    assert.equal(
      decryptValue(unknownRuntimeValue.rows[0].value_ciphertext, encryptionKey),
      canonicalJson(secretValues.futureSetting)
    );
    const runtimeWrite = await request(port, "POST", "/v1/state", {
      changes: {
        ganamosSuffix: "q",
        userCreationPassword: "runtime-secret-password",
        futureRuntimeSecret: { token: "future-secret-value" },
        activeBonusConfig: { type: "simple", enabled: true, percent: 10 },
        remoteCreateDestinations: [{
          id: "remote-1",
          name: "Updated Remote",
          url: "http://192.168.1.30:32146",
          token: "u".repeat(40),
          ganamosSuffix: "h",
          multiPanelSuffix: "n"
        }],
        contactFlowCounters: {
          arrived: 8,
          derived: { "remote-1": 4 },
          countedNumbers: ["5491111111111"],
          panels: [{
            id: "panel-2",
            title: "Updated",
            keyword: "actualizado",
            destinationId: "remote-1",
            count: 4,
            countedNumbers: ["5491111111111"]
          }]
        }
      },
      removes: [],
      expectedRevision: runtimeState.body.revision
    }, main.credential, extensionId);
    assert.equal(runtimeWrite.status, 200, JSON.stringify(runtimeWrite.body));
    assert.equal(runtimeWrite.body.revision, runtimeState.body.revision + 1);
    const stateChanges = await request(
      port,
      "GET",
      `/v1/state/changes?after=${runtimeState.body.changeRevision}`,
      undefined,
      main.credential,
      extensionId
    );
    assert.equal(stateChanges.status, 200);
    assert.equal(stateChanges.body.values.ganamosSuffix, "q");
    assert.equal(stateChanges.body.values.activeBonusConfig.percent, 10);
    assert.ok(stateChanges.body.keys.includes("remoteCreateDestinations"));
    const staleRuntimeWrite = await request(port, "POST", "/v1/state", {
      changes: { activeBonusConfig: { type: "simple", enabled: true, percent: 10 } },
      removes: [],
      expectedRevision: runtimeState.body.revision
    }, main.credential, extensionId);
    assert.equal(staleRuntimeWrite.status, 409);
    assert.equal(staleRuntimeWrite.body.code, "state_revision_conflict");
    const runtimeSecret = await pool.query(`
      SELECT value_ciphertext FROM extension_state_values
      WHERE scope_type = 'profile' AND storage_key = 'userCreationPassword'
    `);
    assert.equal(
      runtimeSecret.rows[0].value_ciphertext.includes(Buffer.from("runtime-secret-password")),
      false
    );
    const unknownRuntimeSecret = await pool.query(`
      SELECT value_json, value_ciphertext FROM extension_state_values
      WHERE scope_type = 'profile' AND storage_key = 'futureRuntimeSecret'
    `);
    assert.equal(unknownRuntimeSecret.rows[0].value_json, null);
    assert.equal(
      decryptValue(unknownRuntimeSecret.rows[0].value_ciphertext, encryptionKey),
      canonicalJson({ token: "future-secret-value" })
    );
    const updatedDestination = await pool.query(`
      SELECT name, token_ciphertext FROM remote_destinations
      WHERE profile_id = $1
    `, [main.identity.profileId]);
    assert.equal(updatedDestination.rows[0].name, "Updated Remote");
    assert.equal(
      updatedDestination.rows[0].token_ciphertext.includes(Buffer.from("u".repeat(40))),
      false
    );
    const updatedCounters = await pool.query(`
      SELECT arrived FROM contact_flow_state
    `);
    assert.equal(updatedCounters.rows[0].arrived, "8");
    const updatedBonus = await pool.query(`
      SELECT value_json FROM workspace_settings WHERE setting_key = 'activeBonusConfig'
    `);
    assert.deepEqual(updatedBonus.rows[0].value_json, { type: "simple", enabled: true, percent: 10 });
    const stateRemoval = await request(port, "POST", "/v1/state", {
      changes: {},
      removes: ["ganamosSuffix"],
      expectedRevision: runtimeWrite.body.revision
    }, main.credential, extensionId);
    assert.equal(stateRemoval.status, 200, JSON.stringify(stateRemoval.body));
    const removedSetting = await pool.query(`
      SELECT count(*)::int AS count FROM app_settings
      WHERE profile_id = $1 AND setting_key = 'ganamosSuffix'
    `, [main.identity.profileId]);
    assert.equal(removedSetting.rows[0].count, 0);

    const secondaryCode = await issueEnrollmentCode(
      pool, initialized.workspaceId, "Secondary Device", false
    );
    const secondary = await enroll(port, extensionId, secondaryCode, "Secondary Device");
    const secondaryDestinations = await request(
      port,
      "GET",
      `/v1/state?keys=${encodeURIComponent(JSON.stringify(["remoteCreateDestinations"]))}`,
      undefined,
      secondary.credential,
      extensionId
    );
    assert.equal(secondaryDestinations.status, 200);
    assert.equal(
      Object.hasOwn(secondaryDestinations.body.values, "remoteCreateDestinations"),
      false
    );
    const secondaryDestinationWrite = await request(port, "POST", "/v1/state", {
      changes: {
        remoteCreateDestinations: [{
          id: "remote-1",
          name: "Secondary Remote",
          url: "http://192.168.1.31:32146",
          token: "s".repeat(40),
          ganamosSuffix: "j",
          multiPanelSuffix: "p"
        }]
      },
      removes: [],
      expectedRevision: 0
    }, secondary.credential, extensionId);
    assert.equal(secondaryDestinationWrite.status, 200, JSON.stringify(secondaryDestinationWrite.body));
    const mainDestinationsAfterSecondaryWrite = await request(
      port,
      "GET",
      `/v1/state?keys=${encodeURIComponent(JSON.stringify(["remoteCreateDestinations"]))}`,
      undefined,
      main.credential,
      extensionId
    );
    assert.equal(mainDestinationsAfterSecondaryWrite.status, 200);
    assert.equal(
      mainDestinationsAfterSecondaryWrite.body.values.remoteCreateDestinations[0].name,
      "Updated Remote"
    );
    const destinationOwners = await pool.query(`
      SELECT DISTINCT profile_id FROM remote_destinations
      WHERE workspace_id = $1
    `, [initialized.workspaceId]);
    assert.deepEqual(
      new Set(destinationOwners.rows.map(({ profile_id }) => profile_id)),
      new Set([main.identity.profileId, secondary.identity.profileId])
    );
    const secondMigrationId = await stageAndValidate(port, extensionId, secondary.credential, {
      "A-legacy": "uppercase",
      bridgeRole: "secondary",
      "a-legacy": "lowercase",
      "é-legacy": "unicode-lowercase",
      "É-legacy": "unicode-uppercase",
      "agentMovement:1760000000001:uuid-2": {
        operation: "exchange",
        amount: 3,
        timestamp: 1760000000001,
        contactKey: "contact-key-2"
      }
    });
    const unauthorizedInitialization = await request(port, "POST", `/v1/migrations/${secondMigrationId}/commit`, {
      confirm: true,
      sharedDataDecision: "initialize_shared"
    }, secondary.credential, extensionId);
    assert.equal(unauthorizedInitialization.status, 403);
    const secondCommit = await request(port, "POST", `/v1/migrations/${secondMigrationId}/commit`, {
      confirm: true,
      sharedDataDecision: "private_and_movements_only"
    }, secondary.credential, extensionId);
    assert.equal(secondCommit.status, 200, JSON.stringify(secondCommit.body));
    assert.equal(secondCommit.body.report.sharedData, "not-imported");
    const importedLegacyKeys = await pool.query(`
      SELECT storage_key FROM legacy_extension_values
      WHERE profile_id = $1 AND storage_key = ANY($2::text[])
    `, [secondary.identity.profileId, ["A-legacy", "a-legacy", "É-legacy", "é-legacy"]]);
    assert.equal(importedLegacyKeys.rowCount, 4);
    const movementCount = await pool.query("SELECT count(*)::int AS count FROM agent_movements");
    assert.equal(movementCount.rows[0].count, 2);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (databaseCreated) {
      await databaseAdmin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
    await databaseAdmin.end();
  }
});
