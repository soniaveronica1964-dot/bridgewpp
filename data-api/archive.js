const crypto = require("node:crypto");

const PAYLOAD_FORMAT = "bridgewpp-profile-payload";
const FORMAT_VERSION = 1;
const MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const MAX_KEYS = 100_000;

function canonicalJson(value, depth = 0) {
  if (depth > 64) throw new Error("El archivo contiene datos demasiado profundos.");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("El archivo contiene un número JSON inválido.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (!value || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("El archivo contiene un valor que no es JSON.");
  }
  const properties = Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`);
  return `{${properties.join(",")}}`;
}

function createCanonicalSha256(entries) {
  const canonicalPayload = canonicalJson({
    format: PAYLOAD_FORMAT,
    formatVersion: FORMAT_VERSION,
    entries: entries.map(({ key, value }) => ({ key, value }))
  });
  return sha256Hex(Buffer.from(canonicalPayload, "utf8"));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validatePayload(payload) {
  if (!payload || payload.format !== PAYLOAD_FORMAT ||
    payload.formatVersion !== FORMAT_VERSION ||
    typeof payload.exportId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.exportId) ||
    typeof payload.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(payload.exportedAt)) ||
    !payload.source || typeof payload.source.extensionId !== "string" ||
    !/^[a-p]{32}$/.test(payload.source.extensionId) ||
    payload.source.storageArea !== "chrome.storage.local" ||
    !payload.integrity || !Number.isSafeInteger(payload.integrity.keyCount) ||
    !Number.isSafeInteger(payload.integrity.movementCount) ||
    !/^[0-9a-f]{64}$/.test(payload.integrity.canonicalSha256) ||
    !Array.isArray(payload.entries)) {
    throw new Error("La estructura del respaldo no es válida.");
  }
  if (payload.entries.length > MAX_KEYS || payload.entries.length !== payload.integrity.keyCount) {
    throw new Error("La cantidad de claves del respaldo no es válida.");
  }
  const ids = new Set();
  const entries = [];
  let previousKey = null;
  let movementCount = 0;
  for (const entry of payload.entries) {
    if (!entry || typeof entry.key !== "string" || entry.key.length === 0 ||
      entry.key.length > 2048 || !/^[0-9a-f]{64}$/.test(entry.valueSha256)) {
      throw new Error("Una entrada del respaldo no es válida.");
    }
    if (ids.has(entry.key) || previousKey !== null && entry.key <= previousKey) {
      throw new Error("El respaldo contiene claves duplicadas o fuera de orden.");
    }
    ids.add(entry.key);
    previousKey = entry.key;
    const valueJson = canonicalJson(entry.value);
    const actualHash = sha256Hex(Buffer.from(valueJson, "utf8"));
    if (actualHash !== entry.valueSha256) {
      throw new Error("El hash de una entrada no coincide.");
    }
    if (entry.key.startsWith("agentMovement:")) movementCount++;
    entries.push({ key: entry.key, value: entry.value, valueSha256: actualHash });
  }
  if (movementCount !== payload.integrity.movementCount) {
    throw new Error("La cantidad de movimientos del respaldo no coincide.");
  }
  const payloadSize = Buffer.byteLength(canonicalJson(payload), "utf8");
  if (payloadSize > MAX_PAYLOAD_BYTES ||
    createCanonicalSha256(entries) !== payload.integrity.canonicalSha256) {
    throw new Error("El checksum global del respaldo no coincide.");
  }
  return {
    exportId: payload.exportId,
    extensionId: payload.source.extensionId,
    keyCount: entries.length,
    movementCount,
    canonicalSha256: payload.integrity.canonicalSha256,
    entries
  };
}

function encryptValue(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decryptValue(value, key) {
  if (!Buffer.isBuffer(value) || value.length < 28) {
    throw new Error("Un valor cifrado del staging está mal formado.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([
    decipher.update(value.subarray(28)),
    decipher.final()
  ]).toString("utf8");
}

module.exports = {
  canonicalJson,
  createCanonicalSha256,
  decryptValue,
  encryptValue,
  sha256Hex,
  validatePayload
};
