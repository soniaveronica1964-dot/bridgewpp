const GANAMOS_API_ORIGIN = "https://agents.ganamos.net";
const MULTIPANEL_API_ORIGIN = "https://wallet.casinoenvivo.club";
const MULTIPANEL_WEB_ORIGIN = "https://bo.casinoenvivo.club";
const DEFAULT_AGENT_USER_ID = "38175478";
const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
const PLATFORM_REQUEST_TIMEOUT_MS = 45_000;
const DATA_HOST_NAME = "com.bridgewpp.data";
const DATA_PROFILE_SELECTOR_KEY = "dataProfileSelector";
const PROFILE_RUNTIME_STATE_KEYS = [
  "bridgeRole",
  "bridgeToken",
  "ganamosUserId",
  "ganamosSuffix",
  "multiPanelSuffix",
  "multiPanelSession"
];
const HIDDEN_ADVERTISING_PROFILES_KEY = "hiddenAdvertisingProfiles";
const STATUS_EXCLUDED_PROFILE_IDS_KEY = "statusExcludedProfileIds";
const SHARED_STATE_KEYS = new Set([
  "contactFlowCounters",
  "contactVisualTags",
  "activeBonusConfig"
]);
const USER_ACCOUNT_SETTING_PREFIX = "userSetting:";
const PLATFORM_OUTAGE_CONFIG_KEY = "platformOutageConfig";
const stateChangedListeners = new Set();
const statusDebuggerSessions = new Map();
const loadedProfileStateKeys = new Set();
let cachedStateRevision = null;
let cachedChangeRevision = null;
let statePollInProgress = null;
let lastStatePollAt = 0;
let extensionStateCache = {};
const withdrawalUserCache = new Map();
let profileRuntimeStatePromise = null;
let dataProfileSelectorPromise = null;
const extensionStateOnChanged = {
  addListener(listener) {
    stateChangedListeners.add(listener);
  },
  removeListener(listener) {
    stateChangedListeners.delete(listener);
  }
};

async function getDataApiCredentials() {
  const profileSelector = await getDataProfileSelector();
  let result;
  try {
    result = await chrome.runtime.sendNativeMessage(DATA_HOST_NAME, {
      command: "get",
      profileSelector
    });
  } catch (error) {
    throw new Error(`No está disponible el host nativo de credenciales. Ejecutá native-host\\install.ps1 para esta extensión. ${error.message}`);
  }
  if (!result?.ok || typeof result.apiOrigin !== "string" ||
    typeof result.credential !== "string" || !result.credential ||
    typeof result.deviceId !== "string" || !result.deviceId) {
    throw new Error("Este perfil Chrome no está conectado a PostgreSQL. Importá su respaldo y enrolá el perfil desde Opciones.");
  }
  const origin = new URL(result.apiOrigin);
  if (origin.protocol !== "https:" || origin.origin !== result.apiOrigin) {
    throw new Error("La dirección guardada de la API PostgreSQL no es HTTPS válida.");
  }
  return {
    origin: origin.origin,
    credential: result.credential,
    deviceId: result.deviceId,
    profileSelector
  };
}

async function getDataProfileSelector() {
  if (!dataProfileSelectorPromise) {
    dataProfileSelectorPromise = (async () => {
      const stored = await chrome.storage.local.get(DATA_PROFILE_SELECTOR_KEY);
      if (typeof stored[DATA_PROFILE_SELECTOR_KEY] === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(stored[DATA_PROFILE_SELECTOR_KEY])) {
        return stored[DATA_PROFILE_SELECTOR_KEY].toLowerCase();
      }
      const selector = crypto.randomUUID();
      await chrome.storage.local.set({ [DATA_PROFILE_SELECTOR_KEY]: selector });
      return selector;
    })();
  }
  try {
    return await dataProfileSelectorPromise;
  } finally {
    dataProfileSelectorPromise = null;
  }
}

