const roleInput = document.querySelector("#role");
const ganamosUserIdInput = document.querySelector("#ganamosUserId");
const tokenInput = document.querySelector("#token");
const ganamosSuffixInput = document.querySelector("#ganamosSuffix");
const multiPanelSuffixInput = document.querySelector("#multiPanelSuffix");
const userCreationPasswordInput = document.querySelector("#userCreationPassword");
const hint = document.querySelector("#hint");
const status = document.querySelector("#status");
const backupForm = document.querySelector("#backupForm");
const backupLabelInput = document.querySelector("#backupLabel");
const backupPassphraseInput = document.querySelector("#backupPassphrase");
const backupPassphraseConfirmInput = document.querySelector("#backupPassphraseConfirm");
const backupButton = document.querySelector("#exportBackup");
const backupStatus = document.querySelector("#backupStatus");
const BACKUP_FORMAT = "bridgewpp-profile-archive";
const BACKUP_PAYLOAD_FORMAT = "bridgewpp-profile-payload";
const BACKUP_FORMAT_VERSION = 1;
const BACKUP_KDF_ITERATIONS = 600_000;
const BACKUP_MAX_BYTES = 32 * 1024 * 1024;
const BACKUP_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const BACKUP_SALT_BYTES = 16;
const BACKUP_IV_BYTES = 12;
const BACKUP_MIN_PASSPHRASE_LENGTH = 16;
const IMPORT_BATCH_TARGET_BYTES = 48 * 1024;
const DATA_NATIVE_HOST = "com.bridgewpp.data";
let dataProfileSelectorPromise = null;
const importForm = document.querySelector("#importForm");
const importFileInput = document.querySelector("#importFile");
const importPassphraseInput = document.querySelector("#importPassphrase");
const importDeviceNameInput = document.querySelector("#dataDeviceName");
const enrollmentCodeInput = document.querySelector("#dataEnrollmentCode");
const importApiOriginInput = document.querySelector("#dataApiOrigin");
const confirmDifferentExtensionInput = document.querySelector("#confirmDifferentExtension");
const importPreviewElement = document.querySelector("#importPreview");
const importStatusElement = document.querySelector("#importStatus");
const sharedDecisionLabel = document.querySelector("#sharedDecisionLabel");
const sharedDecisionSelect = document.querySelector("#sharedDataDecision");
const previewImportButton = document.querySelector("#previewImport");
const commitImportButton = document.querySelector("#commitImport");
const discardImportButton = document.querySelector("#discardImport");
let pendingImport = null;
const remoteDestinationFields = [1, 2, 3].map((index) => ({
  id: `remote-${index}`,
  name: document.querySelector(`#remoteName${index}`),
  url: document.querySelector(`#remoteUrl${index}`),
  token: document.querySelector(`#remoteToken${index}`),
  ganamosSuffix: document.querySelector(`#remoteGanamosSuffix${index}`),
  multiPanelSuffix: document.querySelector(`#remoteMultiPanelSuffix${index}`)
}));

function canonicalJson(value, depth = 0) {
  if (depth > 64) throw new Error("Los datos tienen una estructura demasiado profunda.");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Se encontró un número que no se puede exportar.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Se encontró un valor que no se puede representar en JSON.");
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`);
  return `{${entries.join(",")}}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeBackupFilename(label) {
  const date = new Date().toISOString().slice(0, 10);
  const safeLabel = label.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `bridgewpp${safeLabel ? `-${safeLabel}` : ""}-perfil-${date}.json`;
}

async function createEncryptedProfileBackup(passphrase) {
  const snapshot = await stateStorage.get(null);
  const keys = Object.keys(snapshot).sort();
  if (keys.length > 100_000) {
    throw new Error("El perfil supera el límite de cantidad de claves permitido.");
  }

  const entries = keys.map((key) => ({ key, value: snapshot[key] }));
  const encoder = new TextEncoder();
  const entryJson = canonicalJson(entries);
  const canonicalPayload = `{"entries":${entryJson},"format":${JSON.stringify(BACKUP_PAYLOAD_FORMAT)},"formatVersion":${BACKUP_FORMAT_VERSION}}`;
  const canonicalPayloadBytes = encoder.encode(canonicalPayload);
  if (canonicalPayloadBytes.byteLength > BACKUP_MAX_PAYLOAD_BYTES) {
    throw new Error("El respaldo supera el tamaño máximo de 24 MiB. No se generó un archivo parcial.");
  }

  const valueHashes = [];
  const hashBatchSize = 100;
  for (let offset = 0; offset < entries.length; offset += hashBatchSize) {
    const batch = entries.slice(offset, offset + hashBatchSize);
    valueHashes.push(...await Promise.all(batch.map(({ value }) =>
      sha256Hex(encoder.encode(canonicalJson(value)))
    )));
  }
  const integrity = {
    keyCount: entries.length,
    movementCount: keys.filter((key) => key.startsWith("agentMovement:")).length,
    canonicalSha256: await sha256Hex(canonicalPayloadBytes)
  };
  const payload = {
    format: BACKUP_PAYLOAD_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportId: crypto.randomUUID(),
    exportedAt: new Date().toISOString(),
    source: {
      extensionId: chrome.runtime.id,
      storageArea: "chrome.storage.local"
    },
    integrity,
    entries: entries.map(({ key, value }, index) => ({
      key,
      value,
      valueSha256: valueHashes[index]
    }))
  };
  const plaintext = encoder.encode(canonicalJson(payload));
  if (plaintext.byteLength > BACKUP_MAX_PAYLOAD_BYTES) {
    throw new Error("El respaldo supera el tamaño máximo de 24 MiB. No se generó un archivo parcial.");
  }

  const salt = crypto.getRandomValues(new Uint8Array(BACKUP_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(BACKUP_IV_BYTES));
  const encryption = {
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA-256",
    iterations: BACKUP_KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv)
  };
  const header = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    encryption
  };
  const headerBytes = encoder.encode(canonicalJson(header));
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: BACKUP_KDF_ITERATIONS,
      hash: "SHA-256"
    },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: headerBytes, tagLength: 128 },
    aesKey,
    plaintext
  );
  const archive = JSON.stringify({
    ...header,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  });
  const archiveBytes = encoder.encode(archive);
  if (archiveBytes.byteLength > BACKUP_MAX_BYTES) {
    throw new Error("El archivo cifrado supera el límite de 32 MiB. No se generó un archivo parcial.");
  }

  return {
    blob: new Blob([archiveBytes], { type: "application/json;charset=utf-8" }),
    keyCount: keys.length,
    movementCount: integrity.movementCount,
    byteLength: archiveBytes.byteLength
  };
}

