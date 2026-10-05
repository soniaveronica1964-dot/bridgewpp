const GANAMOS_API_ORIGIN = "https://agents.ganamos.net";
const MULTIPANEL_API_ORIGIN = "https://wallet.casinoenvivo.club";
const MULTIPANEL_WEB_ORIGIN = "https://bo.casinoenvivo.club";
const DEFAULT_AGENT_USER_ID = "38175478";
const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
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
  const stored = await chrome.storage.local.get(["ganamosSuffix", "multiPanelSuffix"]);
  const ganamos = typeof stored.ganamosSuffix === "string" ? stored.ganamosSuffix.toLowerCase() : "f";
  const multipanel = typeof stored.multiPanelSuffix === "string" ? stored.multiPanelSuffix.toLowerCase() : "y";
  if (!/^[a-z]$/.test(ganamos) || !/^[a-z]$/.test(multipanel) || ganamos === multipanel) {
    throw new Error("Los sufijos de Ganamos y MultiPanel deben ser letras distintas.");
  }
  return { ganamos, multipanel };
}

async function getAgentUserId(requestData) {
  const stored = await chrome.storage.local.get("ganamosUserId");
  const userId = String(requestData?.user_id ?? stored.ganamosUserId ?? DEFAULT_AGENT_USER_ID);
  if (!/^\d+$/.test(userId)) {
    throw new Error("El user_id configurado para Ganamos no es válido.");
  }
  return userId;
}

async function requestGanamosJson(path, options = {}) {
  const url = new URL(path, GANAMOS_API_ORIGIN);
  if (url.origin !== GANAMOS_API_ORIGIN) {
    throw new Error("Se rechazó una URL fuera del dominio de Ganamos.");
  }

  const response = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*",
      ...options.headers
    },
    cache: "no-store"
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

async function createGanamosUser(data) {
  const { ganamos: ganamosSuffix } = await getPlatformSuffixes();
  if (!isValidUsername(data?.username, ganamosSuffix)) {
    throw new Error("El nombre de usuario generado no tiene el sufijo configurado para Ganamos.");
  }
  const { userCreationPassword } = await chrome.storage.local.get("userCreationPassword");
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

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields),
    cache: "no-store"
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
  const { userCreationPassword } = await chrome.storage.local.get("userCreationPassword");
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
  const stored = await chrome.storage.local.get("multiPanelSession");
  const session = stored.multiPanelSession;
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
      await chrome.storage.local.set({ multiPanelSession: session });
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
    await chrome.storage.local.set({ multiPanelSession: session });
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
      await chrome.storage.local.set({ multiPanelSession: session });
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

async function getMultiPanelBalance(data) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await findMultiPanelUser(data.nombre.trim());
      return await getMultiPanelBalanceForUser(user);
    } catch (error) {
      if (!isInvalidMultiPanelSession(error) || attempt > 0) throw error;
      await getMultiPanelSessionFromOpenTab();
    }
  }
  throw new Error("No se pudo consultar el saldo de MultiPanel.");
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

  const user = await findGanamosUser(data);
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
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await findMultiPanelUser(data.nombre.trim());
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
        const refreshed = await getMultiPanelBalance({ nombre: data.nombre });
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

  const { userCreationPassword } = await chrome.storage.local.get("userCreationPassword");
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

async function getBridgeSettings() {
  const { bridgeRole = "standalone", bridgeToken = "" } =
    await chrome.storage.local.get(["bridgeRole", "bridgeToken"]);
  return { role: bridgeRole, token: bridgeToken };
}

function isValidActiveBonusConfig(config) {
  if (config === null) return true;
  if (!config || typeof config !== "object" || typeof config.enabled !== "boolean") return false;
  const isPercent = (value) => typeof value === "number" &&
    Number.isFinite(value) && value >= 0 && value <= 100;
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

async function publishActiveBonusConfig() {
  const { role, token } = await getBridgeSettings();
  if (role !== "primary" || !token) {
    throw new Error("Este perfil no está configurado como principal.");
  }
  const stored = await chrome.storage.local.get("activeBonusConfig");
  const config = stored.activeBonusConfig ?? null;
  if (!isValidActiveBonusConfig(config)) {
    throw new Error("La configuración del bono activo no es válida y no se puede sincronizar.");
  }
  return bridgeFetch("/v1/bonus-config", token, {
    method: "POST",
    timeoutMs: 10_000,
    body: { config }
  });
}

async function syncActiveBonusConfig(revision) {
  const { role, token } = await getBridgeSettings();
  if (role !== "secondary" || !token) {
    throw new Error("Este perfil no está configurado como secundario.");
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("La versión de configuración recibida no es válida.");
  }
  const update = await bridgeFetch(`/v1/bonus-config?revision=${revision}`, token, {
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
    await chrome.storage.local.remove("activeBonusConfig");
  } else {
    await chrome.storage.local.set({ activeBonusConfig: update.config });
  }
  return update;
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
  const stored = await chrome.storage.local.get("remoteCreateDestinations");
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

async function getRemoteAgentBalance(data) {
  if (!["ganamos", "multipanel"].includes(data?.platform)) {
    throw new Error("Plataforma no válida para consultar el balance remoto.");
  }
  const messageType = data.platform === "ganamos"
    ? "AGENT_BALANCE_REQUEST"
    : "MULTIPANEL_AGENT_BALANCE_REQUEST";
  return sendRemoteOperation(data.destinationId, { type: messageType }, 25_000);
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
    message.type === "MULTIPANEL_AGENT_BALANCE_REQUEST") return true;
  if (message.type === "USER_SEARCH_REQUEST") return /^\d{4}$/.test(message.data?.digits || "");

  const platform = message.data?.platform || "ganamos";
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
  const suffixes = await getPlatformSuffixes();
  if (!validateApiMessage(message, suffixes)) {
    return { ok: false, error: "Solicitud no válida." };
  }
  if (message.type === "AGENT_BALANCE_REQUEST") return getGanamosAgentBalance();
  if (message.type === "MULTIPANEL_AGENT_BALANCE_REQUEST") return getMultiPanelAgentBalance();
  if (message.type === "USER_SEARCH_REQUEST") return searchUsersByDigits(message.data.digits);
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
    return platform === "multipanel"
      ? getMultiPanelBalance(message.data)
      : findGanamosUser(message.data);
  }
  return runTransactionRequest(message.data);
}

async function runInConfiguredProfile(message) {
  const { role } = await getBridgeSettings();
  if (role === "secondary") return sendRequestThroughBridge(message);
  return executeApiMessage(message);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MULTIPANEL_SESSION_UPDATE") {
    if (sender.frameId !== 0 || getSenderOrigin(sender) !== MULTIPANEL_WEB_ORIGIN ||
      !isValidMultiPanelSession(message.session)) {
      sendResponse({ ok: false, error: "Actualización de sesión de MultiPanel no válida." });
      return;
    }
    getBridgeSettings()
      .then(({ role }) => {
        if (role === "secondary") throw new Error("La sesión de MultiPanel solo se sincroniza en el perfil principal.");
        return chrome.storage.local.set({ multiPanelSession: message.session.trim() });
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
    syncActiveBonusConfig(message.revision)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo recibir la configuración del bono activo."
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.activeBonusConfig) return;
  void getBridgeSettings()
    .then(({ role }) => {
      if (role === "primary") return publishActiveBonusConfig();
      return null;
    })
    .catch((error) => console.error(
      "[Ganamos balance extension] No se pudo publicar la configuración del bono activo en el puente.",
      error
    ));
});