async function requestDataApi(route, { method = "GET", body } = {}) {
  const { origin, credential, deviceId, profileSelector } = await getDataApiCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const proof = await chrome.runtime.sendNativeMessage(DATA_HOST_NAME, {
      command: "sign",
      profileSelector,
      method,
      requestPath: route
    });
    if (!proof?.ok || proof.deviceId !== deviceId ||
      !Number.isSafeInteger(proof.timestamp) ||
      typeof proof.nonce !== "string" || typeof proof.signature !== "string") {
      throw new Error("El host nativo no pudo firmar la solicitud al servidor de datos.");
    }
    const response = await fetch(`${origin}${route}`, {
      method,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${credential}`,
        "x-bridge-device-id": proof.deviceId,
        "x-bridge-device-time": String(proof.timestamp),
        "x-bridge-device-nonce": proof.nonce,
        "x-bridge-device-signature": proof.signature,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("La API PostgreSQL devolvió una respuesta JSON inválida.");
    }
    if (!response.ok) {
      const message = result?.error || `La API PostgreSQL respondió HTTP ${response.status}.`;
      if (response.status === 401) {
        throw new Error(`${message} Reenrolá este perfil desde Opciones.`);
      }
      const error = new Error(message);
      error.code = result?.code;
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("La API PostgreSQL excedió el tiempo de espera.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function dispatchStateChange(changes) {
  for (const listener of stateChangedListeners) {
    try {
      listener(changes, "local");
    } catch (error) {
      console.error("[Ganamos balance extension] Falló un listener de estado PostgreSQL.", error);
    }
  }
  const message = {
    type: "STATE_CHANGED",
    changes,
    revision: cachedStateRevision
  };
  void chrome.runtime.sendMessage(message).catch(() => {});
  void chrome.tabs.query({ url: ["https://web.whatsapp.com/*", "https://bo.casinoenvivo.club/*"] })
    .then((tabs) => Promise.allSettled(tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) => chrome.tabs.sendMessage(tab.id, message))));
}

async function getExtensionState(keys = null) {
  const selectedKeys = typeof keys === "string" ? [keys] : keys;
  const query = selectedKeys === null || selectedKeys === undefined
    ? ""
    : `?keys=${encodeURIComponent(JSON.stringify(selectedKeys))}`;
  const response = await requestDataApi(`/v1/state${query}`);
  if (!response.values || typeof response.values !== "object" ||
    !Number.isSafeInteger(response.revision) ||
    !Number.isSafeInteger(response.changeRevision)) {
    throw new Error("La API PostgreSQL devolvió un estado incompleto.");
  }
  cachedStateRevision = response.revision;
  cachedChangeRevision = response.changeRevision;
  if (selectedKeys === null || selectedKeys === undefined) {
    extensionStateCache = { ...response.values };
  } else {
    for (const key of selectedKeys) {
      if (!Object.hasOwn(response.values, key)) delete extensionStateCache[key];
    }
    Object.assign(extensionStateCache, response.values);
  }
  const loadedKeys = selectedKeys === null || selectedKeys === undefined
    ? PROFILE_RUNTIME_STATE_KEYS
    : selectedKeys;
  for (const key of loadedKeys) loadedProfileStateKeys.add(key);
  return response.values;
}

async function getProfileRuntimeState() {
  if (!profileRuntimeStatePromise) {
    profileRuntimeStatePromise = (async () => {
      const missingKeys = PROFILE_RUNTIME_STATE_KEYS.filter((key) =>
        !loadedProfileStateKeys.has(key));
      if (missingKeys.length) await getExtensionState(missingKeys);
      return extensionStateCache;
    })();
  }
  try {
    return await profileRuntimeStatePromise;
  } finally {
    profileRuntimeStatePromise = null;
  }
}

async function writeExtensionState(changes, removes = [], expectedRevision) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
    !Array.isArray(removes)) {
    throw new Error("El cambio de estado solicitado no es válido.");
  }
  const keys = [...Object.keys(changes), ...removes];
  if (keys.some((key) => typeof key !== "string" || !key) ||
    new Set(keys).size !== keys.length) {
    throw new Error("El cambio contiene claves inválidas o repetidas.");
  }
  const isSharedStateKey = (key) => SHARED_STATE_KEYS.has(key) ||
    key.startsWith(USER_ACCOUNT_SETTING_PREFIX);
  const sharedWrite = keys.some(isSharedStateKey);
  if (sharedWrite && expectedRevision === undefined) {
    await getExtensionState(keys.filter(isSharedStateKey));
  }
  const previous = Object.fromEntries(keys.map((key) => [key, extensionStateCache[key]]));
  const body = { changes, removes };
  if (sharedWrite) {
    body.expectedRevision = expectedRevision ?? cachedStateRevision;
  }
  const response = await requestDataApi("/v1/state", { method: "POST", body });
  if (!Number.isSafeInteger(response.revision) || !Number.isSafeInteger(response.changeRevision)) {
    throw new Error("La API PostgreSQL no confirmó la revisión del cambio.");
  }
  cachedStateRevision = response.revision;
  cachedChangeRevision = response.changeRevision;
  let committedChanges = changes;
  if (Object.hasOwn(changes, "contactFlowCounters")) {
    const counters = Object.hasOwn(response, "contactFlowCounters")
      ? response.contactFlowCounters
      : (await getExtensionState("contactFlowCounters")).contactFlowCounters;
    if (!counters || typeof counters !== "object" || Array.isArray(counters)) {
      throw new Error("La API PostgreSQL no devolvió los contadores compartidos confirmados.");
    }
    committedChanges = { ...changes, contactFlowCounters: counters };
  }
  Object.assign(extensionStateCache, committedChanges);
  for (const key of removes) delete extensionStateCache[key];
  for (const key of keys) loadedProfileStateKeys.add(key);
  const event = {};
  for (const key of keys) {
    event[key] = {
      ...(Object.hasOwn(previous, key) && previous[key] !== undefined
        ? { oldValue: previous[key] }
        : {}),
      ...(Object.hasOwn(committedChanges, key) ? { newValue: committedChanges[key] } : {})
    };
  }
  dispatchStateChange(event);
  return { revision: response.revision, changeRevision: response.changeRevision };
}

function setExtensionState(changes, expectedRevision) {
  return writeExtensionState(changes, [], expectedRevision);
}

function removeExtensionState(keys, expectedRevision) {
  return writeExtensionState({}, Array.isArray(keys) ? keys : [keys], expectedRevision);
}

async function pollExtensionState() {
  const now = Date.now();
  if (statePollInProgress) return statePollInProgress;
  if (now - lastStatePollAt < 3000) return { ok: true, unchanged: true };
  lastStatePollAt = now;
  statePollInProgress = (async () => {
    if (cachedChangeRevision === null) {
      const previous = extensionStateCache;
      const current = await getExtensionState(null);
      const changes = {};
      for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
        const hadValue = Object.hasOwn(previous, key);
        const hasValue = Object.hasOwn(current, key);
        if (hadValue === hasValue && JSON.stringify(previous[key]) === JSON.stringify(current[key])) continue;
        changes[key] = {
          ...(hadValue ? { oldValue: previous[key] } : {}),
          ...(hasValue ? { newValue: current[key] } : {})
        };
      }
      if (Object.keys(changes).length) dispatchStateChange(changes);
      return { ok: true, changed: Object.keys(changes).length > 0 };
    }
    const result = await requestDataApi(`/v1/state/changes?after=${cachedChangeRevision}`);
    if (!Number.isSafeInteger(result.revision) || !Number.isSafeInteger(result.stateRevision)) {
      throw new Error("La respuesta de sincronización de PostgreSQL no contiene revisiones válidas.");
    }
    if (result.revision === cachedChangeRevision) return { ok: true, unchanged: true };
    if (result.resyncRequired) {
      const previous = extensionStateCache;
      const current = await getExtensionState(null);
      const changes = {};
      for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
        const hadValue = Object.hasOwn(previous, key);
        const hasValue = Object.hasOwn(current, key);
        if (hadValue === hasValue && JSON.stringify(previous[key]) === JSON.stringify(current[key])) continue;
        changes[key] = {
          ...(hadValue ? { oldValue: previous[key] } : {}),
          ...(hasValue ? { newValue: current[key] } : {})
        };
      }
      if (Object.keys(changes).length) dispatchStateChange(changes);
      return { ok: true, changed: Object.keys(changes).length > 0, resynced: true };
    }

    const previous = extensionStateCache;
    const current = { ...previous };
    for (const key of result.keys) {
      if (Object.hasOwn(result.values, key)) current[key] = result.values[key];
      else delete current[key];
    }
    extensionStateCache = current;
    for (const key of result.keys) loadedProfileStateKeys.add(key);
    cachedStateRevision = result.stateRevision;
    cachedChangeRevision = result.revision;
    const changes = {};
    for (const key of result.keys) {
      const hadValue = Object.hasOwn(previous, key);
      const hasValue = Object.hasOwn(current, key);
      if (hadValue === hasValue && JSON.stringify(previous[key]) === JSON.stringify(current[key])) continue;
      changes[key] = {
        ...(hadValue ? { oldValue: previous[key] } : {}),
        ...(hasValue ? { newValue: current[key] } : {})
      };
    }
    if (Object.keys(changes).length) dispatchStateChange(changes);
    return { ok: true, changed: Object.keys(changes).length > 0 };
  })();
  try {
    return await statePollInProgress;
  } finally {
    statePollInProgress = null;
  }
}
const MULTIPANEL_WEBSITES = [
  "megafaraon.pw", "esmeralda.uno", "esmeralda.digital", "fortubet.pw", "ganaencasa.pw",
  "ganaencasa.ws", "ganaencasa.one", "grancasinozeus.pw", "granposeidon.pw", "jokervip.pw",
  "jugavip.pw", "jugaygana.one", "jugaygana.pw", "konabet.pw", "magyplay.pw", "emme.pw",
  "mika.red", "millonarios.xyz", "mundocasino.me", "olympuscasino.pw", "oropuro.pw",
  "plutonos.me", "stargame.pw", "trebol.pw", "tribet.pw", "universegame.pw", "vip32.pw",
  "vudu.pw", "zebracasino.pw", "camelbet.pw", "apostamos.online", "areabet.pw",
  "argenbet.me", "azarlatino.pw", "bet30.ws", "bet30.site", "bet32.pw", "bet30.shop",
  "bet71.pw", "bet91.pw", "buffaloclub.pw", "buffalovip.me", "caipiria.pw", "allwin.one",
  "camelbet.ws", "capibet.pw", "casinozeus.pw", "casino33.pw", "casino91.pw",
  "casinotower.pw", "casinozeta20.pw", "casinozeus.ws", "celuapuestas.pw", "circovip.me",
  "cleopatrabet.pw", "clubterra.pw", "cupper.bet"
];

function isValidUsername(username, suffix = "f") {
  return typeof username === "string" && new RegExp(`^[^/]+${suffix}+$`, "i").test(username.trim());
}

function isValidMultiPanelUsername(username, suffix = "y") {
  return typeof username === "string" && new RegExp(`^[^/]+${suffix}+$`, "i").test(username.trim());
}

function normalizeUsernameSuffix(username, suffix) {
  if (typeof username !== "string") return "";
  return username.trim().normalize("NFC").toLocaleLowerCase().replace(new RegExp(`${suffix}+$`, "i"), suffix);
}

async function getPlatformSuffixes() {
  const stored = await getProfileRuntimeState();
  const ganamos = typeof stored.ganamosSuffix === "string" ? stored.ganamosSuffix.toLowerCase() : "f";
  const multipanel = typeof stored.multiPanelSuffix === "string" ? stored.multiPanelSuffix.toLowerCase() : "y";
  if (!/^[a-z]$/.test(ganamos) || !/^[a-z]$/.test(multipanel) || ganamos === multipanel) {
    throw new Error("Los sufijos de Ganamos y MultiPanel deben ser letras distintas.");
  }
  return { ganamos, multipanel };
}

async function getAgentUserId(requestData) {
  const stored = await getProfileRuntimeState();
  const userId = String(requestData?.user_id ?? stored.ganamosUserId ?? DEFAULT_AGENT_USER_ID);
  if (!/^\d+$/.test(userId)) {
    throw new Error("El user_id configurado para Ganamos no es válido.");
  }
  return userId;
}

async function withPlatformRequestTimeout(platform, mayHaveChangedData, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLATFORM_REQUEST_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const timeoutError = new Error(
      `${platform} no respondió en ${PLATFORM_REQUEST_TIMEOUT_MS / 1000} segundos.` +
      (mayHaveChangedData
        ? " La plataforma podría haber procesado la operación; verificá el saldo o el usuario antes de volver a intentarla."
        : "")
    );
    timeoutError.code = "PLATFORM_TIMEOUT";
    throw timeoutError;
  } finally {
    clearTimeout(timer);
  }
}

async function requestGanamosJson(path, options = {}) {
  const url = new URL(path, GANAMOS_API_ORIGIN);
  if (url.origin !== GANAMOS_API_ORIGIN) {
    throw new Error("Se rechazó una URL fuera del dominio de Ganamos.");
  }

  const mayHaveChangedData = (options.method || "GET").toUpperCase() !== "GET";
  return withPlatformRequestTimeout("Ganamos", mayHaveChangedData, async (signal) => {
    const response = await fetch(url, {
      ...options,
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        ...options.headers
      },
      cache: "no-store",
      signal
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("La sesión de Ganamos no está disponible o no tiene permisos.");
      }
      throw new Error(`Ganamos respondió HTTP ${response.status}.`);
    }

    try {
      return await response.json();
    } catch {
      throw new Error("Ganamos devolvió una respuesta que no es JSON válido.");
    }
  });
}

function extractUserRecords(payload) {
  const records = new Map();
  const usernameKeys = ["username", "user_name", "login", "alias"];
  const visit = (value, inherited = {}) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, inherited));
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = { ...inherited, ...value };
    const username = usernameKeys.map((key) => record[key]).find((item) => typeof item === "string");
    if (username) {
      const normalized = username.trim().toLocaleLowerCase();
      const existing = records.get(normalized);
      const hasBalance = Object.keys(record).some((key) => /balance|saldo/i.test(key));
      const existingHasBalance = existing && Object.keys(existing).some((key) => /balance|saldo/i.test(key));
      if (!existing || (hasBalance && !existingHasBalance)) records.set(normalized, record);
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child, record);
    }
  };
  visit(payload);
  return [...records.values()];
}

async function findGanamosUser(data) {
  const username = data.nombre.trim();
  const { ganamos: suffix } = await getPlatformSuffixes();
  const normalizedUsername = normalizeUsernameSuffix(username, suffix);
  const userId = await getAgentUserId(data);
  const params = new URLSearchParams({
    username,
    count: "10",
    page: "0",
    user_id: userId,
    is_banned: "false",
    is_direct_structure: "false"
  });
  const payload = await requestGanamosJson(`/api/agent_admin/user/?${params}`);
  const matches = extractUserRecords(payload).filter((user) =>
    [user?.username, user?.user_name, user?.login, user?.alias]
      .some((candidate) => normalizeUsernameSuffix(candidate, suffix) === normalizedUsername));

  if (matches.length !== 1) {
    if (matches.length) throw new Error("Ganamos devolvió más de una coincidencia exacta.");
    const records = extractUserRecords(payload);
    const availableKeys = records[0] ? Object.keys(records[0]).slice(0, 12).join(", ") : "sin registros reconocibles";
    throw new Error(`Ganamos respondió, pero no se encontró ${username} con user_id ${userId} (${availableKeys}). Verificá el identificador de agente y la respuesta de la API.`);
  }

  const user = matches[0];
  const balanceKey = Object.keys(user).find((key) => /^(balance|.*_balance|saldo|.*_saldo)$/i.test(key));
  const balance = user.balance ?? user.user_balance ?? user.wallet_balance ?? user.saldo ?? user[balanceKey];
  if (typeof balance !== "string" && typeof balance !== "number") {
    throw new Error("Ganamos encontró el usuario, pero la respuesta no incluye un saldo reconocible.");
  }

  const matchedUsername = user.username ?? user.user_name ?? user.login ?? user.alias;
  return {
    ok: true,
    username: matchedUsername,
    userId: user.id ?? user.user_id ?? user.pk,
    balance: String(balance)
  };
}

async function findGanamosUsersByDigits(digits) {
  const { ganamos: suffix } = await getPlatformSuffixes();
  const userId = await getAgentUserId();
  const pageSize = 10;
  const records = new Map();

  for (let page = 0; ; page += 1) {
    const params = new URLSearchParams({
      username: digits,
      count: String(pageSize),
      page: String(page),
      user_id: userId,
      is_banned: "false",
      is_direct_structure: "false"
    });
    const payload = await requestGanamosJson(`/api/agent_admin/user/?${params}`);
    if (payload?.status !== 0) {
      throw new Error(payload?.error_message || "Ganamos no pudo buscar usuarios.");
    }
    const pageRecords = extractUserRecords(payload);
    let newRecords = 0;
    for (const record of pageRecords) {
      const username = [record?.username, record?.user_name, record?.login, record?.alias]
        .find((candidate) => typeof candidate === "string");
      if (!username || !username.includes(digits)) continue;
      const key = username.trim().toLocaleLowerCase();
      if (!records.has(key)) {
        records.set(key, username.trim());
        newRecords += 1;
      }
    }
    if (pageRecords.length < pageSize || newRecords === 0) break;
  }

  return [...records.values()].filter((username) =>
    normalizeUsernameSuffix(username, suffix).includes(digits));
}

async function getGanamosAgentBalance() {
  const payload = await requestGanamosJson("/api/user/balance");
  if (payload?.status !== 0) {
    throw new Error(payload?.error_message || "Ganamos no pudo consultar el balance del agente.");
  }
  const balance = payload?.result?.balance;
  if (typeof balance !== "number" && typeof balance !== "string") {
    throw new Error("Ganamos devolvió el balance del agente con un formato inesperado.");
  }
  const numericBalance = Number(balance);
  if (!Number.isFinite(numericBalance)) {
    throw new Error("Ganamos devolvió un balance del agente que no es numérico.");
  }
  return {
    ok: true,
    balance: String(numericBalance),
    currency: typeof payload.result.currency === "string" ? payload.result.currency : ""
  };
}

async function getGanamosActiveSportBets(data) {
  const username = data.nombre.trim();
  const pageSize = 100;
  const now = new Date();
  const rangeStart = new Date(now);
  rangeStart.setFullYear(rangeStart.getFullYear() - 1);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(now);
  rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);
  rangeEnd.setHours(23, 59, 59, 0);
  const formatDateTime = (date) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  let totalCount = null;
  let receivedCount = 0;
  let activeCount = 0;
  const seenCouponIds = new Set();

  for (let page = 0; totalCount === null || receivedCount < totalCount; page += 1) {
    const params = new URLSearchParams({
      username,
      created_at__gte: formatDateTime(rangeStart),
      created_at__lte: formatDateTime(rangeEnd),
      count: String(pageSize),
      page: String(page),
      tz: String(-now.getTimezoneOffset() / 60)
    });
    const payload = await requestGanamosJson(
      `/api/agent_admin/user/sport/coupon/?${params}`
    );
    if (payload?.status !== 0) {
      throw new Error(payload?.error_message || "Ganamos no pudo consultar las apuestas deportivas.");
    }
    const result = payload?.result;
    if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.count) ||
      result.count < 0) {
      throw new Error("Ganamos devolvió las apuestas deportivas con un formato inesperado.");
    }
    if (totalCount === null) totalCount = result.count;
    if (result.items.length === 0) break;

    for (const coupon of result.items) {
      if (!coupon || typeof coupon !== "object" || typeof coupon.status !== "string" ||
        (typeof coupon.id !== "number" && typeof coupon.id !== "string")) {
        throw new Error("Ganamos devolvió una apuesta deportiva con un formato inesperado.");
      }
      const couponId = String(coupon.id);
      if (seenCouponIds.has(couponId)) continue;
      seenCouponIds.add(couponId);
      if (coupon.status.toUpperCase() === "ACCEPTED") activeCount += 1;
    }
    receivedCount += result.items.length;
  }

  if (seenCouponIds.size < totalCount) {
    throw new Error("Ganamos no devolvió todas las páginas de apuestas deportivas.");
  }
  return {
    ok: true,
    count: activeCount,
    hasBets: seenCouponIds.size > 0
  };
}

async function getMultiPanelActiveSportBets(data) {
  const username = data.nombre.trim();
  const now = new Date();
  const rangeStart = new Date(now);
  rangeStart.setFullYear(rangeStart.getFullYear() - 1);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(now);
  rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);
  rangeEnd.setHours(23, 59, 59, 0);
  const formatDateTime = (date) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  const pageSize = 200;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await findMultiPanelUser(username);
      const records = new Map();
      for (let offset = 0; ; offset += pageSize) {
        const report = await requestMultiPanelForm("/api/admin_reports/getReport", {
          session: user.session,
          company: "MULT",
          report: "agents_user_last_bets",
          filter: JSON.stringify([{
            field: "t.created_date",
            type: "time_range",
            value: [formatDateTime(rangeStart), formatDateTime(rangeEnd)]
          }]),
          user: user.user,
          db: user.db,
          limit: `limit ${offset},${pageSize}`,
          sort: "",
          callFilter: ""
        });
        const pageRecords = report?.data?.data;
        if (!Array.isArray(pageRecords)) {
          throw new Error("MultiPanel devolvió las apuestas deportivas con un formato inesperado.");
        }
        let newRecords = 0;
        for (const record of pageRecords) {
          if (!record || typeof record !== "object" ||
            (typeof record.operation !== "string" && typeof record.operation !== "number") ||
            typeof record.status !== "string") {
            throw new Error("MultiPanel devolvió una apuesta deportiva con un formato inesperado.");
          }
          if (!records.has(String(record.operation))) newRecords += 1;
          records.set(String(record.operation), record);
        }
        if (pageRecords.length < pageSize) break;
        if (newRecords === 0) {
          throw new Error("MultiPanel no avanzó a la siguiente página de apuestas deportivas.");
        }
      }
      const bets = [...records.values()];
      return {
        ok: true,
        count: bets.filter((bet) => bet.status.toUpperCase() === "OPEN").length,
        hasBets: bets.length > 0
      };
    } catch (error) {
      if (!isInvalidMultiPanelSession(error) || attempt > 0) throw error;
      await getMultiPanelSessionFromOpenTab();
    }
  }
  throw new Error("No se pudieron consultar las apuestas deportivas de MultiPanel.");
}

async function createGanamosUser(data) {
  const { ganamos: ganamosSuffix } = await getPlatformSuffixes();
  if (!isValidUsername(data?.username, ganamosSuffix)) {
    throw new Error("El nombre de usuario generado no tiene el sufijo configurado para Ganamos.");
  }
  const { userCreationPassword } = await getExtensionState("userCreationPassword");
  if (typeof userCreationPassword !== "string" || !userCreationPassword.trim()) {
    throw new Error("Configurá la contraseña automática en las opciones de la extensión del perfil principal.");
  }

  const payload = await requestGanamosJson("/api/agent_admin/user/", {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      username: data.username,
      password: userCreationPassword,
      email: "",
      first_name: "",
      last_name: "",
      role: 0
    })
  });
  if (payload?.status !== 0 || !/^\d+$/.test(String(payload?.result?.user_id ?? ""))) {
    const errorMessage = typeof payload?.error_message === "string" ? payload.error_message : "";
    const isDuplicate = errorMessage.toLocaleLowerCase()
      .includes(`user with username: ${data.username}`.toLocaleLowerCase()) &&
      /already exists?/i.test(errorMessage);
    if (isDuplicate) {
      return { ok: false, usernameExists: true, username: data.username, error: errorMessage };
    }
    throw new Error(errorMessage || "Ganamos no confirmó la creación del usuario.");
  }
  return { ok: true, username: data.username, userId: String(payload.result.user_id) };
}

async function requestMultiPanelForm(path, fields) {
  const url = new URL(path, MULTIPANEL_API_ORIGIN);
  if (url.origin !== MULTIPANEL_API_ORIGIN) {
    throw new Error("Se rechazó una URL fuera del dominio de MultiPanel.");
  }

  const mayHaveChangedData = [
    "/api/admin/manualDeposit",
    "/api/admin/register",
    "/api/admin/updatePasswordAgent",
    "/api/admin/updateUserWebsitesPlayer"
  ].includes(url.pathname);
  return withPlatformRequestTimeout("MultiPanel", mayHaveChangedData, async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(fields),
      cache: "no-store",
      signal
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("MultiPanel devolvió una respuesta que no es JSON válido.");
    }
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.description || `MultiPanel respondió HTTP ${response.status}.`);
      error.code = payload?.code;
      error.payload = payload;
      throw error;
    }
    if (payload?.result !== "OK" || (payload?.code != null && payload.code !== 0)) {
      const error = new Error(payload?.message || payload?.description || "MultiPanel no pudo completar la consulta.");
      error.code = payload?.code;
      error.payload = payload;
      throw error;
    }
    return payload;
  });
}

function isInvalidMultiPanelSession(error) {
  return error?.code === -2 || /invalid session/i.test(error?.message || "");
}

function isValidMultiPanelSession(session) {
  return typeof session === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(session.trim());
}

function isDuplicateUsernameError(error, username) {
  const details = [error?.message, error?.payload ? JSON.stringify(error.payload) : ""].join(" ");
  return details.toLocaleLowerCase().includes(username.toLocaleLowerCase()) &&
    /(already\s+exists?|duplicate|duplicad[oa]s?|ya\s+existe)/i.test(details);
}

async function createMultiPanelUser(data) {
  const { multipanel: suffix } = await getPlatformSuffixes();
  if (!isValidMultiPanelUsername(data?.username, suffix)) {
    throw new Error("El nombre de usuario generado no tiene el sufijo configurado para MultiPanel.");
  }
  const { userCreationPassword } = await getExtensionState("userCreationPassword");
  if (typeof userCreationPassword !== "string" || !userCreationPassword.trim()) {
    throw new Error("Configurá la contraseña automática en las opciones de la extensión del perfil que ejecuta las solicitudes.");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await getMultiPanelSession();
      const username = data.username;
      const payload = await requestMultiPanelForm("/api/admin/register", {
        session,
        user: JSON.stringify({
          popupTitle: "",
          errors: {},
          currency: "ARS",
          code_send: false,
          code_verified: false,
          code: "",
          alias: username,
          password: userCreationPassword,
          national_id: username,
          national_id_type: "",
          email: `${username}@`,
          first_name: username,
          last_name: username,
          mobile: username,
          comments: ""
        }),
        company: "MULT",
        websites: JSON.stringify(MULTIPANEL_WEBSITES)
      });
      const createdUser = payload?.user;
      if (createdUser?.result !== "OK" || createdUser?.status !== "REGISTERED") {
        const error = new Error("MultiPanel no confirmó el registro del usuario.");
        error.payload = payload;
        if (isDuplicateUsernameError(error, username)) {
          return { ok: false, usernameExists: true, username, error: error.message };
        }
        throw error;
      }
      const userId = createdUser.user;
      return {
        ok: true,
        username,
        ...(userId != null ? { userId: String(userId) } : {})
      };
    } catch (error) {
      if (isDuplicateUsernameError(error, data.username)) {
        return { ok: false, usernameExists: true, username: data.username, error: error.message };
      }
      if (!isInvalidMultiPanelSession(error) || attempt > 0) throw error;
      await getMultiPanelSessionFromOpenTab();
    }
  }
  throw new Error("No se pudo crear el usuario en MultiPanel.");
}

async function getMultiPanelSession() {
  let session = extensionStateCache.multiPanelSession;
  if (!isValidMultiPanelSession(session)) {
    const stored = await getProfileRuntimeState();
    session = stored.multiPanelSession;
  }
  if (isValidMultiPanelSession(session)) return session.trim();
  return getMultiPanelSessionFromOpenTab();
}

async function getMultiPanelSessionFromOpenTab() {
  const tabs = await chrome.tabs.query({ url: `${MULTIPANEL_WEB_ORIGIN}/*` });
  let lastError;
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "MULTIPANEL_READ_SESSION" });
    } catch (error) {
      // The tab may not have the extension content script until it is reloaded.
      lastError = /receiving end does not exist|could not establish connection/i.test(error?.message || "")
        ? new Error("El conector de MultiPanel no está activo en esa pestaña. Recargá la extensión y después recargá el panel de MultiPanel.")
        : error;
      continue;
    }
    if (response?.ok && isValidMultiPanelSession(response.session)) {
      const session = response.session.trim();
      await setExtensionState({ multiPanelSession: session });
      return session;
    }
    if (response?.error) lastError = new Error(response.error);
  }
  throw new Error(lastError?.message || "No se pudo leer una sesión activa de MultiPanel. Recargá la pestaña del panel e intentá de nuevo.");
}

async function findMultiPanelUser(username) {
  const { multipanel: suffix } = await getPlatformSuffixes();
  const normalizedUsername = normalizeUsernameSuffix(username, suffix);
  let session = await getMultiPanelSession();
  const report = await requestMultiPanelForm("/api/admin_reports/getReport", {
    session,
    company: "MULT",
    report: "agents_control_all",
    filter: JSON.stringify([{ field: "u.alias", type: "like", value: username }]),
    user: "null",
    db: "null",
    limit: "limit 0,20",
    sort: "alias asc",
    callFilter: ""
  });

  const records = report?.data?.data;
  if (!Array.isArray(records)) {
    throw new Error("MultiPanel devolvió una lista de usuarios con formato inesperado.");
  }
  const matches = records.filter((record) =>
    normalizeUsernameSuffix(record?.alias, suffix) === normalizedUsername);
  if (matches.length !== 1) {
    throw new Error(matches.length ? "MultiPanel devolvió varias coincidencias exactas." : `No se encontró ${username} en MultiPanel.`);
  }

  const refreshedSession = report?.data?.def?.session;
  if (typeof refreshedSession === "string" && refreshedSession.trim() && refreshedSession !== session) {
    session = refreshedSession.trim();
    await setExtensionState({ multiPanelSession: session });
  }

  const user = matches[0];
  if (!/^\d+$/.test(String(user.user ?? "")) || !/^\d+$/.test(String(user.db ?? ""))) {
    throw new Error("MultiPanel encontró el alias, pero no devolvió IDs válidos de usuario y base de datos.");
  }
  return { session, user: String(user.user), db: String(user.db), alias: user.alias };
}

async function findMultiPanelUsersByDigits(digits) {
  let session = await getMultiPanelSession();
  const pageSize = 20;
  const records = new Map();

  for (let offset = 0; ; offset += pageSize) {
    const report = await requestMultiPanelForm("/api/admin_reports/getReport", {
      session,
      company: "MULT",
      report: "agents_control_all",
      filter: JSON.stringify([{ field: "u.alias", type: "like", value: digits }]),
      user: "null",
      db: "null",
      limit: `limit ${offset},${pageSize}`,
      sort: "alias asc",
      callFilter: ""
    });
    const pageRecords = report?.data?.data;
    if (!Array.isArray(pageRecords)) {
      throw new Error("MultiPanel devolvió una lista de usuarios con formato inesperado.");
    }
    let newRecords = 0;
    for (const record of pageRecords) {
      const alias = record?.alias;
      if (typeof alias !== "string" || !alias.includes(digits)) continue;
      const key = alias.trim().toLocaleLowerCase();
      if (!records.has(key)) {
        records.set(key, alias.trim());
        newRecords += 1;
      }
    }

    const refreshedSession = report?.data?.def?.session;
    if (typeof refreshedSession === "string" && refreshedSession.trim() && refreshedSession !== session) {
      session = refreshedSession.trim();
      await setExtensionState({ multiPanelSession: session });
    }
    if (pageRecords.length < pageSize || newRecords === 0) break;
  }

  return [...records.values()];
}

async function searchUsersByDigits(digits) {
  const [ganamosResult, multipanelResult] = await Promise.allSettled([
    findGanamosUsersByDigits(digits),
    findMultiPanelUsersByDigits(digits)
  ]);
  const errors = {};
  if (ganamosResult.status === "rejected") {
    errors.ganamos = ganamosResult.reason?.message || "Error de búsqueda en Ganamos.";
  }
  if (multipanelResult.status === "rejected") {
    errors.multipanel = multipanelResult.reason?.message || "Error de búsqueda en MultiPanel.";
  }
  return {
    ok: true,
    ganamos: ganamosResult.status === "fulfilled" ? ganamosResult.value : [],
    multipanel: multipanelResult.status === "fulfilled" ? multipanelResult.value : [],
    errors
  };
}

function getListedUserBalance(record) {
  if (!record || typeof record !== "object") return null;
  const keys = [
    "balance",
    "user_balance",
    "wallet_balance",
    "saldo",
    ...Object.keys(record).filter((key) => /^(?:.*_balance|.*_saldo|amount)$/i.test(key))
  ];
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === "number" || typeof value === "string") &&
      String(value).trim() !== "") {
      const balance = Number(String(value).replace(",", "."));
      if (Number.isFinite(balance)) return balance;
    }
  }
  return null;
}

async function getTopGanamosUsersPage() {
  const userId = await getAgentUserId();
  const pageSize = 100;
  const params = new URLSearchParams({
    count: String(pageSize),
    page: "0",
    order_by: "-balance",
    user_id: userId,
    is_banned: "false",
    is_direct_structure: "false"
  });
  const payload = await requestGanamosJson(`/api/agent_admin/user/?${params}`);
  if (payload?.status !== 0) {
    throw new Error(payload?.error_message || "Ganamos no pudo consultar la lista de usuarios.");
  }
  const result = payload?.result;
  const pageRecords = result?.users;
  if (!Array.isArray(pageRecords) ||
    !Number.isSafeInteger(result.total_count) || result.total_count < 0) {
    throw new Error("Ganamos devolvió la lista de usuarios con un formato inesperado.");
  }
  const users = [];
  for (const record of pageRecords) {
    const username = typeof record?.username === "string" ? record.username.trim() : "";
    const balance = getListedUserBalance(record);
    if (!username || balance === null) {
      throw new Error("Ganamos devolvió un usuario sin nombre o saldo válido para el ranking.");
    }
    users.push({ username, balance });
  }
  users.sort((first, second) => second.balance - first.balance);
  return users;
}

async function getTopMultiPanelUsersPage() {
  let session = await getMultiPanelSession();
  const pageSize = 20;
  const report = await requestMultiPanelForm("/api/admin_reports/getReport", {
    session,
    company: "MULT",
    report: "agents_control_all",
    filter: JSON.stringify([{ field: "u.alias", type: "like", value: "" }]),
    user: "null",
    db: "null",
    limit: `limit 0,${pageSize}`,
    sort: "amount desc",
    callFilter: ""
  });
  const pageRecords = report?.data?.data;
  if (!Array.isArray(pageRecords)) {
    throw new Error("MultiPanel devolvió una lista de usuarios con formato inesperado.");
  }
  const users = [];
  for (const record of pageRecords) {
    const username = typeof record?.alias === "string" ? record.alias.trim() : "";
    const balanceInMinorUnits = getListedUserBalance(record);
    if (!username || balanceInMinorUnits === null) {
      throw new Error("MultiPanel devolvió un usuario sin nombre o saldo válido para el ranking.");
    }
    users.push({
      username,
      balance: balanceInMinorUnits / 100
    });
  }
  users.sort((first, second) => second.balance - first.balance);
  const refreshedSession = report?.data?.def?.session;
  if (typeof refreshedSession === "string" && refreshedSession.trim()) {
    const nextSession = refreshedSession.trim();
    if (nextSession !== session) {
      await setExtensionState({ multiPanelSession: nextSession });
    }
  }
  return users;
}

async function getTopPlatformUsersByBalance(data) {
  const page = data.page;
  const users = data.platform === "ganamos"
    ? await getTopGanamosUsersPage()
    : await getTopMultiPanelUsersPage();
  return {
    ok: true,
    platform: data.platform,
    page,
    users
  };
}

async function getMultiPanelBalance(data) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await findMultiPanelUser(data.nombre.trim());
      const balance = await getMultiPanelBalanceForUser(user);
      if (data.force === true) {
        rememberWithdrawalUser("multipanel", data.nombre, user);
      }
      return balance;
    } catch (error) {
      if (!isInvalidMultiPanelSession(error) || attempt > 0) throw error;
      await getMultiPanelSessionFromOpenTab();
    }
  }
  throw new Error("No se pudo consultar el saldo de MultiPanel.");
}

function withdrawalUserCacheKey(platform, username) {
  return `${platform}:${username.trim().toLocaleLowerCase()}`;
}

function rememberWithdrawalUser(platform, username, user) {
  const now = Date.now();
  for (const [key, cached] of withdrawalUserCache) {
    if (cached.expiresAt <= now) withdrawalUserCache.delete(key);
  }
  if (withdrawalUserCache.size >= 100) {
    withdrawalUserCache.delete(withdrawalUserCache.keys().next().value);
  }
  const operationUser = platform === "ganamos"
    ? { username: user.username, userId: user.userId }
    : { session: user.session, user: user.user, db: user.db, alias: user.alias };
  withdrawalUserCache.set(withdrawalUserCacheKey(platform, username), {
    user: operationUser,
    expiresAt: now + 15_000
  });
}

function takeWithdrawalUser(platform, username) {
  const key = withdrawalUserCacheKey(platform, username);
  const cached = withdrawalUserCache.get(key);
  withdrawalUserCache.delete(key);
  return cached && cached.expiresAt > Date.now() ? cached.user : null;
}

async function getMultiPanelBalanceForUser(user) {
  const result = await requestMultiPanelForm("/api/admin/getCurrentUserBalance", {
    session: user.session,
    company: "MULT",
    user: user.user,
    db: user.db,
    balance: "CASH"
  });
  const balances = Array.isArray(result?.data) ? result.data : [];
  const balance = balances.find((entry) =>
    String(entry?.user) === user.user && String(entry?.db) === user.db && entry?.account === "CASH");
  if (!balance || (typeof balance.amount !== "string" && typeof balance.amount !== "number")) {
    throw new Error("MultiPanel no devolvió el saldo CASH para el usuario encontrado.");
  }
  const amountInMinorUnits = Number(balance.amount);
  if (!Number.isFinite(amountInMinorUnits)) {
    throw new Error("MultiPanel devolvió un saldo CASH que no es numérico.");
  }
  return { ok: true, username: user.alias, balance: (amountInMinorUnits / 100).toFixed(2) };
}

async function verifyBalanceIncrease(getBalance, initialBalance, expectedIncrease) {
  const initialCents = Math.round(initialBalance * 100);
  const expectedCents = Math.round(expectedIncrease * 100);
  let lastBalance = null;
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      lastBalance = await getBalance();
      lastError = null;
      if (Math.round(lastBalance * 100) === initialCents + expectedCents) {
        return {
          status: "verified",
          initialBalance,
          finalBalance: lastBalance,
          expectedIncrease
        };
      }
    } catch (error) {
      lastError = error;
      if (error?.code === "PLATFORM_TIMEOUT") break;
    }
  }

  return {
    status: "pending",
    initialBalance,
    ...(lastBalance != null ? { finalBalance: lastBalance } : {}),
    expectedIncrease,
    ...(lastError ? { verificationError: lastError.message || "No se pudo volver a consultar el saldo." } : {})
  };
}

async function getMultiPanelAgentBalance() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await getMultiPanelSession();
      const result = await requestMultiPanelForm("/api/admin/getBalanceUser", {
        session,
        company: "MULT"
      });
      const balances = Array.isArray(result?.data) ? result.data : [];
      const balance = balances.find((entry) =>
        (typeof entry?.amount === "number" || typeof entry?.amount === "string") &&
        Number.isFinite(Number(entry.amount)));
      if (!balance) {
        throw new Error("MultiPanel no devolvió el balance actual del agente en un formato reconocible.");
      }
      return {
        ok: true,
        balance: (Number(balance.amount) / 100).toFixed(2),
        currency: typeof balance.currency === "string" ? balance.currency : ""
      };
    } catch (error) {
      if (!isInvalidMultiPanelSession(error) || attempt > 0) throw error;
      await getMultiPanelSessionFromOpenTab();
    }
  }
  throw new Error("No se pudo consultar el balance actual del agente MultiPanel.");
}

function validateTransaction(data, suffixes = { ganamos: "f", multipanel: "y" }) {
  const validPlatformUsername = data?.platform === "multipanel"
    ? isValidMultiPanelUsername(data.nombre, suffixes.multipanel)
    : data?.platform === "ganamos" && isValidUsername(data.nombre, suffixes.ganamos);
  if (!data || !["deposit", "withdrawal"].includes(data.operation) ||
    !validPlatformUsername ||
    typeof data.monto !== "string" || !/^\d+(?:[.,]\d{1,2})?$/.test(data.monto) ||
    Number(data.monto.replace(",", ".")) <= 0) {
    return false;
  }
  if (data.bonus == null) return true;
  return data.operation === "deposit" && data.bonus.enabled === true && data.bonus.mode === "value" &&
    typeof data.bonus.value === "string" && /^\d+(?:[.,]\d{1,2})?$/.test(data.bonus.value) &&
    Number(data.bonus.value.replace(",", ".")) >= 0;
}

function toApiAmount(value) {
  const amount = Number(value.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("El monto no es válido.");
  return amount;
}

function toMultiPanelMinorUnits(value) {
  const amount = Number(value.replace(",", "."));
  const minorUnits = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(minorUnits)) {
    throw new Error("El monto de MultiPanel no es válido.");
  }
  return String(minorUnits);
}

async function runTransactionRequest(data) {
  if (data.platform === "multipanel") {
    return runMultiPanelManualOperation(data);
  }

  const validatedUser = takeWithdrawalUser("ganamos", data.nombre);
  const user = data.operation === "withdrawal" && validatedUser
    ? validatedUser
    : await findGanamosUser(data);
  if (!/^\d+$/.test(String(user.userId ?? ""))) {
    throw new Error("Ganamos encontró el usuario, pero no devolvió un ID válido para la operación.");
  }
  const initialBalance = Number(user.balance);
  if (data.operation === "deposit" && !Number.isFinite(initialBalance)) {
    throw new Error("Ganamos no devolvió un saldo inicial válido; no se envió el depósito.");
  }
  if (data.operation === "withdrawal" && data.bonus != null) {
    throw new Error("Ganamos no admite bonos en solicitudes de retiro.");
  }

  const bonusAmount = data.bonus?.enabled ? toApiAmount(data.bonus.value) : 0;
  const payload = data.operation === "deposit"
    ? {
        operation: 0,
        amount: toApiAmount(data.monto),
        is_bonus: bonusAmount > 0,
        bonus_amount: bonusAmount
      }
    : { operation: 1, amount: toApiAmount(data.monto) };
  const response = await requestGanamosJson(
    `/api/agent_admin/user/${encodeURIComponent(user.userId)}/payment/`,
    {
      method: "POST",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(payload)
    }
  );
  if (response?.ok === false || response?.success === false || response?.error ||
    (response?.status != null && Number(response.status) !== 0) ||
    (typeof response?.error_message === "string" && response.error_message.trim())) {
    throw new Error(response.error || response.message || response.error_message ||
      `Ganamos rechazó el ${data.operation === "deposit" ? "depósito" : "retiro"}.`);
  }
  if (data.operation !== "deposit") {
    return { ok: true, username: user.username, userId: user.userId, response };
  }

  const expectedIncrease = toApiAmount(data.monto) + bonusAmount;
  const verification = await verifyBalanceIncrease(async () => {
    const refreshed = await findGanamosUser({ ...data, nombre: user.username });
    const balance = Number(refreshed.balance);
    if (!Number.isFinite(balance)) throw new Error("Ganamos devolvió un saldo no numérico al verificar.");
    return balance;
  }, initialBalance, expectedIncrease);
  return { ok: true, username: user.username, userId: user.userId, response, verification };
}

async function runMultiPanelManualOperation(data) {
  const idempotence = crypto.randomUUID().replace(/-/g, "");
  let validatedUser = takeWithdrawalUser("multipanel", data.nombre);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = data.operation === "withdrawal" && validatedUser
        ? validatedUser
        : await findMultiPanelUser(data.nombre.trim());
      const initialBalanceResult = data.operation === "deposit"
        ? await getMultiPanelBalanceForUser(user)
        : null;
      const initialBalance = initialBalanceResult ? Number(initialBalanceResult.balance) : null;
      if (data.operation === "deposit" && !Number.isFinite(initialBalance)) {
        throw new Error("MultiPanel no devolvió un saldo inicial válido; no se envió el depósito.");
      }
      const bonusAmount = data.operation === "deposit" && data.bonus?.enabled
        ? toMultiPanelMinorUnits(data.bonus.value)
        : "0";
      const amount = toMultiPanelMinorUnits(data.monto);
      const response = await requestMultiPanelForm("/api/admin/manualDeposit", {
        session: user.session,
        company: "MULT",
        user: user.user,
        method: "AGENTS",
        amount: data.operation === "withdrawal" ? `-${amount}` : amount,
        tip: bonusAmount,
        status: "NEW",
        comment: "",
        db: user.db,
        idempotence
      });
      if (response?.ok === false || response?.success === false || response?.error) {
        throw new Error(response.error || response.message ||
          `MultiPanel rechazó el ${data.operation === "deposit" ? "depósito" : "retiro"}.`);
      }
      if (data.operation !== "deposit") return { ok: true, username: user.alias, response };

      const expectedIncrease = Number(amount) / 100 + Number(bonusAmount) / 100;
      const verification = await verifyBalanceIncrease(async () => {
        const refreshed = await getMultiPanelBalanceForUser(user);
        const balance = Number(refreshed.balance);
        if (!Number.isFinite(balance)) throw new Error("MultiPanel devolvió un saldo no numérico al verificar.");
        return balance;
      }, initialBalance, expectedIncrease);
      if (verification.status === "pending") {
        return {
          ok: true,
          username: user.alias,
          response,
          verification,
          partial: true,
          error: `MultiPanel respondió al depósito, pero el saldo no confirmó el aumento esperado de $${expectedIncrease.toFixed(2)}.`
        };
      }
      return { ok: true, username: user.alias, response, verification };
    } catch (error) {
      lastError = error;
      if (!isInvalidMultiPanelSession(error) || attempt > 0) throw error;
      await getMultiPanelSessionFromOpenTab();
      validatedUser = null;
    }
  }
  throw lastError || new Error("No se pudo completar el depósito en MultiPanel.");
}

function validateExchange(data, suffixes) {
  if (!data || !["ganamos", "multipanel"].includes(data.fromPlatform) ||
    !["ganamos", "multipanel"].includes(data.toPlatform) ||
    data.fromPlatform === data.toPlatform ||
    typeof data.fromUsername !== "string" ||
    typeof data.toUsername !== "string" ||
    typeof data.monto !== "string" ||
    !/^\d+(?:[.,]\d{1,2})?$/.test(data.monto) ||
    Number(data.monto.replace(",", ".")) <= 0) {
    return false;
  }
  const fromValid = data.fromPlatform === "ganamos"
    ? isValidUsername(data.fromUsername, suffixes.ganamos)
    : isValidMultiPanelUsername(data.fromUsername, suffixes.multipanel);
  const toValid = data.toPlatform === "ganamos"
    ? isValidUsername(data.toUsername, suffixes.ganamos)
    : isValidMultiPanelUsername(data.toUsername, suffixes.multipanel);
  return fromValid && toValid;
}

async function runExchangeRequest(data) {
  const amount = data.monto;
  await runTransactionRequest({
    operation: "withdrawal",
    platform: data.fromPlatform,
    nombre: data.fromUsername,
    monto: amount
  });

  try {
    const depositResult = await runTransactionRequest({
      operation: "deposit",
      platform: data.toPlatform,
      nombre: data.toUsername,
      monto: amount
    });
    if (depositResult.verification?.status === "pending") {
      return {
        ok: false,
        partial: true,
        verificationPending: true,
        error: `El retiro de $${amount} en ${data.fromPlatform === "ganamos" ? "Ganamos" : "MultiPanel"} se confirmó, pero el depósito en ${data.toPlatform === "ganamos" ? "Ganamos" : "MultiPanel"} quedó pendiente de verificación. Revisá ambos saldos antes de repetir la operación.`
      };
    }
  } catch (error) {
    return {
      ok: false,
      partial: true,
      error: `El retiro de $${amount} en ${data.fromPlatform === "ganamos" ? "Ganamos" : "MultiPanel"} se confirmó, pero no se pudo acreditar en ${data.toPlatform === "ganamos" ? "Ganamos" : "MultiPanel"}. Verificá ambos saldos antes de volver a operar. Detalle: ${error.message}`
    };
  }

  return { ok: true };
}

async function resetUserPassword(data) {
  const { ganamos, multipanel } = await getPlatformSuffixes();
  const validUsername = data?.platform === "ganamos"
    ? isValidUsername(data.nombre, ganamos)
    : data?.platform === "multipanel" && isValidMultiPanelUsername(data.nombre, multipanel);
  if (!validUsername) throw new Error("El usuario no tiene el sufijo configurado para la plataforma seleccionada.");

  const { userCreationPassword } = await getExtensionState("userCreationPassword");
  if (typeof userCreationPassword !== "string" || !userCreationPassword.trim()) {
    throw new Error("Configurá la contraseña automática en las opciones del perfil que ejecuta las solicitudes.");
  }

  if (data.platform === "ganamos") {
    const user = await findGanamosUser({ nombre: data.nombre });
    if (!/^\d+$/.test(String(user.userId ?? ""))) {
      throw new Error("Ganamos encontró el usuario, pero no devolvió un ID válido para cambiar la contraseña.");
    }
    const payload = await requestGanamosJson(
      `/api/agent_admin/user/${encodeURIComponent(user.userId)}/`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json;charset=UTF-8" },
        body: JSON.stringify({ password: userCreationPassword })
      }
    );
    if (payload?.status !== 0 || String(payload?.result?.user?.id ?? "") !== String(user.userId)) {
      throw new Error(payload?.error_message || "Ganamos no confirmó el cambio de contraseña.");
    }
    return { ok: true, username: user.username };
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await findMultiPanelUser(data.nombre.trim());
      await requestMultiPanelForm("/api/admin/updatePasswordAgent", {
        session: user.session,
        company: "MULT",
        user: user.user,
        db: user.db,
        password: userCreationPassword
      });
      try {
        await requestMultiPanelForm("/api/admin/updateUserWebsitesPlayer", {
          session: user.session,
          company: "MULT",
          user: `${user.db}.${user.user}`,
          websites: JSON.stringify(MULTIPANEL_WEBSITES)
        });
      } catch (error) {
        const websitesError = new Error(
          `La contraseña se actualizó, pero no se pudieron activar todos los sitios: ${error.message}`
        );
        if (error?.code != null) websitesError.code = error.code;
        throw websitesError;
      }
      return { ok: true, username: user.alias };
    } catch (error) {
      lastError = error;
      if (!isInvalidMultiPanelSession(error) || attempt > 0) throw error;
      await getMultiPanelSessionFromOpenTab();
    }
  }
  throw lastError || new Error("No se pudo cambiar la contraseña en MultiPanel.");
}

const BRIDGE_ORIGIN = "http://127.0.0.1:32145";
const API_MESSAGE_TYPES = new Set([
  "AGENT_BALANCE_REQUEST",
  "MULTIPANEL_AGENT_BALANCE_REQUEST",
  "USER_SEARCH_REQUEST",
  "TOP_USER_BALANCES_REQUEST",
  "SPORT_BETS_REQUEST",
  "BALANCE_REQUEST",
  "TRANSACTION_REQUEST",
  "EXCHANGE_REQUEST",
  "WITHDRAWAL_HISTORY_REQUEST",
  "CREATE_USER_REQUEST",
  "PASSWORD_RESET_REQUEST"
]);

function getSenderOrigin(sender) {
  try {
    return new URL(sender.url || "").origin;
  } catch {
    return "";
  }
}

function isWhatsAppSender(sender) {
  return sender.frameId === 0 && getSenderOrigin(sender) === WHATSAPP_ORIGIN;
}

function isStateStorageSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0) return false;
  const origin = getSenderOrigin(sender);
  if (origin === WHATSAPP_ORIGIN || origin === MULTIPANEL_WEB_ORIGIN) return true;
  return sender.url === chrome.runtime.getURL("options.html");
}

async function getBridgeSettings() {
  const { bridgeRole = "standalone", bridgeToken = "" } = await getProfileRuntimeState();
  return { role: bridgeRole, token: bridgeToken };
}

function isValidActiveBonusConfig(config) {
  if (config === null) return true;
  if (!config || typeof config !== "object" || typeof config.enabled !== "boolean") return false;
  if (config.copyBonus !== undefined && typeof config.copyBonus !== "boolean") return false;
  if (config.invertDepositButtons !== undefined &&
    typeof config.invertDepositButtons !== "boolean") return false;
  if (config.activeAdvertising !== undefined &&
    typeof config.activeAdvertising !== "boolean") return false;
  if (config.markUnreadAfterStatusUpdate !== undefined &&
    typeof config.markUnreadAfterStatusUpdate !== "boolean") return false;
  if (config.mouseSideButtonsEnabled !== undefined &&
    typeof config.mouseSideButtonsEnabled !== "boolean") return false;
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

function isValidBridgeProfileIds(profileIds) {
  return Array.isArray(profileIds) &&
    profileIds.length <= 1000 &&
    profileIds.every((profileId) =>
      typeof profileId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(profileId)) &&
    new Set(profileIds).size === profileIds.length;
}

async function getStatusExcludedProfileIds() {
  const stored = await chrome.storage.local.get(STATUS_EXCLUDED_PROFILE_IDS_KEY);
  const profileIds = stored[STATUS_EXCLUDED_PROFILE_IDS_KEY] ?? [];
  if (!isValidBridgeProfileIds(profileIds)) {
    throw new Error("La lista de excepciones de estados no es válida.");
  }
  return profileIds;
}

async function publishActiveBonusConfig() {
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  const stored = await getExtensionState("activeBonusConfig");
  const config = stored.activeBonusConfig ?? null;
  if (!isValidActiveBonusConfig(config)) {
    throw new Error("La configuración del bono activo no es válida y no se puede sincronizar.");
  }
  const excludedProfileIds = await getStatusExcludedProfileIds();
  return bridgeFetch("/v1/bonus-config", token, {
    method: "POST",
    timeoutMs: 10_000,
    body: { config, excludedProfileIds }
  });
}

async function getConnectedStatusProfiles() {
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  const [response, excludedProfileIds, primaryProfile] = await Promise.all([
    bridgeFetch("/v1/status-profiles", token, { timeoutMs: 10_000 }),
    getStatusExcludedProfileIds(),
    getEnrolledProfileIdentity()
  ]);
  if (!response?.ok || !Array.isArray(response.profiles) ||
    response.profiles.length > 1000 ||
    response.profiles.some((profile) =>
      typeof profile?.profileId !== "string" ||
      !isValidBridgeProfileIds([profile.profileId]) ||
      typeof profile.name !== "string" ||
      !profile.name.trim() || profile.name.length > 120) ||
    new Set(response.profiles.map((profile) => profile.profileId)).size !==
      response.profiles.length) {
    throw new Error(response?.error || "El puente devolvió una lista de perfiles conectados no válida.");
  }
  return { profiles: response.profiles, excludedProfileIds, primaryProfile };
}

async function getEnrolledProfileIdentity() {
  const identity = await requestDataApi("/v1/identity");
  if (typeof identity.profileId !== "string" ||
    !isValidBridgeProfileIds([identity.profileId]) ||
    typeof identity.profileName !== "string" ||
    !identity.profileName.trim() || identity.profileName.length > 120) {
    throw new Error("La API no devolvió la identidad de enrolamiento de este perfil.");
  }
  return {
    profileId: identity.profileId,
    name: identity.profileName.trim()
  };
}

async function setStatusExcludedProfileIds(profileIds) {
  if (!isValidBridgeProfileIds(profileIds)) {
    throw new Error("La lista de excepciones de estados no es válida.");
  }
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  await chrome.storage.local.set({
    [STATUS_EXCLUDED_PROFILE_IDS_KEY]: profileIds
  });
  let warning;
  try {
    await publishActiveBonusConfig();
  } catch (error) {
    warning = `Las excepciones se guardaron, pero no se pudieron sincronizar todavía: ${error.message}`;
  }
  return { profileIds, warning };
}

async function publishHiddenAdvertisingProfiles() {
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  const stored = await getExtensionState(HIDDEN_ADVERTISING_PROFILES_KEY);
  const profileIds = stored[HIDDEN_ADVERTISING_PROFILES_KEY] ?? [];
  if (!isValidBridgeProfileIds(profileIds)) {
    throw new Error("La lista de paneles minimizados no es válida y no se puede sincronizar.");
  }
  return bridgeFetch("/v1/advertising-hidden-profiles", token, {
    method: "POST",
    timeoutMs: 10_000,
    body: { profileIds }
  });
}

function isValidPlatformOutageConfig(config) {
  return config !== null && typeof config === "object" && !Array.isArray(config) &&
    typeof config.ganamos === "boolean" &&
    typeof config.multipanel === "boolean" &&
    Object.keys(config).every((key) => ["ganamos", "multipanel"].includes(key));
}

async function publishPlatformOutageConfig() {
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  const stored = await getExtensionState(PLATFORM_OUTAGE_CONFIG_KEY);
  const config = stored[PLATFORM_OUTAGE_CONFIG_KEY] ?? { ganamos: false, multipanel: false };
  if (!isValidPlatformOutageConfig(config)) {
    throw new Error("La configuración de plataformas caídas no es válida y no se puede sincronizar.");
  }
  return bridgeFetch("/v1/platform-outages", token, {
    method: "POST",
    timeoutMs: 10_000,
    body: { config }
  });
}

async function syncPlatformOutageConfig(revision) {
  const { role, token } = await getBridgeSettings();
  if (role !== "secondary" || !token) {
    throw new Error("Este perfil no está configurado como secundario.");
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("La versión de configuración de plataformas caídas recibida no es válida.");
  }
  const update = await bridgeFetch(
    `/v1/platform-outages?revision=${revision}`,
    token,
    { timeoutMs: 25_000 }
  );
  if (!update?.ok || !Number.isSafeInteger(update.revision) || update.revision < 0) {
    throw new Error("El puente devolvió una versión de plataformas caídas no válida.");
  }
  if (!update.changed) return update;
  if (!isValidPlatformOutageConfig(update.config)) {
    throw new Error("El puente devolvió una configuración de plataformas caídas no válida.");
  }
  await setExtensionState({ [PLATFORM_OUTAGE_CONFIG_KEY]: update.config });
  return update;
}

async function syncActiveBonusConfig(revision, profileId, profileName) {
  const { role, token } = await getBridgeSettings();
  if (role !== "secondary" || !token) {
    throw new Error("Este perfil no está configurado como secundario.");
  }
  if (!Number.isSafeInteger(revision) || revision < 0 ||
    typeof profileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(profileId) ||
    typeof profileName !== "string" || !profileName.trim() ||
    profileName.length > 120) {
    throw new Error("La versión de configuración recibida no es válida.");
  }
  const { statusBridgeProfileId } = await chrome.storage.local.get("statusBridgeProfileId");
  if (statusBridgeProfileId !== profileId) {
    throw new Error("La identidad del perfil secundario no coincide.");
  }
  const update = await bridgeFetch(
    `/v1/bonus-config?revision=${revision}&profileId=${encodeURIComponent(profileId)}&profileName=${encodeURIComponent(profileName.trim())}`,
    token, {
    timeoutMs: 25_000
  });
  if (!update?.ok || !Number.isSafeInteger(update.revision) || update.revision < 0) {
    throw new Error("El puente devolvió una versión de bono activo no válida.");
  }
  if (!update.changed) return update;
  if (!isValidActiveBonusConfig(update.config)) {
    throw new Error("El puente devolvió una configuración de bono activo no válida.");
  }
  if (update.config === null) {
    await removeExtensionState("activeBonusConfig");
  } else {
    await setExtensionState({ activeBonusConfig: update.config });
  }
  return update;
}

async function syncHiddenAdvertisingProfiles(revision) {
  const { role, token } = await getBridgeSettings();
  if (role !== "secondary" || !token) {
    throw new Error("Este perfil no está configurado como secundario.");
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("La versión de paneles minimizados recibida no es válida.");
  }
  const update = await bridgeFetch(
    `/v1/advertising-hidden-profiles?revision=${revision}`,
    token,
    { timeoutMs: 25_000 }
  );
  if (!update?.ok || !Number.isSafeInteger(update.revision) || update.revision < 0) {
    throw new Error("El puente devolvió una versión de paneles minimizados no válida.");
  }
  if (!update.changed) return update;
  if (!isValidBridgeProfileIds(update.profileIds)) {
    throw new Error("El puente devolvió una lista de paneles minimizados no válida.");
  }
  await setExtensionState({ [HIDDEN_ADVERTISING_PROFILES_KEY]: update.profileIds });
  return update;
}

async function publishStatusUpdate(message) {
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  const action = message.action ?? "replace";
  const needsImage = action !== "delete";
  if (typeof message.id !== "string" || !/^[0-9a-f-]{36}$/i.test(message.id) ||
    !["delete", "upload", "replace"].includes(action) ||
    needsImage && (typeof message.image !== "string" ||
      message.image.length > Math.ceil((10 * 1024 * 1024) / 3) * 4) ||
    !needsImage && message.image !== undefined) {
    throw new Error("La solicitud de cambio de estado no es válida.");
  }
  const excludedProfileIds = await getStatusExcludedProfileIds();
  const receipt = await bridgeFetch("/v1/status-update", token, {
    method: "POST",
    timeoutMs: 20_000,
    body: {
      id: message.id,
      action,
      ...(needsImage ? { image: message.image } : {}),
      excludedProfileIds
    }
  });
  if (!receipt?.ok || receipt.id !== message.id || receipt.action !== action ||
    !Array.isArray(receipt.targets)) {
    throw new Error(
      "El puente no confirmó la acción solicitada. Reiniciá el puente local y volvé a intentarlo; no se ejecutó el cambio en este perfil."
    );
  }
  return receipt;
}

async function pollStatusUpdate(message) {
  const { role, token } = await getBridgeSettings();
  if (role !== "secondary" || !token) {
    throw new Error("Este perfil no está configurado como secundario.");
  }
  if (!Number.isSafeInteger(message.revision) || message.revision < 0 ||
    typeof message.profileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(message.profileId) ||
    typeof message.profileName !== "string" || !message.profileName.trim() ||
    message.profileName.length > 120) {
    throw new Error("La consulta de cambios de estado no es válida.");
  }
  const { statusBridgeProfileId } = await chrome.storage.local.get("statusBridgeProfileId");
  if (statusBridgeProfileId !== message.profileId) {
    throw new Error("La identidad del perfil secundario no coincide.");
  }
  return bridgeFetch(
    `/v1/status-update?revision=${message.revision}&profileId=${encodeURIComponent(message.profileId)}&profileName=${encodeURIComponent(message.profileName.trim())}`,
    token,
    { timeoutMs: 25_000 }
  );
}

async function reportStatusUpdateResult(message) {
  const { role, token } = await getBridgeSettings();
  if (role !== "secondary" || !token) {
    throw new Error("Este perfil no está configurado como secundario.");
  }
  if (typeof message.id !== "string" || !/^[0-9a-f-]{36}$/i.test(message.id) ||
    typeof message.profileId !== "string" || typeof message.ok !== "boolean" ||
    (message.error !== undefined && typeof message.error !== "string")) {
    throw new Error("El resultado del cambio de estado no es válido.");
  }
  const { statusBridgeProfileId } = await chrome.storage.local.get("statusBridgeProfileId");
  if (statusBridgeProfileId !== message.profileId) {
    throw new Error("La identidad del perfil secundario no coincide.");
  }
  return bridgeFetch("/v1/status-update-result", token, {
    method: "POST",
    timeoutMs: 10_000,
    body: {
      id: message.id,
      profileId: message.profileId,
      ok: message.ok,
      ...(message.error ? { error: message.error.slice(0, 300) } : {})
    }
  });
}

async function getStatusUpdateResults(id) {
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error("La consulta de resultados no es válida.");
  }
  return bridgeFetch(`/v1/status-update-result?id=${encodeURIComponent(id)}`, token, {
    timeoutMs: 10_000
  });
}

async function bridgeFetch(path, token, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 95_000);
  try {
    const response = await fetch(`${BRIDGE_ORIGIN}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: controller.signal
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("El puente local devolvió una respuesta no válida.");
    }
    if (!response.ok) {
      throw new Error(result?.error || `El puente local respondió HTTP ${response.status}.`);
    }
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("El puente local agotó el tiempo de espera. Verificá el estado antes de repetir una operación.");
    }
    if (error instanceof TypeError) {
      throw new Error("No se pudo verificar la respuesta del puente local. Comprobá la operación en la plataforma antes de volver a intentarla.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sendRequestThroughBridge(message) {
  const { token } = await getBridgeSettings();
  if (typeof token !== "string" || !token) {
    return { ok: false, error: "Configurá el código de emparejamiento del perfil secundario en las opciones de la extensión." };
  }
  return bridgeFetch("/v1/request", token, {
    method: "POST",
    timeoutMs: 95_000,
    body: { id: crypto.randomUUID(), message }
  });
}

function getRemoteCreateOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("La dirección de la PC destino no es válida.");
  }
  if (url.protocol !== "http:" || url.port !== "32146" || url.pathname !== "/" ||
    url.search || url.hash || url.username || url.password) {
    throw new Error("La dirección de la PC destino no usa el puerto remoto autorizado.");
  }
  const host = url.hostname.toLowerCase();
  const parts = host.split(".");
  const isIPv4 = parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const isPrivateIPv4 = isIPv4 && (
    Number(parts[0]) === 10 ||
    Number(parts[0]) === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31 ||
    Number(parts[0]) === 192 && Number(parts[1]) === 168 ||
    Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127 ||
    Number(parts[0]) === 169 && Number(parts[1]) === 254 ||
    Number(parts[0]) === 127
  );
  const ipv6Host = host.startsWith("[") ? host.slice(1, -1) : "";
  const isPrivateIPv6 = ipv6Host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ipv6Host) ||
    /^fe[89ab][0-9a-f]:/i.test(ipv6Host);
  const isPrivateHostname = /^[a-z0-9.-]+$/.test(host) &&
    /\.(local|lan|internal)$/.test(host);
  if (!isPrivateIPv4 && !isPrivateIPv6 && !isPrivateHostname) {
    throw new Error("La PC destino debe tener una dirección de red privada.");
  }
  return url.origin;
}

async function sendRemoteOperation(destinationId, message, timeoutMs = 95_000) {
  const stored = await getExtensionState("remoteCreateDestinations");
  const destination = (Array.isArray(stored.remoteCreateDestinations)
    ? stored.remoteCreateDestinations
    : []).find((item) => item?.id === destinationId);
  if (!destination) throw new Error("La PC elegida no está configurada en las opciones de la extensión.");

  const origin = getRemoteCreateOrigin(destination.url);
  if (typeof destination.token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(destination.token)) {
    throw new Error(`El código remoto de ${destination.name || "la PC destino"} no es válido.`);
  }
  if (message.type === "CREATE_USER_REQUEST") {
    if (!["ganamos", "multipanel"].includes(message.data?.platform) ||
      typeof message.data.username !== "string") {
      throw new Error("La plataforma o el nombre de usuario para creación remota no son válidos.");
    }
    const suffix = message.data.platform === "ganamos"
      ? destination.ganamosSuffix
      : destination.multiPanelSuffix;
    if (!/^[a-z]$/i.test(suffix || "") ||
      !new RegExp(`^[a-z0-9]+${suffix}+$`, "i").test(message.data.username) ||
      message.data.username.length > 64) {
      throw new Error(`El usuario no cumple el sufijo configurado para ${destination.name || "la PC destino"}.`);
    }
  } else if (message.type === "PASSWORD_RESET_REQUEST") {
    if (!["ganamos", "multipanel"].includes(message.data?.platform) ||
      typeof message.data.nombre !== "string") {
      throw new Error("La plataforma o el nombre de usuario para restaurar la contraseña no son válidos.");
    }
    const suffix = message.data.platform === "ganamos"
      ? destination.ganamosSuffix
      : destination.multiPanelSuffix;
    if (!/^[a-z]$/i.test(suffix || "") ||
      !new RegExp(`^[a-z0-9]+${suffix}+$`, "i").test(message.data.nombre) ||
      message.data.nombre.length > 64) {
      throw new Error(`El usuario no cumple el sufijo configurado para ${destination.name || "la PC destino"}.`);
    }
  } else if (message.type === "USER_SEARCH_REQUEST") {
    if (!/^\d{4}$/.test(message.data?.digits || "")) {
      throw new Error("La búsqueda remota requiere exactamente cuatro números.");
    }
  } else if (!["AGENT_BALANCE_REQUEST", "MULTIPANEL_AGENT_BALANCE_REQUEST"].includes(message.type) ||
    message.data !== undefined) {
    throw new Error("La operación remota no está permitida.");
  }

  const targetUrl = new URL(origin);
  const permissionPattern = `${targetUrl.protocol}//${targetUrl.hostname}/*`;
  const permission = await chrome.permissions.contains({ origins: [permissionPattern] });
  if (!permission) {
    throw new Error(`Falta permiso de conexión para ${destination.name || "la PC destino"}. Volvé a guardar las opciones.`);
  }

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    message
  });
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(destination.token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const requestSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}\n${nonce}\n${body}`)
  );
  const toHex = (bytes) => [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/v1/remote-operation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridge-timestamp": timestamp,
        "x-bridge-nonce": nonce,
        "x-bridge-signature": toHex(requestSignature)
      },
      body,
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) {
      let failure;
      try {
        failure = JSON.parse(await response.text());
      } catch {
        throw new Error("La PC destino devolvió una respuesta no válida.");
      }
      const result = failure;
      throw new Error(result?.error || `La PC destino respondió HTTP ${response.status}.`);
    }
    const responseBody = await response.text();
    const responseSignature = response.headers.get("x-bridge-response-signature") || "";
    const expectedResponseSignature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}\n${nonce}\n${responseBody}`)
    );
    const expectedHex = toHex(expectedResponseSignature);
    let signaturesMatch = responseSignature.length === expectedHex.length;
    for (let index = 0; signaturesMatch && index < expectedHex.length; index += 1) {
      signaturesMatch = responseSignature.charCodeAt(index) === expectedHex.charCodeAt(index);
    }
    if (!signaturesMatch) {
      throw new Error("No se pudo verificar la respuesta firmada de la PC destino.");
    }
    try {
      return JSON.parse(responseBody);
    } catch {
      throw new Error("La PC destino devolvió una respuesta no válida.");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Se agotó el tiempo de espera de la PC destino.");
    }
    if (error instanceof TypeError) {
      throw new Error(`No se pudo conectar con ${destination.name || "la PC destino"}. Verificá el bridge, la dirección y el firewall de red privada.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sendRemoteCreateUserRequest(data) {
  return sendRemoteOperation(data.destinationId, {
    type: "CREATE_USER_REQUEST",
    data: { platform: data.platform, username: data.username }
  });
}

async function sendRemotePasswordResetRequest(data) {
  if (!["ganamos", "multipanel"].includes(data?.platform) ||
    typeof data?.nombre !== "string") {
    throw new Error("El usuario o la plataforma no son válidos para restaurar la contraseña.");
  }
  return sendRemoteOperation(data.destinationId, {
    type: "PASSWORD_RESET_REQUEST",
    data: { platform: data.platform, nombre: data.nombre }
  });
}

async function getRemoteAgentBalance(data) {
  if (!["ganamos", "multipanel"].includes(data?.platform)) {
    throw new Error("Plataforma no válida para consultar el balance remoto.");
  }
  const messageType = data.platform === "ganamos"
    ? "AGENT_BALANCE_REQUEST"
    : "MULTIPANEL_AGENT_BALANCE_REQUEST";
  return sendRemoteOperation(data.destinationId, { type: messageType }, 60_000);
}

async function getRemoteUserSearch(data) {
  if (!/^\d{4}$/.test(data?.digits || "")) {
    throw new Error("La búsqueda remota requiere exactamente cuatro números.");
  }
  return sendRemoteOperation(data.destinationId, {
    type: "USER_SEARCH_REQUEST",
    data: { digits: data.digits }
  }, 95_000);
}

function validateApiMessage(message, suffixes) {
  if (!API_MESSAGE_TYPES.has(message?.type)) return false;
  if (message.type === "AGENT_BALANCE_REQUEST" ||
    message.type === "MULTIPANEL_AGENT_BALANCE_REQUEST") return message.data === undefined;
  if (message.type === "TOP_USER_BALANCES_REQUEST") {
    return ["ganamos", "multipanel"].includes(message.data?.platform) &&
      message.data?.page === 0;
  }
  if (message.type === "USER_SEARCH_REQUEST") return /^\d{4}$/.test(message.data?.digits || "");

  const platform = message.data?.platform || "ganamos";
  if (message.type === "SPORT_BETS_REQUEST") {
    return platform === "multipanel"
      ? isValidMultiPanelUsername(message.data?.nombre, suffixes.multipanel)
      : platform === "ganamos" && isValidUsername(message.data?.nombre, suffixes.ganamos);
  }
  if (message.type === "CREATE_USER_REQUEST") {
    return platform === "multipanel"
      ? isValidMultiPanelUsername(message.data?.username, suffixes.multipanel)
      : platform === "ganamos" && isValidUsername(message.data?.username, suffixes.ganamos);
  }
  if (message.type === "PASSWORD_RESET_REQUEST") {
    return platform === "multipanel"
      ? isValidMultiPanelUsername(message.data?.nombre, suffixes.multipanel)
      : platform === "ganamos" && isValidUsername(message.data?.nombre, suffixes.ganamos);
  }
  if (message.type === "BALANCE_REQUEST") {
    return platform === "multipanel"
      ? isValidMultiPanelUsername(message.data?.nombre, suffixes.multipanel)
      : platform === "ganamos" && isValidUsername(message.data?.nombre, suffixes.ganamos);
  }
  if (message.type === "WITHDRAWAL_HISTORY_REQUEST") {
    return isValidUsername(message.data?.nombre, suffixes.ganamos);
  }
  if (message.type === "EXCHANGE_REQUEST") {
    return validateExchange(message.data, suffixes);
  }
  return validateTransaction({ ...message.data, platform }, suffixes);
}

async function executeApiMessage(message) {
  const suffixes = [
    "AGENT_BALANCE_REQUEST",
    "MULTIPANEL_AGENT_BALANCE_REQUEST",
    "USER_SEARCH_REQUEST",
    "TOP_USER_BALANCES_REQUEST"
  ].includes(message.type)
    ? null
    : await getPlatformSuffixes();
  if (!validateApiMessage(message, suffixes)) {
    return { ok: false, error: "Solicitud no válida." };
  }
  if (message.type === "AGENT_BALANCE_REQUEST") return getGanamosAgentBalance();
  if (message.type === "MULTIPANEL_AGENT_BALANCE_REQUEST") return getMultiPanelAgentBalance();
  if (message.type === "USER_SEARCH_REQUEST") return searchUsersByDigits(message.data.digits);
  if (message.type === "TOP_USER_BALANCES_REQUEST") {
    return getTopPlatformUsersByBalance(message.data);
  }
  if (message.type === "SPORT_BETS_REQUEST") {
    return message.data.platform === "multipanel"
      ? getMultiPanelActiveSportBets(message.data)
      : getGanamosActiveSportBets(message.data);
  }
  if (message.type === "WITHDRAWAL_HISTORY_REQUEST") {
    return {
      ok: false,
      error: "La consulta de historial está deshabilitada: no se proporcionó su endpoint REST."
    };
  }
  if (message.type === "CREATE_USER_REQUEST") {
    return message.data.platform === "multipanel"
      ? createMultiPanelUser(message.data)
      : createGanamosUser(message.data);
  }
  if (message.type === "PASSWORD_RESET_REQUEST") return resetUserPassword(message.data);
  if (message.type === "EXCHANGE_REQUEST") return runExchangeRequest(message.data);
  if (message.type === "BALANCE_REQUEST") {
    const platform = message.data?.platform || "ganamos";
    const cacheKey = withdrawalUserCacheKey(platform, message.data?.nombre || "");
    if (message.data?.force === true) withdrawalUserCache.delete(cacheKey);
    return platform === "multipanel"
      ? getMultiPanelBalance(message.data)
      : findGanamosUser(message.data).then((user) => {
          if (message.data?.force === true) {
            rememberWithdrawalUser("ganamos", message.data.nombre, user);
          }
          return user;
        });
  }
  return runTransactionRequest(message.data);
}

async function runInConfiguredProfile(message) {
  const { role } = await getBridgeSettings();
  if (role === "secondary") return sendRequestThroughBridge(message);
  return executeApiMessage(message);
}

async function startStatusDebuggerSession(tabId) {
  const { role } = await getBridgeSettings();
  if (!["primary", "secondary"].includes(role)) {
    throw new Error("El perfil debe estar configurado como principal o secundario.");
  }
  if (statusDebuggerSessions.has(tabId)) {
    throw new Error("Ya hay una automatización de estados activa en esta pestaña.");
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    throw new Error(
      `Chrome no permitió controlar esta pestaña. Aceptá el permiso debugger y cerrá DevTools u otra herramienta conectada a la pestaña. ${error.message || ""}`.trim()
    );
  }
  statusDebuggerSessions.set(tabId, true);
}

async function clickStatusDebuggerTarget(tabId, message) {
  if (!statusDebuggerSessions.has(tabId)) {
    throw new Error("La sesión de control de Chrome no está activa.");
  }
  if (!Number.isFinite(message.x) || !Number.isFinite(message.y) ||
    message.x < 0 || message.y < 0 || message.x > 20_000 || message.y > 20_000) {
    throw new Error("La posición del control de WhatsApp no es válida.");
  }
  const target = { tabId };
  const point = { x: message.x, y: message.y, button: "left" };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    ...point,
    type: "mouseMoved",
    buttons: 0
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  let pressed = false;
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...point,
      type: "mousePressed",
      clickCount: 1,
      buttons: 1
    });
    pressed = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    if (pressed) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        ...point,
        type: "mouseReleased",
        clickCount: 1,
        buttons: 0
      });
    }
  }
}

async function pressStatusDebuggerKey(tabId, message) {
  if (!statusDebuggerSessions.has(tabId)) {
    throw new Error("La sesión de control de Chrome no está activa.");
  }
  if (message.key !== "Escape") {
    throw new Error("La tecla solicitada no está permitida.");
  }
  const target = { tabId };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
}

async function stopStatusDebuggerSession(tabId) {
  if (!statusDebuggerSessions.has(tabId)) return;
  statusDebuggerSessions.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    throw new Error(
      `No se pudo cerrar la sesión debugger de WhatsApp: ${error.message || "error desconocido."}`
    );
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") statusDebuggerSessions.delete(source.tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DATA_PROFILE_SELECTOR_GET") {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      sender.url !== chrome.runtime.getURL("options.html")) {
      sendResponse({ ok: false, error: "Origen no autorizado para consultar la identidad local del perfil." });
      return;
    }
    getDataProfileSelector()
      .then((profileSelector) => sendResponse({ ok: true, profileSelector }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo persistir la identidad local del perfil."
      }));
    return true;
  }

  if (["STATE_GET", "STATE_SET", "STATE_REMOVE", "STATE_POLL"].includes(message?.type)) {
    if (!isStateStorageSender(sender)) {
      sendResponse({ ok: false, error: "El origen no está autorizado para acceder al estado PostgreSQL." });
      return;
    }
    const operation = message.type === "STATE_GET"
      ? getExtensionState(message.keys ?? null).then((values) => ({
          ok: true,
          values,
          revision: cachedStateRevision
        }))
      : message.type === "STATE_SET"
      ? writeExtensionState(message.changes, [], message.expectedRevision)
        .then(({ revision, changeRevision }) => ({ ok: true, revision, changeRevision }))
      : message.type === "STATE_REMOVE"
        ? writeExtensionState({}, message.removes, message.expectedRevision)
          .then(({ revision, changeRevision }) => ({ ok: true, revision, changeRevision }))
          : pollExtensionState();
    operation.then(sendResponse).catch((error) => sendResponse({
      ok: false,
      error: error.message || "Falló la operación de estado PostgreSQL."
    }));
    return true;
  }

  if (message?.type === "MOVEMENTS_GET") {
    if (!isStateStorageSender(sender)) {
      sendResponse({ ok: false, error: "El origen no está autorizado para consultar movimientos." });
      return;
    }
    const filters = message.filters && typeof message.filters === "object" &&
      !Array.isArray(message.filters) ? message.filters : {};
    const allowedFilters = new Set([
      "accountIds", "contactKey", "ganamosUsername", "legacyContactKeys", "multipanelUsername",
      "operation", "since", "limit", "ownProfile"
    ]);
    if (Object.keys(filters).some((key) => !allowedFilters.has(key)) ||
      (Object.hasOwn(filters, "ownProfile") && typeof filters.ownProfile !== "boolean") ||
      (Object.hasOwn(filters, "accountIds") &&
        (!Array.isArray(filters.accountIds) || filters.accountIds.length < 1 ||
          filters.accountIds.length > 4 ||
          filters.accountIds.some((accountId) =>
            typeof accountId !== "string" ||
            !/^(ganamos|multipanel):\d{4,20}$/.test(accountId)) ||
          new Set(filters.accountIds).size !== filters.accountIds.length)) ||
      (Object.hasOwn(filters, "legacyContactKeys") &&
        (!Array.isArray(filters.legacyContactKeys) || filters.legacyContactKeys.length < 1 ||
          filters.legacyContactKeys.length > 40 ||
          filters.legacyContactKeys.some((contactKey) =>
            typeof contactKey !== "string" || !contactKey || contactKey.length > 2048 ||
            /[\u0000-\u001f\u007f]/.test(contactKey)) ||
          new Set(filters.legacyContactKeys).size !== filters.legacyContactKeys.length ||
          Object.hasOwn(filters, "accountIds") && !Array.isArray(filters.accountIds))) ||
      (Object.hasOwn(filters, "contactKey") &&
        (typeof filters.contactKey !== "string" || !filters.contactKey)) ||
      (["ganamosUsername", "multipanelUsername"].some((key) =>
        Object.hasOwn(filters, key) &&
        (typeof filters[key] !== "string" || !filters[key] || filters[key].length > 128 ||
          /[\u0000-\u001f\u007f]/.test(filters[key])))) ||
      (Object.hasOwn(filters, "operation") &&
        !["deposit", "withdrawal", "exchange"].includes(filters.operation)) ||
      (Object.hasOwn(filters, "since") &&
        (!Number.isSafeInteger(filters.since) || filters.since < 0)) ||
      (Object.hasOwn(filters, "limit") &&
        (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 10000))) {
      sendResponse({ ok: false, error: "Los filtros de movimientos solicitados no son válidos." });
      return;
    }
    const query = new URLSearchParams();
    if (filters.ownProfile === true) query.set("source", "profile");
    if (Array.isArray(filters.accountIds)) {
      for (const accountId of filters.accountIds) query.append("accountId", accountId);
    }
    if (Array.isArray(filters.legacyContactKeys)) {
      for (const contactKey of filters.legacyContactKeys) {
        query.append("legacyContactKey", contactKey);
      }
    }
    if (typeof filters.contactKey === "string") query.set("contactKey", filters.contactKey);
    if (typeof filters.ganamosUsername === "string") {
      query.set("ganamosUsername", filters.ganamosUsername);
    }
    if (typeof filters.multipanelUsername === "string") {
      query.set("multipanelUsername", filters.multipanelUsername);
    }
    if (typeof filters.operation === "string") query.set("operation", filters.operation);
    if (Number.isSafeInteger(filters.since)) query.set("since", String(filters.since));
    if (Number.isSafeInteger(filters.limit)) query.set("limit", String(filters.limit));
    (async () => {
      let response;
      try {
        response = await requestDataApi(`/v1/movements?${query}`);
      } catch (error) {
        const hasUsernameFilters = query.has("ganamosUsername") || query.has("multipanelUsername");
        if (error.code !== "invalid_movement_query" || !hasUsernameFilters) throw error;
        const compatibleQuery = new URLSearchParams(query);
        compatibleQuery.delete("ganamosUsername");
        compatibleQuery.delete("multipanelUsername");
        console.warn(
          "[Ganamos balance extension] La API de datos debe reiniciarse para habilitar la búsqueda por usuario; se reintenta con los filtros compatibles."
        );
        response = await requestDataApi(`/v1/movements?${compatibleQuery}`);
      }
      if (!Array.isArray(response.movements)) {
        throw new Error("La API PostgreSQL devolvió una lista de movimientos incompleta.");
      }
      sendResponse({ ok: true, movements: response.movements });
    })().catch((error) => sendResponse({
      ok: false,
      error: error.message || "No se pudieron consultar los movimientos."
    }));
    return true;
  }

  if (message?.type === "ADVERTISING_STATS_GET") {
    if (!isStateStorageSender(sender)) {
      sendResponse({ ok: false, error: "El origen no está autorizado para consultar estadísticas." });
      return;
    }
    const excludedProfiles = message.excludedProfiles ?? [];
    if (!Array.isArray(excludedProfiles) || excludedProfiles.length > 1000 ||
      excludedProfiles.some((profileId) =>
        typeof profileId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(profileId)) ||
      new Set(excludedProfiles).size !== excludedProfiles.length) {
      sendResponse({ ok: false, error: "La lista de paneles minimizados no es válida." });
      return;
    }
    const hasCustomRange = message.from !== undefined || message.to !== undefined;
    if (hasCustomRange
      ? !Number.isSafeInteger(message.from) || !Number.isSafeInteger(message.to) ||
        message.from < 0 || message.to <= message.from
      : message.days !== null && ![7, 30, 90].includes(message.days)) {
      sendResponse({ ok: false, error: "El período de estadísticas solicitado no es válido." });
      return;
    }
    const query = new URLSearchParams();
    if (hasCustomRange) {
      query.set("from", String(message.from));
      query.set("to", String(message.to));
    } else if (message.days !== null) {
      query.set("days", String(message.days));
    }
    if (excludedProfiles.length) {
      query.set("excludedProfiles", JSON.stringify(excludedProfiles));
    }
    requestDataApi(`/v1/advertising-stats?${query}`)
      .then((stats) => {
        if (!stats.summary || !Array.isArray(stats.platforms) ||
          !Array.isArray(stats.profiles) || !Array.isArray(stats.hiddenProfiles)) {
          throw new Error("La API PostgreSQL devolvió estadísticas incompletas.");
        }
        sendResponse({ ok: true, stats });
      })
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudieron consultar las estadísticas de publicidad."
      }));
    return true;
  }

  if (message?.type === "WITHDRAWAL_RECORD") {
    if (!isStateStorageSender(sender)) {
      sendResponse({ ok: false, error: "El origen no está autorizado para registrar retiros." });
      return;
    }
    const withdrawal = message.withdrawal;
    if (!withdrawal || typeof withdrawal !== "object" || Array.isArray(withdrawal) ||
      Object.keys(withdrawal).some((key) =>
        !["withdrawalId", "username", "createdAt", "completedAt"].includes(key)) ||
      typeof withdrawal.withdrawalId !== "string" || !withdrawal.withdrawalId.trim() ||
      withdrawal.withdrawalId.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(withdrawal.withdrawalId) ||
      typeof withdrawal.username !== "string" || !withdrawal.username.trim() ||
      withdrawal.username.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(withdrawal.username) ||
      !Number.isSafeInteger(withdrawal.createdAt) || withdrawal.createdAt < 0 ||
      !Number.isSafeInteger(withdrawal.completedAt) ||
      withdrawal.completedAt < withdrawal.createdAt ||
      withdrawal.completedAt > Date.now() + 60_000) {
      sendResponse({ ok: false, error: "Los datos del retiro completado no son válidos." });
      return;
    }
    requestDataApi("/v1/withdrawals", {
      method: "POST",
      body: {
        withdrawalId: withdrawal.withdrawalId.trim(),
        username: withdrawal.username.trim(),
        createdAt: withdrawal.createdAt,
        completedAt: withdrawal.completedAt
      }
    })
      .then((result) => {
        if (result.recorded !== true) {
          throw new Error("La API PostgreSQL no confirmó el registro del retiro.");
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo registrar el retiro completado."
      }));
    return true;
  }

  if (message?.type === "WITHDRAWALS_GET") {
    if (!isStateStorageSender(sender)) {
      sendResponse({ ok: false, error: "El origen no está autorizado para consultar retiros." });
      return;
    }
    const filters = message.filters && typeof message.filters === "object" &&
      !Array.isArray(message.filters) ? message.filters : {};
    if (Object.keys(filters).some((key) => !["from", "to"].includes(key)) ||
      Object.hasOwn(filters, "from") !== Object.hasOwn(filters, "to") ||
      Object.hasOwn(filters, "from") &&
        (!Number.isSafeInteger(filters.from) || filters.from < 0 ||
          !Number.isSafeInteger(filters.to) || filters.to <= filters.from)) {
      sendResponse({ ok: false, error: "Los filtros del historial de retiros no son válidos." });
      return;
    }
    const query = new URLSearchParams();
    if (Object.hasOwn(filters, "from")) {
      query.set("from", String(filters.from));
      query.set("to", String(filters.to));
    }
    requestDataApi(`/v1/withdrawals${query.size ? `?${query}` : ""}`)
      .then((result) => {
        if (!Array.isArray(result.withdrawals) || !Array.isArray(result.profiles)) {
          throw new Error("La API PostgreSQL devolvió un historial de retiros incompleto.");
        }
        sendResponse({
          ok: true,
          withdrawals: result.withdrawals,
          profiles: result.profiles
        });
      })
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudieron consultar los retiros."
      }));
    return true;
  }

  if (message?.type === "MULTIPANEL_SESSION_UPDATE") {
    if (sender.frameId !== 0 || getSenderOrigin(sender) !== MULTIPANEL_WEB_ORIGIN ||
      !isValidMultiPanelSession(message.session)) {
      sendResponse({ ok: false, error: "Actualización de sesión de MultiPanel no válida." });
      return;
    }
    getBridgeSettings()
      .then(({ role }) => {
        if (role === "secondary") throw new Error("La sesión de MultiPanel solo se sincroniza en el perfil principal.");
        return setExtensionState({ multiPanelSession: message.session.trim() });
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "No se pudo guardar la sesión de MultiPanel." }));
    return true;
  }

  if (message?.type === "BRIDGE_BONUS_CONFIG_PUBLISH") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de sincronización no válida." });
      return;
    }
    publishActiveBonusConfig()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo sincronizar la configuración del bono activo."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_BONUS_CONFIG_POLL") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de sincronización no válida." });
      return;
    }
    syncActiveBonusConfig(message.revision, message.profileId, message.profileName)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo recibir la configuración del bono activo."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_STATUS_PROFILES_GET") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de perfiles conectados no válida." });
      return;
    }
    getConnectedStatusProfiles()
      .then(({ profiles, excludedProfileIds, primaryProfile }) =>
        sendResponse({ ok: true, profiles, excludedProfileIds, primaryProfile }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudieron consultar las excepciones de estados."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_PROFILE_NAME_GET") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de nombre de perfil no válida." });
      return;
    }
    getEnrolledProfileIdentity()
      .then((primaryProfile) => sendResponse({
        ok: true,
        profileId: primaryProfile.profileId,
        profileName: primaryProfile.name
      }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo consultar el nombre de enrolamiento."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_STATUS_EXCEPTIONS_SET") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de excepciones de estados no válida." });
      return;
    }
    setStatusExcludedProfileIds(message.profileIds)
      .then(({ profileIds, warning }) => sendResponse({
        ok: true,
        excludedProfileIds: profileIds,
        ...(warning ? { warning } : {})
      }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudieron guardar las excepciones de estados."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_ADVERTISING_PROFILES_PUBLISH") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de sincronización no válida." });
      return;
    }
    publishHiddenAdvertisingProfiles()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo sincronizar los paneles minimizados."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_ADVERTISING_PROFILES_POLL") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de sincronización no válida." });
      return;
    }
    syncHiddenAdvertisingProfiles(message.revision)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo recibir la configuración de paneles minimizados."
      }));
    return true;
  }

  if (message?.type === "STATUS_UPDATE_EXECUTE") {
    if (!isWhatsAppSender(sender) || typeof sender.tab?.id !== "number") {
      sendResponse({ ok: false, error: "Origen no autorizado para cambiar el estado." });
      return;
    }
    chrome.tabs.sendMessage(sender.tab.id, {
      type: "STATUS_UPDATE_LOCAL_EXECUTE",
      action: message.action ?? "replace",
      ...(message.image === undefined ? {} : { image: message.image })
    }).then(sendResponse).catch((error) => sendResponse({
      ok: false,
      error: error.message || "No se pudo ejecutar el cambio de estado en WhatsApp Web."
    }));
    return true;
  }

  if ([
    "STATUS_UPDATE_DEBUGGER_START",
    "STATUS_UPDATE_DEBUGGER_CLICK",
    "STATUS_UPDATE_DEBUGGER_KEY",
    "STATUS_UPDATE_DEBUGGER_STOP"
  ].includes(message?.type)) {
    if (!isWhatsAppSender(sender) || typeof sender.tab?.id !== "number") {
      sendResponse({ ok: false, error: "Origen no autorizado para controlar WhatsApp Web." });
      return;
    }
    const operation = message.type === "STATUS_UPDATE_DEBUGGER_START"
      ? startStatusDebuggerSession(sender.tab.id)
      : message.type === "STATUS_UPDATE_DEBUGGER_CLICK"
        ? clickStatusDebuggerTarget(sender.tab.id, message)
        : message.type === "STATUS_UPDATE_DEBUGGER_KEY"
          ? pressStatusDebuggerKey(sender.tab.id, message)
          : stopStatusDebuggerSession(sender.tab.id);
    operation.then(() => sendResponse({ ok: true })).catch((error) => sendResponse({
      ok: false,
      error: error.message || "No se pudo controlar WhatsApp Web mediante Chrome."
    }));
    return true;
  }

  if ([
    "BRIDGE_STATUS_UPDATE_PUBLISH",
    "BRIDGE_STATUS_UPDATE_RESULTS_GET",
    "BRIDGE_STATUS_UPDATE_POLL",
    "BRIDGE_STATUS_UPDATE_RESULT"
  ].includes(message?.type)) {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de cambio de estado no válida." });
      return;
    }
    const operation = message.type === "BRIDGE_STATUS_UPDATE_PUBLISH"
      ? publishStatusUpdate(message)
      : message.type === "BRIDGE_STATUS_UPDATE_RESULTS_GET"
        ? getStatusUpdateResults(message.id)
        : message.type === "BRIDGE_STATUS_UPDATE_POLL"
          ? pollStatusUpdate(message)
          : reportStatusUpdateResult(message);
    operation.then(sendResponse).catch((error) => sendResponse({
      ok: false,
      error: error.message || "No se pudo sincronizar el cambio de estado."
    }));
    return true;
  }

  if (message?.type === "BRIDGE_PLATFORM_OUTAGES_PUBLISH") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de sincronización no válida." });
      return;
    }
    publishPlatformOutageConfig()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo sincronizar la configuración de plataformas caídas."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_PLATFORM_OUTAGES_POLL") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de sincronización no válida." });
      return;
    }
    syncPlatformOutageConfig(message.revision)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo recibir la configuración de plataformas caídas."
      }));
    return true;
  }

  if (message?.type === "BRIDGE_POLL" || message?.type === "BRIDGE_COMPLETE") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de puente no válida." });
      return;
    }
    getBridgeSettings().then(async ({ role, token }) => {
      if (role !== "primary" || !token) {
        throw new Error("Este perfil no está configurado como principal.");
      }
      if (message.type === "BRIDGE_POLL") {
        return bridgeFetch("/v1/next", token, { timeoutMs: 25_000 });
      }
      return bridgeFetch("/v1/complete", token, {
        method: "POST",
        timeoutMs: 10_000,
        body: { id: message.id, result: message.result }
      });
    }).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "Falló la comunicación con el puente." }));
    return true;
  }

  if (message?.type === "BRIDGE_EXECUTE") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud de puente no válida." });
      return;
    }
    getBridgeSettings().then(({ role }) => {
      if (role !== "primary") throw new Error("Este perfil no está configurado como principal.");
      return executeApiMessage(message.message);
    }).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "No se pudo ejecutar la solicitud en el perfil principal." }));
    return true;
  }

  if (message?.type === "CREATE_USER_REQUEST" &&
    Object.hasOwn(message.data || {}, "destinationId")) {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud no válida o enviada desde una página no autorizada." });
      return;
    }
    sendRemoteCreateUserRequest(message.data)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "No se pudo crear el usuario en la PC destino." }));
    return true;
  }

  if (message?.type === "PASSWORD_RESET_REQUEST" &&
    Object.hasOwn(message.data || {}, "destinationId")) {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud no válida o enviada desde una página no autorizada." });
      return;
    }
    sendRemotePasswordResetRequest(message.data)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "No se pudo restaurar la contraseña en la PC destino." }));
    return true;
  }

  if (message?.type === "REMOTE_AGENT_BALANCE_REQUEST") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud no válida o enviada desde una página no autorizada." });
      return;
    }
    getRemoteAgentBalance(message.data || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "No se pudo consultar el balance remoto." }));
    return true;
  }

  if (message?.type === "REMOTE_USER_SEARCH_REQUEST") {
    if (!isWhatsAppSender(sender)) {
      sendResponse({ ok: false, error: "Solicitud no válida o enviada desde una página no autorizada." });
      return;
    }
    getRemoteUserSearch(message.data || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "No se pudieron buscar usuarios en la PC destino." }));
    return true;
  }

  if (!API_MESSAGE_TYPES.has(message?.type)) return;
  if (!isWhatsAppSender(sender)) {
    sendResponse({ ok: false, error: "Solicitud no válida o enviada desde una página no autorizada." });
    return;
  }

  runInConfiguredProfile(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "No se pudo completar la solicitud." }));
  return true;
});

extensionStateOnChanged.addListener((changes, areaName) => {
  if (areaName !== "local" ||
    (!changes.activeBonusConfig && !changes[HIDDEN_ADVERTISING_PROFILES_KEY] &&
      !changes[PLATFORM_OUTAGE_CONFIG_KEY])) return;
  void getBridgeSettings()
    .then(({ role }) => {
      if (role !== "primary") return null;
      const publications = [];
      if (changes.activeBonusConfig) publications.push(publishActiveBonusConfig());
      if (changes[HIDDEN_ADVERTISING_PROFILES_KEY]) {
        publications.push(publishHiddenAdvertisingProfiles());
      }
      if (changes[PLATFORM_OUTAGE_CONFIG_KEY]) {
        publications.push(publishPlatformOutageConfig());
      }
      return Promise.all(publications);
    })
    .catch((error) => console.error(
      "[Ganamos balance extension] No se pudo publicar la configuración compartida en el puente.",
      error
    ));
});