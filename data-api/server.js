const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const { isDeepStrictEqual } = require("node:util");
const { canonicalJson, decryptValue, encryptValue, sha256Hex, validatePayload } = require("./archive");

const API_VERSION = 1;
const SCHEMA_VERSION = 5;
const CONTACT_FLOW_COUNTED_NUMBER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STATE_REQUEST_BYTES = 24 * 1024 * 1024 + 64 * 1024;
const MAX_STAGING_REQUEST_BYTES = 24 * 1024 * 1024 + 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENROLLMENT_WINDOW_MS = 15 * 60 * 1000;
const ENROLLMENT_ATTEMPT_LIMIT = 10;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createDeviceAssertionNonceCleanup(pool) {
  let lastCleanupAt = 0;
  let cleanupPromise = null;
  return async function cleanupExpiredNonces() {
    const now = Date.now();
    if (now - lastCleanupAt < 60_000) return;
    if (!cleanupPromise) {
      cleanupPromise = pool.query(
        "DELETE FROM device_assertion_nonces WHERE expires_at_ms < $1",
        [now]
      ).then(() => {
        lastCleanupAt = Date.now();
      }).finally(() => {
        cleanupPromise = null;
      });
    }
    await cleanupPromise;
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

function getServerConfig() {
  const host = process.env.DATA_API_HOST || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || !privateNetworkHost(host)) {
    throw new Error("DATA_API_HOST debe ser una dirección de loopback o privada específica; no se permite escuchar en todas las interfaces ni en direcciones públicas.");
  }
  const encryptionKey = Buffer.from(requiredEnvironment("DATA_ENCRYPTION_KEY"), "base64");
  if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== process.env.DATA_ENCRYPTION_KEY) {
    throw new Error("DATA_ENCRYPTION_KEY debe ser una clave Base64 canónica de 32 bytes.");
  }
  const extensionIds = requiredEnvironment("DATA_ALLOWED_EXTENSION_IDS")
    .split(",").map((id) => id.trim()).filter(Boolean);
  if (extensionIds.length === 0 || extensionIds.some((id) => !/^[a-p]{32}$/.test(id))) {
    throw new Error("DATA_ALLOWED_EXTENSION_IDS debe contener IDs válidos separados por comas.");
  }
  const cert = fs.readFileSync(requiredEnvironment("DATA_TLS_CERT_FILE"));
  const key = fs.readFileSync(requiredEnvironment("DATA_TLS_KEY_FILE"));
  const workspaceId = requiredEnvironment("DATA_WORKSPACE_ID");
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error("DATA_WORKSPACE_ID debe ser un UUID válido.");
  }
  return { host, encryptionKey, extensionIds, cert, key, workspaceId };
}

function parseBody(request, maximumBytes = MAX_REQUEST_BYTES) {
  if (typeof request.headers["content-type"] !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"])) {
    return Promise.reject(new ApiError(415, "unsupported_media_type", "Se requiere una solicitud application/json."));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maximumBytes) {
        settled = true;
        reject(new ApiError(413, "request_too_large", "La solicitud supera el tamaño permitido."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(body));
      } catch {
        reject(new ApiError(400, "invalid_json", "El cuerpo de la solicitud no es JSON válido."));
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function sendJson(response, status, body, origin, allowedOrigin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
    "referrer-policy": "no-referrer"
  };
  if (origin && origin === allowedOrigin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = [
      "authorization",
      "content-type",
      "x-bridge-device-id",
      "x-bridge-device-time",
      "x-bridge-device-nonce",
      "x-bridge-device-signature"
    ].join(", ");
    headers["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
    headers.vary = "Origin";
  }
  response.writeHead(status, headers);
  if (status === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(body));
}

function getRoute(request) {
  const url = new URL(request.url, "https://localhost");
  const stateReadQuery = request.method === "GET" &&
    ["/v1/state", "/v1/state/changes", "/v1/movements"].includes(url.pathname);
  if (url.hash || url.search && !stateReadQuery) {
    throw new ApiError(400, "invalid_url", "La ruta de la solicitud no es válida.");
  }
  return url.pathname;
}

function validateUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_request", `${field} no es válido.`);
  }
}

function decodeDeviceProofKey(value) {
  if (typeof value !== "string") return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 && key.toString("base64") === value ? key : null;
}

function requireObjectBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "El cuerpo de la solicitud debe ser un objeto JSON.");
  }
  return value;
}

function validateEntry(entry) {
  if (!entry || typeof entry.key !== "string" || !entry.key.length ||
    entry.key.length > 2048 || typeof entry.valueSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.valueSha256)) {
    throw new ApiError(400, "invalid_entry", "Una entrada del lote no es válida.");
  }
  let valueJson;
  try {
    valueJson = canonicalJson(entry.value);
  } catch {
    throw new ApiError(400, "invalid_entry", "Una entrada no contiene un valor JSON válido.");
  }
  const actualHash = sha256Hex(Buffer.from(valueJson, "utf8"));
  if (actualHash !== entry.valueSha256) {
    throw new ApiError(400, "integrity_error", "El hash de una entrada no coincide.");
  }
  return { key: entry.key, valueJson, valueSha256: actualHash };
}

function compareStorageKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildReport(payload) {
  const operationCounts = {};
  let unknownKeyCount = 0;
  for (const entry of payload.entries) {
    if (entry.key.startsWith("agentMovement:")) {
      const operation = ["deposit", "withdrawal", "exchange"].includes(entry.value?.operation)
        ? entry.value.operation
        : "unknown";
      operationCounts[operation] = (operationCounts[operation] || 0) + 1;
    } else if (![
      "bridgeRole", "bridgeToken", "ganamosUserId", "ganamosSuffix",
      "multiPanelSuffix", "userCreationPassword", "remoteCreateDestinations",
      "multiPanelSession", "activeBonusConfig", "contactFlowCounters",
      "agentBalanceView", "agentBalancesMinimized"
    ].includes(entry.key)) {
      unknownKeyCount++;
    }
  }
  return {
    keyCount: payload.keyCount,
    movementCount: payload.movementCount,
    unknownKeyCount,
    operationCounts,
    canonicalSha256: payload.canonicalSha256
  };
}

async function buildConflictPreview(pool, identity, payload, encryptionKey) {
  const settingEntries = payload.entries.filter(({ key }) => PROFILE_SETTING_KEYS.has(key));
  const secretEntries = payload.entries.filter(({ key }) => PROFILE_SECRET_KEYS.has(key));
  const movementEntries = payload.entries.filter(({ key }) => key.startsWith("agentMovement:"));
  const legacyEntries = payload.entries.filter(({ key }) =>
    !PROFILE_SETTING_KEYS.has(key) && !PROFILE_SECRET_KEYS.has(key) &&
    !WORKSPACE_SETTING_KEYS.has(key) && !SHARED_KEYS.has(key) &&
    !key.startsWith("agentMovement:")
  );
  const [settings, secrets, movements, legacy, shared] = await Promise.all([
    settingEntries.length
      ? pool.query(`
          SELECT setting_key, value_json FROM app_settings
          WHERE profile_id = $1 AND setting_key = ANY($2::text[])
        `, [identity.profile_id, settingEntries.map(({ key }) => key)])
      : { rows: [] },
    secretEntries.length
      ? pool.query(`
          SELECT secret_key, ciphertext FROM app_secrets
          WHERE scope_type = 'profile' AND scope_id = $1
            AND secret_key = ANY($2::text[])
        `, [identity.profile_id, secretEntries.map(({ key }) => key)])
      : { rows: [] },
    movementEntries.length
      ? pool.query(`
          SELECT legacy_storage_key, legacy_record_json FROM agent_movements
          WHERE workspace_id = $1 AND source_profile_id = $2
            AND legacy_storage_key = ANY($3::text[])
        `, [identity.workspace_id, identity.profile_id, movementEntries.map(({ key }) => key)])
      : { rows: [] },
    legacyEntries.length
      ? pool.query(`
          SELECT storage_key, source_sha256 FROM legacy_extension_values
          WHERE profile_id = $1 AND storage_key = ANY($2::text[])
        `, [identity.profile_id, legacyEntries.map(({ key }) => key)])
      : { rows: [] },
    pool.query(`
      SELECT migration_id, source_profile_id, source_sha256
      FROM workspace_migration_imports WHERE workspace_id = $1
    `, [identity.workspace_id])
  ]);
  const settingByKey = new Map(settings.rows.map((row) => [row.setting_key, row.value_json]));
  const secretByKey = new Map(secrets.rows.map((row) => [
    row.secret_key,
    decryptValue(row.ciphertext, encryptionKey)
  ]));
  const movementByKey = new Map(movements.rows.map((row) => [
    row.legacy_storage_key,
    row.legacy_record_json
  ]));
  const legacyByKey = new Map(legacy.rows.map((row) => [row.storage_key, row.source_sha256]));
  let settingConflicts = 0;
  let secretConflicts = 0;
  let movementConflicts = 0;
  let legacyConflicts = 0;
  for (const { key, value } of settingEntries) {
    if (settingByKey.has(key) && !isDeepStrictEqual(settingByKey.get(key), value)) settingConflicts++;
  }
  for (const { key, value } of secretEntries) {
    if (secretByKey.has(key) && secretByKey.get(key) !== canonicalJson(value)) secretConflicts++;
  }
  for (const { key, value } of movementEntries) {
    if (movementByKey.has(key) && !isDeepStrictEqual(movementByKey.get(key), value)) movementConflicts++;
  }
  for (const { key, value } of legacyEntries) {
    const oldHash = legacyByKey.get(key);
    const newHash = sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
    if (oldHash !== undefined && oldHash !== newHash) legacyConflicts++;
  }
  return {
    ...buildReport(payload),
    target: {
      serverId: identity.server_id,
      workspaceId: identity.workspace_id,
      profileId: identity.profile_id,
      deviceId: identity.device_id
    },
    conflicts: {
      profileSettings: settingConflicts,
      profileSecrets: secretConflicts,
      movements: movementConflicts,
      legacyKeys: legacyConflicts
    },
    sharedData: {
      initialized: shared.rowCount > 0,
      canInitializeFromThisProfile: identity.is_workspace_admin && shared.rowCount === 0,
      choices: shared.rowCount === 0
        ? identity.is_workspace_admin
          ? ["initialize_shared"]
          : []
        : ["private_and_movements_only"]
    }
  };
}

