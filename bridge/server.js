const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const HOST = "127.0.0.1";
const PORT = 32145;
const REMOTE_CREATE_HOST = "0.0.0.0";
const REMOTE_CREATE_PORT = 32146;
const REQUEST_TIMEOUT_MS = 90_000;
const POLL_TIMEOUT_MS = 20_000;
const REMOTE_REQUEST_MAX_AGE_MS = 5 * 60_000;
const STATUS_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const STATUS_REQUEST_MAX_BYTES = Math.ceil(STATUS_IMAGE_MAX_BYTES / 3) * 4 + 64 * 1024;
const STATUS_JOB_TIMEOUT_MS = 10 * 60_000;
const ALLOWED_REQUEST_TYPES = new Set([
  "AGENT_BALANCE_REQUEST",
  "MULTIPANEL_AGENT_BALANCE_REQUEST",
  "USER_SEARCH_REQUEST",
  "SPORT_BETS_REQUEST",
  "BALANCE_REQUEST",
  "TRANSACTION_REQUEST",
  "EXCHANGE_REQUEST",
  "WITHDRAWAL_HISTORY_REQUEST",
  "CREATE_USER_REQUEST",
  "PASSWORD_RESET_REQUEST"
]);
const DATA_DIRECTORY = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  "GanamosWhatsAppBridge"
);
const CREDENTIALS_PATH = path.join(DATA_DIRECTORY, "credentials.json");

let credentials;
let primaryLastSeen = 0;
let remoteCreateActive = false;
let activeBonusConfig = null;
let activeBonusConfigPublished = false;
let excludedBonusProfileIds = [];
let activeBonusRevision = 0;
let platformOutageConfig = { ganamos: false, multipanel: false };
let platformOutageRevision = 1;
let hiddenAdvertisingProfiles = [];
let hiddenAdvertisingProfilesRevision = 0;
const queuedRequests = [];
const waitingPolls = [];
const waitingBonusConfigPolls = [];
const waitingPlatformOutagePolls = [];
const waitingHiddenAdvertisingProfilesPolls = [];
const waitingStatusUpdatePolls = [];
const pendingRequests = new Map();
const remoteNonces = new Map();
const statusUpdateJobs = new Map();
const lastSeenStatusProfiles = new Map();
const statusProfileNames = new Map();
const statusProfileRevisions = new Map();
let statusUpdateRevision = 0;
let latestStatusUpdate = null;

function isLoopback(remoteAddress) {
  return remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
}

function isPrivateNetworkAddress(remoteAddress) {
  const address = String(remoteAddress || "").replace(/^::ffff:/i, "");
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10 ||
      octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
      octets[0] === 192 && octets[1] === 168 ||
      octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 ||
      octets[0] === 169 && octets[1] === 254 ||
      octets[0] === 127;
  }
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1" || /^f[cd][0-9a-f]{2}:/i.test(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized);
}

function constantTimeEquals(actual, expected) {
  const actualBuffer = Buffer.from(actual || "");
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function signatureEquals(actual, expected) {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  return constantTimeEquals(Buffer.from(actual, "hex"), expected);
}

function tokenRole(request) {
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  if (constantTimeEquals(token, credentials.primaryToken)) return "primary";
  if (constantTimeEquals(token, credentials.clientToken)) return "client";
  return null;
}

function sendJson(response, status, body, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function sendSignedRemoteJson(response, body, origin, timestamp, nonce) {
  const rawBody = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", credentials.remoteCreateToken)
    .update(`${timestamp}\n${nonce}\n${rawBody}`)
    .digest("hex");
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-bridge-response-signature": signature
  };
  if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-expose-headers"] = "X-Bridge-Response-Signature";
    headers.vary = "Origin";
  }
  response.writeHead(200, headers);
  response.end(rawBody);
}