function decodeArchiveBase64(value, expectedBytes, field) {
  if (typeof value !== "string" || !value.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`El campo ${field} del respaldo no es Base64 válido.`);
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`El campo ${field} del respaldo no es Base64 válido.`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64(bytes) !== value || expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new Error(`El tamaño del campo ${field} del respaldo no es válido.`);
  }
  return bytes;
}

async function decryptAndValidateProfileArchive(file, passphrase) {
  if (!file || file.size === 0 || file.size > BACKUP_MAX_BYTES) {
    throw new Error("Seleccioná un archivo de respaldo no vacío de hasta 32 MiB.");
  }
  let archive;
  try {
    archive = JSON.parse(await file.text());
  } catch {
    throw new Error("El archivo seleccionado no contiene JSON válido.");
  }
  const encryption = archive?.encryption;
  if (archive?.format !== BACKUP_FORMAT || archive.formatVersion !== BACKUP_FORMAT_VERSION ||
    encryption?.algorithm !== "AES-256-GCM" || encryption?.kdf !== "PBKDF2-SHA-256" ||
    encryption?.iterations !== BACKUP_KDF_ITERATIONS ||
    typeof archive.ciphertext !== "string") {
    throw new Error("El formato o los parámetros de cifrado del respaldo no son compatibles.");
  }

  const salt = decodeArchiveBase64(encryption.salt, BACKUP_SALT_BYTES, "salt");
  const iv = decodeArchiveBase64(encryption.iv, BACKUP_IV_BYTES, "iv");
  const ciphertext = decodeArchiveBase64(archive.ciphertext, undefined, "ciphertext");
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > BACKUP_MAX_PAYLOAD_BYTES + 16) {
    throw new Error("El contenido cifrado del respaldo tiene un tamaño no válido.");
  }

  const header = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2-SHA-256",
      iterations: BACKUP_KDF_ITERATIONS,
      salt: encryption.salt,
      iv: encryption.iv
    }
  };
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: BACKUP_KDF_ITERATIONS, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(canonicalJson(header)), tagLength: 128 },
      aesKey,
      ciphertext
    );
  } catch {
    throw new Error("No se pudo autenticar el respaldo. Verificá la frase de contraseña y que el archivo no esté dañado.");
  }
  if (plaintext.byteLength > BACKUP_MAX_PAYLOAD_BYTES) {
    throw new Error("El contenido descifrado supera el máximo de 24 MiB.");
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new Error("El contenido descifrado no es un payload JSON válido.");
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (payload?.format !== BACKUP_PAYLOAD_FORMAT ||
    payload.formatVersion !== BACKUP_FORMAT_VERSION ||
    !uuidPattern.test(payload.exportId || "") ||
    typeof payload.exportedAt !== "string" || !Number.isFinite(Date.parse(payload.exportedAt)) ||
    !/^[a-p]{32}$/.test(payload.source?.extensionId || "") ||
    payload.source.storageArea !== "chrome.storage.local" ||
    !Number.isSafeInteger(payload.integrity?.keyCount) || payload.integrity.keyCount < 0 ||
    !Number.isSafeInteger(payload.integrity?.movementCount) || payload.integrity.movementCount < 0 ||
    !/^[0-9a-f]{64}$/.test(payload.integrity?.canonicalSha256 || "") ||
    !Array.isArray(payload.entries) || payload.entries.length !== payload.integrity.keyCount ||
    payload.entries.length > 100_000) {
    throw new Error("La estructura o los metadatos del respaldo no son válidos.");
  }

  let previousKey = null;
  let movementCount = 0;
  for (const entry of payload.entries) {
    if (!entry || typeof entry.key !== "string" || entry.key.length === 0 ||
      entry.key.length > 2048 || !/^[0-9a-f]{64}$/.test(entry.valueSha256 || "") ||
      previousKey !== null && entry.key <= previousKey) {
      throw new Error("El respaldo contiene claves inválidas, duplicadas o fuera de orden.");
    }
    previousKey = entry.key;
    const valueHash = await sha256Hex(encoder.encode(canonicalJson(entry.value)));
    if (valueHash !== entry.valueSha256) {
      throw new Error(`No coincide la integridad de la clave "${entry.key}".`);
    }
    if (entry.key.startsWith("agentMovement:")) movementCount++;
  }
  if (movementCount !== payload.integrity.movementCount) {
    throw new Error("La cantidad de movimientos del respaldo no coincide.");
  }
  const canonicalPayload = canonicalJson({
    format: BACKUP_PAYLOAD_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    entries: payload.entries.map(({ key, value }) => ({ key, value }))
  });
  const actualHash = await sha256Hex(encoder.encode(canonicalPayload));
  if (actualHash !== payload.integrity.canonicalSha256) {
    throw new Error("El checksum global del respaldo no coincide.");
  }
  return {
    exportId: payload.exportId,
    exportedAt: payload.exportedAt,
    formatVersion: payload.formatVersion,
    extensionId: payload.source.extensionId,
    keyCount: payload.entries.length,
    movementCount,
    canonicalSha256: actualHash,
    entries: payload.entries
  };
}

function isPrivateDataApiHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 10 || parts[0] === 127 ||
      parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 ||
      parts[0] === 192 && parts[1] === 168 ||
      parts[0] === 169 && parts[1] === 254 ||
      parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  }
  return host === "localhost" || /\.(local|lan|internal)$/.test(host) ||
    host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}

function getDataApiOrigin(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("La dirección HTTPS de la API no es válida.");
  }
  if (url.protocol !== "https:" || !isPrivateDataApiHost(url.hostname) ||
    !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("La API debe usar HTTPS, un puerto explícito y una dirección privada de la LAN.");
  }
  return url.origin;
}

function getDataApiPermissionPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

async function getDataProfileSelector() {
  if (!dataProfileSelectorPromise) {
    dataProfileSelectorPromise = chrome.runtime.sendMessage({
      type: "DATA_PROFILE_SELECTOR_GET"
    }).then((result) => {
      if (!result?.ok ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(result.profileSelector || "")) {
        throw new Error(result?.error || "No se pudo obtener la identidad persistente de este perfil Chrome.");
      }
      return result.profileSelector.toLowerCase();
    });
  }
  try {
    return await dataProfileSelectorPromise;
  } finally {
    dataProfileSelectorPromise = null;
  }
}

async function sendNativeHost(message) {
  let result;
  try {
    const profileSelector = await getDataProfileSelector();
    result = await chrome.runtime.sendNativeMessage(DATA_NATIVE_HOST, {
      ...message,
      profileSelector
    });
  } catch (error) {
    throw new Error(`No está instalado o accesible el host nativo con protección DPAPI. Ejecutá native-host\\install.ps1 para esta extensión. ${error.message}`);
  }
  if (!result?.ok) throw new Error(result?.error || "El host nativo no pudo completar la operación.");
  return result;
}