const PROFILE_SETTING_KEYS = new Set([
  "bridgeRole",
  "ganamosUserId",
  "ganamosSuffix",
  "multiPanelSuffix",
  "agentBalanceView",
  "agentBalancesMinimized"
]);
const PROFILE_SECRET_KEYS = new Set([
  "bridgeToken",
  "userCreationPassword",
  "multiPanelSession",
  "remoteCreateDestinations"
]);
const WORKSPACE_SETTING_KEYS = new Set(["activeBonusConfig"]);
const SHARED_KEYS = new Set([
  "contactFlowCounters",
  "activeBonusConfig"
]);
const PUBLIC_STATE_KEYS = new Set([
  ...PROFILE_SETTING_KEYS,
  ...WORKSPACE_SETTING_KEYS,
  "contactFlowCounters",
  "agentBalanceView",
  "agentBalancesMinimized"
]);
const CONTACT_COUNTER_KEYS = new Set([
  "arrived",
  "derived",
  "countedNumbers",
  "panels"
]);

function stateScope(key) {
  if (SHARED_KEYS.has(key)) return "workspace";
  return "profile";
}

function isStateSecret(key, value) {
  return !PUBLIC_STATE_KEYS.has(key) && !key.startsWith("agentMovement:");
}

async function readExtensionState(pool, config, identity, keys) {
  const [profileValues, workspaceValues, movements] = await Promise.all([
    pool.query(`
      SELECT storage_key, value_json, value_ciphertext
      FROM extension_state_values
      WHERE scope_type = 'profile' AND scope_id = $1
        AND ($2::text[] IS NULL OR storage_key = ANY($2::text[]))
    `, [identity.profile_id, keys]),
    pool.query(`
      SELECT storage_key, value_json, value_ciphertext
      FROM extension_state_values
      WHERE scope_type = 'workspace' AND scope_id = $1
        AND ($2::text[] IS NULL OR storage_key = ANY($2::text[]))
    `, [identity.workspace_id, keys]),
    keys === null || keys.some((key) => key.startsWith("agentMovement:"))
      ? pool.query(`
          SELECT legacy_storage_key, legacy_record_json
          FROM agent_movements
          WHERE workspace_id = $1
            AND ($2::text[] IS NULL OR legacy_storage_key = ANY($2::text[]))
          ORDER BY timestamp_ms DESC NULLS LAST
        `, [identity.workspace_id, keys])
      : { rows: [] }
  ]);
  const values = {};
  for (const row of [...profileValues.rows, ...workspaceValues.rows]) {
    values[row.storage_key] = row.value_ciphertext
      ? JSON.parse(decryptValue(row.value_ciphertext, config.encryptionKey))
      : row.value_json;
  }
  for (const row of movements.rows) values[row.legacy_storage_key] = row.legacy_record_json;
  if (keys === null || keys.some((key) => !PROFILE_SETTING_KEYS.has(key) &&
    !PROFILE_SECRET_KEYS.has(key) && !WORKSPACE_SETTING_KEYS.has(key) &&
    !SHARED_KEYS.has(key) && !key.startsWith("agentMovement:"))) {
    const legacy = await pool.query(`
      SELECT storage_key, value_ciphertext FROM legacy_extension_values
      WHERE profile_id = $1
        AND ($2::text[] IS NULL OR storage_key = ANY($2::text[]))
    `, [identity.profile_id, keys]);
    for (const row of legacy.rows) {
      if (!Object.hasOwn(values, row.storage_key)) {
        values[row.storage_key] = JSON.parse(decryptValue(row.value_ciphertext, config.encryptionKey));
      }
    }
  }
  const [revision, changeRevision] = await Promise.all([
    pool.query(
      "SELECT revision FROM extension_state_revisions WHERE workspace_id = $1",
      [identity.workspace_id]
    ),
    pool.query(
      "SELECT revision FROM workspace_revisions WHERE workspace_id = $1",
      [identity.workspace_id]
    )
  ]);
  return {
    values,
    revision: Number(revision.rows[0]?.revision || 0),
    changeRevision: Number(changeRevision.rows[0]?.revision || 0)
  };
}

async function readWorkspaceStateChanges(pool, identity, afterRevision) {
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
    throw new ApiError(400, "invalid_state_revision", "La revisión de sincronización no es válida.");
  }
  const result = await pool.query(`
    SELECT revision, event_type, entity_key
    FROM workspace_change_log
    WHERE workspace_id = $1 AND revision > $2
    ORDER BY revision
    LIMIT 501
  `, [identity.workspace_id, afterRevision]);
  const [current, stateCurrent] = await Promise.all([
    pool.query(
      "SELECT revision FROM workspace_revisions WHERE workspace_id = $1",
      [identity.workspace_id]
    ),
    pool.query(
      "SELECT revision FROM extension_state_revisions WHERE workspace_id = $1",
      [identity.workspace_id]
    )
  ]);
  const revision = Number(current.rows[0]?.revision || 0);
  const stateRevision = Number(stateCurrent.rows[0]?.revision || 0);
  if (result.rowCount > 500) {
    return { revision, stateRevision, resyncRequired: true, keys: [] };
  }
  const keys = new Set();
  let resyncRequired = false;
  for (const row of result.rows) {
    if (row.event_type !== "state_changed") {
      resyncRequired = true;
      continue;
    }
    let change;
    try {
      change = JSON.parse(row.entity_key);
    } catch {
      throw new Error("La bitácora de cambios de estado contiene JSON corrupto.");
    }
    for (const key of [...(change.keys || []), ...(change.removes || [])]) {
      if (typeof key === "string") keys.add(key);
    }
  }
  return { revision, stateRevision, resyncRequired, keys: [...keys] };
}