function readRawBody(request, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("La solicitud excede el tamaño permitido."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function readJson(request, maxBytes) {
  const body = await readRawBody(request, maxBytes);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("El cuerpo de la solicitud no es JSON válido.");
  }
}

function deliverTask(task) {
  const poll = waitingPolls.shift();
  if (poll) {
    clearTimeout(poll.timer);
    poll.finish(task);
  } else {
    queuedRequests.push(task);
  }
}

function waitForTask(response, origin) {
  const queued = queuedRequests.shift();
  if (queued) {
    sendJson(response, 200, { ok: true, task: queued }, origin);
    return;
  }

  const poll = {
    finish: (task) => sendJson(response, 200, { ok: true, task }, origin),
    timer: setTimeout(() => {
      const index = waitingPolls.indexOf(poll);
      if (index !== -1) waitingPolls.splice(index, 1);
      sendJson(response, 200, { ok: true, task: null }, origin);
    }, POLL_TIMEOUT_MS)
  };
  waitingPolls.push(poll);
  response.on("close", () => {
    clearTimeout(poll.timer);
    const index = waitingPolls.indexOf(poll);
    if (index !== -1) waitingPolls.splice(index, 1);
  });
}

function validateActiveBonusConfig(config) {
  if (config === null) return true;
  if (!config || typeof config !== "object" || typeof config.enabled !== "boolean") return false;
  if (config.copyBonus !== undefined && typeof config.copyBonus !== "boolean") return false;
  if (config.invertDepositButtons !== undefined &&
    typeof config.invertDepositButtons !== "boolean") return false;
  if (config.activeAdvertising !== undefined &&
    typeof config.activeAdvertising !== "boolean") return false;
  if (config.markUnreadAfterStatusUpdate !== undefined &&
    typeof config.markUnreadAfterStatusUpdate !== "boolean") return false;
  const isPercent = (value) => typeof value === "number" &&
    Number.isFinite(value) && value >= 0 && value <= 100;
  if (config.advertisingPercent !== undefined &&
    config.advertisingPercent !== null && !isPercent(config.advertisingPercent)) return false;
  if (config.type === "none") return !config.enabled;
  const isConfiguredPercent = (value) => config.enabled
    ? isPercent(value)
    : value === null || value === undefined || isPercent(value);
  if (config.type === "simple") return isConfiguredPercent(config.percent);
  if (config.type === "double") {
    return isConfiguredPercent(config.ganamos) && isConfiguredPercent(config.multipanel);
  }
  if (config.type === "specific") {
    return ["ganamos", "multipanel"].includes(config.platform) &&
      isConfiguredPercent(config.percent);
  }
  if (config.type === "special") {
    return isConfiguredPercent(config.underThreshold) &&
      isConfiguredPercent(config.overThreshold);
  }
  if (config.type !== "mysterious") return false;
  if (config.outcomes === undefined) return true;
  if (!Array.isArray(config.outcomes) || !config.outcomes.length) return false;
  const percentages = new Set();
  let totalWeight = 0;
  for (const outcome of config.outcomes) {
    if (!isPercent(outcome?.percent) || !Number.isSafeInteger(outcome.weight) ||
      outcome.weight < 0 || percentages.has(outcome.percent)) return false;
    percentages.add(outcome.percent);
    totalWeight += outcome.weight;
    if (!Number.isSafeInteger(totalWeight)) return false;
  }
  return totalWeight > 0;
}

function validateProfileIds(profileIds) {
  return Array.isArray(profileIds) &&
    profileIds.length <= 1000 &&
    profileIds.every((profileId) =>
      typeof profileId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(profileId)) &&
    new Set(profileIds).size === profileIds.length;
}

function isValidBase64(value) {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  if (padding === 2 && contentLength % 4 !== 2 ||
    padding === 1 && contentLength % 4 !== 3) return false;

  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!(code >= 65 && code <= 90) && !(code >= 97 && code <= 122) &&
      !(code >= 48 && code <= 57) && code !== 43 && code !== 47) return false;
  }
  return true;
}

function validatePlatformOutageConfig(config) {
  return config !== null && typeof config === "object" && !Array.isArray(config) &&
    typeof config.ganamos === "boolean" &&
    typeof config.multipanel === "boolean" &&
    Object.keys(config).every((key) => ["ganamos", "multipanel"].includes(key));
}

function getConnectedStatusProfileIds() {
  const now = Date.now();
  for (const [profileId, seenAt] of lastSeenStatusProfiles) {
    if (now - seenAt > 45_000) {
      lastSeenStatusProfiles.delete(profileId);
      statusProfileNames.delete(profileId);
    }
  }
  return [...lastSeenStatusProfiles.keys()].map((profileId) => ({
    profileId,
    name: statusProfileNames.get(profileId) || `Perfil ${profileId.slice(0, 8)}`
  }));
}

function recordStatusProfile(profileId, profileName) {
  lastSeenStatusProfiles.set(profileId, Date.now());
  if (typeof profileName === "string" && profileName.trim() &&
    profileName.length <= 120) {
    statusProfileNames.set(profileId, profileName.trim());
  }
}

function getActiveBonusConfigUpdate(profileId) {
  if (profileId && excludedBonusProfileIds.includes(profileId)) {
    return { ok: true, changed: false, revision: activeBonusRevision };
  }
  if (!activeBonusConfigPublished) {
    return { ok: true, changed: false, revision: activeBonusRevision };
  }
  return { ok: true, changed: true, revision: activeBonusRevision, config: activeBonusConfig };
}

