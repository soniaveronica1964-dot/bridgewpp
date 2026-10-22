const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const { isDeepStrictEqual } = require("node:util");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const { canonicalJson, decryptValue, encryptValue, sha256Hex, validatePayload } = require("./archive");

const API_VERSION = 1;
const SCHEMA_VERSION = 11;
const CONTACT_FLOW_MESSAGE_MAX_AGE_MS = 45 * 60_000;
const CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS = 30_000;
const CONTACT_FLOW_COUNTED_NUMBER_TTL_MS = 12 * 60 * 60 * 1000;
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

function getMovementAccountIds(movement) {
  let phone = null;
  if (typeof movement.contactKey === "string") {
    try {
      const contact = JSON.parse(movement.contactKey);
      if (typeof contact?.phone === "string" && /^\d{4,20}$/.test(contact.phone)) {
        phone = contact.phone;
      }
    } catch {
      phone = null;
    }
  }
  if (phone) {
    const platforms = movement.operation === "exchange"
      ? [movement.fromPlatform, movement.toPlatform]
      : [movement.platform];
    return [...new Set(platforms
      .filter((platform) => platform === "ganamos" || platform === "multipanel")
      .map((platform) => `${platform}:${phone}`))];
  }
  return Array.isArray(movement.accountIds)
    ? [...new Set(movement.accountIds.filter((accountId) =>
      typeof accountId === "string" && /^(ganamos|multipanel):\d{4,20}$/.test(accountId)))]
    : [];
}

function sameMovementRecord(left, right) {
  const withoutAccountIds = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { accountIds, ...record } = value;
    return record;
  };
  return isDeepStrictEqual(withoutAccountIds(left), withoutAccountIds(right));
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
    ["/v1/state", "/v1/state/changes", "/v1/movements", "/v1/advertising-stats", "/v1/withdrawals"]
      .includes(url.pathname);
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
      "multiPanelSession", "activeBonusConfig", "hiddenAdvertisingProfiles", "contactFlowCounters",
      "contactVisualTags",
      "agentBalanceView", "agentBalancesMinimized", "platformOutageConfig"
    ].includes(entry.key) && !isUserAccountSettingKey(entry.key)) {
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
    !SHARED_KEYS.has(key) && !isUserAccountSettingKey(key) &&
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
    if (movementByKey.has(key) && !sameMovementRecord(movementByKey.get(key), value)) movementConflicts++;
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
  "activeBonusConfig",
  "hiddenAdvertisingProfiles",
  "platformOutageConfig",
  "agentBalanceView",
  "agentBalancesMinimized"
]);
const PROFILE_SECRET_KEYS = new Set([
  "bridgeToken",
  "userCreationPassword",
  "multiPanelSession",
  "remoteCreateDestinations"
]);
const CONTACT_VISUAL_TAGS_STATE_KEY = "contactVisualTags";
const USER_ACCOUNT_SETTING_PREFIX = "userSetting:";
const USER_ACCOUNT_SETTINGS = new Set([
  "sportBetsDisabled",
  "userBonusDisabled",
  "userAccumulatesBonuses",
  "userBlocked",
  "userWithdrawalLimit",
  "userRelatedContacts"
]);
const SHARED_KEYS = new Set(["contactFlowCounters", CONTACT_VISUAL_TAGS_STATE_KEY]);
const PUBLIC_STATE_KEYS = new Set([
  ...PROFILE_SETTING_KEYS,
  "contactFlowCounters",
  "agentBalanceView",
  "agentBalancesMinimized"
]);
const CONTACT_COUNTER_KEYS = new Set([
  "arrived",
  "derived",
  "generation",
  "generationStartedAt",
  "countedNumbers",
  "panels",
  "adjustmentOperations",
  "resetOperations"
]);

function parseUserAccountSettingKey(key) {
  if (typeof key !== "string" || !key.startsWith(USER_ACCOUNT_SETTING_PREFIX)) return null;
  const match = key.match(/^userSetting:([^:]+):(ganamos|multipanel):(.+)$/);
  if (!match || !USER_ACCOUNT_SETTINGS.has(match[1])) return null;
  let username;
  try {
    username = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  if (!username || username.length > 128 || username !== username.toLowerCase() ||
    /[\u0000-\u001f\u007f]/.test(username) ||
    encodeURIComponent(username) !== match[3]) return null;
  return { setting: match[1], platform: match[2], username };
}

function isUserAccountSettingKey(key) {
  return parseUserAccountSettingKey(key) !== null;
}

function validateUserAccountSettingValue(key, value) {
  const parsed = parseUserAccountSettingKey(key);
  if (!parsed) return false;
  if (["sportBetsDisabled", "userBonusDisabled", "userAccumulatesBonuses", "userBlocked"]
    .includes(parsed.setting)) {
    return typeof value === "boolean";
  }
  if (parsed.setting === "userWithdrawalLimit") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  return parsed.setting === "userRelatedContacts" &&
    typeof value === "string" && value.length <= 1200;
}

function stateScope(key) {
  if (SHARED_KEYS.has(key) || isUserAccountSettingKey(key)) return "workspace";
  return "profile";
}

function mergeContactVisualTagSnapshots(...snapshots) {
  const merged = {};
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
    for (const [identity, tags] of Object.entries(snapshot)) {
      if (!identity || !tags || typeof tags !== "object" || Array.isArray(tags)) continue;
      const current = merged[identity] || {};
      if (tags.highDepositor === true) current.highDepositor = true;
      if (tags.scammer === true) current.scammer = true;
      if (current.highDepositor || current.scammer) merged[identity] = current;
    }
  }
  return merged;
}

function isStateSecret(key, value) {
  return !PUBLIC_STATE_KEYS.has(key) && !key.startsWith("agentMovement:");
}