async function writeExtensionState(pool, config, identity, changes, removes, expectedRevision) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
    Object.keys(changes).length > 1000 || !Array.isArray(removes) || removes.length > 1000 ||
    removes.some((key) => typeof key !== "string" || !key || key.length > 2048)) {
    throw new ApiError(400, "invalid_state", "El conjunto de cambios de estado no es válido.");
  }
  const keys = Object.keys(changes);
  const sharedWrite = [...keys, ...removes].some((key) => stateScope(key) === "workspace");
  if (keys.some((key) => !key || key.length > 2048) ||
    new Set([...keys, ...removes]).size !== keys.length + removes.length) {
    throw new ApiError(400, "invalid_state", "Las claves del estado están vacías, repetidas o superan el límite.");
  }
  if (sharedWrite && expectedRevision === undefined) {
    throw new ApiError(428, "state_revision_required", "Las escrituras compartidas requieren la revisión leída para evitar sobrescrituras.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT workspace_id FROM workspaces WHERE workspace_id = $1 FOR UPDATE",
      [identity.workspace_id]
    );
    const currentRevision = await client.query(
      "SELECT revision FROM extension_state_revisions WHERE workspace_id = $1 FOR UPDATE",
      [identity.workspace_id]
    );
    const revision = Number(currentRevision.rows[0]?.revision || 0);
    if (sharedWrite && expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision)) {
      const isStaleCounterSnapshot = Number.isSafeInteger(expectedRevision) &&
        expectedRevision >= 0 && expectedRevision < revision &&
        keys.length === 1 && keys[0] === "contactFlowCounters" && removes.length === 0;
      if (!isStaleCounterSnapshot) {
        throw new ApiError(409, "state_revision_conflict", "El estado compartido cambió; recargá y revisá antes de volver a guardar.");
      }
      const storedCounters = await client.query(`
        SELECT value_json, value_ciphertext
        FROM extension_state_values
        WHERE scope_type = 'workspace' AND scope_id = $1
          AND storage_key = 'contactFlowCounters'
        FOR UPDATE
      `, [identity.workspace_id]);
      if (storedCounters.rows[0]) {
        const currentValue = storedCounters.rows[0].value_ciphertext
          ? JSON.parse(decryptValue(storedCounters.rows[0].value_ciphertext, config.encryptionKey))
          : storedCounters.rows[0].value_json;
        changes = {
          ...changes,
          contactFlowCounters: mergeContactFlowCounterSnapshots(
            currentValue,
            changes.contactFlowCounters
          )
        };
      }
    }
    const timestamp = Date.now();
    for (const [key, value] of Object.entries(changes)) {
      const valueJson = canonicalJson(value);
      const scope = stateScope(key);
      const scopeId = scope === "workspace" ? identity.workspace_id : identity.profile_id;
      const secret = isStateSecret(key, value);
      const ciphertext = secret ? encryptValue(valueJson, config.encryptionKey) : null;
      await client.query(`
        INSERT INTO extension_state_values (
          scope_type, scope_id, storage_key, value_json, value_ciphertext, revision, updated_at_ms
        ) VALUES ($1, $2, $3, $4::jsonb, $5, 1, $6)
        ON CONFLICT (scope_type, scope_id, storage_key) DO UPDATE SET
          value_json = EXCLUDED.value_json,
          value_ciphertext = EXCLUDED.value_ciphertext,
          revision = extension_state_values.revision + 1,
          updated_at_ms = EXCLUDED.updated_at_ms
      `, [scope, scopeId, key, secret ? null : valueJson, ciphertext, timestamp]);
      if (PROFILE_SETTING_KEYS.has(key)) {
        await client.query(`
          INSERT INTO app_settings (profile_id, setting_key, value_json, updated_at_ms)
          VALUES ($1, $2, $3::jsonb, $4)
          ON CONFLICT (profile_id, setting_key) DO UPDATE SET
            value_json = EXCLUDED.value_json, revision = app_settings.revision + 1,
            updated_at_ms = EXCLUDED.updated_at_ms
        `, [identity.profile_id, key, valueJson, timestamp]);
      } else if (PROFILE_SECRET_KEYS.has(key)) {
        await client.query(`
          INSERT INTO app_secrets (scope_type, scope_id, secret_key, ciphertext, updated_at_ms)
          VALUES ('profile', $1, $2, $3, $4)
          ON CONFLICT (scope_type, scope_id, secret_key) DO UPDATE SET
            ciphertext = EXCLUDED.ciphertext, updated_at_ms = EXCLUDED.updated_at_ms
        `, [identity.profile_id, key, ciphertext, timestamp]);
        if (key === "remoteCreateDestinations") {
          await replaceRemoteDestinations(client, config, identity, value, timestamp);
        }
      } else if (WORKSPACE_SETTING_KEYS.has(key)) {
        await client.query(`
          INSERT INTO workspace_settings (
            workspace_id, setting_key, value_json, updated_at_ms, updated_by_profile_id
          ) VALUES ($1, $2, $3::jsonb, $4, $5)
          ON CONFLICT (workspace_id, setting_key) DO UPDATE SET
            value_json = EXCLUDED.value_json, revision = workspace_settings.revision + 1,
            updated_at_ms = EXCLUDED.updated_at_ms,
            updated_by_profile_id = EXCLUDED.updated_by_profile_id
        `, [identity.workspace_id, key, valueJson, timestamp, identity.profile_id]);
      } else if (key.startsWith("agentMovement:")) {
        const movement = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        await client.query(`
          INSERT INTO agent_movements (
            workspace_id, source_profile_id, source_device_id, legacy_storage_key,
            timestamp_ms, contact_key, operation, amount_minor, platform, username,
            transaction_minor, bonus_minor, from_platform, to_platform, status,
            verification_json, legacy_record_json, imported_at_ms
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16::jsonb, $17::jsonb, $18
          )
          ON CONFLICT (workspace_id, source_profile_id, legacy_storage_key) DO UPDATE SET
            timestamp_ms = EXCLUDED.timestamp_ms, contact_key = EXCLUDED.contact_key,
            operation = EXCLUDED.operation, amount_minor = EXCLUDED.amount_minor,
            platform = EXCLUDED.platform, username = EXCLUDED.username,
            transaction_minor = EXCLUDED.transaction_minor, bonus_minor = EXCLUDED.bonus_minor,
            from_platform = EXCLUDED.from_platform, to_platform = EXCLUDED.to_platform,
            status = EXCLUDED.status, verification_json = EXCLUDED.verification_json,
            legacy_record_json = EXCLUDED.legacy_record_json
        `, [
          identity.workspace_id, identity.profile_id, identity.device_id, key,
          safeEpochMilliseconds(movement.timestamp),
          typeof movement.contactKey === "string" ? movement.contactKey : null,
          typeof movement.operation === "string" ? movement.operation : null,
          moneyToMinorUnits(movement.amount),
          typeof movement.platform === "string" ? movement.platform : null,
          typeof movement.username === "string" ? movement.username : null,
          moneyToMinorUnits(movement.transactionAmount),
          moneyToMinorUnits(movement.bonusAmount),
          typeof movement.fromPlatform === "string" ? movement.fromPlatform : null,
          typeof movement.toPlatform === "string" ? movement.toPlatform : null,
          typeof movement.status === "string" ? movement.status : null,
          movement.verification === undefined ? null : JSON.stringify(movement.verification),
          valueJson,
          timestamp
        ]);
      } else if (key === "contactFlowCounters") {
        const counters = validateCounterSnapshot(value);
        await client.query(`
          INSERT INTO contact_flow_state (workspace_id, arrived, legacy_unknown_json, updated_at_ms)
          VALUES ($1, $2, $3::jsonb, $4)
          ON CONFLICT (workspace_id) DO UPDATE SET
            arrived = EXCLUDED.arrived,
            legacy_unknown_json = EXCLUDED.legacy_unknown_json,
            revision = contact_flow_state.revision + 1,
            updated_at_ms = EXCLUDED.updated_at_ms
        `, [
          identity.workspace_id,
          counters.arrived,
          jsonValue(counters.legacyUnknown),
          timestamp
        ]);
        await client.query("DELETE FROM contact_flow_derived WHERE workspace_id = $1", [identity.workspace_id]);
        await client.query("DELETE FROM contact_flow_counted_numbers WHERE workspace_id = $1", [identity.workspace_id]);
        await client.query("DELETE FROM contact_flow_panels WHERE workspace_id = $1", [identity.workspace_id]);
        for (const [destinationId, count] of counters.derived) {
          await client.query(`
            INSERT INTO contact_flow_derived (workspace_id, destination_id, count)
            VALUES ($1, $2, $3)
          `, [identity.workspace_id, destinationId, count]);
        }
        for (const { number, countedAt } of counters.countedNumbers) {
          await client.query(`
            INSERT INTO contact_flow_counted_numbers (workspace_id, phone, counted_at_ms)
            VALUES ($1, $2, $3)
          `, [identity.workspace_id, number, countedAt]);
        }
        for (const panel of counters.panels) {
          await client.query(`
            INSERT INTO contact_flow_panels (
              workspace_id, panel_id, ordinal, title, keyword, destination_id,
              count, legacy_json
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          `, [
            identity.workspace_id,
            panel.id,
            panel.ordinal,
            panel.title,
            panel.keyword,
            panel.destinationId,
            panel.count,
            jsonValue(panel.legacy)
          ]);
          for (const { number, countedAt } of panel.countedNumbers) {
            await client.query(`
              INSERT INTO contact_flow_panel_counted_numbers (
                workspace_id, panel_id, phone, counted_at_ms
              ) VALUES ($1, $2, $3, $4)
            `, [identity.workspace_id, panel.id, number, countedAt]);
          }
        }
        await client.query(`
          INSERT INTO app_secrets (scope_type, scope_id, secret_key, ciphertext, updated_at_ms)
          VALUES ('workspace', $1, 'contactFlowCountersSource', $2, $3)
          ON CONFLICT (scope_type, scope_id, secret_key) DO UPDATE SET
            ciphertext = EXCLUDED.ciphertext, updated_at_ms = EXCLUDED.updated_at_ms
        `, [
          identity.workspace_id,
          encryptValue(valueJson, config.encryptionKey),
          timestamp
        ]);
      }
    }
    for (const key of removes) {
      const scope = stateScope(key);
      const scopeId = scope === "workspace" ? identity.workspace_id : identity.profile_id;
      await client.query(`
        DELETE FROM extension_state_values
        WHERE scope_type = $1 AND scope_id = $2 AND storage_key = $3
      `, [scope, scopeId, key]);
      if (key.startsWith("agentMovement:")) {
        await client.query(`
          DELETE FROM agent_movements
          WHERE workspace_id = $1 AND source_profile_id = $2 AND legacy_storage_key = $3
        `, [identity.workspace_id, identity.profile_id, key]);
      }
      if (PROFILE_SETTING_KEYS.has(key)) {
        await client.query(
          "DELETE FROM app_settings WHERE profile_id = $1 AND setting_key = $2",
          [identity.profile_id, key]
        );
      } else if (PROFILE_SECRET_KEYS.has(key)) {
        await client.query(`
          DELETE FROM app_secrets
          WHERE scope_type = 'profile' AND scope_id = $1 AND secret_key = $2
        `, [identity.profile_id, key]);
        if (key === "remoteCreateDestinations") {
          await client.query(
            "DELETE FROM remote_destinations WHERE workspace_id = $1 AND profile_id = $2",
            [identity.workspace_id, identity.profile_id]
          );
        }
      } else if (WORKSPACE_SETTING_KEYS.has(key)) {
        await client.query(
          "DELETE FROM workspace_settings WHERE workspace_id = $1 AND setting_key = $2",
          [identity.workspace_id, key]
        );
      } else if (key === "contactFlowCounters") {
        await client.query("DELETE FROM contact_flow_state WHERE workspace_id = $1", [identity.workspace_id]);
        await client.query(`
          DELETE FROM app_secrets
          WHERE scope_type = 'workspace' AND scope_id = $1 AND secret_key = 'contactFlowCountersSource'
        `, [identity.workspace_id]);
      }
    }
    const updated = await client.query(`
      UPDATE extension_state_revisions SET revision = revision + 1
      WHERE workspace_id = $1 RETURNING revision
    `, [identity.workspace_id]);
    const nextRevision = Number(updated.rows[0]?.revision || 0);
    const workspaceRevision = await client.query(`
      UPDATE workspace_revisions SET revision = revision + 1
      WHERE workspace_id = $1 RETURNING revision
    `, [identity.workspace_id]);
    if (workspaceRevision.rowCount !== 1) {
      throw new ApiError(409, "workspace_not_initialized", "El workspace no está listo para guardar el estado.");
    }
    await client.query(`
      INSERT INTO workspace_change_log (
        workspace_id, revision, event_type, entity_key, actor_profile_id, created_at_ms
      ) VALUES ($1, $2, 'state_changed', $3, $4, $5)
    `, [
      identity.workspace_id,
      workspaceRevision.rows[0].revision,
      JSON.stringify({ keys, removes }),
      identity.profile_id,
      timestamp
    ]);
    await client.query("COMMIT");
    return { revision: nextRevision, changeRevision: Number(workspaceRevision.rows[0].revision) };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Falló la escritura de estado y no se pudo confirmar el rollback.");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function replaceRemoteDestinations(client, config, identity, value, timestamp) {
  const destinations = validateDestinations(value);
  await client.query(
    "DELETE FROM remote_destinations WHERE workspace_id = $1 AND profile_id = $2",
    [identity.workspace_id, identity.profile_id]
  );
  for (const destination of destinations) {
    await client.query(`
      INSERT INTO remote_destinations (
        workspace_id, profile_id, destination_id, ordinal, name, url, token_ciphertext,
        ganamos_suffix, multipanel_suffix, legacy_json, revision, updated_at_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 1, $11)
    `, [
      identity.workspace_id,
      identity.profile_id,
      destination.id,
      destination.ordinal,
      destination.name,
      destination.url,
      encryptValue(destination.token, config.encryptionKey),
      destination.ganamosSuffix,
      destination.multipanelSuffix,
      jsonValue(destination.legacy),
      timestamp
    ]);
  }
}

function jsonValue(value) {
  return JSON.stringify(value);
}

function safeEpochMilliseconds(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() && Number.isSafeInteger(Number(value)) &&
    Number(value) > 0) return Number(value);
  return null;
}