function getPlatformOutageConfigUpdate() {
  return {
    ok: true,
    changed: true,
    revision: platformOutageRevision,
    config: platformOutageConfig
  };
}

function waitForPlatformOutageConfig(response, origin, revision) {
  if (revision !== platformOutageRevision) {
    sendJson(response, 200, getPlatformOutageConfigUpdate(), origin);
    return;
  }
  const poll = {
    finish: () => sendJson(response, 200, getPlatformOutageConfigUpdate(), origin),
    timer: setTimeout(() => {
      const index = waitingPlatformOutagePolls.indexOf(poll);
      if (index !== -1) waitingPlatformOutagePolls.splice(index, 1);
      sendJson(response, 200, {
        ok: true,
        changed: false,
        revision: platformOutageRevision
      }, origin);
    }, POLL_TIMEOUT_MS)
  };
  waitingPlatformOutagePolls.push(poll);
  response.on("close", () => {
    clearTimeout(poll.timer);
    const index = waitingPlatformOutagePolls.indexOf(poll);
    if (index !== -1) waitingPlatformOutagePolls.splice(index, 1);
  });
}

function waitForActiveBonusConfig(response, origin, revision, profileId) {
  if (profileId && excludedBonusProfileIds.includes(profileId)) {
    sendJson(response, 200, getActiveBonusConfigUpdate(profileId), origin);
    return;
  }
  if (revision !== activeBonusRevision) {
    sendJson(response, 200, getActiveBonusConfigUpdate(profileId), origin);
    return;
  }
  const poll = {
    profileId,
    finish: () => sendJson(response, 200, getActiveBonusConfigUpdate(profileId), origin),
    timer: setTimeout(() => {
      const index = waitingBonusConfigPolls.indexOf(poll);
      if (index !== -1) waitingBonusConfigPolls.splice(index, 1);
      sendJson(response, 200, {
        ok: true,
        changed: false,
        revision: activeBonusRevision
      }, origin);
    }, POLL_TIMEOUT_MS)
  };
  waitingBonusConfigPolls.push(poll);
  response.on("close", () => {
    clearTimeout(poll.timer);
    const index = waitingBonusConfigPolls.indexOf(poll);
    if (index !== -1) waitingBonusConfigPolls.splice(index, 1);
  });
}

function getHiddenAdvertisingProfilesUpdate() {
  return {
    ok: true,
    changed: true,
    revision: hiddenAdvertisingProfilesRevision,
    profileIds: hiddenAdvertisingProfiles
  };
}

function waitForHiddenAdvertisingProfiles(response, origin, revision) {
  if (revision !== hiddenAdvertisingProfilesRevision) {
    sendJson(response, 200, getHiddenAdvertisingProfilesUpdate(), origin);
    return;
  }

  const poll = {
    finish: () => sendJson(response, 200, getHiddenAdvertisingProfilesUpdate(), origin),
    timer: setTimeout(() => {
      const index = waitingHiddenAdvertisingProfilesPolls.indexOf(poll);
      if (index !== -1) waitingHiddenAdvertisingProfilesPolls.splice(index, 1);
      sendJson(response, 200, {
        ok: true,
        changed: false,
        revision: hiddenAdvertisingProfilesRevision
      }, origin);
    }, POLL_TIMEOUT_MS)
  };
  waitingHiddenAdvertisingProfilesPolls.push(poll);
  response.on("close", () => {
    clearTimeout(poll.timer);
    const index = waitingHiddenAdvertisingProfilesPolls.indexOf(poll);
    if (index !== -1) waitingHiddenAdvertisingProfilesPolls.splice(index, 1);
  });
}

function getStatusUpdateResult(job) {
  return {
    ok: true,
    id: job.id,
    results: [...job.results.values()],
    pending: job.targets.filter((profileId) => !job.results.has(profileId)),
    complete: job.targets.every((profileId) => job.results.has(profileId))
  };
}