async function requestDataApi(origin, route, { method = "GET", body, credential } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 120_000);
  try {
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(credential ? { authorization: `Bearer ${credential}` } : {})
    };
    if (credential) {
      const nativeProfile = await sendNativeHost({ command: "get" });
      if (!nativeProfile.deviceId) {
        throw new Error("El perfil no tiene una identidad de dispositivo persistida en el host nativo.");
      }
      const proof = await sendNativeHost({ command: "sign", method, requestPath: route });
      headers["x-bridge-device-id"] = proof.deviceId;
      headers["x-bridge-device-time"] = String(proof.timestamp);
      headers["x-bridge-device-nonce"] = proof.nonce;
      headers["x-bridge-device-signature"] = proof.signature;
    }
    const response = await fetch(`${origin}${route}`, {
      method,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const responseText = await response.text();
    let result = null;
    if (responseText) {
      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error("La API PostgreSQL devolvió una respuesta que no es JSON válido.");
      }
    }
    if (!response.ok) {
      const error = new Error(result?.error || `La API PostgreSQL respondió HTTP ${response.status}.`);
      error.status = response.status;
      error.code = result?.code;
      throw error;
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("La API local excedió el tiempo de espera.");
    if (error instanceof TypeError || error.name === "TypeError") {
      throw new Error("No se pudo conectar con la API HTTPS. Comprobá que esté activa, que el certificado sea confiable y que Chrome tenga permiso para conectarse.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function ensureDataApiCredential(origin, serverInfo) {
  const stored = await sendNativeHost({ command: "get" });
  const credential = stored.credential;
  if (typeof credential === "string" && credential) {
    try {
      if (stored.apiOrigin !== origin) {
        throw new Error("La credencial de este perfil está vinculada a otro origen de API. Verificá la dirección antes de reenrolar.");
      }
      const identity = await requestDataApi(origin, "/v1/identity", { credential });
      if (identity.serverId !== serverInfo.serverId ||
        identity.workspaceId !== serverInfo.workspaceId) {
        throw new Error("La credencial está enrolada en otro servidor o workspace. No se inició la importación.");
      }
      return { credential, identity };
    } catch (error) {
      if (error.status !== 401 || !enrollmentCodeInput.value.trim()) throw error;
    }
  }

  const code = enrollmentCodeInput.value.trim();
  const deviceName = importDeviceNameInput.value.trim();
  if (!code || !deviceName || deviceName.length > 120) {
    throw new Error("Para enrolar este perfil, ingresá un nombre de dispositivo y un código temporal válido.");
  }
  const installationId = stored.installationId;
  if (typeof stored.deviceProofKey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(stored.deviceProofKey)) {
    throw new Error("El host nativo no devolvió una clave privada de dispositivo válida.");
  }
  const enrollment = await requestDataApi(origin, "/v1/enroll", {
    method: "POST",
    body: {
      code,
      deviceName,
      installationId,
      extensionId: chrome.runtime.id,
      deviceProofKey: stored.deviceProofKey
    }
  });
  if (typeof enrollment?.credential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(enrollment.credential) ||
    enrollment.identity?.workspaceId !== serverInfo.workspaceId) {
    throw new Error("La API no devolvió una identidad de perfil válida.");
  }
  await sendNativeHost({
    command: "store",
    apiOrigin: origin,
    credential: enrollment.credential,
    deviceId: enrollment.identity.deviceId
  });
  const identity = await requestDataApi(origin, "/v1/identity", {
    credential: enrollment.credential
  });
  if (identity.serverId !== serverInfo.serverId || identity.workspaceId !== serverInfo.workspaceId) {
    throw new Error("La identidad emitida no corresponde al servidor elegido.");
  }
  enrollmentCodeInput.value = "";
  return { credential: enrollment.credential, identity };
}

function makeImportBatches(entries) {
  const batches = [];
  let batch = [];
  for (const entry of entries) {
    const candidate = [...batch, entry];
    const byteLength = new TextEncoder().encode(JSON.stringify({ entries: candidate })).byteLength;
    if ((byteLength > IMPORT_BATCH_TARGET_BYTES || candidate.length > 500) && batch.length) {
      batches.push(batch);
      batch = [entry];
    } else {
      batch = candidate;
    }
    const singleEntrySize = new TextEncoder().encode(JSON.stringify({ entries: batch })).byteLength;
    if (batch.length === 1 && singleEntrySize > BACKUP_MAX_PAYLOAD_BYTES + 64 * 1024) {
      throw new Error(`La clave "${entry.key}" supera el máximo aceptado por el servicio.`);
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function renderImportPreview(preview) {
  importPreviewElement.replaceChildren();
  const report = preview.report;
  const target = report.target || preview.identity || {};
  const conflicts = report.conflicts;
  const heading = document.createElement("strong");
  heading.textContent = preview.status === "committed"
    ? "Este respaldo ya fue importado."
    : "Vista previa validada; todavía no se importó ningún dato.";
  importPreviewElement.append(heading);
  const details = [
    `Archivo: ${preview.fileName || "sin nombre"}; formato v${preview.archive.formatVersion}; exportado ${new Date(preview.archive.exportedAt).toLocaleString()}`,
    `Servidor: ${target.serverId || "no disponible"}`,
    `Workspace: ${target.workspaceId || "no disponible"}`,
    `Perfil: ${target.profileId || "no disponible"}`,
    `Claves: ${report.keyCount ?? preview.archive.keyCount}; movimientos: ${report.movementCount ?? preview.archive.movementCount}; tipos: ${Object.entries(report.operationCounts || {}).map(([operation, count]) => `${operation} ${count}`).join(", ") || "sin movimientos"}; claves desconocidas: ${report.unknownKeyCount ?? report.preservedUnknownKeys ?? "no disponible"}`,
    conflicts
      ? `Conflictos: ajustes ${conflicts.profileSettings}, secretos ${conflicts.profileSecrets}, movimientos ${conflicts.movements}, claves heredadas ${conflicts.legacyKeys}`
      : "Conflictos: no disponible para una migración que ya estaba confirmada."
  ];
  for (const detail of details) {
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    importPreviewElement.append(paragraph);
  }
  importPreviewElement.hidden = false;

  const decisions = Array.isArray(report.sharedData?.choices) ? report.sharedData.choices : [];
  sharedDecisionSelect.replaceChildren();
  if (decisions.includes("initialize_shared")) {
    const option = document.createElement("option");
    option.value = "initialize_shared";
    option.textContent = "Inicializar datos compartidos con este perfil (solo si se eligió como fuente canónica)";
    sharedDecisionSelect.append(option);
  }
  if (decisions.includes("private_and_movements_only")) {
    const option = document.createElement("option");
    option.value = "private_and_movements_only";
    option.textContent = "Importar solo datos privados y movimientos; mantener datos compartidos actuales";
    sharedDecisionSelect.append(option);
  }
  const needsDecision = decisions.length > 0;
  sharedDecisionLabel.hidden = !needsDecision;
  sharedDecisionSelect.hidden = !needsDecision;
  commitImportButton.hidden = preview.status === "committed" || !needsDecision;
  commitImportButton.disabled = preview.status === "committed" || !needsDecision;
  discardImportButton.hidden = preview.status === "committed";
  discardImportButton.disabled = preview.status === "committed";
  if (!needsDecision && preview.status !== "committed") {
    const warning = document.createElement("p");
    warning.textContent = "Este workspace aún no tiene datos compartidos canónicos. Un administrador debe enrolar y confirmar primero el perfil elegido como fuente.";
    importPreviewElement.append(warning);
  }
}

async function loadOrStageImport(origin, credential, archive) {
  const migrationId = archive.exportId;
  const statusRoute = `/v1/migrations/${migrationId}`;
  let status;
  try {
    status = await requestDataApi(origin, statusRoute, { credential });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (status?.status === "committed" || status?.status === "validated") {
    return { status: status.status, report: status.report };
  }
  if (!status) {
    const start = await requestDataApi(origin, statusRoute, {
      method: "POST",
      credential,
      body: {
        migrationId,
        extensionId: archive.extensionId,
        keyCount: archive.keyCount,
        movementCount: archive.movementCount,
        canonicalSha256: archive.canonicalSha256,
        confirmDifferentExtension: confirmDifferentExtensionInput.checked
      }
    });
    if (start.status === "committed" || start.status === "validated") {
      const result = await requestDataApi(origin, statusRoute, { credential });
      return { status: result.status, report: result.report };
    }
  }

  const batches = makeImportBatches(archive.entries);
  for (let index = 0; index < batches.length; index++) {
    importStatusElement.textContent = `Enviando lote ${index + 1} de ${batches.length} al staging cifrado...`;
    await requestDataApi(origin, `${statusRoute}/entries`, {
      method: "POST",
      credential,
      body: { entries: batches[index] }
    });
  }
  const validation = await requestDataApi(origin, `${statusRoute}/validate`, {
    method: "POST",
    credential,
    body: {}
  });
  if (validation.status !== "validated" || !validation.report) {
    throw new Error("La API no pudo validar el respaldo completo.");
  }
  return { status: validation.status, report: validation.report };
}

importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  pendingImport = null;
  importPreviewElement.hidden = true;
  sharedDecisionLabel.hidden = true;
  sharedDecisionSelect.hidden = true;
  commitImportButton.hidden = true;
  commitImportButton.disabled = true;
  discardImportButton.hidden = true;
  importStatusElement.textContent = "";
  importPassphraseInput.setCustomValidity("");
  if (!importForm.reportValidity()) return;
  const file = importFileInput.files?.[0];
  const passphrase = importPassphraseInput.value;
  importPassphraseInput.value = "";
  enrollmentCodeInput.value = enrollmentCodeInput.value.trim();
  if (passphrase.length < BACKUP_MIN_PASSPHRASE_LENGTH || passphrase.length > 1024) {
    importStatusElement.textContent = "La frase debe tener entre 16 y 1024 caracteres.";
    return;
  }
  if (typeof crypto === "undefined" || !crypto.subtle || typeof crypto.randomUUID !== "function") {
    importStatusElement.textContent = "Este navegador no dispone de las funciones criptográficas necesarias.";
    return;
  }

  previewImportButton.disabled = true;
  try {
    const origin = getDataApiOrigin(importApiOriginInput.value);
    const permitted = await chrome.permissions.request({
      origins: [getDataApiPermissionPattern(origin)]
    });
    if (!permitted) throw new Error("No se concedió permiso para conectarse a esta API HTTPS.");
    const archive = await decryptAndValidateProfileArchive(file, passphrase);
    if (archive.extensionId !== chrome.runtime.id && !confirmDifferentExtensionInput.checked) {
      throw new Error("El respaldo proviene de otro ID de extensión. Revisalo y marcá la confirmación explícita si corresponde.");
    }
    importStatusElement.textContent = "Comprobando identidad del servidor PostgreSQL...";
    const health = await requestDataApi(origin, "/health");
    if (health?.status !== "healthy" || health.apiVersion !== 1 || health.schemaVersion !== 4) {
      throw new Error("La API no confirmó una versión compatible y el esquema de estado PostgreSQL.");
    }
    const serverInfo = await requestDataApi(origin, "/v1/server-info");
    if (serverInfo?.tls !== true || serverInfo.apiVersion !== 1 || serverInfo.schemaVersion !== 4 ||
      !/^[0-9a-f-]{36}$/i.test(serverInfo.serverId || "") ||
      !/^[0-9a-f-]{36}$/i.test(serverInfo.workspaceId || "")) {
      throw new Error("La identidad, versión o canal seguro de la API no coincide con lo esperado.");
    }
    const { credential, identity } = await ensureDataApiCredential(origin, serverInfo);
    importStatusElement.textContent = "Enviando la instantánea validada al staging cifrado...";
    const preview = await loadOrStageImport(origin, credential, archive);
    pendingImport = {
      origin,
      credential,
      identity,
      archive,
      fileName: file.name,
      ...preview
    };
    renderImportPreview(pendingImport);
    importStatusElement.textContent = preview.status === "committed"
      ? "Esta instantánea ya se había importado; no se aplicaron cambios nuevos."
      : "Vista previa lista. Revisá el destino y los conflictos antes de confirmar.";
  } catch (error) {
    importStatusElement.textContent = `No se pudo preparar la importación: ${error.message}`;
  } finally {
    importPassphraseInput.value = "";
    previewImportButton.disabled = false;
  }
});

commitImportButton.addEventListener("click", async () => {
  if (!pendingImport || pendingImport.status !== "validated") return;
  if (!sharedDecisionSelect.value) {
    importStatusElement.textContent = "Elegí explícitamente cómo tratar los datos compartidos.";
    return;
  }
  const decision = sharedDecisionSelect.value;
  const confirmed = window.confirm(
    `Se importarán ${pendingImport.archive.keyCount} claves y ${pendingImport.archive.movementCount} movimientos en el perfil mostrado. Esta acción no se puede borrar desde esta pantalla. ¿Confirmás continuar?`
  );
  if (!confirmed) return;

  commitImportButton.disabled = true;
  previewImportButton.disabled = true;
  importStatusElement.textContent = "Confirmando la importación transaccional en PostgreSQL...";
  try {
    const result = await requestDataApi(
      pendingImport.origin,
      `/v1/migrations/${pendingImport.archive.exportId}/commit`,
      {
        method: "POST",
        credential: pendingImport.credential,
        body: { confirm: true, sharedDataDecision: decision }
      }
    );
    pendingImport.status = result.status;
    pendingImport.commitReport = result.report;
    renderImportPreview(pendingImport);
    importStatusElement.textContent = "Importación confirmada. Este perfil ya lee y escribe su estado en PostgreSQL. Conservá el respaldo original y recargá WhatsApp Web.";
  } catch (error) {
    importStatusElement.textContent = `No se pudo confirmar la importación: ${error.message}. Si se perdió la respuesta, volvé a validar el mismo archivo para consultar su estado antes de reintentar.`;
    commitImportButton.disabled = false;
  } finally {
    previewImportButton.disabled = false;
  }
});

discardImportButton.addEventListener("click", async () => {
  if (!pendingImport || pendingImport.status !== "validated") return;
  const confirmed = window.confirm(
    "Se eliminará el staging no confirmado de esta importación. No se borrarán los datos de origen ni otras migraciones. ¿Descartar?"
  );
  if (!confirmed) return;
  discardImportButton.disabled = true;
  commitImportButton.disabled = true;
  importStatusElement.textContent = "Eliminando staging no confirmado...";
  try {
    await requestDataApi(
      pendingImport.origin,
      `/v1/migrations/${pendingImport.archive.exportId}`,
      { method: "DELETE", credential: pendingImport.credential }
    );
    pendingImport = null;
    importPreviewElement.hidden = true;
    sharedDecisionLabel.hidden = true;
    sharedDecisionSelect.hidden = true;
    commitImportButton.hidden = true;
    discardImportButton.hidden = true;
    importStatusElement.textContent = "Staging descartado. No se modificaron los datos importados ni el perfil de origen.";
  } catch (error) {
    importStatusElement.textContent = `No se pudo descartar el staging: ${error.message}`;
    discardImportButton.disabled = false;
    commitImportButton.disabled = false;
  }
});

backupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backupForm.reportValidity()) return;

  const passphrase = backupPassphraseInput.value;
  const confirmation = backupPassphraseConfirmInput.value;
  backupPassphraseInput.value = "";
  backupPassphraseConfirmInput.value = "";
  if (passphrase.length < BACKUP_MIN_PASSPHRASE_LENGTH) {
    backupStatus.textContent = "La frase de contraseña debe tener al menos 16 caracteres.";
    return;
  }
  if (passphrase !== confirmation) {
    backupStatus.textContent = "Las frases de contraseña no coinciden.";
    return;
  }
  if (typeof crypto === "undefined" || !crypto.subtle || typeof crypto.randomUUID !== "function") {
    backupStatus.textContent = "Este navegador no dispone de las funciones criptográficas necesarias para exportar.";
    return;
  }
  if (passphrase.length > 1024) {
    backupStatus.textContent = "La frase de contraseña supera el máximo de 1024 caracteres.";
    return;
  }

  const backupLabel = backupLabelInput.value;
  backupButton.disabled = true;
  backupStatus.textContent = "Preparando y cifrando el respaldo. No cierres esta página.";
  let blobUrl;
  try {
    const backup = await createEncryptedProfileBackup(passphrase);
    const sizeMiB = (backup.byteLength / (1024 * 1024)).toFixed(2);
    const confirmed = window.confirm(
      `El archivo incluirá ${backup.keyCount} claves de este perfil y ${backup.movementCount} movimientos, además de datos sensibles cifrados. ¿Continuar con la descarga?`
    );
    if (!confirmed) {
      backupStatus.textContent = "Exportación cancelada. No se modificaron los datos del perfil.";
      return;
    }

    blobUrl = URL.createObjectURL(backup.blob);
    const downloadLink = document.createElement("a");
    downloadLink.href = blobUrl;
    downloadLink.download = makeBackupFilename(backupLabel);
    downloadLink.hidden = true;
    document.body.append(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    backupStatus.textContent = `Descarga iniciada: ${backup.keyCount} claves, ${backup.movementCount} movimientos, ${sizeMiB} MiB. Verificá que el archivo se haya guardado.`;
  } catch (error) {
    backupStatus.textContent = `No se pudo generar el respaldo: ${error.message}`;
  } finally {
    backupPassphraseInput.value = "";
    backupPassphraseConfirmInput.value = "";
    backupButton.disabled = false;
    if (blobUrl) window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
});

function normalizeRemoteOrigin(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("La dirección remota no es válida.");
  }
  if (url.protocol !== "http:" || url.port !== "32146" || url.pathname !== "/" ||
    url.search || url.hash || url.username || url.password) {
    throw new Error("Usá una dirección http:// de la PC destino, puerto 32146 y sin rutas adicionales.");
  }

  const host = url.hostname.toLowerCase();
  const ipv4Parts = host.split(".");
  const isIPv4 = ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const isPrivateIPv4 = isIPv4 && (
    Number(ipv4Parts[0]) === 10 ||
    Number(ipv4Parts[0]) === 172 && Number(ipv4Parts[1]) >= 16 && Number(ipv4Parts[1]) <= 31 ||
    Number(ipv4Parts[0]) === 192 && Number(ipv4Parts[1]) === 168 ||
    Number(ipv4Parts[0]) === 100 && Number(ipv4Parts[1]) >= 64 && Number(ipv4Parts[1]) <= 127 ||
    Number(ipv4Parts[0]) === 169 && Number(ipv4Parts[1]) === 254 ||
    Number(ipv4Parts[0]) === 127
  );
  const ipv6Host = host.startsWith("[") ? host.slice(1, -1) : "";
  const isPrivateIPv6 = ipv6Host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ipv6Host) ||
    /^fe[89ab][0-9a-f]:/i.test(ipv6Host);
  const isPrivateHostname = /^[a-z0-9.-]+$/.test(host) &&
    /\.(local|lan|internal)$/.test(host);
  if (!isPrivateIPv4 && !isPrivateIPv6 && !isPrivateHostname) {
    throw new Error("La dirección debe ser una IP o un nombre de host de red privada.");
  }
  return url.origin;
}

function getRemotePermissionPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

function readRemoteDestinations() {
  const destinations = [];
  const usedNames = new Set();
  const usedOrigins = new Set();
  for (const fields of remoteDestinationFields) {
    const name = fields.name.value.trim();
    const urlValue = fields.url.value.trim();
    const token = fields.token.value.trim();
    const ganamosSuffix = fields.ganamosSuffix.value.trim().toLowerCase();
    const multiPanelSuffix = fields.multiPanelSuffix.value.trim().toLowerCase();
    if (!name && !urlValue && !token) continue;
    if (!name || !urlValue || !token) {
      throw new Error(`Completá nombre, dirección y código del destino ${fields.id.slice(-1)}.`);
    }
    if (name.length > 40) throw new Error("El nombre visible de cada PC admite hasta 40 caracteres.");
    const normalizedName = name.toLocaleLowerCase();
    if (usedNames.has(normalizedName)) throw new Error("Los nombres visibles de los destinos deben ser distintos.");
    usedNames.add(normalizedName);
    const origin = normalizeRemoteOrigin(urlValue);
    if (usedOrigins.has(origin)) throw new Error("Cada destino debe usar una dirección distinta.");
    usedOrigins.add(origin);
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      throw new Error(`El código remoto de ${name} no tiene el formato esperado.`);
    }
    if (!/^[a-z]$/.test(ganamosSuffix) || !/^[a-z]$/.test(multiPanelSuffix) ||
      ganamosSuffix === multiPanelSuffix) {
      throw new Error(`Configurá dos sufijos distintos de una sola letra para ${name}.`);
    }
    destinations.push({
      id: fields.id,
      name,
      url: origin,
      token,
      ganamosSuffix,
      multiPanelSuffix
    });
  }
  return destinations;
}

function populateRemoteDestinations(destinations) {
  for (const fields of remoteDestinationFields) {
    const destination = destinations.find((item) => item.id === fields.id);
    fields.name.value = destination?.name || "";
    fields.url.value = destination?.url || "";
    fields.token.value = destination?.token || "";
    fields.ganamosSuffix.value = destination?.ganamosSuffix || "";
    fields.multiPanelSuffix.value = destination?.multiPanelSuffix || "";
  }
}

function updateHint() {
  if (roleInput.value === "primary") {
    hint.textContent = "Pegá primaryToken del archivo local credentials.json. El puente debe estar ejecutándose en esta computadora.";
    tokenInput.autocomplete = "off";
  } else if (roleInput.value === "secondary") {
    hint.textContent = "Pegá clientToken del mismo archivo credentials.json usado por el perfil principal.";
    tokenInput.autocomplete = "off";
  } else {
    hint.textContent = "El modo independiente no necesita código.";
    tokenInput.value = "";
  }
  tokenInput.disabled = roleInput.value === "standalone";
  tokenInput.required = roleInput.value !== "standalone";
}

roleInput.addEventListener("change", updateHint);
document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const role = roleInput.value;
  const ganamosUserId = ganamosUserIdInput.value.trim();
  const token = tokenInput.value.trim();
  const ganamosSuffix = ganamosSuffixInput.value.trim().toLowerCase();
  const multiPanelSuffix = multiPanelSuffixInput.value.trim().toLowerCase();
  if (!["standalone", "primary", "secondary"].includes(role)) {
    status.textContent = "Elegí un modo válido.";
    return;
  }
  if (!/^\d+$/.test(ganamosUserId)) {
    status.textContent = "Ingresá un ID de agente Ganamos válido, usando solo números.";
    return;
  }
  if (!/^[a-z]$/.test(ganamosSuffix) || !/^[a-z]$/.test(multiPanelSuffix) ||
    ganamosSuffix === multiPanelSuffix) {
    status.textContent = "Ingresá una sola letra para cada plataforma y asegurate de que sean distintas.";
    return;
  }
  let remoteDestinations;
  try {
    remoteDestinations = readRemoteDestinations();
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  if (role !== "standalone" && !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    status.textContent = "El código no tiene el formato esperado. Copialo de credentials.json.";
    return;
  }

  try {
    const origins = remoteDestinations.map(({ url }) => getRemotePermissionPattern(url));
    if (origins.length && !await chrome.permissions.request({ origins })) {
      status.textContent = "No se concedió permiso de conexión a uno o más destinos.";
      return;
    }
    const previous = await stateStorage.get("remoteCreateDestinations");
    const previousOrigins = (Array.isArray(previous.remoteCreateDestinations)
      ? previous.remoteCreateDestinations
      : [])
      .filter((destination) => typeof destination?.url === "string")
      .map((destination) => getRemotePermissionPattern(destination.url));
    await stateStorage.set({
      bridgeRole: role,
      bridgeToken: role === "standalone" ? "" : token,
      ganamosUserId,
      ganamosSuffix,
      multiPanelSuffix,
      userCreationPassword: userCreationPasswordInput.value,
      remoteCreateDestinations: remoteDestinations
    });
    const removedOrigins = previousOrigins.filter((origin) => !origins.includes(origin));
    if (removedOrigins.length) await chrome.permissions.remove({ origins: removedOrigins });
    status.textContent = "Configuración guardada. Recargá WhatsApp Web para aplicar los cambios.";
  } catch (error) {
    status.textContent = `No se pudo guardar la configuración: ${error.message}`;
  }
});