async function readContactFlowCounterSnapshot(pool, workspaceId, fallbackValue) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const stateResult = await client.query(`
      SELECT generation, generation_started_at_ms, arrived_adjustment, legacy_unknown_json,
             arrived_adjustment +
             (SELECT COUNT(*) FROM contact_flow_count_events
              WHERE workspace_id = state.workspace_id
                AND generation = state.generation AND event_type = 'arrived') +
             COALESCE((
               SELECT SUM(delta) FROM contact_flow_adjustment_events
               WHERE workspace_id = state.workspace_id
                 AND generation = state.generation AND target_type = 'arrived'
             ), 0) AS arrived
      FROM contact_flow_state AS state
      WHERE workspace_id = $1
    `, [workspaceId]);
    if (stateResult.rowCount === 0) {
      await client.query("COMMIT");
      return fallbackValue;
    }
    const state = stateResult.rows[0];
    const generation = Number(state.generation);
    const now = Date.now();
    const cutoff = now - CONTACT_FLOW_COUNTED_NUMBER_TTL_MS;
    const [arrivals, destinationTotals, panels] = await Promise.all([
      client.query(`
        SELECT phone, counted_at_ms FROM contact_flow_counted_numbers
        WHERE workspace_id = $1 AND counted_at_ms > $2 AND counted_at_ms <= $3
        ORDER BY counted_at_ms, phone
      `, [workspaceId, cutoff, now + CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS]),
      client.query(`
        WITH destinations AS (
          SELECT destination_id FROM contact_flow_derived WHERE workspace_id = $1
          UNION
          SELECT destination_id FROM contact_flow_count_events
          WHERE workspace_id = $1 AND event_type = 'derived'
          UNION
          SELECT target_id FROM contact_flow_adjustment_events
          WHERE workspace_id = $1 AND target_type = 'destination'
        )
        SELECT destinations.destination_id,
          COALESCE(derived.manual_adjustment, 0) +
          (SELECT COUNT(*) FROM contact_flow_count_events AS events
           WHERE events.workspace_id = $1 AND events.generation = $2
             AND events.event_type = 'derived'
             AND events.destination_id = destinations.destination_id) +
          COALESCE((
            SELECT SUM(delta) FROM contact_flow_adjustment_events AS adjustments
            WHERE adjustments.workspace_id = $1 AND adjustments.generation = $2
              AND adjustments.target_type = 'destination'
              AND adjustments.target_id = destinations.destination_id
          ), 0) AS total
        FROM destinations
        LEFT JOIN contact_flow_derived AS derived
          ON derived.workspace_id = $1
         AND derived.destination_id = destinations.destination_id
      `, [workspaceId, generation]),
      client.query(`
        SELECT panels.panel_id, panels.title, panels.keyword, panels.destination_id,
               panels.legacy_json, panels.manual_adjustment +
               (SELECT COUNT(*) FROM contact_flow_count_events AS events
                WHERE events.workspace_id = $1 AND events.generation = $2
                  AND events.event_type = 'derived' AND events.panel_id = panels.panel_id)
               AS total
        FROM contact_flow_panels AS panels
        WHERE panels.workspace_id = $1
        ORDER BY panels.ordinal
      `, [workspaceId, generation])
    ]);
    const derived = Object.fromEntries(destinationTotals.rows.map((row) => [
      row.destination_id,
      safeContactFlowCount(row.total)
    ]));
    const canonicalPanels = [];
    for (const panel of panels.rows) {
      const markers = await client.query(`
        SELECT phone, counted_at_ms FROM contact_flow_panel_counted_numbers
        WHERE workspace_id = $1 AND panel_id = $2
          AND counted_at_ms > $3 AND counted_at_ms <= $4
        ORDER BY counted_at_ms, phone
      `, [
        workspaceId,
        panel.panel_id,
        cutoff,
        now + CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS
      ]);
      canonicalPanels.push({
        ...(panel.legacy_json && typeof panel.legacy_json === "object"
          ? panel.legacy_json
          : {}),
        id: panel.panel_id,
        title: panel.title,
        keyword: panel.keyword,
        destinationId: panel.destination_id,
        count: safeContactFlowCount(panel.total),
        countedNumbers: markers.rows.map(({ phone, counted_at_ms: countedAt }) => ({
          number: phone,
          countedAt: Number(countedAt)
        }))
      });
    }
    await client.query("COMMIT");
    return {
      ...(fallbackValue && typeof fallbackValue === "object" ? fallbackValue : {}),
      ...(state.legacy_unknown_json && typeof state.legacy_unknown_json === "object"
        ? state.legacy_unknown_json
        : {}),
      arrived: safeContactFlowCount(state.arrived),
      derived,
      generation,
      generationStartedAt: Number(state.generation_started_at_ms),
      countedNumbers: arrivals.rows.map(({ phone, counted_at_ms: countedAt }) => ({
        number: phone,
        countedAt: Number(countedAt)
      })),
      panels: canonicalPanels,
      adjustmentOperations: [],
      resetOperations: []
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "No se pudo leer consistentemente el conteo compartido ni confirmar el rollback."
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function readExtensionState(pool, config, identity, keys) {
  const workspaceKeys = keys === null
    ? [...SHARED_KEYS]
    : keys.filter((key) => stateScope(key) === "workspace");
  const [profileValues, workspaceValues, movements] = await Promise.all([
    pool.query(`
      SELECT storage_key, value_json, value_ciphertext
      FROM extension_state_values
      WHERE scope_type = 'profile' AND scope_id = $1
        AND ($2::text[] IS NULL OR storage_key = ANY($2::text[]))
    `, [identity.profile_id, keys]),
    workspaceKeys.length
      ? pool.query(`
          SELECT storage_key, value_json, value_ciphertext
          FROM extension_state_values
          WHERE scope_type = 'workspace' AND scope_id = $1
            AND (storage_key = ANY($2::text[]) OR
              ($3::boolean AND storage_key LIKE 'userSetting:%'))
        `, [identity.workspace_id, workspaceKeys, keys === null])
      : { rows: [] },
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
  const legacyUserPreferenceKeys = keys?.filter((key) =>
    /^(?:sportBetsDisabledUsers|userBonusDisabled|userAccumulatesBonuses|userWithdrawalLimit|userRelatedContacts):/.test(key)
  ) || [];
  if (legacyUserPreferenceKeys.length) {
    const legacyValues = await pool.query(`
      SELECT state.storage_key, state.value_json, state.value_ciphertext, state.updated_at_ms
      FROM extension_state_values AS state
      JOIN extension_profiles AS profiles ON profiles.profile_id = state.scope_id
      WHERE profiles.workspace_id = $1 AND state.scope_type = 'profile'
        AND state.storage_key = ANY($2::text[])
      UNION ALL
      SELECT legacy.storage_key, NULL::jsonb AS value_json,
             legacy.value_ciphertext, legacy.imported_at_ms AS updated_at_ms
      FROM legacy_extension_values AS legacy
      JOIN extension_profiles AS profiles ON profiles.profile_id = legacy.profile_id
      WHERE profiles.workspace_id = $1 AND legacy.storage_key = ANY($2::text[])
      ORDER BY updated_at_ms DESC
    `, [identity.workspace_id, legacyUserPreferenceKeys]);
    for (const row of legacyValues.rows) {
      if (Object.hasOwn(values, row.storage_key)) continue;
      values[row.storage_key] = row.value_ciphertext
        ? JSON.parse(decryptValue(row.value_ciphertext, config.encryptionKey))
        : row.value_json;
    }
  }
  for (const row of movements.rows) values[row.legacy_storage_key] = row.legacy_record_json;
  if (workspaceKeys.includes("contactFlowCounters")) {
    const counters = await readContactFlowCounterSnapshot(
      pool,
      identity.workspace_id,
      values.contactFlowCounters
    );
    if (counters !== undefined) values.contactFlowCounters = counters;
  }
  if (workspaceKeys.includes(CONTACT_VISUAL_TAGS_STATE_KEY) &&
    !workspaceValues.rows.some(({ storage_key: key }) =>
      key === CONTACT_VISUAL_TAGS_STATE_KEY)) {
    const legacyTags = await pool.query(`
      SELECT legacy.value_ciphertext, NULL::jsonb AS value_json
      FROM legacy_extension_values AS legacy
      JOIN extension_profiles AS profiles ON profiles.profile_id = legacy.profile_id
      WHERE profiles.workspace_id = $1 AND legacy.storage_key = $2
      UNION ALL
      SELECT state.value_ciphertext, state.value_json
      FROM extension_state_values AS state
      JOIN extension_profiles AS profiles ON profiles.profile_id = state.scope_id
      WHERE profiles.workspace_id = $1 AND state.scope_type = 'profile'
        AND state.storage_key = $2
    `, [identity.workspace_id, CONTACT_VISUAL_TAGS_STATE_KEY]);
    if (legacyTags.rowCount) {
      values[CONTACT_VISUAL_TAGS_STATE_KEY] = mergeContactVisualTagSnapshots(
        values[CONTACT_VISUAL_TAGS_STATE_KEY],
        ...legacyTags.rows.map(({ value_ciphertext, value_json }) =>
          value_ciphertext
            ? JSON.parse(decryptValue(value_ciphertext, config.encryptionKey))
            : value_json)
      );
    }
  }
  if (keys === null || keys.some((key) => !PROFILE_SETTING_KEYS.has(key) &&
    !PROFILE_SECRET_KEYS.has(key) && !SHARED_KEYS.has(key) &&
    !isUserAccountSettingKey(key) &&
    !key.startsWith("agentMovement:"))) {
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
  if ([...keys, ...removes].some((key) =>
    key.startsWith(USER_ACCOUNT_SETTING_PREFIX) && !isUserAccountSettingKey(key)) ||
    Object.entries(changes).some(([key, value]) =>
      key.startsWith(USER_ACCOUNT_SETTING_PREFIX) &&
      !validateUserAccountSettingValue(key, value))) {
    throw new ApiError(400, "invalid_state", "Una configuración de usuario compartida no es válida.");
  }
  const hiddenAdvertisingProfiles = changes.hiddenAdvertisingProfiles;
  if (Object.hasOwn(changes, "hiddenAdvertisingProfiles") &&
    (!Array.isArray(hiddenAdvertisingProfiles) || hiddenAdvertisingProfiles.length > 1000 ||
      hiddenAdvertisingProfiles.some((profileId) =>
        typeof profileId !== "string" || !UUID_PATTERN.test(profileId)) ||
      new Set(hiddenAdvertisingProfiles).size !== hiddenAdvertisingProfiles.length)) {
    throw new ApiError(400, "invalid_state", "La lista de paneles minimizados no es válida.");
  }
  const platformOutageConfig = changes.platformOutageConfig;
  if (Object.hasOwn(changes, "platformOutageConfig") &&
    (!platformOutageConfig || typeof platformOutageConfig !== "object" ||
      Array.isArray(platformOutageConfig) ||
      typeof platformOutageConfig.ganamos !== "boolean" ||
      typeof platformOutageConfig.multipanel !== "boolean" ||
      Object.keys(platformOutageConfig).some((key) =>
        !["ganamos", "multipanel"].includes(key)))) {
    throw new ApiError(400, "invalid_state", "La configuración de plataformas caídas no es válida.");
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
      const isStaleUserSettingWrite = Number.isSafeInteger(expectedRevision) &&
        expectedRevision >= 0 && expectedRevision < revision &&
        keys.length > 0 && keys.every(isUserAccountSettingKey) && removes.length === 0;
      if (!isStaleCounterSnapshot && !isStaleUserSettingWrite) {
        throw new ApiError(409, "state_revision_conflict", "El estado compartido cambió; recargá y revisá antes de volver a guardar.");
      }
      if (isStaleCounterSnapshot) {
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
      } else if (key.startsWith("agentMovement:")) {
        const movement = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const accountIds = getMovementAccountIds(movement);
        const movementJson = JSON.stringify(accountIds.length
          ? { ...movement, accountIds }
          : movement);
        await client.query(`
          INSERT INTO agent_movements (
            workspace_id, source_profile_id, source_device_id, legacy_storage_key,
            timestamp_ms, contact_key, operation, amount_minor, platform, username,
            transaction_minor, bonus_minor, from_platform, to_platform, status,
            verification_json, legacy_record_json, imported_at_ms, is_advertising,
            account_ids
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16::jsonb, $17::jsonb, $18, $19, $20
          )
          ON CONFLICT (workspace_id, source_profile_id, legacy_storage_key) DO UPDATE SET
            timestamp_ms = EXCLUDED.timestamp_ms, contact_key = EXCLUDED.contact_key,
            operation = EXCLUDED.operation, amount_minor = EXCLUDED.amount_minor,
            platform = EXCLUDED.platform, username = EXCLUDED.username,
            transaction_minor = EXCLUDED.transaction_minor, bonus_minor = EXCLUDED.bonus_minor,
            from_platform = EXCLUDED.from_platform, to_platform = EXCLUDED.to_platform,
            status = EXCLUDED.status, verification_json = EXCLUDED.verification_json,
            legacy_record_json = EXCLUDED.legacy_record_json,
            is_advertising = EXCLUDED.is_advertising,
            account_ids = EXCLUDED.account_ids
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
          movementJson,
          timestamp,
          movement.depositType === "advertising",
          accountIds
        ]);
      } else if (key === "contactFlowCounters") {
        const canonicalCounters = await persistContactFlowCounterSnapshot(
          client,
          identity.workspace_id,
          identity.profile_id,
          value,
          timestamp
        );
        const canonicalCountersJson = canonicalJson(canonicalCounters);
        await client.query(`
          UPDATE extension_state_values
          SET value_json = $2::jsonb, value_ciphertext = NULL
          WHERE scope_type = 'workspace' AND scope_id = $1
            AND storage_key = 'contactFlowCounters'
        `, [identity.workspace_id, canonicalCountersJson]);
        await client.query(`
          INSERT INTO app_secrets (scope_type, scope_id, secret_key, ciphertext, updated_at_ms)
          VALUES ('workspace', $1, 'contactFlowCountersSource', $2, $3)
          ON CONFLICT (scope_type, scope_id, secret_key) DO UPDATE SET
            ciphertext = EXCLUDED.ciphertext, updated_at_ms = EXCLUDED.updated_at_ms
        `, [
          identity.workspace_id,
          encryptValue(canonicalCountersJson, config.encryptionKey),
          timestamp
        ]);
        changes[key] = canonicalCounters;
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
    return {
      revision: nextRevision,
      changeRevision: Number(workspaceRevision.rows[0].revision),
      ...(Object.hasOwn(changes, "contactFlowCounters")
        ? { contactFlowCounters: changes.contactFlowCounters }
        : {})
    };
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
  const adjustmentOperations = [];
  const adjustmentOperationIds = new Set();
  if (Array.isArray(value.adjustmentOperations)) {
    for (const operation of value.adjustmentOperations) {
      if (!operation || typeof operation !== "object" ||
        typeof operation.id !== "string" || !UUID_PATTERN.test(operation.id) ||
        adjustmentOperationIds.has(operation.id) ||
        !Number.isSafeInteger(operation.delta) || operation.delta === 0 ||
        (operation.target !== "arrived" &&
          (typeof operation.target !== "string" ||
            !operation.target.startsWith("destination:") ||
            !operation.target.slice("destination:".length)))) continue;
      adjustmentOperationIds.add(operation.id);
      adjustmentOperations.push({
        id: operation.id,
        target: operation.target,
        delta: operation.delta,
        generation: Number.isSafeInteger(operation.generation) && operation.generation > 0
          ? operation.generation
          : null
      });
    }
  }
  const resetOperations = [];
  const resetOperationIds = new Set();
  if (Array.isArray(value.resetOperations)) {
    for (const operation of value.resetOperations) {
      if (!operation || typeof operation !== "object" ||
        typeof operation.id !== "string" || !UUID_PATTERN.test(operation.id) ||
        resetOperationIds.has(operation.id) ||
        typeof operation.clearCountedNumbers !== "boolean") continue;
      resetOperationIds.add(operation.id);
      resetOperations.push({
        id: operation.id,
        clearCountedNumbers: operation.clearCountedNumbers
      });
    }
  }
  return {
    arrived,
    derived,
    generation: Number.isSafeInteger(value.generation) && value.generation > 0
      ? value.generation
      : 1,
    generationStartedAt: Number.isSafeInteger(value.generationStartedAt) &&
      value.generationStartedAt >= 0
      ? value.generationStartedAt
      : 0,
    countedNumbers: normalizeNumbers(value.countedNumbers),
    panels,
    adjustmentOperations,
    resetOperations,
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
    for (const entry of activeNumbers(incomingNumbers)) {
      merged.set(entry.number, Math.max(merged.get(entry.number) || 0, entry.countedAt));
    }
    return [...merged].map(([number, countedAt]) => ({ number, countedAt }));
  };
  const incomingGenerationIsStale = incoming.generation < current.generation;
  const currentGenerationNumbers = (numbers) => incomingGenerationIsStale
    ? numbers.filter(({ countedAt }) => countedAt >= current.generationStartedAt)
    : numbers;
  const currentDerived = Object.fromEntries(current.derived);
  const mergedDerived = { ...currentDerived };
  const alreadyAppliedResets = new Set(current.resetOperations.map(({ id }) => id));
  const clearsMarkers = incoming.resetOperations.some((operation) =>
    operation.clearCountedNumbers && !alreadyAppliedResets.has(operation.id));
  const currentPanels = new Map(current.panels.map((panel) => [panel.id, panel]));
  const incomingPanels = new Map(incoming.panels.map((panel) => [panel.id, panel]));
  const mergedPanels = [];

  for (const [id, currentPanel] of currentPanels) {
    const incomingPanel = incomingPanels.get(id);
    const numbers = mergeNumbers(
      clearsMarkers ? [] : currentPanel.countedNumbers,
      clearsMarkers ? [] : currentGenerationNumbers(incomingPanel?.countedNumbers || [])
    );
    mergedPanels.push({
      ...currentPanel,
      count: currentPanel.count,
      countedNumbers: numbers
    });
  }

  for (const [id, incomingPanel] of incomingPanels) {
    if (currentPanels.has(id)) continue;
    const numbers = mergeNumbers(
      [],
      clearsMarkers ? [] : currentGenerationNumbers(incomingPanel.countedNumbers)
    );
    mergedPanels.push({
      ...incomingPanel,
      count: incomingPanel.count,
      countedNumbers: numbers
    });
  }

  const countedNumbers = mergeNumbers(
    clearsMarkers ? [] : current.countedNumbers,
    clearsMarkers ? [] : currentGenerationNumbers(incoming.countedNumbers)
  );
  const mergeOperations = (left, right) => {
    const byId = new Map(left.map((operation) => [operation.id, operation]));
    for (const operation of right) byId.set(operation.id, operation);
    return [...byId.values()];
  };
  return {
    arrived: current.arrived,
    derived: mergedDerived,
    generation: current.generation,
    generationStartedAt: current.generationStartedAt,
    countedNumbers,
    panels: mergedPanels,
    adjustmentOperations: mergeOperations(
      current.adjustmentOperations,
      incoming.adjustmentOperations
    ),
    resetOperations: mergeOperations(current.resetOperations, incoming.resetOperations),
    ...current.legacyUnknown,
    ...incoming.legacyUnknown
  };
}

function safeContactFlowCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ApiError(409, "invalid_contact_flow", "Un contador compartido quedó fuera del rango seguro.");
  }
  return count;
}

function normalizeArgentinaPhone(value) {
  const digits = value.replace(/\D/g, "");
  const internationalDigits = digits.startsWith("00") ? digits.slice(2) : digits;
  const international = internationalDigits.startsWith("54")
    ? `+${internationalDigits}`
    : null;
  const parsed = parsePhoneNumberFromString(
    international || digits,
    international ? undefined : "AR"
  );
  return parsed?.country === "AR" && parsed.isPossible()
    ? parsed.number.replace(/\D/g, "")
    : digits;
}

async function persistContactFlowCounterSnapshot(
  client,
  workspaceId,
  profileId,
  value,
  timestamp
) {
  const counters = validateCounterSnapshot(value);
  await client.query(`
    INSERT INTO contact_flow_state (
      workspace_id, arrived, generation_started_at_ms, updated_at_ms
    ) VALUES ($1, 0, $2, $2)
    ON CONFLICT (workspace_id) DO NOTHING
  `, [workspaceId, timestamp]);

  let state = await client.query(`
    SELECT generation, generation_started_at_ms
    FROM contact_flow_state
    WHERE workspace_id = $1
    FOR UPDATE
  `, [workspaceId]);
  let generation = Number(state.rows[0].generation);
  let generationStartedAt = Number(state.rows[0].generation_started_at_ms);
  for (const operation of counters.resetOperations) {
    const nextGeneration = generation + 1;
    const inserted = await client.query(`
      INSERT INTO contact_flow_reset_operations (
        workspace_id, operation_id, generation, clear_counted_numbers, created_at_ms
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (workspace_id, operation_id) DO NOTHING
      RETURNING operation_id
    `, [
      workspaceId,
      operation.id,
      nextGeneration,
      operation.clearCountedNumbers,
      timestamp
    ]);
    if (inserted.rowCount === 0) {
      const existing = await client.query(`
        SELECT clear_counted_numbers FROM contact_flow_reset_operations
        WHERE workspace_id = $1 AND operation_id = $2
      `, [workspaceId, operation.id]);
      if (existing.rows[0]?.clear_counted_numbers !== operation.clearCountedNumbers) {
        throw new ApiError(
          409,
          "contact_flow_operation_conflict",
          "El identificador del reinicio ya se usó con otra operación."
        );
      }
      continue;
    }
    generation = nextGeneration;
    generationStartedAt = timestamp;
    await client.query(`
      UPDATE contact_flow_state
      SET generation = $2, generation_started_at_ms = $3,
          arrived = 0, arrived_adjustment = 0,
          revision = revision + 1, updated_at_ms = $3
      WHERE workspace_id = $1
    `, [workspaceId, generation, timestamp]);
    await client.query(`
      UPDATE contact_flow_derived
      SET count = 0, manual_adjustment = 0
      WHERE workspace_id = $1
    `, [workspaceId]);
    await client.query(`
      UPDATE contact_flow_panels
      SET count = 0, manual_adjustment = 0
      WHERE workspace_id = $1
    `, [workspaceId]);
    if (operation.clearCountedNumbers) {
      await client.query(
        "DELETE FROM contact_flow_counted_numbers WHERE workspace_id = $1",
        [workspaceId]
      );
      await client.query(
        "DELETE FROM contact_flow_panel_counted_numbers WHERE workspace_id = $1",
        [workspaceId]
      );
    }
  }

  for (const operation of counters.adjustmentOperations) {
    const isArrived = operation.target === "arrived";
    const targetType = isArrived ? "arrived" : "destination";
    const targetId = isArrived ? null : operation.target.slice("destination:".length);
    const operationGeneration = operation.generation === null
      ? generation
      : Math.min(operation.generation, generation);
    const inserted = await client.query(`
      INSERT INTO contact_flow_adjustment_events (
        workspace_id, operation_id, generation, target_type, target_id, delta, created_at_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (workspace_id, operation_id) DO NOTHING
      RETURNING operation_id
    `, [
      workspaceId,
      operation.id,
      operationGeneration,
      targetType,
      targetId,
      operation.delta,
      timestamp
    ]);
    if (inserted.rowCount !== 0) continue;
    const existing = await client.query(`
      SELECT generation, target_type, target_id, delta
      FROM contact_flow_adjustment_events
      WHERE workspace_id = $1 AND operation_id = $2
    `, [workspaceId, operation.id]);
    const stored = existing.rows[0];
    if (!stored || Number(stored.generation) !== operationGeneration ||
      stored.target_type !== targetType || stored.target_id !== targetId ||
      Number(stored.delta) !== operation.delta) {
      throw new ApiError(
        409,
        "contact_flow_operation_conflict",
        "El identificador del ajuste ya se usó con otra operación."
      );
    }
  }

  await client.query(`
    DELETE FROM contact_flow_counted_numbers
    WHERE workspace_id = $1 AND counted_at_ms <= $2
  `, [workspaceId, timestamp - CONTACT_FLOW_COUNTED_NUMBER_TTL_MS]);

  const panelIds = counters.panels.map(({ id }) => id);
  await client.query(
    "UPDATE contact_flow_panels SET ordinal = ordinal + 1000 WHERE workspace_id = $1",
    [workspaceId]
  );
  await client.query(`
    DELETE FROM contact_flow_panels
    WHERE workspace_id = $1 AND NOT (panel_id = ANY($2::text[]))
  `, [workspaceId, panelIds]);
  for (const panel of counters.panels) {
    await client.query(`
      INSERT INTO contact_flow_panels (
        workspace_id, panel_id, ordinal, title, keyword, destination_id,
        count, legacy_json
      ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7::jsonb)
      ON CONFLICT (workspace_id, panel_id) DO UPDATE SET
        ordinal = EXCLUDED.ordinal,
        title = EXCLUDED.title,
        keyword = EXCLUDED.keyword,
        destination_id = EXCLUDED.destination_id,
        legacy_json = EXCLUDED.legacy_json
    `, [
      workspaceId,
      panel.id,
      panel.ordinal,
      panel.title,
      panel.keyword,
      panel.destinationId,
      jsonValue(panel.legacy)
    ]);
  }

  const activeNumbers = counters.countedNumbers.filter(({ countedAt }) =>
    countedAt <= timestamp + CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS &&
    timestamp - countedAt < CONTACT_FLOW_COUNTED_NUMBER_TTL_MS &&
    countedAt >= generationStartedAt);
  const existingArrivals = await client.query(`
    SELECT phone FROM contact_flow_counted_numbers
    WHERE workspace_id = $1 AND counted_at_ms > $2
  `, [workspaceId, timestamp - CONTACT_FLOW_COUNTED_NUMBER_TTL_MS]);
  const normalizedArrivals = new Set(existingArrivals.rows.map(({ phone }) =>
    normalizeArgentinaPhone(phone)));
  for (const { number, countedAt } of activeNumbers) {
    const normalizedNumber = normalizeArgentinaPhone(number);
    if (normalizedArrivals.has(normalizedNumber)) continue;
    const marker = await client.query(`
      INSERT INTO contact_flow_counted_numbers (workspace_id, phone, counted_at_ms)
      VALUES ($1, $2, $3)
      ON CONFLICT (workspace_id, phone) DO NOTHING
      RETURNING phone
    `, [workspaceId, normalizedNumber, timestamp]);
    if (marker.rowCount === 0) continue;
    normalizedArrivals.add(normalizedNumber);
    await client.query(`
      INSERT INTO contact_flow_count_events (
        workspace_id, generation, event_type, phone, counted_at_ms, source_profile_id
      ) VALUES ($1, $2, 'arrived', $3, $4, $5)
    `, [workspaceId, generation, normalizedNumber, timestamp, profileId]);
  }

  for (const panel of counters.panels) {
    await client.query(`
      DELETE FROM contact_flow_panel_counted_numbers
      WHERE workspace_id = $1 AND panel_id = $2 AND counted_at_ms <= $3
    `, [
      workspaceId,
      panel.id,
      timestamp - CONTACT_FLOW_COUNTED_NUMBER_TTL_MS
    ]);
    const panelNumbers = panel.countedNumbers.filter(({ countedAt }) =>
      countedAt <= timestamp + CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS &&
      timestamp - countedAt < CONTACT_FLOW_COUNTED_NUMBER_TTL_MS &&
      countedAt >= generationStartedAt);
    const existingPanelNumbers = await client.query(`
      SELECT phone FROM contact_flow_panel_counted_numbers
      WHERE workspace_id = $1 AND panel_id = $2 AND counted_at_ms > $3
    `, [workspaceId, panel.id, timestamp - CONTACT_FLOW_COUNTED_NUMBER_TTL_MS]);
    const normalizedPanelNumbers = new Set(existingPanelNumbers.rows.map(({ phone }) =>
      normalizeArgentinaPhone(phone)));
    for (const { number, countedAt } of panelNumbers) {
      const normalizedNumber = normalizeArgentinaPhone(number);
      if (normalizedPanelNumbers.has(normalizedNumber)) continue;
      const marker = await client.query(`
        INSERT INTO contact_flow_panel_counted_numbers (
          workspace_id, panel_id, phone, counted_at_ms
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (workspace_id, panel_id, phone) DO NOTHING
        RETURNING phone
      `, [workspaceId, panel.id, normalizedNumber, timestamp]);
      if (marker.rowCount === 0) continue;
      normalizedPanelNumbers.add(normalizedNumber);
      await client.query(`
        INSERT INTO contact_flow_count_events (
          workspace_id, generation, event_type, panel_id, destination_id, phone,
          counted_at_ms, source_profile_id
        ) VALUES ($1, $2, 'derived', $3, $4, $5, $6, $7)
      `, [
        workspaceId,
        generation,
        panel.id,
        panel.destinationId,
        normalizedNumber,
        timestamp,
        profileId
      ]);
    }
  }

  const arrivedResult = await client.query(`
    SELECT
      state.arrived_adjustment +
      COUNT(events.event_id) +
      COALESCE((
        SELECT SUM(delta) FROM contact_flow_adjustment_events
        WHERE workspace_id = $1 AND generation = $2 AND target_type = 'arrived'
      ), 0) AS total
    FROM contact_flow_state AS state
    LEFT JOIN contact_flow_count_events AS events
      ON events.workspace_id = state.workspace_id
     AND events.generation = state.generation
     AND events.event_type = 'arrived'
    WHERE state.workspace_id = $1
    GROUP BY state.arrived_adjustment
  `, [workspaceId, generation]);
  const arrived = safeContactFlowCount(arrivedResult.rows[0]?.total ?? 0);
  await client.query(`
    UPDATE contact_flow_state
    SET arrived = $2, legacy_unknown_json = $3::jsonb, updated_at_ms = $4
    WHERE workspace_id = $1
  `, [workspaceId, arrived, jsonValue(counters.legacyUnknown), timestamp]);

  const destinationIdsResult = await client.query(`
    SELECT destination_id FROM contact_flow_derived WHERE workspace_id = $1
    UNION
    SELECT destination_id FROM contact_flow_count_events
    WHERE workspace_id = $1 AND event_type = 'derived'
    UNION
    SELECT destination_id FROM contact_flow_panels WHERE workspace_id = $1
    UNION
    SELECT target_id FROM contact_flow_adjustment_events
    WHERE workspace_id = $1 AND target_type = 'destination'
  `, [workspaceId]);
  const derived = {};
  for (const { destination_id: destinationId } of destinationIdsResult.rows) {
    const result = await client.query(`
      SELECT
        COALESCE((
          SELECT manual_adjustment FROM contact_flow_derived
          WHERE workspace_id = $1 AND destination_id = $2
        ), 0) +
        (SELECT COUNT(*) FROM contact_flow_count_events
         WHERE workspace_id = $1 AND generation = $3
           AND event_type = 'derived' AND destination_id = $2) +
        COALESCE((
          SELECT SUM(delta) FROM contact_flow_adjustment_events
          WHERE workspace_id = $1 AND generation = $3
            AND target_type = 'destination' AND target_id = $2
        ), 0) AS total
    `, [workspaceId, destinationId, generation]);
    derived[destinationId] = safeContactFlowCount(result.rows[0].total);
    await client.query(`
      INSERT INTO contact_flow_derived (workspace_id, destination_id, count)
      VALUES ($1, $2, $3)
      ON CONFLICT (workspace_id, destination_id) DO UPDATE SET count = EXCLUDED.count
    `, [workspaceId, destinationId, derived[destinationId]]);
  }

  const canonicalPanels = [];
  for (const panel of counters.panels) {
    const result = await client.query(`
      SELECT
        panel.manual_adjustment +
        (SELECT COUNT(*) FROM contact_flow_count_events
         WHERE workspace_id = $1 AND generation = $3
           AND event_type = 'derived' AND panel_id = $2) AS total
      FROM contact_flow_panels AS panel
      WHERE panel.workspace_id = $1 AND panel.panel_id = $2
    `, [workspaceId, panel.id, generation]);
    const count = safeContactFlowCount(result.rows[0]?.total ?? 0);
    await client.query(`
      UPDATE contact_flow_panels SET count = $3
      WHERE workspace_id = $1 AND panel_id = $2
    `, [workspaceId, panel.id, count]);
    const markers = await client.query(`
      SELECT phone, counted_at_ms FROM contact_flow_panel_counted_numbers
      WHERE workspace_id = $1 AND panel_id = $2
      ORDER BY counted_at_ms, phone
    `, [workspaceId, panel.id]);
    canonicalPanels.push({
      ...panel,
      count,
      countedNumbers: markers.rows.map(({ phone, counted_at_ms: countedAt }) => ({
        number: phone,
        countedAt: Number(countedAt)
      }))
    });
  }
  const arrivedMarkers = await client.query(`
    SELECT phone, counted_at_ms FROM contact_flow_counted_numbers
    WHERE workspace_id = $1
    ORDER BY counted_at_ms, phone
  `, [workspaceId]);
  return {
    arrived,
    derived,
    generation,
    generationStartedAt,
    countedNumbers: arrivedMarkers.rows.map(({ phone, counted_at_ms: countedAt }) => ({
      number: phone,
      countedAt: Number(countedAt)
    })),
    panels: canonicalPanels,
    adjustmentOperations: [],
    resetOperations: [],
    ...counters.legacyUnknown
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
    for (const [key, value] of entries) {
      if (key.startsWith(USER_ACCOUNT_SETTING_PREFIX) &&
        !validateUserAccountSettingValue(key, value)) {
        throw new ApiError(409, "invalid_user_setting", "Una configuración de usuario del respaldo no es válida.");
      }
    }
    const now = Date.now();
    let settingCount = 0;
    let secretCount = 0;
    let movementCount = 0;
    let unknownCount = 0;
    for (const [key, value] of entries) {
      if (key.startsWith("agentMovement:") ||
        (SHARED_KEYS.has(key) || isUserAccountSettingKey(key)) &&
          key !== CONTACT_VISUAL_TAGS_STATE_KEY &&
          decision !== "initialize_shared") continue;
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
        const accountIds = getMovementAccountIds(movement);
        const movementJson = accountIds.length
          ? { ...movement, accountIds }
          : value;
        const insertResult = await client.query(`
          INSERT INTO agent_movements (
            workspace_id, source_profile_id, source_device_id, legacy_storage_key,
            timestamp_ms, contact_key, operation, amount_minor, platform, username,
            transaction_minor, bonus_minor, from_platform, to_platform, status,
            verification_json, legacy_record_json, imported_at_ms, is_advertising,
            account_ids
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16::jsonb, $17::jsonb, $18, $19, $20
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
          jsonValue(movementJson), now,
          movement.depositType === "advertising", accountIds
        ]);
        if (insertResult.rowCount === 0) {
          const existing = await client.query(`
            SELECT legacy_record_json FROM agent_movements
            WHERE workspace_id = $1 AND source_profile_id = $2 AND legacy_storage_key = $3
          `, [identity.workspace_id, identity.profile_id, key]);
          if (!sameMovementRecord(existing.rows[0]?.legacy_record_json, value)) {
            throw new ApiError(409, "movement_conflict", "Un movimiento heredado existe con contenido diferente.");
          }
        }
        movementCount++;
      } else if (key === CONTACT_VISUAL_TAGS_STATE_KEY) {
        const encryptedTags = encryptValue(canonicalJson(value), config.encryptionKey);
        await client.query(`
          UPDATE extension_state_values
          SET value_json = NULL, value_ciphertext = $3, updated_at_ms = $4
          WHERE scope_type = 'workspace' AND scope_id = $1 AND storage_key = $2
        `, [identity.workspace_id, key, encryptedTags, now]);
      } else if (isUserAccountSettingKey(key)) {
        if (decision !== "initialize_shared") continue;
      } else if (SHARED_KEYS.has(key)) {
        if (decision !== "initialize_shared") continue;
        const counters = validateCounterSnapshot(value);
        await client.query(`
          INSERT INTO contact_flow_state (
            workspace_id, arrived, generation_started_at_ms, arrived_adjustment,
            legacy_unknown_json, updated_at_ms
          ) VALUES ($1, $2, $3, $2, $4::jsonb, $5)
        `, [
          identity.workspace_id,
          counters.arrived,
          now,
          jsonValue(counters.legacyUnknown),
          now
        ]);
        for (const [destinationId, count] of counters.derived) {
          await client.query(`
            INSERT INTO contact_flow_derived (
              workspace_id, destination_id, count, manual_adjustment
            ) VALUES ($1, $2, $3, $3)
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
              count, manual_adjustment, legacy_json
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8::jsonb)
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

      if (route === "/v1/withdrawals" && request.method === "POST") {
        const identity = await authenticate(request);
        const body = requireObjectBody(await parseBody(request));
        if (Object.keys(body).some((key) =>
          !["withdrawalId", "username", "createdAt", "completedAt"].includes(key)) ||
          typeof body.withdrawalId !== "string" || !body.withdrawalId.trim() ||
          body.withdrawalId.length > 512 || /[\u0000-\u001f\u007f]/.test(body.withdrawalId) ||
          typeof body.username !== "string" || !body.username.trim() ||
          body.username.length > 512 || /[\u0000-\u001f\u007f]/.test(body.username) ||
          !Number.isSafeInteger(body.createdAt) || body.createdAt < 0 ||
          !Number.isSafeInteger(body.completedAt) || body.completedAt < body.createdAt ||
          body.completedAt > Date.now() + 60_000) {
          throw new ApiError(400, "invalid_withdrawal", "Los datos del retiro completado no son válidos.");
        }
        const now = Date.now();
        const inserted = await pool.query(`
          INSERT INTO completed_withdrawals (
            workspace_id, withdrawal_id, source_profile_id, username,
            created_at_ms, completed_at_ms, recorded_at_ms
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (workspace_id, withdrawal_id) DO NOTHING
          RETURNING source_profile_id::text AS profile_id, username,
                    created_at_ms, completed_at_ms
        `, [
          identity.workspace_id,
          body.withdrawalId.trim(),
          identity.profile_id,
          body.username.trim(),
          body.createdAt,
          body.completedAt,
          now
        ]);
        let record = inserted.rows[0];
        if (!record) {
          const existing = await pool.query(`
            SELECT source_profile_id::text AS profile_id, username,
                   created_at_ms, completed_at_ms
            FROM completed_withdrawals
            WHERE workspace_id = $1 AND withdrawal_id = $2
          `, [identity.workspace_id, body.withdrawalId.trim()]);
          record = existing.rows[0];
          if (!record) throw new Error("No se pudo confirmar el retiro registrado.");
        }
        sendJson(response, 201, { ok: true, recorded: true }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/withdrawals" && request.method === "GET") {
        const identity = await authenticate(request);
        const query = new URL(request.url, "https://localhost").searchParams;
        if ([...query.keys()].some((key) => !["from", "to"].includes(key)) ||
          query.getAll("from").length > 1 || query.getAll("to").length > 1 ||
          query.has("from") !== query.has("to")) {
          throw new ApiError(400, "invalid_withdrawal_query", "Los filtros del historial no son válidos.");
        }
        const fromValue = query.get("from");
        const toValue = query.get("to");
        const from = fromValue === null ? null : Number(fromValue);
        const to = toValue === null ? null : Number(toValue);
        if ((fromValue !== null && (!/^\d+$/.test(fromValue) || !Number.isSafeInteger(from))) ||
          (toValue !== null && (!/^\d+$/.test(toValue) || !Number.isSafeInteger(to))) ||
          from !== null && to !== null && (from < 0 || to <= from)) {
          throw new ApiError(400, "invalid_withdrawal_query", "El rango de fechas no es válido.");
        }
        const [result, profileResult] = await Promise.all([
          pool.query(`
          SELECT withdrawals.withdrawal_id,
                 withdrawals.username,
                 withdrawals.created_at_ms,
                 withdrawals.completed_at_ms,
                 withdrawals.source_profile_id::text AS profile_id,
                 devices.display_name AS profile_name
          FROM completed_withdrawals AS withdrawals
          JOIN extension_profiles AS profiles
            ON profiles.profile_id = withdrawals.source_profile_id
           AND profiles.workspace_id = withdrawals.workspace_id
          JOIN enrolled_devices AS devices
            ON devices.device_id = profiles.device_id
           AND devices.workspace_id = profiles.workspace_id
          WHERE withdrawals.workspace_id = $1
            AND ($2::bigint IS NULL OR withdrawals.created_at_ms >= $2)
            AND ($3::bigint IS NULL OR withdrawals.created_at_ms < $3)
          ORDER BY withdrawals.created_at_ms DESC, withdrawals.withdrawal_id DESC
          `, [identity.workspace_id, from, to]),
          pool.query(`
            SELECT profiles.profile_id::text AS profile_id,
                   devices.display_name AS profile_name
            FROM extension_profiles AS profiles
            JOIN enrolled_devices AS devices
              ON devices.device_id = profiles.device_id
             AND devices.workspace_id = profiles.workspace_id
            WHERE profiles.workspace_id = $1
            ORDER BY devices.display_name, profiles.profile_id
          `, [identity.workspace_id])
        ]);
        const withdrawals = result.rows.map((row) => {
          const createdAt = Number(row.created_at_ms);
          const completedAt = Number(row.completed_at_ms);
          if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(completedAt)) {
            throw new Error("La API encontró un retiro con fechas fuera del rango admitido.");
          }
          return {
            withdrawalId: row.withdrawal_id,
            username: row.username,
            createdAt,
            completedAt,
            durationMs: completedAt - createdAt,
            profileId: row.profile_id,
            profileName: row.profile_name
          };
        });
        sendJson(response, 200, {
          ok: true,
          withdrawals,
          profiles: profileResult.rows
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/advertising-stats" && request.method === "GET") {
        const identity = await authenticate(request);
        const query = new URL(request.url, "https://localhost").searchParams;
        const hasFrom = query.has("from");
        const hasTo = query.has("to");
        if ([...query.keys()].some((key) =>
          !["days", "from", "to", "excludedProfiles"].includes(key)) ||
          ["days", "from", "to", "excludedProfiles"].some((key) => query.getAll(key).length > 1) ||
          hasFrom !== hasTo || query.has("days") && hasFrom) {
          throw new ApiError(400, "invalid_advertising_stats_query", "Los filtros de estadísticas no son válidos.");
        }
        const daysValue = query.get("days");
        if (daysValue !== null && !["7", "30", "90"].includes(daysValue)) {
          throw new ApiError(400, "invalid_advertising_stats_query", "El período debe ser de 7, 30, 90 días o todo el historial.");
        }
        const fromValue = query.get("from");
        const toValue = query.get("to");
        const from = fromValue === null ? null : Number(fromValue);
        const to = toValue === null ? null : Number(toValue);
        if ((fromValue !== null && (!/^\d+$/.test(fromValue) || !Number.isSafeInteger(from))) ||
          (toValue !== null && (!/^\d+$/.test(toValue) || !Number.isSafeInteger(to))) ||
          from !== null && to !== null && (from < 0 || to <= from)) {
          throw new ApiError(400, "invalid_advertising_stats_query", "El rango de fechas no es válido.");
        }
        let excludedProfiles = null;
        const excludedProfilesValue = query.get("excludedProfiles");
        if (excludedProfilesValue !== null) {
          try {
            excludedProfiles = JSON.parse(excludedProfilesValue);
          } catch {
            throw new ApiError(400, "invalid_advertising_stats_query", "La lista de paneles minimizados no es válida.");
          }
          if (!Array.isArray(excludedProfiles) || excludedProfiles.length > 1000 ||
            excludedProfiles.some((profileId) =>
              typeof profileId !== "string" || !UUID_PATTERN.test(profileId)) ||
            new Set(excludedProfiles).size !== excludedProfiles.length) {
            throw new ApiError(400, "invalid_advertising_stats_query", "La lista de paneles minimizados no es válida.");
          }
          if (!excludedProfiles.length) excludedProfiles = null;
        }
        const since = daysValue === null ? from : Date.now() - Number(daysValue) * 24 * 60 * 60 * 1000;
        const until = to;
        const [summary, platforms, profiles, hiddenProfiles] = await Promise.all([
          pool.query(`
            WITH advertising AS (
              SELECT contact_key, timestamp_ms, amount_minor, transaction_minor,
                     bonus_minor, platform, status, source_profile_id
              FROM agent_movements
              WHERE workspace_id = $1
                AND is_advertising
                AND operation = 'deposit'
                AND ($4::uuid[] IS NULL OR source_profile_id <> ALL($4::uuid[]))
                AND ($2::bigint IS NULL OR timestamp_ms >= $2)
                AND ($3::bigint IS NULL OR timestamp_ms < $3)
            ),
            confirmed_advertising AS (
              SELECT * FROM advertising
              WHERE status IS DISTINCT FROM 'pending-verification'
            ),
            cohort AS (
              SELECT contact_key, MIN(timestamp_ms) AS first_advertising_at
              FROM confirmed_advertising
              WHERE contact_key IS NOT NULL
              GROUP BY contact_key
            ),
            cohort_returns AS (
              SELECT cohort.contact_key,
                     cohort.first_advertising_at,
                     count(later.legacy_storage_key) FILTER (
                       WHERE later.operation = 'deposit'
                     ) AS later_deposits,
                     count(later.legacy_storage_key) FILTER (
                       WHERE later.is_advertising
                     ) AS later_advertising_deposits,
                     count(later.legacy_storage_key) FILTER (
                       WHERE later.timestamp_ms <= cohort.first_advertising_at + 604800000
                     ) AS later_deposits_within_7_days,
                     count(later.legacy_storage_key) FILTER (
                       WHERE later.timestamp_ms > cohort.first_advertising_at + 604800000
                         AND later.timestamp_ms <= cohort.first_advertising_at + 2592000000
                     ) AS later_deposits_between_7_and_30_days,
                     count(later.legacy_storage_key) FILTER (
                       WHERE later.timestamp_ms > cohort.first_advertising_at + 2592000000
                     ) AS later_deposits_after_30_days
              FROM cohort
              LEFT JOIN agent_movements AS later
                ON later.workspace_id = $1
               AND later.contact_key = cohort.contact_key
               AND later.operation = 'deposit'
               AND later.status IS DISTINCT FROM 'pending-verification'
               AND later.timestamp_ms > cohort.first_advertising_at
               AND ($4::uuid[] IS NULL OR later.source_profile_id <> ALL($4::uuid[]))
              GROUP BY cohort.contact_key, cohort.first_advertising_at
            ),
            return_tiers AS (
              SELECT jsonb_build_object(
                'one_load', jsonb_build_object(
                  'customers_with_later_deposit',
                    (count(*) FILTER (WHERE later_deposits >= 1))::text,
                  'customers_with_later_advertising',
                    (count(*) FILTER (
                      WHERE later_deposits >= 1 AND later_advertising_deposits > 0
                    ))::text,
                  'customers_returned_within_7_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 1 AND later_deposits_within_7_days > 0
                    ))::text,
                  'customers_returned_between_7_and_30_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 1 AND later_deposits_between_7_and_30_days > 0
                    ))::text,
                  'customers_returned_after_30_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 1 AND later_deposits_after_30_days > 0
                    ))::text,
                  'cohort_customers', (count(*))::text,
                  'eligible_7_day_cohort',
                    (count(*) FILTER (
                      WHERE first_advertising_at <=
                        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 604800000
                    ))::text,
                  'eligible_30_day_cohort',
                    (count(*) FILTER (
                      WHERE first_advertising_at <=
                        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 2592000000
                    ))::text
                ),
                'two_loads', jsonb_build_object(
                  'customers_with_later_deposit',
                    (count(*) FILTER (WHERE later_deposits >= 2))::text,
                  'customers_with_later_advertising',
                    (count(*) FILTER (
                      WHERE later_deposits >= 2 AND later_advertising_deposits > 0
                    ))::text,
                  'customers_returned_within_7_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 2 AND later_deposits_within_7_days > 0
                    ))::text,
                  'customers_returned_between_7_and_30_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 2 AND later_deposits_between_7_and_30_days > 0
                    ))::text,
                  'customers_returned_after_30_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 2 AND later_deposits_after_30_days > 0
                    ))::text,
                  'cohort_customers', (count(*))::text,
                  'eligible_7_day_cohort',
                    (count(*) FILTER (
                      WHERE first_advertising_at <=
                        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 604800000
                    ))::text,
                  'eligible_30_day_cohort',
                    (count(*) FILTER (
                      WHERE first_advertising_at <=
                        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 2592000000
                    ))::text
                ),
                'more_than_five_loads', jsonb_build_object(
                  'customers_with_later_deposit',
                    (count(*) FILTER (WHERE later_deposits >= 6))::text,
                  'customers_with_later_advertising',
                    (count(*) FILTER (
                      WHERE later_deposits >= 6 AND later_advertising_deposits > 0
                    ))::text,
                  'customers_returned_within_7_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 6 AND later_deposits_within_7_days > 0
                    ))::text,
                  'customers_returned_between_7_and_30_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 6 AND later_deposits_between_7_and_30_days > 0
                    ))::text,
                  'customers_returned_after_30_days',
                    (count(*) FILTER (
                      WHERE later_deposits >= 6 AND later_deposits_after_30_days > 0
                    ))::text,
                  'cohort_customers', (count(*))::text,
                  'eligible_7_day_cohort',
                    (count(*) FILTER (
                      WHERE first_advertising_at <=
                        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 604800000
                    ))::text,
                  'eligible_30_day_cohort',
                    (count(*) FILTER (
                      WHERE first_advertising_at <=
                        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 2592000000
                    ))::text
                )
              ) AS tiers
              FROM cohort_returns
            )
            SELECT
              (SELECT count(*)::text FROM confirmed_advertising) AS deposits,
              (SELECT count(DISTINCT contact_key)::text FROM confirmed_advertising
               WHERE contact_key IS NOT NULL) AS customers,
              COALESCE((SELECT sum(transaction_minor)::text FROM confirmed_advertising), '0')
                AS transaction_minor,
              COALESCE((SELECT sum(bonus_minor)::text FROM confirmed_advertising), '0')
                AS bonus_minor,
              COALESCE((SELECT sum(amount_minor)::text FROM confirmed_advertising), '0')
                AS credited_minor,
              (SELECT count(*)::text FROM advertising
               WHERE status = 'pending-verification') AS pending_deposits,
              (SELECT count(*)::text FROM cohort) AS cohort_customers,
              (SELECT count(*)::text FROM cohort
               WHERE first_advertising_at <=
                 floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 604800000)
                AS eligible_7_day_cohort,
              (SELECT count(*)::text FROM cohort
               WHERE first_advertising_at <=
                 floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 2592000000)
                AS eligible_30_day_cohort,
              (SELECT count(*)::text FROM cohort
               WHERE EXISTS (
                 SELECT 1 FROM agent_movements AS later
                 WHERE later.workspace_id = $1
                   AND later.contact_key = cohort.contact_key
                   AND later.operation = 'deposit'
                   AND ($4::uuid[] IS NULL OR later.source_profile_id <> ALL($4::uuid[]))
                   AND later.status IS DISTINCT FROM 'pending-verification'
                   AND later.timestamp_ms > cohort.first_advertising_at
               )) AS customers_with_later_deposit,
              (SELECT count(*)::text FROM cohort
               WHERE EXISTS (
                 SELECT 1 FROM agent_movements AS later
                 WHERE later.workspace_id = $1
                   AND later.contact_key = cohort.contact_key
                   AND later.operation = 'deposit'
                   AND later.is_advertising
                   AND ($4::uuid[] IS NULL OR later.source_profile_id <> ALL($4::uuid[]))
                   AND later.status IS DISTINCT FROM 'pending-verification'
                   AND later.timestamp_ms > cohort.first_advertising_at
               )) AS customers_with_later_advertising,
              (SELECT count(*)::text FROM cohort
               WHERE EXISTS (
                 SELECT 1 FROM agent_movements AS later
                 WHERE later.workspace_id = $1
                   AND later.contact_key = cohort.contact_key
                   AND later.operation = 'deposit'
                   AND ($4::uuid[] IS NULL OR later.source_profile_id <> ALL($4::uuid[]))
                   AND later.status IS DISTINCT FROM 'pending-verification'
                   AND later.timestamp_ms > cohort.first_advertising_at
                   AND later.timestamp_ms <= cohort.first_advertising_at + 604800000
               )) AS customers_returned_within_7_days,
              (SELECT count(*)::text FROM cohort
               WHERE EXISTS (
                 SELECT 1 FROM agent_movements AS later
                 WHERE later.workspace_id = $1
                   AND later.contact_key = cohort.contact_key
                   AND later.operation = 'deposit'
                   AND ($4::uuid[] IS NULL OR later.source_profile_id <> ALL($4::uuid[]))
                   AND later.status IS DISTINCT FROM 'pending-verification'
                   AND later.timestamp_ms > cohort.first_advertising_at
                   AND later.timestamp_ms <= cohort.first_advertising_at + 2592000000
               )) AS customers_returned_within_30_days,
              (SELECT tiers FROM return_tiers) AS return_tiers
          `, [identity.workspace_id, since, until, excludedProfiles]),
          pool.query(`
            SELECT movements.platform,
                   count(*)::text AS deposits,
                   count(DISTINCT movements.contact_key)::text AS customers,
                   count(DISTINCT movements.contact_key) FILTER (WHERE EXISTS (
                     SELECT 1 FROM agent_movements AS later
                     WHERE later.workspace_id = movements.workspace_id
                       AND later.contact_key = movements.contact_key
                       AND later.operation = 'deposit'
                       AND ($4::uuid[] IS NULL OR later.source_profile_id <> ALL($4::uuid[]))
                       AND later.status IS DISTINCT FROM 'pending-verification'
                       AND later.timestamp_ms > movements.timestamp_ms
                   ))::text AS returning_customers,
                   COALESCE(sum(transaction_minor)::text, '0') AS transaction_minor,
                   COALESCE(sum(bonus_minor)::text, '0') AS bonus_minor,
                   COALESCE(sum(amount_minor)::text, '0') AS credited_minor
            FROM agent_movements AS movements
            WHERE movements.workspace_id = $1
              AND movements.is_advertising
              AND movements.operation = 'deposit'
              AND movements.status IS DISTINCT FROM 'pending-verification'
              AND ($4::uuid[] IS NULL OR movements.source_profile_id <> ALL($4::uuid[]))
              AND ($2::bigint IS NULL OR movements.timestamp_ms >= $2)
              AND ($3::bigint IS NULL OR movements.timestamp_ms < $3)
            GROUP BY movements.platform
            ORDER BY movements.platform
          `, [identity.workspace_id, since, until, excludedProfiles]),
          pool.query(`
            SELECT movements.source_profile_id::text AS profile_id,
                   devices.display_name,
                   count(*)::text AS deposits,
                   count(DISTINCT movements.contact_key)::text AS customers,
                   count(DISTINCT movements.contact_key) FILTER (WHERE EXISTS (
                     SELECT 1 FROM agent_movements AS later
                     WHERE later.workspace_id = movements.workspace_id
                       AND later.contact_key = movements.contact_key
                       AND later.operation = 'deposit'
                       AND ($4::uuid[] IS NULL OR later.source_profile_id <> ALL($4::uuid[]))
                       AND later.status IS DISTINCT FROM 'pending-verification'
                       AND later.timestamp_ms > movements.timestamp_ms
                   ))::text AS returning_customers,
                   COALESCE(sum(movements.transaction_minor)::text, '0') AS transaction_minor,
                   COALESCE(sum(movements.bonus_minor)::text, '0') AS bonus_minor,
                   COALESCE(sum(movements.amount_minor)::text, '0') AS credited_minor
            FROM agent_movements AS movements
            JOIN extension_profiles AS profiles
              ON profiles.profile_id = movements.source_profile_id
             AND profiles.workspace_id = movements.workspace_id
            JOIN enrolled_devices AS devices
              ON devices.device_id = movements.source_device_id
             AND devices.workspace_id = movements.workspace_id
            WHERE movements.workspace_id = $1
              AND movements.is_advertising
              AND movements.operation = 'deposit'
              AND movements.status IS DISTINCT FROM 'pending-verification'
              AND ($4::uuid[] IS NULL OR movements.source_profile_id <> ALL($4::uuid[]))
              AND ($2::bigint IS NULL OR movements.timestamp_ms >= $2)
              AND ($3::bigint IS NULL OR movements.timestamp_ms < $3)
            GROUP BY movements.source_profile_id, devices.display_name
            ORDER BY devices.display_name, movements.source_profile_id
          `, [identity.workspace_id, since, until, excludedProfiles]),
          excludedProfiles?.length
            ? pool.query(`
                SELECT profiles.profile_id::text AS profile_id,
                       devices.display_name
                FROM extension_profiles AS profiles
                JOIN enrolled_devices AS devices
                  ON devices.device_id = profiles.device_id
                 AND devices.workspace_id = profiles.workspace_id
                WHERE profiles.workspace_id = $1
                  AND profiles.profile_id = ANY($2::uuid[])
                ORDER BY devices.display_name, profiles.profile_id
              `, [identity.workspace_id, excludedProfiles])
            : { rows: [] }
        ]);
        sendJson(response, 200, {
          ok: true,
          days: daysValue === null ? null : Number(daysValue),
          from,
          to,
          summary: summary.rows[0],
          platforms: platforms.rows,
          profiles: profiles.rows,
          hiddenProfiles: hiddenProfiles.rows
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/movements" && request.method === "GET") {
        const identity = await authenticate(request);
        const query = new URL(request.url, "https://localhost").searchParams;
        const allowedParameters = new Set([
          "accountId", "contactKey", "ganamosUsername", "legacyContactKey", "multipanelUsername",
          "operation", "since", "limit", "source"
        ]);
        if ([...query.keys()].some((key) => !allowedParameters.has(key)) ||
          [...allowedParameters].some((key) =>
            !["accountId", "legacyContactKey"].includes(key) && query.getAll(key).length > 1) ||
          query.getAll("accountId").length > 4 || query.getAll("legacyContactKey").length > 40) {
          throw new ApiError(400, "invalid_movement_query", "Los filtros de movimientos no son válidos.");
        }
        const accountIds = query.getAll("accountId");
        const legacyContactKeys = query.getAll("legacyContactKey");
        const ganamosUsername = query.get("ganamosUsername");
        const multipanelUsername = query.get("multipanelUsername");
        if (accountIds.some((accountId) =>
          !/^(ganamos|multipanel):\d{4,20}$/.test(accountId)) ||
          new Set(accountIds).size !== accountIds.length ||
          legacyContactKeys.some((key) =>
            !key || key.length > 2048 || /[\u0000-\u001f\u007f]/.test(key)) ||
          new Set(legacyContactKeys).size !== legacyContactKeys.length ||
          [ganamosUsername, multipanelUsername].some((username) =>
            username !== null &&
            (!username || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username))) ||
          legacyContactKeys.length > 0 && accountIds.length === 0 &&
            query.get("contactKey") !== null) {
          throw new ApiError(400, "invalid_movement_query", "Las cuentas consultadas no son válidas.");
        }
        const source = query.get("source");
        if (source !== null && source !== "profile") {
          throw new ApiError(400, "invalid_movement_query", "El origen consultado no es válido.");
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
        if (source === "profile") {
          parameters.push(identity.profile_id);
          filters.push(`source_profile_id = $${parameters.length}`);
        }
        if (contactKey !== null) {
          parameters.push(contactKey);
          filters.push(`contact_key = $${parameters.length}`);
        }
        const identityFilters = [];
        if (accountIds.length && legacyContactKeys.length) {
          parameters.push(accountIds);
          const accountParameter = parameters.length;
          const legacyPhones = [...new Set(accountIds.map((accountId) =>
            accountId.slice(accountId.indexOf(":") + 1)))];
          parameters.push(legacyPhones.map((phone) =>
            `"phone"\\s*:\\s*"${phone}"`));
          const phonePatternParameter = parameters.length;
          parameters.push(legacyContactKeys);
          const legacyContactParameter = parameters.length;
          identityFilters.push(
            `(account_ids && $${accountParameter}::text[] OR ` +
            `legacy_record_json->>'contactKey' ~ ANY($${phonePatternParameter}::text[]) OR ` +
            `contact_key = ANY($${legacyContactParameter}::text[]))`
          );
        } else if (accountIds.length) {
          parameters.push(accountIds);
          identityFilters.push(`account_ids && $${parameters.length}::text[]`);
        } else if (legacyContactKeys.length) {
          parameters.push(legacyContactKeys);
          identityFilters.push(`contact_key = ANY($${parameters.length}::text[])`);
        }
        if (ganamosUsername !== null) {
          parameters.push(ganamosUsername);
          identityFilters.push(`(platform = 'ganamos' AND username = $${parameters.length})`);
        }
        if (multipanelUsername !== null) {
          parameters.push(multipanelUsername);
          identityFilters.push(`(platform = 'multipanel' AND username = $${parameters.length})`);
        }
        if (identityFilters.length) {
          filters.push(`(${identityFilters.join(" OR ")})`);
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
          SELECT legacy_storage_key, legacy_record_json
          FROM agent_movements
          WHERE ${filters.join(" AND ")}
          ORDER BY timestamp_ms DESC NULLS LAST, legacy_storage_key DESC
          ${limitClause}
        `, parameters);
        sendJson(response, 200, {
          ok: true,
          movements: result.rows.map(({
            legacy_storage_key: recordKey,
            legacy_record_json: movement
          }) => ({ ...movement, recordKey }))
        }, origin, extensionId && `chrome-extension://${extensionId}`);
        return;
      }

      if (route === "/v1/state" && request.method === "POST") {
        const identity = await authenticate(request);
        const body = requireObjectBody(await parseBody(request, MAX_STATE_REQUEST_BYTES));
        const result = await writeExtensionState(
          pool,
          config,
          identity,
          body.changes,
          body.removes || [],
          body.expectedRevision
        );
        sendJson(response, 200, {
          ok: true,
          ...result
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
  getMovementAccountIds,
  getServerConfig,
  parseUserAccountSettingKey,
  mergeContactFlowCounterSnapshots,
  normalizeArgentinaPhone,
  validateUserAccountSettingValue,
  validateCounterSnapshot,
  validateDestinations
};