function waitForStatusUpdate(response, origin, revision, profileId) {
  lastSeenStatusProfiles.set(profileId, Date.now());
  const knownRevision = statusProfileRevisions.get(profileId);
  const profileRevision = Math.max(
    Number.isSafeInteger(knownRevision) ? knownRevision : statusUpdateRevision,
    revision
  );
  statusProfileRevisions.set(profileId, profileRevision);
  const latestJob = latestStatusUpdate
    ? statusUpdateJobs.get(latestStatusUpdate.id)
    : null;
  if (latestStatusUpdate && latestJob?.targets.includes(profileId) &&
    profileRevision < latestStatusUpdate.revision) {
    statusProfileRevisions.set(profileId, latestStatusUpdate.revision);
    sendJson(response, 200, latestStatusUpdate, origin);
    return;
  }
  statusProfileRevisions.set(profileId, statusUpdateRevision);
  const poll = {
    profileId,
    finish: (update) => sendJson(response, 200, update, origin),
    timer: setTimeout(() => {
      const index = waitingStatusUpdatePolls.indexOf(poll);
      if (index !== -1) waitingStatusUpdatePolls.splice(index, 1);
      poll.finish({ ok: true, changed: false, revision: statusUpdateRevision });
    }, POLL_TIMEOUT_MS)
  };
  waitingStatusUpdatePolls.push(poll);
  response.on("close", () => {
    clearTimeout(poll.timer);
    const index = waitingStatusUpdatePolls.indexOf(poll);
    if (index !== -1) waitingStatusUpdatePolls.splice(index, 1);
  });
}