stateStorage.get([
  "bridgeRole",
  "bridgeToken",
  "ganamosUserId",
  "ganamosSuffix",
  "multiPanelSuffix",
  "userCreationPassword",
  "remoteCreateDestinations"
])
  .then(({ bridgeRole, bridgeToken, ganamosUserId, ganamosSuffix, multiPanelSuffix, userCreationPassword, remoteCreateDestinations }) => {
    roleInput.value = ["primary", "secondary"].includes(bridgeRole) ? bridgeRole : "standalone";
    ganamosUserIdInput.value = /^\d+$/.test(String(ganamosUserId ?? ""))
      ? String(ganamosUserId)
      : "38175478";
    tokenInput.value = typeof bridgeToken === "string" ? bridgeToken : "";
    ganamosSuffixInput.value = typeof ganamosSuffix === "string" ? ganamosSuffix : "f";
    multiPanelSuffixInput.value = typeof multiPanelSuffix === "string" ? multiPanelSuffix : "y";
    userCreationPasswordInput.value = typeof userCreationPassword === "string" ? userCreationPassword : "";
    populateRemoteDestinations(Array.isArray(remoteCreateDestinations) ? remoteCreateDestinations : []);
    updateHint();
  })
  .catch((error) => {
    status.textContent = `No se pudo cargar la configuración: ${error.message}`;
  });
