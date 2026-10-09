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
  const snapshot = await chrome.storage.local.get(null);
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
    const previous = await chrome.storage.local.get("remoteCreateDestinations");
    const previousOrigins = (Array.isArray(previous.remoteCreateDestinations)
      ? previous.remoteCreateDestinations
      : [])
      .filter((destination) => typeof destination?.url === "string")
      .map((destination) => getRemotePermissionPattern(destination.url));
    await chrome.storage.local.set({
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

chrome.storage.local.get([
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