function moneyToMinorUnits(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER / 100) return null;
  const minor = Math.round(numeric * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

function privateNetworkHost(hostname) {
  const host = hostname.toLowerCase();
  const ip = host.startsWith("[") ? host.slice(1, -1) : host;
  if (net.isIPv4(ip)) {
    const [first, second] = ip.split(".").map(Number);
    return first === 10 || first === 172 && second >= 16 && second <= 31 ||
      first === 192 && second === 168 || first === 100 && second >= 64 && second <= 127 ||
      first === 169 && second === 254 || first === 127;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.split("%")[0].toLowerCase();
    return normalized === "::1" || /^f[cd][0-9a-f]{2}:/i.test(normalized) ||
      /^fe[89ab][0-9a-f]:/i.test(normalized);
  }
  return /^[a-z0-9.-]+$/.test(host) && /\.(local|lan|internal)$/.test(host);
}

function validateDestinations(value) {
  if (!Array.isArray(value) || value.length > 3) {
    throw new ApiError(409, "invalid_destinations", "La lista de destinos remotos no es válida.");
  }
  const ids = new Set();
  const names = new Set();
  const origins = new Set();
  return value.map((destination, ordinal) => {
    if (!destination || typeof destination !== "object" ||
      typeof destination.id !== "string" || !/^remote-[1-3]$/.test(destination.id) ||
      typeof destination.name !== "string" || !destination.name.trim() ||
      destination.name.trim().length > 40 ||
      typeof destination.url !== "string" ||
      typeof destination.token !== "string" ||
      !/^[A-Za-z0-9_-]{40,64}$/.test(destination.token) ||
      typeof destination.ganamosSuffix !== "string" ||
      !/^[a-z]$/i.test(destination.ganamosSuffix) ||
      typeof destination.multiPanelSuffix !== "string" ||
      !/^[a-z]$/i.test(destination.multiPanelSuffix) ||
      destination.ganamosSuffix.toLowerCase() === destination.multiPanelSuffix.toLowerCase()) {
      throw new ApiError(409, "invalid_destinations", "Un destino remoto no cumple el formato requerido.");
    }
    let url;
    try {
      url = new URL(destination.url);
    } catch {
      throw new ApiError(409, "invalid_destinations", "La dirección de un destino remoto no es válida.");
    }
    if (url.protocol !== "http:" || url.port !== "32146" || url.pathname !== "/" ||
      url.search || url.hash || url.username || url.password || !privateNetworkHost(url.hostname)) {
      throw new ApiError(409, "invalid_destinations", "Un destino remoto no pertenece a una dirección privada permitida.");
    }
    const origin = url.origin;
    const id = destination.id;
    const name = destination.name.trim();
    if (ids.has(id) || names.has(name.toLocaleLowerCase()) || origins.has(origin)) {
      throw new ApiError(409, "invalid_destinations", "Los destinos contienen IDs, nombres o direcciones repetidas.");
    }
    ids.add(id);
    names.add(name.toLocaleLowerCase());
    origins.add(origin);
    const { token, ...legacyWithoutToken } = destination;
    return {
      id,
      ordinal,
      name,
      url: origin,
      token,
      ganamosSuffix: destination.ganamosSuffix.toLowerCase(),
      multipanelSuffix: destination.multiPanelSuffix.toLowerCase(),
      legacy: legacyWithoutToken
    };
  });
}

function validateCounterSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(409, "invalid_contact_flow", "La configuración de contadores no es un objeto válido.");
  }
  const arrived = Number.isSafeInteger(value.arrived) && value.arrived >= 0 ? value.arrived : 0;
  const derived = [];
  if (value.derived && typeof value.derived === "object" && !Array.isArray(value.derived)) {
    for (const [destinationId, count] of Object.entries(value.derived)) {
      if (Number.isSafeInteger(count) && count >= 0) derived.push([destinationId, count]);
    }
  }
  const now = Date.now();
  const normalizeNumbers = (numbers) => {
    if (!Array.isArray(numbers)) return [];
    const normalized = new Map();
    for (const entry of numbers) {
      const number = typeof entry === "string" ? entry : entry?.number;
      const countedAt = typeof entry === "string" ? now : entry?.countedAt;
      if (typeof number !== "string" || !/^\d{7,20}$/.test(number) ||
        !Number.isSafeInteger(countedAt) || countedAt <= 0) continue;
      normalized.set(number, Math.max(normalized.get(number) || 0, countedAt));
    }
    return [...normalized].map(([number, countedAt]) => ({ number, countedAt }));
  };
  const panels = [];
  const panelIds = new Set();
  if (Array.isArray(value.panels)) {
    for (const panel of value.panels) {
      if (!panel || typeof panel !== "object" ||
        typeof panel.id !== "string" || !panel.id ||
        typeof panel.keyword !== "string" || !panel.keyword.trim() ||
        typeof panel.destinationId !== "string" || !panel.destinationId ||
        panelIds.has(panel.id)) continue;
      panelIds.add(panel.id);
      const knownPanelKeys = new Set([
        "id", "title", "keyword", "destinationId", "count", "countedNumbers"
      ]);
      const legacy = Object.fromEntries(
        Object.entries(panel).filter(([key]) => !knownPanelKeys.has(key))
      );
      panels.push({
        id: panel.id,
        ordinal: panels.length,
        title: typeof panel.title === "string" && panel.title.trim()
          ? panel.title.trim()
          : panel.keyword.trim(),
        keyword: panel.keyword,
        destinationId: panel.destinationId,
        count: Number.isSafeInteger(panel.count) && panel.count >= 0 ? panel.count : 0,
        countedNumbers: normalizeNumbers(panel.countedNumbers),
        legacy
      });
    }
  }
  const legacyUnknown = Object.fromEntries(
    Object.entries(value).filter(([key]) => !CONTACT_COUNTER_KEYS.has(key))
  );
  return {
    arrived,
    derived,
    countedNumbers: normalizeNumbers(value.countedNumbers),
    panels,
    legacyUnknown
  };
}

function mergeContactFlowCounterSnapshots(currentValue, incomingValue, now = Date.now()) {
  const current = validateCounterSnapshot(currentValue);
  const incoming = validateCounterSnapshot(incomingValue);
  const activeNumbers = (numbers) => numbers.filter(({ countedAt }) =>
    countedAt <= now && now - countedAt < CONTACT_FLOW_COUNTED_NUMBER_TTL_MS);
  const mergeNumbers = (currentNumbers, incomingNumbers) => {
    const merged = new Map(activeNumbers(currentNumbers).map((entry) => [entry.number, entry.countedAt]));
    let added = 0;
    for (const entry of activeNumbers(incomingNumbers)) {
      if (!merged.has(entry.number)) added++;
      merged.set(entry.number, Math.max(merged.get(entry.number) || 0, entry.countedAt));
    }
    return {
      numbers: [...merged].map(([number, countedAt]) => ({ number, countedAt })),
      added
    };
  };
  const currentDerived = Object.fromEntries(current.derived);
  const incomingDerived = Object.fromEntries(incoming.derived);
  const mergedDerived = { ...currentDerived };
  const currentPanels = new Map(current.panels.map((panel) => [panel.id, panel]));
  const incomingPanels = new Map(incoming.panels.map((panel) => [panel.id, panel]));
  const mergedPanels = [];

  for (const [id, currentPanel] of currentPanels) {
    const incomingPanel = incomingPanels.get(id);
    const numbers = mergeNumbers(
      currentPanel.countedNumbers,
      incomingPanel?.countedNumbers || []
    );
    mergedPanels.push({
      ...currentPanel,
      count: Math.max(currentPanel.count + numbers.added, incomingPanel?.count || 0),
      countedNumbers: numbers.numbers
    });
    if (incomingPanel && numbers.added) {
      mergedDerived[currentPanel.destinationId] =
        (mergedDerived[currentPanel.destinationId] || 0) + numbers.added;
    }
  }

  for (const [id, incomingPanel] of incomingPanels) {
    if (currentPanels.has(id)) continue;
    const numbers = mergeNumbers([], incomingPanel.countedNumbers);
    mergedPanels.push({
      ...incomingPanel,
      count: Math.max(incomingPanel.count, numbers.added),
      countedNumbers: numbers.numbers
    });
  }
  for (const [destinationId, count] of Object.entries(incomingDerived)) {
    mergedDerived[destinationId] = Math.max(mergedDerived[destinationId] || 0, count);
  }

  const countedNumbers = mergeNumbers(current.countedNumbers, incoming.countedNumbers);
  const arrived = Math.max(current.arrived + countedNumbers.added, incoming.arrived);
  if (!Number.isSafeInteger(arrived) ||
    Object.values(mergedDerived).some((count) => !Number.isSafeInteger(count)) ||
    mergedPanels.some((panel) => !Number.isSafeInteger(panel.count))) {
    throw new ApiError(409, "invalid_contact_flow", "La combinación de contadores supera el límite seguro.");
  }
  return {
    arrived,
    derived: mergedDerived,
    countedNumbers: countedNumbers.numbers,
    panels: mergedPanels,
    ...current.legacyUnknown,
    ...incoming.legacyUnknown
  };
}

