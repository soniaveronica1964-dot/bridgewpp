const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 32145;
const REQUEST_TIMEOUT_MS = 90_000;
const POLL_TIMEOUT_MS = 20_000;
const ALLOWED_REQUEST_TYPES = new Set([
  "AGENT_BALANCE_REQUEST",
  "MULTIPANEL_AGENT_BALANCE_REQUEST",
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
const queuedRequests = [];
const waitingPolls = [];
const pendingRequests = new Map();

function isLoopback(remoteAddress) {
  return remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
}

function constantTimeEquals(actual, expected) {
  const actualBuffer = Buffer.from(actual || "");
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
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

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        reject(new Error("La solicitud excede el tamaño permitido."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("El cuerpo de la solicitud no es JSON válido."));
      }
    });
    request.on("error", reject);
  });
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
    sendJson(response, 200, { ok: true, service: "running" }, origin);
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

    const task = { id: body.id, message: body.message };
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

async function loadCredentials() {
  await fs.mkdir(DATA_DIRECTORY, { recursive: true });
  try {
    credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    credentials = {
      primaryToken: crypto.randomBytes(32).toString("base64url"),
      clientToken: crypto.randomBytes(32).toString("base64url")
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
}

loadCredentials().then(() => {
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: "Error interno del puente local." }, request.headers.origin);
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
}).catch((error) => {
  console.error("No se pudieron inicializar las credenciales del puente:", error.message);
  process.exitCode = 1;
});