async function handleRequest(request, response) {
  const origin = request.headers.origin || "";
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 403, { ok: false, error: "Solo se permiten conexiones locales." });
    return;
  }

  if (request.method === "OPTIONS") {
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      sendJson(response, 403, { ok: false, error: "Origen de extensión no autorizado." });
      return;
    }
    response.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-max-age": "600",
      vary: "Origin"
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const role = tokenRole(request);
  if (url.pathname === "/health" && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      service: "running",
      remoteCreate: remoteCreateActive
    }, origin);
    return;
  }

  if (!role) {
    sendJson(response, 401, { ok: false, error: "Código de emparejamiento inválido." }, origin);
    return;
  }

  if (url.pathname === "/v1/status" && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      primaryOnline: Date.now() - primaryLastSeen < 45_000
    }, origin);
    return;
  }

  if (url.pathname === "/v1/status-profiles" && request.method === "GET") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede consultar los perfiles conectados." }, origin);
      return;
    }
    sendJson(response, 200, {
      ok: true,
      profiles: getConnectedStatusProfileIds()
    }, origin);
    return;
  }

  if (url.pathname === "/v1/status-update" && request.method === "GET") {
    if (role !== "client") {
      sendJson(response, 403, { ok: false, error: "Solo los perfiles secundarios pueden recibir la imagen." }, origin);
      return;
    }
    const revision = Number(url.searchParams.get("revision") || 0);
    const profileId = url.searchParams.get("profileId") || "";
    const profileName = url.searchParams.get("profileName") || "";
    if (!Number.isSafeInteger(revision) || revision < 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId) ||
      !profileName.trim() || profileName.length > 120) {
      sendJson(response, 400, { ok: false, error: "Perfil o versión de actualización no válidos." }, origin);
      return;
    }
    recordStatusProfile(profileId, profileName);
    waitForStatusUpdate(response, origin, revision, profileId);
    return;
  }

  if (url.pathname === "/v1/status-update" && request.method === "POST") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede iniciar un cambio de estado." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(request, STATUS_REQUEST_MAX_BYTES);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    const action = body?.action ?? "replace";
    const needsImage = action !== "delete";
    if (typeof body?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id) ||
      !["delete", "upload", "replace"].includes(action) ||
      needsImage && (typeof body.image !== "string" || !isValidBase64(body.image)) ||
      !needsImage && body.image !== undefined ||
      (Object.hasOwn(body || {}, "excludedProfileIds") &&
        !validateProfileIds(body.excludedProfileIds)) ||
      statusUpdateJobs.has(body.id)) {
      sendJson(response, 400, { ok: false, error: "La solicitud de cambio de estado no es válida." }, origin);
      return;
    }
    if (needsImage) {
      const image = Buffer.from(body.image, "base64");
      const isPng = image.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
      const isJpeg = image.length >= 3 &&
        image[0] === 255 && image[1] === 216 && image[2] === 255;
      if (!image.length || image.length > STATUS_IMAGE_MAX_BYTES ||
        image.toString("base64") !== body.image ||
        !isPng && !isJpeg) {
        sendJson(response, 400, { ok: false, error: "La imagen debe ser un archivo PNG o JPEG válido de hasta 10 MB." }, origin);
        return;
      }
    }
    const now = Date.now();
    for (const [jobId, existingJob] of statusUpdateJobs) {
      if (now >= existingJob.expiresAt) {
        statusUpdateJobs.delete(jobId);
        if (latestStatusUpdate?.id === jobId) latestStatusUpdate = null;
      }
    }
    const excludedProfileIds = body.excludedProfileIds || [];
    const targets = getConnectedStatusProfileIds()
      .map(({ profileId }) => profileId)
      .filter((profileId) => !excludedProfileIds.includes(profileId));
    const job = {
      id: body.id,
      targets,
      results: new Map(),
      expiresAt: now + STATUS_JOB_TIMEOUT_MS
    };
    statusUpdateJobs.set(body.id, job);
    latestStatusUpdate = {
      ok: true,
      changed: true,
      revision: ++statusUpdateRevision,
      id: body.id,
      action,
      ...(needsImage ? { image: body.image } : {})
    };
    const deliveredProfiles = new Set();
    for (const poll of waitingStatusUpdatePolls.splice(0)) {
      clearTimeout(poll.timer);
      if (!job.targets.includes(poll.profileId)) {
        poll.finish({ ok: true, changed: false, revision: statusUpdateRevision });
        continue;
      }
      if (deliveredProfiles.has(poll.profileId)) {
        poll.finish({ ok: true, changed: false, revision: statusUpdateRevision });
      } else {
        deliveredProfiles.add(poll.profileId);
        poll.finish(latestStatusUpdate);
      }
    }
    sendJson(response, 200, { ok: true, id: body.id, action, targets }, origin);
    return;
  }

  if (url.pathname === "/v1/status-update-result" && request.method === "GET") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede consultar los resultados." }, origin);
      return;
    }
    const job = statusUpdateJobs.get(url.searchParams.get("id"));
    if (!job) {
      sendJson(response, 404, { ok: false, error: "No se encontró el proceso de cambio de estado." }, origin);
      return;
    }
    if (Date.now() >= job.expiresAt) {
      for (const profileId of job.targets) {
        if (!job.results.has(profileId)) {
          job.results.set(profileId, {
            profileId,
            ok: false,
            error: "El perfil secundario no respondió a tiempo."
          });
        }
      }
    }
    sendJson(response, 200, getStatusUpdateResult(job), origin);
    if (job.results.size === job.targets.length) {
      statusUpdateJobs.delete(job.id);
      if (latestStatusUpdate?.id === job.id) latestStatusUpdate = null;
    }
    return;
  }

  if (url.pathname === "/v1/status-update-result" && request.method === "POST") {
    if (role !== "client") {
      sendJson(response, 403, { ok: false, error: "Solo los perfiles secundarios pueden informar el resultado." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    const job = statusUpdateJobs.get(body?.id);
    if (!job || !job.targets.includes(body?.profileId) ||
      typeof body.ok !== "boolean" ||
      (body.error !== undefined && (typeof body.error !== "string" || body.error.length > 300))) {
      sendJson(response, 400, { ok: false, error: "El resultado del perfil no es válido." }, origin);
      return;
    }
    job.results.set(body.profileId, {
      profileId: body.profileId,
      ok: body.ok,
      ...(body.error ? { error: body.error } : {})
    });
    sendJson(response, 200, { ok: true }, origin);
    return;
  }

  if (url.pathname === "/v1/bonus-config" && request.method === "GET") {
    if (role !== "client") {
      sendJson(response, 403, { ok: false, error: "Solo los perfiles secundarios pueden recibir la configuración." }, origin);
      return;
    }
    const revision = Number(url.searchParams.get("revision") || 0);
    const profileId = url.searchParams.get("profileId");
    if (!Number.isSafeInteger(revision) || revision < 0 ||
      profileId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(profileId)) {
      sendJson(response, 400, { ok: false, error: "Versión de configuración no válida." }, origin);
      return;
    }
    const profileName = url.searchParams.get("profileName");
    if (profileId && profileName && profileName.trim() && profileName.length <= 120) {
      recordStatusProfile(profileId, profileName);
    }
    waitForActiveBonusConfig(response, origin, revision, profileId);
    return;
  }

  if (url.pathname === "/v1/bonus-config" && request.method === "POST") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede publicar la configuración." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    if (!Object.hasOwn(body || {}, "config") || !validateActiveBonusConfig(body.config) ||
      (Object.hasOwn(body || {}, "excludedProfileIds") &&
        !validateProfileIds(body.excludedProfileIds))) {
      sendJson(response, 400, { ok: false, error: "Configuración de bono activo no válida." }, origin);
      return;
    }
    const serializedConfig = JSON.stringify(body.config);
    const serializedExcludedProfileIds = JSON.stringify(body.excludedProfileIds || []);
    if (!activeBonusConfigPublished ||
      serializedConfig !== JSON.stringify(activeBonusConfig) ||
      serializedExcludedProfileIds !== JSON.stringify(excludedBonusProfileIds)) {
      activeBonusConfig = body.config === null ? null : JSON.parse(serializedConfig);
      activeBonusConfigPublished = true;
      excludedBonusProfileIds = JSON.parse(serializedExcludedProfileIds);
      activeBonusRevision += 1;
      for (const poll of waitingBonusConfigPolls.splice(0)) {
        clearTimeout(poll.timer);
        poll.finish();
      }
    }
    sendJson(response, 200, { ok: true, revision: activeBonusRevision }, origin);
    return;
  }

  if (url.pathname === "/v1/platform-outages" && request.method === "GET") {
    if (role !== "client") {
      sendJson(response, 403, { ok: false, error: "Solo los perfiles secundarios pueden recibir la configuración." }, origin);
      return;
    }
    const revision = Number(url.searchParams.get("revision") || 0);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      sendJson(response, 400, { ok: false, error: "Versión de configuración no válida." }, origin);
      return;
    }
    waitForPlatformOutageConfig(response, origin, revision);
    return;
  }

  if (url.pathname === "/v1/platform-outages" && request.method === "POST") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede publicar la configuración." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    if (!Object.hasOwn(body || {}, "config") || !validatePlatformOutageConfig(body.config)) {
      sendJson(response, 400, { ok: false, error: "La configuración de plataformas caídas no es válida." }, origin);
      return;
    }
    const serializedConfig = JSON.stringify(body.config);
    if (serializedConfig !== JSON.stringify(platformOutageConfig)) {
      platformOutageConfig = JSON.parse(serializedConfig);
      platformOutageRevision += 1;
      for (const poll of waitingPlatformOutagePolls.splice(0)) {
        clearTimeout(poll.timer);
        poll.finish();
      }
    }
    sendJson(response, 200, { ok: true, revision: platformOutageRevision }, origin);
    return;
  }

  if (url.pathname === "/v1/advertising-hidden-profiles" && request.method === "GET") {
    if (role !== "client") {
      sendJson(response, 403, { ok: false, error: "Solo los perfiles secundarios pueden recibir esta configuración." }, origin);
      return;
    }
    const revision = Number(url.searchParams.get("revision") || 0);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      sendJson(response, 400, { ok: false, error: "Versión de paneles minimizados no válida." }, origin);
      return;
    }
    waitForHiddenAdvertisingProfiles(response, origin, revision);
    return;
  }

  if (url.pathname === "/v1/advertising-hidden-profiles" && request.method === "POST") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede publicar esta configuración." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    if (!Object.hasOwn(body || {}, "profileIds") ||
      !validateProfileIds(body.profileIds)) {
      sendJson(response, 400, { ok: false, error: "La lista de paneles minimizados no es válida." }, origin);
      return;
    }
    const serializedProfileIds = JSON.stringify(body.profileIds);
    if (serializedProfileIds !== JSON.stringify(hiddenAdvertisingProfiles)) {
      hiddenAdvertisingProfiles = JSON.parse(serializedProfileIds);
      hiddenAdvertisingProfilesRevision += 1;
      for (const poll of waitingHiddenAdvertisingProfilesPolls.splice(0)) {
        clearTimeout(poll.timer);
        poll.finish();
      }
    }
    sendJson(response, 200, { ok: true, revision: hiddenAdvertisingProfilesRevision }, origin);
    return;
  }

  if (url.pathname === "/v1/next" && request.method === "GET") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede recibir solicitudes." }, origin);
      return;
    }
    primaryLastSeen = Date.now();
    waitForTask(response, origin);
    return;
  }

  if (url.pathname === "/v1/request" && request.method === "POST") {
    if (role !== "client") {
      sendJson(response, 403, { ok: false, error: "El perfil principal no debe reenviar solicitudes." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    if (typeof body?.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id) ||
      !ALLOWED_REQUEST_TYPES.has(body.message?.type) || pendingRequests.has(body.id)) {
      sendJson(response, 400, { ok: false, error: "Solicitud de puente inválida." }, origin);
      return;
    }

    if (Date.now() - primaryLastSeen >= 45_000) {
      sendJson(response, 503, { ok: false, error: "El perfil principal no está conectado al puente." }, origin);
      return;
    }

    const task = {
      id: body.id,
      message: body.message,
      expiresAt: Date.now() + REQUEST_TIMEOUT_MS
    };
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(body.id);
        const queuedIndex = queuedRequests.findIndex((queued) => queued.id === body.id);
        if (queuedIndex !== -1) queuedRequests.splice(queuedIndex, 1);
        resolve({
          ok: false,
          error: "Se agotó el tiempo de espera del perfil principal. Verificá el estado antes de repetir la operación."
        });
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(body.id, {
        finish: (value) => {
          clearTimeout(timeout);
          pendingRequests.delete(body.id);
          resolve(value);
        }
      });
      deliverTask(task);
    });
    sendJson(response, 200, result, origin);
    return;
  }

  if (url.pathname === "/v1/complete" && request.method === "POST") {
    if (role !== "primary") {
      sendJson(response, 403, { ok: false, error: "Solo el perfil principal puede completar solicitudes." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    const pending = pendingRequests.get(body?.id);
    if (!pending || !body.result || typeof body.result.ok !== "boolean") {
      sendJson(response, 404, { ok: false, error: "La solicitud ya no está pendiente." }, origin);
      return;
    }
    pending.finish(body.result);
    primaryLastSeen = Date.now();
    sendJson(response, 200, { ok: true }, origin);
    return;
  }

  sendJson(response, 404, { ok: false, error: "Ruta de puente desconocida." }, origin);
}

function validateRemoteMessage(message) {
  if (message?.type === "CREATE_USER_REQUEST") {
    return ["ganamos", "multipanel"].includes(message.data?.platform) &&
      typeof message.data?.username === "string" &&
      /^[a-z0-9]{2,64}$/i.test(message.data.username);
  }
  if (message?.type === "PASSWORD_RESET_REQUEST") {
    return ["ganamos", "multipanel"].includes(message.data?.platform) &&
      typeof message.data?.nombre === "string" &&
      /^[^\u0000-\u001f\u007f/]{2,128}$/.test(message.data.nombre);
  }
  if (message?.type === "USER_SEARCH_REQUEST") {
    return /^\d{4}$/.test(message.data?.digits || "");
  }
  return ["AGENT_BALANCE_REQUEST", "MULTIPANEL_AGENT_BALANCE_REQUEST"]
    .includes(message?.type) && message.data === undefined;
}

async function handleRemoteCreateRequest(request, response) {
  const origin = request.headers.origin || "";
  if (!isPrivateNetworkAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, { ok: false, error: "Solo se permiten solicitudes desde una red privada." });
    return;
  }
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    sendJson(response, 403, { ok: false, error: "Origen de extensión no autorizado." });
    return;
  }
  if (request.method === "OPTIONS") {
    if (!origin) {
      sendJson(response, 403, { ok: false, error: "Origen de extensión no autorizado." });
      return;
    }
    response.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, X-Bridge-Timestamp, X-Bridge-Nonce, X-Bridge-Signature",
      "access-control-max-age": "600",
      vary: "Origin"
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${REMOTE_CREATE_HOST}:${REMOTE_CREATE_PORT}`);
  if (url.pathname !== "/v1/remote-operation" || request.method !== "POST") {
    sendJson(response, 404, { ok: false, error: "Ruta remota desconocida." }, origin);
    return;
  }

  let rawBody;
  let body;
  try {
    rawBody = await readRawBody(request);
    body = JSON.parse(rawBody);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  const timestamp = request.headers["x-bridge-timestamp"];
  const nonce = request.headers["x-bridge-nonce"];
  const suppliedSignature = request.headers["x-bridge-signature"];
  const timestampNumber = Number(timestamp);
  if (typeof credentials.remoteCreateToken !== "string" ||
    typeof timestamp !== "string" ||
    !Number.isSafeInteger(timestampNumber) ||
    Math.abs(Date.now() - timestampNumber) > REMOTE_REQUEST_MAX_AGE_MS ||
    typeof nonce !== "string" || !/^[a-f0-9-]{36}$/i.test(nonce) ||
    typeof suppliedSignature !== "string" ||
    typeof body?.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id) ||
    !validateRemoteMessage(body.message) || pendingRequests.has(body.id)) {
    sendJson(response, 400, { ok: false, error: "Solicitud remota inválida." }, origin);
    return;
  }

  const now = Date.now();
  for (const [usedNonce, expiresAt] of remoteNonces) {
    if (expiresAt <= now) remoteNonces.delete(usedNonce);
  }
  if (remoteNonces.has(nonce)) {
    sendJson(response, 409, { ok: false, error: "La solicitud remota ya fue recibida." }, origin);
    return;
  }
  const expectedSignature = crypto.createHmac("sha256", credentials.remoteCreateToken)
    .update(`${timestamp}\n${nonce}\n${rawBody}`)
    .digest();
  if (!signatureEquals(suppliedSignature, expectedSignature)) {
    sendJson(response, 401, { ok: false, error: "Código de creación remota inválido." }, origin);
    return;
  }
  remoteNonces.set(nonce, timestampNumber + REMOTE_REQUEST_MAX_AGE_MS);

  if (Date.now() - primaryLastSeen >= 45_000) {
    sendJson(response, 503, { ok: false, error: "El perfil principal de esta PC no está conectado al puente." }, origin);
    return;
  }

  let message;
  if (body.message.type === "CREATE_USER_REQUEST") {
    message = {
      type: "CREATE_USER_REQUEST",
      data: {
        platform: body.message.data.platform,
        username: body.message.data.username
      }
    };
  } else if (body.message.type === "PASSWORD_RESET_REQUEST") {
    message = {
      type: "PASSWORD_RESET_REQUEST",
      data: {
        platform: body.message.data.platform,
        nombre: body.message.data.nombre
      }
    };
  } else if (body.message.type === "USER_SEARCH_REQUEST") {
    message = {
      type: "USER_SEARCH_REQUEST",
      data: { digits: body.message.data.digits }
    };
  } else {
    message = { type: body.message.type };
  }
  const task = { id: body.id, expiresAt: Date.now() + REQUEST_TIMEOUT_MS, message };
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(body.id);
      const queuedIndex = queuedRequests.findIndex((queued) => queued.id === body.id);
      if (queuedIndex !== -1) queuedRequests.splice(queuedIndex, 1);
      resolve({
        ok: false,
        error: "Se agotó el tiempo de espera de la PC destino. Verificá el resultado en esa PC antes de volver a intentarlo."
      });
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(body.id, {
      finish: (value) => {
        clearTimeout(timeout);
        pendingRequests.delete(body.id);
        resolve(value);
      }
    });
    deliverTask(task);
  });
  sendSignedRemoteJson(response, result, origin, timestamp, nonce);
}

async function loadCredentials() {
  await fs.mkdir(DATA_DIRECTORY, { recursive: true });
  try {
    credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    credentials = {
      primaryToken: crypto.randomBytes(32).toString("base64url"),
      clientToken: crypto.randomBytes(32).toString("base64url"),
      remoteCreateToken: crypto.randomBytes(32).toString("base64url")
    };
    await fs.writeFile(CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  }
  if (typeof credentials.primaryToken !== "string" || typeof credentials.clientToken !== "string") {
    throw new Error(`El archivo de credenciales local no es válido: ${CREDENTIALS_PATH}`);
  }
  if (credentials.remoteCreateToken === undefined) {
    credentials.remoteCreateToken = crypto.randomBytes(32).toString("base64url");
    await fs.writeFile(CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
  if (typeof credentials.remoteCreateToken !== "string" ||
    !/^[A-Za-z0-9_-]{40,64}$/.test(credentials.remoteCreateToken)) {
    throw new Error(`El código de creación remota local no es válido: ${CREDENTIALS_PATH}`);
  }
}

loadCredentials().then(() => {
  const allowRemoteCreate = process.argv.includes("--allow-remote-creation");
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        const isAuthorizedStatusUpdate =
          request.url?.split("?")[0] === "/v1/status-update" &&
          tokenRole(request) === "primary";
        const errorMessage = isAuthorizedStatusUpdate && error?.message
          ? `Error interno del puente local. Detalle: ${error.message}`
          : "Error interno del puente local.";
        sendJson(response, 500, { ok: false, error: errorMessage }, request.headers.origin);
      } else {
        response.destroy(error);
      }
      console.error("Error del puente:", error.message);
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Puente local activo en http://${HOST}:${PORT}`);
    console.log(`Credenciales locales para configurar los perfiles: ${CREDENTIALS_PATH}`);
    console.log("No compartas este archivo; reiniciar el puente conserva los mismos códigos.");
  });
  server.on("error", (error) => {
    console.error(`No se pudo iniciar el puente local en ${HOST}:${PORT}: ${error.message}`);
    process.exitCode = 1;
  });

  if (allowRemoteCreate) {
    const remoteServer = http.createServer((request, response) => {
      handleRemoteCreateRequest(request, response).catch((error) => {
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "Error interno de creación remota." }, request.headers.origin);
        } else {
          response.destroy(error);
        }
        console.error("Error de creación remota:", error.message);
      });
    });
    remoteServer.listen(REMOTE_CREATE_PORT, REMOTE_CREATE_HOST, () => {
      remoteCreateActive = true;
      console.log(`Creación remota restringida activa en puerto ${REMOTE_CREATE_PORT} (solo redes privadas).`);
    });
    remoteServer.on("error", (error) => {
      remoteCreateActive = false;
      console.error(`No se pudo iniciar la creación remota en ${REMOTE_CREATE_HOST}:${REMOTE_CREATE_PORT}: ${error.message}`);
    });
  }
}).catch((error) => {
  console.error("No se pudieron inicializar las credenciales del puente:", error.message);
  process.exitCode = 1;
});