async function commitMigration({ pool, config, identity, migrationId, decision }) {
  if (decision !== "initialize_shared" && decision !== "private_and_movements_only") {
    throw new ApiError(400, "invalid_commit_decision", "La decisión de consolidación no es válida.");
  }
  if (decision === "initialize_shared" && !identity.is_workspace_admin) {
    throw new ApiError(403, "admin_required", "Solo el administrador del workspace puede inicializar datos compartidos.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(
      "SELECT workspace_id FROM workspaces WHERE workspace_id = $1 FOR UPDATE",
      [identity.workspace_id]
    );
    if (workspace.rowCount !== 1) {
      throw new ApiError(409, "workspace_not_initialized", "El workspace autenticado no existe.");
    }
    const migrationResult = await client.query(`
      SELECT status, source_extension, source_key_count, movement_count, source_sha256, report_json
      FROM data_migrations
      WHERE profile_id = $1 AND migration_id = $2
      FOR UPDATE
    `, [identity.profile_id, migrationId]);
    const migration = migrationResult.rows[0];
    if (!migration) throw new ApiError(404, "migration_not_found", "No existe esa migración para el perfil autenticado.");
    if (migration.status === "committed") {
      await client.query("COMMIT");
      return { status: "committed", report: migration.report_json };
    }
    if (migration.status !== "validated") {
      throw new ApiError(409, "migration_not_validated", "La migración debe validarse antes de confirmarla.");
    }
    const priorWorkspaceImport = await client.query(`
      SELECT migration_id, source_profile_id, source_sha256
      FROM workspace_migration_imports
      WHERE workspace_id = $1
      FOR UPDATE
    `, [identity.workspace_id]);
    if (decision === "initialize_shared" && priorWorkspaceImport.rowCount !== 0) {
      throw new ApiError(409, "shared_already_initialized", "Los datos compartidos ya se inicializaron desde otro respaldo.");
    }
    if (decision === "private_and_movements_only" && priorWorkspaceImport.rowCount === 0) {
      throw new ApiError(409, "shared_decision_required", "El workspace todavía no tiene una fuente canónica compartida; un administrador debe elegir el primer respaldo.");
    }

    const stagedRows = await client.query(`
      SELECT storage_key, value_ciphertext, value_sha256
      FROM migration_staging_entries
      WHERE profile_id = $1 AND migration_id = $2
    `, [identity.profile_id, migrationId]);
    if (stagedRows.rowCount !== Number(migration.source_key_count)) {
      throw new ApiError(409, "incomplete_migration", "La cantidad de claves del staging ya no coincide.");
    }
    const sourceEntries = stagedRows.rows
      .sort((left, right) => compareStorageKeys(left.storage_key, right.storage_key))
      .map((row) => {
        const plaintext = decryptValue(row.value_ciphertext, config.encryptionKey);
        const value = JSON.parse(plaintext);
        if (canonicalJson(value) !== plaintext ||
          sha256Hex(Buffer.from(plaintext, "utf8")) !== row.value_sha256) {
          throw new ApiError(409, "staging_integrity_error", "No se pudo verificar una entrada del staging.");
        }
        return { key: row.storage_key, value, valueSha256: row.value_sha256 };
      });
    let payload;
    try {
      payload = validatePayload({
        format: "bridgewpp-profile-payload",
        formatVersion: 1,
        exportId: migrationId,
        exportedAt: new Date().toISOString(),
        source: { extensionId: migration.source_extension, storageArea: "chrome.storage.local" },
        integrity: {
          keyCount: Number(migration.source_key_count),
          movementCount: Number(migration.movement_count),
          canonicalSha256: migration.source_sha256
        },
        entries: sourceEntries
      });
    } catch (error) {
      throw new ApiError(409, "payload_integrity_error", error.message);
    }

    const entries = new Map(payload.entries.map(({ key, value }) => [key, value]));
    const now = Date.now();
    let settingCount = 0;
    let secretCount = 0;
    let movementCount = 0;
    let unknownCount = 0;
    for (const [key, value] of entries) {
      if (key.startsWith("agentMovement:") ||
        SHARED_KEYS.has(key) && decision !== "initialize_shared") continue;
      const scope = stateScope(key);
      const scopeId = scope === "workspace" ? identity.workspace_id : identity.profile_id;
      const valueJson = canonicalJson(value);
      const secret = isStateSecret(key, value);
      await client.query(`
        INSERT INTO extension_state_values (
          scope_type, scope_id, storage_key, value_json, value_ciphertext, revision, updated_at_ms
        ) VALUES ($1, $2, $3, $4::jsonb, $5, 1, $6)
        ON CONFLICT (scope_type, scope_id, storage_key) DO NOTHING
      `, [
        scope,
        scopeId,
        key,
        secret ? null : valueJson,
        secret ? encryptValue(valueJson, config.encryptionKey) : null,
        now
      ]);
    }
    const storeSecret = async (scopeType, scopeId, secretKey, value) => {
      const encrypted = encryptValue(canonicalJson(value), config.encryptionKey);
      await client.query(`
        INSERT INTO app_secrets (scope_type, scope_id, secret_key, ciphertext, updated_at_ms)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (scope_type, scope_id, secret_key) DO NOTHING
      `, [scopeType, scopeId, secretKey, encrypted, now]);
      const existing = await client.query(`
        SELECT ciphertext FROM app_secrets
        WHERE scope_type = $1 AND scope_id = $2 AND secret_key = $3
      `, [scopeType, scopeId, secretKey]);
      const previous = decryptValue(existing.rows[0].ciphertext, config.encryptionKey);
      if (previous !== canonicalJson(value)) {
        throw new ApiError(409, "secret_conflict", "Un valor secreto ya existe con otro contenido para el perfil o workspace.");
      }
      secretCount++;
    };
    for (const [key, value] of entries) {
      if (PROFILE_SETTING_KEYS.has(key)) {
        await client.query(`
          INSERT INTO app_settings (profile_id, setting_key, value_json, updated_at_ms)
          VALUES ($1, $2, $3::jsonb, $4)
          ON CONFLICT (profile_id, setting_key) DO NOTHING
        `, [identity.profile_id, key, jsonValue(value), now]);
        const saved = await client.query(`
          SELECT value_json FROM app_settings WHERE profile_id = $1 AND setting_key = $2
        `, [identity.profile_id, key]);
        if (!isDeepStrictEqual(saved.rows[0].value_json, value)) {
          throw new ApiError(409, "setting_conflict", "Una configuración del perfil ya existe con otro valor.");
        }
        settingCount++;
      } else if (PROFILE_SECRET_KEYS.has(key)) {
        await storeSecret("profile", identity.profile_id, key, value);
        if (key === "remoteCreateDestinations") {
          await replaceRemoteDestinations(client, config, identity, value, now);
        }
      } else if (key.startsWith("agentMovement:")) {
        const movement = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const insertResult = await client.query(`
          INSERT INTO agent_movements (
            workspace_id, source_profile_id, source_device_id, legacy_storage_key,
            timestamp_ms, contact_key, operation, amount_minor, platform, username,
            transaction_minor, bonus_minor, from_platform, to_platform, status,
            verification_json, legacy_record_json, imported_at_ms
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16::jsonb, $17::jsonb, $18
          )
          ON CONFLICT (workspace_id, source_profile_id, legacy_storage_key) DO NOTHING
          RETURNING legacy_storage_key
        `, [
          identity.workspace_id, identity.profile_id, identity.device_id, key,
          safeEpochMilliseconds(movement.timestamp),
          typeof movement.contactKey === "string" ? movement.contactKey : null,
          typeof movement.operation === "string" ? movement.operation : null,
          moneyToMinorUnits(movement.amount),
          typeof movement.platform === "string" ? movement.platform : null,
          typeof movement.username === "string" ? movement.username : null,
          moneyToMinorUnits(movement.transactionAmount),
          moneyToMinorUnits(movement.bonusAmount),
          typeof movement.fromPlatform === "string" ? movement.fromPlatform : null,
          typeof movement.toPlatform === "string" ? movement.toPlatform : null,
          typeof movement.status === "string" ? movement.status : null,
          movement.verification === undefined ? null : jsonValue(movement.verification),
          jsonValue(value), now
        ]);
        if (insertResult.rowCount === 0) {
          const existing = await client.query(`
            SELECT legacy_record_json FROM agent_movements
            WHERE workspace_id = $1 AND source_profile_id = $2 AND legacy_storage_key = $3
          `, [identity.workspace_id, identity.profile_id, key]);
          if (!isDeepStrictEqual(existing.rows[0]?.legacy_record_json, value)) {
            throw new ApiError(409, "movement_conflict", "Un movimiento heredado existe con contenido diferente.");
          }
        }
        movementCount++;
      } else if (SHARED_KEYS.has(key)) {
        if (decision !== "initialize_shared") continue;
        if (key === "activeBonusConfig") {
          await client.query(`
            INSERT INTO workspace_settings (
              workspace_id, setting_key, value_json, updated_at_ms, updated_by_profile_id
            ) VALUES ($1, $2, $3::jsonb, $4, $5)
          `, [identity.workspace_id, key, jsonValue(value), now, identity.profile_id]);
        } else {
          const counters = validateCounterSnapshot(value);
          await client.query(`
            INSERT INTO contact_flow_state (
              workspace_id, arrived, legacy_unknown_json, updated_at_ms
            ) VALUES ($1, $2, $3::jsonb, $4)
          `, [identity.workspace_id, counters.arrived, jsonValue(counters.legacyUnknown), now]);
          for (const [destinationId, count] of counters.derived) {
            await client.query(`
              INSERT INTO contact_flow_derived (workspace_id, destination_id, count)
              VALUES ($1, $2, $3)
            `, [identity.workspace_id, destinationId, count]);
          }
          for (const { number, countedAt } of counters.countedNumbers) {
            await client.query(`
              INSERT INTO contact_flow_counted_numbers (workspace_id, phone, counted_at_ms)
              VALUES ($1, $2, $3)
            `, [identity.workspace_id, number, countedAt]);
          }
          for (const panel of counters.panels) {
            await client.query(`
              INSERT INTO contact_flow_panels (
                workspace_id, panel_id, ordinal, title, keyword, destination_id,
                count, legacy_json
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            `, [
              identity.workspace_id, panel.id, panel.ordinal, panel.title,
              panel.keyword, panel.destinationId, panel.count, jsonValue(panel.legacy)
            ]);
            for (const { number, countedAt } of panel.countedNumbers) {
              await client.query(`
                INSERT INTO contact_flow_panel_counted_numbers (
                  workspace_id, panel_id, phone, counted_at_ms
                ) VALUES ($1, $2, $3, $4)
              `, [identity.workspace_id, panel.id, number, countedAt]);
            }
          }
          await storeSecret("workspace", identity.workspace_id, "contactFlowCountersSource", value);
        }
      } else if (!key.startsWith("agentMovement:")) {
        const encrypted = encryptValue(canonicalJson(value), config.encryptionKey);
        const hash = sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
        await client.query(`
          INSERT INTO legacy_extension_values (
            profile_id, storage_key, value_ciphertext, imported_at_ms, source_sha256
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (profile_id, storage_key) DO NOTHING
        `, [identity.profile_id, key, encrypted, now, hash]);
        const stored = await client.query(`
          SELECT value_ciphertext FROM legacy_extension_values
          WHERE profile_id = $1 AND storage_key = $2
        `, [identity.profile_id, key]);
        if (decryptValue(stored.rows[0].value_ciphertext, config.encryptionKey) !== canonicalJson(value)) {
          throw new ApiError(409, "legacy_conflict", "Una clave heredada ya existe con otro contenido.");
        }
        unknownCount++;
      }
    }

    if (decision === "initialize_shared") {
      await client.query(`
        INSERT INTO workspace_migration_imports (
          workspace_id, migration_id, source_profile_id, source_sha256, committed_at_ms
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        identity.workspace_id, migrationId, identity.profile_id,
        migration.source_sha256, now
      ]);
    }
    await client.query(`
      INSERT INTO extension_state_revisions (workspace_id, revision)
      VALUES ($1, 1)
      ON CONFLICT (workspace_id) DO UPDATE SET
        revision = extension_state_revisions.revision + 1
    `, [identity.workspace_id]);
    const revisionResult = await client.query(`
      UPDATE workspace_revisions SET revision = revision + 1 WHERE workspace_id = $1
      RETURNING revision
    `, [identity.workspace_id]);
    if (revisionResult.rowCount !== 1) {
      throw new ApiError(409, "workspace_not_initialized", "El workspace no está listo para importar.");
    }
    await client.query(`
      INSERT INTO workspace_change_log (
        workspace_id, revision, event_type, entity_key, actor_profile_id, created_at_ms
      ) VALUES ($1, $2, 'profile_migration_committed', $3, $4, $5)
    `, [
      identity.workspace_id, revisionResult.rows[0].revision,
      migrationId, identity.profile_id, now
    ]);
    const report = {
      ...buildReport(payload),
      importedSettings: settingCount,
      importedSecrets: secretCount,
      importedMovements: movementCount,
      preservedUnknownKeys: unknownCount,
      sharedData: decision === "initialize_shared" ? "initialized" : "not-imported"
    };
    await client.query(`
      UPDATE data_migrations
      SET status = 'committed', report_json = $3::jsonb, completed_at_ms = $4
      WHERE profile_id = $1 AND migration_id = $2
    `, [identity.profile_id, migrationId, JSON.stringify(report), now]);
    await client.query("COMMIT");
    return { status: "committed", report };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Falló la importación y no se pudo confirmar el rollback.");
    }
    throw error;
  } finally {
    client.release();
  }
}

function createDataApiServer({ pool, config }) {
  const attemptsByAddress = new Map();
  const cleanupExpiredDeviceAssertionNonces = createDeviceAssertionNonceCleanup(pool);
  const allowedOrigins = new Map(
    config.extensionIds.map((extensionId) => [`chrome-extension://${extensionId}`, extensionId])
  );

  async function authenticate(request) {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      throw new ApiError(401, "unauthorized", "El perfil no está autenticado.");
    }
    const token = authorization.slice(7);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new ApiError(401, "unauthorized", "El perfil no está autenticado.");
    }
    const tokenHash = crypto.createHash("sha256").update(token).digest();
    const result = await pool.query(`
      SELECT p.profile_id, p.workspace_id, p.device_id, p.installation_id,
             p.source_extension, p.is_workspace_admin,
             p.revoked_at_ms AS profile_revoked_at_ms,
             d.revoked_at_ms AS device_revoked_at_ms,
             d.device_proof_ciphertext, w.server_id
      FROM profile_credentials c
      JOIN extension_profiles p USING (profile_id)
      JOIN enrolled_devices d USING (device_id, workspace_id)
      JOIN workspaces w USING (workspace_id)
      WHERE c.credential_hash = $1
        AND c.revoked_at_ms IS NULL
        AND (c.expires_at_ms IS NULL OR c.expires_at_ms > $2)
      LIMIT 1
    `, [tokenHash, Date.now()]);
    const identity = result.rows[0];
    if (!identity || identity.profile_revoked_at_ms !== null ||
      identity.device_revoked_at_ms !== null) {
      throw new ApiError(401, "unauthorized", "El perfil no está autenticado o fue revocado.");
    }
    if (!identity.device_proof_ciphertext) {
      const address = request.socket.remoteAddress || "";
      const loopback = address === "::1" || address === "127.0.0.1" ||
        address.startsWith("::ffff:127.");
      if (!loopback) {
        throw new ApiError(401, "device_proof_required", "Esta instalación requiere una aserción criptográfica del dispositivo.");
      }
    } else {
      const deviceId = request.headers["x-bridge-device-id"];
      const timestamp = Number(request.headers["x-bridge-device-time"]);
      const nonce = request.headers["x-bridge-device-nonce"];
      const signature = request.headers["x-bridge-device-signature"];
      if (deviceId !== identity.device_id || !Number.isSafeInteger(timestamp) ||
        Math.abs(Date.now() - timestamp) > 30_000 ||
        typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
        typeof signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
        throw new ApiError(401, "invalid_device_proof", "La aserción del dispositivo no es válida o expiró.");
      }
      const proofKey = decodeDeviceProofKey(
        decryptValue(identity.device_proof_ciphertext, config.encryptionKey)
      );
      if (!proofKey) throw new Error("La clave de dispositivo cifrada no tiene el formato esperado.");
      const signedData = [
        request.method.toUpperCase(),
        request.url,
        String(timestamp),
        nonce
      ].join("\n");
      const expected = crypto.createHmac("sha256", proofKey).update(signedData).digest();
      const supplied = Buffer.from(signature, "base64url");
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        throw new ApiError(401, "invalid_device_proof", "La firma del dispositivo no es válida.");
      }
      await cleanupExpiredDeviceAssertionNonces();
      const nonceClaim = await pool.query(`
        INSERT INTO device_assertion_nonces (device_id, nonce, expires_at_ms)
        VALUES ($1, $2, $3)
        ON CONFLICT (device_id, nonce) DO NOTHING
        RETURNING nonce
      `, [identity.device_id, nonce, timestamp + 30_000]);
      if (nonceClaim.rowCount !== 1) {
        throw new ApiError(401, "replayed_device_proof", "La aserción del dispositivo ya se utilizó.");
      }
    }
    const origin = request.headers.origin;
    if (origin && allowedOrigins.get(origin) !== identity.source_extension) {
      throw new ApiError(403, "extension_mismatch", "La extensión no coincide con el perfil enrolado.");
    }
    return identity;
  }

  async function handle(request, response) {
    const origin = request.headers.origin;
    const extensionId = origin ? allowedOrigins.get(origin) : null;
    if (origin && !extensionId) {
      sendJson(response, 403, { ok: false, code: "origin_denied", error: "Origen no autorizado." }, origin, null);
      return;
    }
    if (request.method === "OPTIONS") {
      if (!extensionId) {
        sendJson(response, 403, { ok: false, code: "origin_denied", error: "Origen no autorizado." }, origin, null);
        return;
      }
      sendJson(response, 204, {}, origin, `chrome-extension://${extensionId}`);
      return;
    }

    let route;
    try {
      route = getRoute(request);
      if (request.method === "GET" && route === "/health") {
        let schema;
        try {
          schema = await pool.query(
            `SELECT count(*)::int AS applied_count
             FROM schema_migrations
             WHERE version BETWEEN 1 AND $1`,
            [SCHEMA_VERSION]
          );
        } catch (error) {
          console.error(`Health check de base no disponible: ${error.code || error.name || "unknown"}`);
          throw new ApiError(503, "database_not_ready", "La base o el esquema no están disponibles.");
        }
        if (schema.rows[0]?.applied_count !== SCHEMA_VERSION) {
          throw new ApiError(503, "schema_not_ready", "El esquema de datos no está preparado.");
        }
        sendJson(response, 200, {
          ok: true,
          status: "healthy",
          apiVersion: API_VERSION,
          schemaVersion: SCHEMA_VERSION
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (request.method === "GET" && route === "/v1/server-info") {
        const result = await pool.query(`
          SELECT server_id, workspace_id
          FROM workspaces WHERE workspace_id = $1
        `, [config.workspaceId]);
        if (!result.rows[0]) throw new ApiError(503, "not_initialized", "El servidor de datos aún no está inicializado.");
        sendJson(response, 200, {
          ok: true,
          serverId: result.rows[0].server_id,
          workspaceId: result.rows[0].workspace_id,
          apiVersion: API_VERSION,
          schemaVersion: SCHEMA_VERSION,
          tls: true
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (request.method === "GET" && route === "/v1/identity") {
        const identity = await authenticate(request);
        sendJson(response, 200, {
          ok: true,
          serverId: identity.server_id,
          workspaceId: identity.workspace_id,
          profileId: identity.profile_id,
          deviceId: identity.device_id,
          installationId: identity.installation_id,
          sourceExtensionId: identity.source_extension,
          enrolled: true,
          schemaVersion: SCHEMA_VERSION,
          apiVersion: API_VERSION
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (request.method === "POST" && route === "/v1/enroll") {
        const remoteAddress = request.socket.remoteAddress || "unknown";
        const attempts = attemptsByAddress.get(remoteAddress) || { start: Date.now(), count: 0 };
        if (Date.now() - attempts.start > ENROLLMENT_WINDOW_MS) {
          attempts.start = Date.now();
          attempts.count = 0;
        }
        attempts.count++;
        attemptsByAddress.set(remoteAddress, attempts);
        if (attempts.count > ENROLLMENT_ATTEMPT_LIMIT) {
          throw new ApiError(429, "rate_limited", "Se superó el límite de intentos de enrolamiento.");
        }
        const body = requireObjectBody(await parseBody(request));
        validateUuid(body.installationId, "installationId");
        if (typeof body.code !== "string" || body.code.length < 32 || body.code.length > 128 ||
          typeof body.extensionId !== "string" || !/^[a-p]{32}$/.test(body.extensionId) ||
          !allowedOrigins.has(`chrome-extension://${body.extensionId}`) ||
          typeof body.deviceName !== "string" || !body.deviceName.trim() ||
          body.deviceName.length > 120) {
          throw new ApiError(400, "invalid_request", "Los datos de enrolamiento no son válidos.");
        }
        const deviceProofKey = decodeDeviceProofKey(body.deviceProofKey);
        if (!deviceProofKey) {
          throw new ApiError(400, "invalid_device_proof_key", "La clave de dispositivo no tiene el formato requerido.");
        }

        const token = crypto.randomBytes(32).toString("base64url");
        const tokenHash = crypto.createHash("sha256").update(token).digest();
        const codeHash = crypto.createHash("sha256").update(body.code).digest();
        const now = Date.now();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const enrollment = await client.query(`
            SELECT workspace_id, device_name, grants_workspace_admin
            FROM enrollment_codes
            WHERE code_hash = $1 AND consumed_at_ms IS NULL AND expires_at_ms > $2
            FOR UPDATE
          `, [codeHash, now]);
          if (!enrollment.rows[0] || enrollment.rows[0].device_name !== body.deviceName.trim()) {
            throw new ApiError(401, "invalid_enrollment", "El código no es válido, expiró o no corresponde al dispositivo.");
          }
          const workspaceId = enrollment.rows[0].workspace_id;
          const deviceId = crypto.randomUUID();
          const profileId = crypto.randomUUID();
          await client.query(`
            UPDATE enrollment_codes SET consumed_at_ms = $2
            WHERE code_hash = $1 AND consumed_at_ms IS NULL
          `, [codeHash, now]);
          await client.query(`
            INSERT INTO enrolled_devices (
              device_id, workspace_id, display_name, enrolled_at_ms, device_proof_ciphertext
            ) VALUES ($1, $2, $3, $4, $5)
          `, [
            deviceId,
            workspaceId,
            body.deviceName.trim(),
            now,
            encryptValue(body.deviceProofKey, config.encryptionKey)
          ]);
          await client.query(`
            INSERT INTO extension_profiles (
              profile_id, workspace_id, device_id, installation_id,
              source_extension, is_workspace_admin, enrolled_at_ms
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            profileId, workspaceId, deviceId, body.installationId, body.extensionId,
            enrollment.rows[0].grants_workspace_admin, now
          ]);
          await client.query(`
            INSERT INTO profile_credentials (credential_id, profile_id, credential_hash, created_at_ms)
            VALUES ($1, $2, $3, $4)
          `, [crypto.randomUUID(), profileId, tokenHash, now]);
          await client.query("COMMIT");
          attemptsByAddress.delete(remoteAddress);
          sendJson(response, 201, {
            ok: true,
            credential: token,
            identity: { profileId, deviceId, workspaceId }
          }, origin, extensionId && `chrome-extension://${extensionId}`);
          return;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Falló el enrolamiento y no se pudo confirmar el rollback.");
          }
          throw error;
        } finally {
          client.release();
        }
      }

      const statusRoute = /^\/v1\/migrations\/([0-9a-f-]{36})$/.exec(route);
      if (request.method === "DELETE" && statusRoute) {
        const identity = await authenticate(request);
        validateUuid(statusRoute[1], "migrationId");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const migration = await client.query(`
            SELECT status FROM data_migrations
            WHERE profile_id = $1 AND migration_id = $2
            FOR UPDATE
          `, [identity.profile_id, statusRoute[1]]);
          if (!migration.rows[0]) {
            throw new ApiError(404, "migration_not_found", "No existe esa migración para el perfil autenticado.");
          }
          if (!["staging", "validated"].includes(migration.rows[0].status)) {
            throw new ApiError(409, "migration_not_discardable", "Solo se puede descartar staging sin confirmar.");
          }
          await client.query(`
            DELETE FROM data_migrations WHERE profile_id = $1 AND migration_id = $2
          `, [identity.profile_id, statusRoute[1]]);
          await client.query("COMMIT");
          sendJson(response, 200, { ok: true, discarded: true }, origin, extensionId && `chrome-extension://${extensionId}`);
          return;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Falló el descarte y no se pudo confirmar el rollback.");
          }
          throw error;
        } finally {
          client.release();
        }
      }
      if (request.method === "GET" && statusRoute) {
        const identity = await authenticate(request);
        validateUuid(statusRoute[1], "migrationId");
        const result = await pool.query(`
          SELECT status, report_json, source_key_count, movement_count, source_sha256
          FROM data_migrations WHERE profile_id = $1 AND migration_id = $2
        `, [identity.profile_id, statusRoute[1]]);
        if (!result.rows[0]) {
          throw new ApiError(404, "migration_not_found", "No existe esa migración para el perfil autenticado.");
        }
        sendJson(response, 200, {
          ok: true,
          migrationId: statusRoute[1],
          status: result.rows[0].status,
          keyCount: Number(result.rows[0].source_key_count),
          movementCount: Number(result.rows[0].movement_count),
          canonicalSha256: result.rows[0].source_sha256,
          report: result.rows[0].report_json
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/state/revision" && request.method === "GET") {
        const identity = await authenticate(request);
        const result = await pool.query(
          "SELECT revision FROM workspace_revisions WHERE workspace_id = $1",
          [identity.workspace_id]
        );
        sendJson(response, 200, {
          ok: true,
          revision: Number(result.rows[0]?.revision || 0)
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/state/changes" && request.method === "GET") {
        const identity = await authenticate(request);
        const query = new URL(request.url, "https://localhost").searchParams;
        if ([...query.keys()].some((key) => key !== "after") || query.getAll("after").length !== 1) {
          throw new ApiError(400, "invalid_state_query", "La consulta de sincronización no es válida.");
        }
        const after = Number(query.get("after"));
        const changes = await readWorkspaceStateChanges(pool, identity, after);
        if (changes.resyncRequired) {
          sendJson(response, 200, { ok: true, ...changes }, origin, extensionId && `chrome-extension://${extensionId}`);
          return;
        }
        const state = changes.keys.length
          ? await readExtensionState(pool, config, identity, changes.keys)
          : { values: {} };
        sendJson(response, 200, {
          ok: true,
          ...changes,
          values: state.values,
          stateRevision: state.revision ?? changes.stateRevision
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/state" && request.method === "GET") {
        const identity = await authenticate(request);
        const query = new URL(request.url, "https://localhost").searchParams;
        let keys = null;
        if ([...query.keys()].some((key) => key !== "keys") || query.getAll("keys").length > 1) {
          throw new ApiError(400, "invalid_state_query", "La consulta de estado contiene parámetros no válidos.");
        }
        if (query.has("keys")) {
          try {
            keys = JSON.parse(query.get("keys"));
          } catch {
            throw new ApiError(400, "invalid_state_query", "La lista de claves solicitadas no es JSON válida.");
          }
          if (!Array.isArray(keys) || keys.length > 1000 ||
            keys.some((key) => typeof key !== "string" || !key || key.length > 2048) ||
            new Set(keys).size !== keys.length) {
            throw new ApiError(400, "invalid_state_query", "La lista de claves solicitadas no es válida.");
          }
        }
        const state = await readExtensionState(pool, config, identity, keys);
        sendJson(response, 200, { ok: true, ...state }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/movements" && request.method === "GET") {
        const identity = await authenticate(request);
        const query = new URL(request.url, "https://localhost").searchParams;
        const allowedParameters = new Set(["contactKey", "operation", "since", "limit"]);
        if ([...query.keys()].some((key) => !allowedParameters.has(key)) ||
          [...allowedParameters].some((key) => query.getAll(key).length > 1)) {
          throw new ApiError(400, "invalid_movement_query", "Los filtros de movimientos no son válidos.");
        }
        const contactKey = query.get("contactKey");
        if (contactKey !== null &&
          (!contactKey || contactKey.length > 2048 || /[\u0000-\u001f\u007f]/.test(contactKey))) {
          throw new ApiError(400, "invalid_movement_query", "El contacto consultado no es válido.");
        }
        const operation = query.get("operation");
        if (operation !== null && !["deposit", "withdrawal", "exchange"].includes(operation)) {
          throw new ApiError(400, "invalid_movement_query", "El tipo de movimiento consultado no es válido.");
        }
        const since = query.get("since");
        if (since !== null && (!/^\d{1,16}$/.test(since) || !Number.isSafeInteger(Number(since)))) {
          throw new ApiError(400, "invalid_movement_query", "La fecha mínima de movimientos no es válida.");
        }
        const limit = query.get("limit");
        if (limit !== null && (!/^[1-9]\d{0,4}$/.test(limit) || Number(limit) > 10000)) {
          throw new ApiError(400, "invalid_movement_query", "El límite de movimientos debe estar entre 1 y 10000.");
        }
        const parameters = [identity.workspace_id];
        const filters = ["workspace_id = $1"];
        if (contactKey !== null) {
          parameters.push(contactKey);
          filters.push(`contact_key = $${parameters.length}`);
        }
        if (operation !== null) {
          parameters.push(operation);
          filters.push(`operation = $${parameters.length}`);
        }
        if (since !== null) {
          parameters.push(Number(since));
          filters.push(`timestamp_ms >= $${parameters.length}`);
        }
        let limitClause = "";
        if (limit !== null) {
          parameters.push(Number(limit));
          limitClause = `LIMIT $${parameters.length}`;
        }
        const result = await pool.query(`
          SELECT legacy_record_json
          FROM agent_movements
          WHERE ${filters.join(" AND ")}
          ORDER BY timestamp_ms DESC NULLS LAST, legacy_storage_key DESC
          ${limitClause}
        `, parameters);
        sendJson(response, 200, {
          ok: true,
          movements: result.rows.map(({ legacy_record_json: movement }) => movement)
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/state" && request.method === "POST") {
        const identity = await authenticate(request);
        const body = requireObjectBody(await parseBody(request, MAX_STATE_REQUEST_BYTES));
        const { revision, changeRevision } = await writeExtensionState(
          pool,
          config,
          identity,
          body.changes,
          body.removes || [],
          body.expectedRevision
        );
        sendJson(response, 200, {
          ok: true,
          revision,
          changeRevision
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      const migrationRoute = /^\/v1\/migrations\/([0-9a-f-]{36})(?:\/(entries|validate|commit))?$/.exec(route);
      if (!migrationRoute || request.method !== "POST") {
        throw new ApiError(404, "not_found", "La ruta solicitada no existe.");
      }
      const identity = await authenticate(request);
      const migrationId = migrationRoute[1];
      validateUuid(migrationId, "migrationId");
      const action = migrationRoute[2] || "start";
      const bodyLimit = action === "entries"
        ? MAX_STAGING_REQUEST_BYTES
        : route === "/v1/state" ? MAX_STATE_REQUEST_BYTES : MAX_REQUEST_BYTES;
      const body = requireObjectBody(await parseBody(request, bodyLimit));

      if (action === "start") {
        if (body.migrationId !== migrationId) {
          throw new ApiError(400, "invalid_request", "El identificador de migración no coincide.");
        }
        validateUuid(body.migrationId, "migrationId");
        if (!Number.isSafeInteger(body.keyCount) || body.keyCount < 0 || body.keyCount > 100_000 ||
          !Number.isSafeInteger(body.movementCount) || body.movementCount < 0 ||
          body.movementCount > body.keyCount ||
          typeof body.canonicalSha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.canonicalSha256) ||
          typeof body.extensionId !== "string" || !/^[a-p]{32}$/.test(body.extensionId) ||
          body.extensionId !== identity.source_extension && body.confirmDifferentExtension !== true) {
          throw new ApiError(400, "invalid_request", "Los metadatos de migración no son válidos.");
        }
        await pool.query(`
          INSERT INTO data_migrations (
            profile_id, migration_id, status, source_extension,
            source_key_count, movement_count, source_sha256, started_at_ms
          ) VALUES ($1, $2, 'staging', $3, $4, $5, $6, $7)
          ON CONFLICT (profile_id, migration_id) DO NOTHING
        `, [
          identity.profile_id, migrationId, body.extensionId, body.keyCount,
          body.movementCount, body.canonicalSha256, Date.now()
        ]);
        const current = await pool.query(`
          SELECT status, source_extension, source_key_count, movement_count, source_sha256
          FROM data_migrations WHERE profile_id = $1 AND migration_id = $2
        `, [identity.profile_id, migrationId]);
        const existing = current.rows[0];
        if (existing.source_extension !== body.extensionId ||
          Number(existing.source_key_count) !== body.keyCount ||
          Number(existing.movement_count) !== body.movementCount ||
          existing.source_sha256 !== body.canonicalSha256) {
          throw new ApiError(409, "migration_conflict", "El identificador ya existe con otro contenido.");
        }
        sendJson(response, 200, { ok: true, status: existing.status }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      const statusResult = await pool.query(`
        SELECT status, source_extension, source_key_count, movement_count,
               source_sha256, report_json
        FROM data_migrations WHERE profile_id = $1 AND migration_id = $2
      `, [identity.profile_id, migrationId]);
      const migration = statusResult.rows[0];
      if (!migration) throw new ApiError(404, "migration_not_found", "No existe esa migración para el perfil autenticado.");
      if (migration.status === "committed") {
        sendJson(response, 200, { ok: true, status: "committed", report: migration.report_json }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }
      if (action === "commit") {
        if (body.confirm !== true) {
          throw new ApiError(400, "explicit_confirmation_required", "La importación requiere confirmación explícita.");
        }
        const result = await commitMigration({
          pool,
          config,
          identity,
          migrationId,
          decision: body.sharedDataDecision
        });
        sendJson(response, 200, { ok: true, ...result }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }
      if (action === "entries") {
        if (migration.status !== "staging" || !Array.isArray(body.entries) ||
          body.entries.length === 0 || body.entries.length > 500) {
          throw new ApiError(409, "invalid_batch", "El lote o el estado de la migración no son válidos.");
        }
        const batchBytes = Buffer.byteLength(JSON.stringify(body.entries), "utf8");
        if (batchBytes > MAX_STAGING_REQUEST_BYTES) {
          throw new ApiError(413, "request_too_large", "El lote supera el tamaño máximo permitido.");
        }
        const entries = body.entries.map(validateEntry);
        if (new Set(entries.map(({ key }) => key)).size !== entries.length) {
          throw new ApiError(400, "duplicate_keys", "El lote contiene claves repetidas.");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const entry of entries) {
            const encryptedValue = encryptValue(entry.valueJson, config.encryptionKey);
            const inserted = await client.query(`
              INSERT INTO migration_staging_entries (
                profile_id, migration_id, storage_key, value_ciphertext, value_sha256
              ) VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (profile_id, migration_id, storage_key) DO NOTHING
              RETURNING storage_key
            `, [identity.profile_id, migrationId, entry.key, encryptedValue, entry.valueSha256]);
            if (inserted.rowCount === 0) {
              const existing = await client.query(`
                SELECT value_sha256 FROM migration_staging_entries
                WHERE profile_id = $1 AND migration_id = $2 AND storage_key = $3
              `, [identity.profile_id, migrationId, entry.key]);
              if (existing.rows[0]?.value_sha256 !== entry.valueSha256) {
                throw new ApiError(409, "entry_conflict", "Una clave ya fue recibida con otro contenido.");
              }
            }
          }
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Falló el lote y no se pudo confirmar el rollback.");
          }
          throw error;
        } finally {
          client.release();
        }
        sendJson(response, 200, { ok: true, accepted: entries.length }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (action === "validate") {
        if (migration.status === "validated") {
          sendJson(response, 200, { ok: true, status: "validated", report: migration.report_json }, origin, extensionId && `chrome-extension://${extensionId}`);
          return;
        }
        if (migration.status !== "staging") {
          throw new ApiError(409, "invalid_migration_state", "La migración no está en estado de staging.");
        }
        const storedEntries = await pool.query(`
          SELECT storage_key, value_ciphertext, value_sha256
          FROM migration_staging_entries
          WHERE profile_id = $1 AND migration_id = $2
          ORDER BY storage_key
        `, [identity.profile_id, migrationId]);
        if (storedEntries.rowCount !== Number(migration.source_key_count)) {
          throw new ApiError(409, "incomplete_migration", "La cantidad de claves recibidas no coincide.");
        }
        const orderedRows = storedEntries.rows.sort((left, right) =>
          compareStorageKeys(left.storage_key, right.storage_key)
        );
        const entries = orderedRows.map((row) => {
          let value;
          try {
            const json = decryptValue(row.value_ciphertext, config.encryptionKey);
            value = JSON.parse(json);
            if (canonicalJson(value) !== json ||
              sha256Hex(Buffer.from(json, "utf8")) !== row.value_sha256) {
              throw new Error("hash mismatch");
            }
          } catch {
            throw new ApiError(409, "staging_integrity_error", "No se pudo verificar una entrada del staging.");
          }
          return { key: row.storage_key, value, valueSha256: row.value_sha256 };
        });
        const payload = {
          format: "bridgewpp-profile-payload",
          formatVersion: 1,
          exportId: migrationId,
          exportedAt: new Date().toISOString(),
          source: { extensionId: migration.source_extension, storageArea: "chrome.storage.local" },
          integrity: {
            keyCount: Number(migration.source_key_count),
            movementCount: Number(migration.movement_count),
            canonicalSha256: migration.source_sha256
          },
          entries
        };
        let validated;
        try {
          validated = validatePayload(payload);
        } catch (error) {
          throw new ApiError(409, "payload_integrity_error", error.message);
        }
        const report = await buildConflictPreview(pool, identity, validated, config.encryptionKey);
        const updated = await pool.query(`
          UPDATE data_migrations
          SET status = 'validated', report_json = $3::jsonb
          WHERE profile_id = $1 AND migration_id = $2 AND status = 'staging'
          RETURNING status
        `, [identity.profile_id, migrationId, JSON.stringify(report)]);
        if (updated.rowCount !== 1) throw new ApiError(409, "migration_race", "El estado cambió durante la validación.");
        sendJson(response, 200, { ok: true, status: "validated", report }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      throw new ApiError(404, "not_found", "La ruta solicitada no existe.");
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof ApiError ? error.status : 500;
      const code = error instanceof ApiError ? error.code : "internal_error";
      const message = error instanceof ApiError ? error.message : "Error interno del servicio de datos.";
      if (status >= 500) {
        const requestPath = typeof route === "string"
          ? route
          : new URL(request.url, "https://localhost").pathname;
        const details = error instanceof ApiError
          ? code
          : `${error.code || error.name || "unknown"}: ${error.message}`;
        console.error(
          `[${new Date().toISOString()}] Error API ${request.method} ${requestPath} HTTP ${status}: ${details}`
        );
      }
      if (status === 413) response.shouldKeepAlive = false;
      sendJson(response, status, { ok: false, code, error: message }, origin, extensionId && `chrome-extension://${extensionId}`);
    }
  }

  return https.createServer({ cert: config.cert, key: config.key, minVersion: "TLSv1.2" }, (request, response) => {
    void handle(request, response).catch((error) => {
      console.error(`Fallo no controlado al atender ${request.method}: ${error.code || error.name || "unknown"}`);
      if (response.headersSent || response.destroyed) {
        response.destroy(error);
        return;
      }
      sendJson(response, 500, {
        ok: false,
        code: "internal_error",
        error: "Error interno del servicio de datos."
      }, request.headers.origin, null);
    });
  }).setTimeout(30_000);
}

function main() {
  const config = getServerConfig();
  const pgConfig = require("./migrate").getDatabaseConfig("DATA_PG");
  const { Pool } = require("pg");
  const pool = new Pool({ ...pgConfig, max: 20, connectionTimeoutMillis: 15_000 });
  pool.on("error", (error) => {
    console.error(`Conexión inactiva de PostgreSQL descartada: ${error.code || error.name || "unknown"}`);
  });
  const server = createDataApiServer({ pool, config });
  const port = Number(process.env.DATA_API_PORT || 3443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATA_API_PORT debe ser un puerto válido.");
  }
  server.listen(port, config.host, () => {
    console.log(`API HTTPS de datos activa en https://${config.host}:${port}`);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 32;
  server.on("error", (error) => {
    console.error(
      `[${new Date().toISOString()}] No se pudo iniciar la API de datos: ${error.code || error.name}`
    );
    process.exit(1);
  });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    console.error(
      `[${new Date().toISOString()}] Excepción fatal de Node pid=${process.pid} (${origin}): ` +
      `${error.stack || error.message || error.name}`
    );
  });
  process.on("exit", (code) => {
    console.error(`[${new Date().toISOString()}] Proceso API finalizado pid=${process.pid} exitCode=${code}`);
  });
  const shutdown = (signal) => {
    console.log(`[${new Date().toISOString()}] Cierre solicitado a la API: ${signal}.`);
    server.close(() => pool.end().finally(() => process.exit(0)));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`No se pudo iniciar la API de datos: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  commitMigration,
  createDataApiServer,
  createDeviceAssertionNonceCleanup,
  getServerConfig,
  mergeContactFlowCounterSnapshots,
  validateCounterSnapshot,
  validateDestinations
};
