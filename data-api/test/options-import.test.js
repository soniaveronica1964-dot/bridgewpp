const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function createOptionsContext(storage, fetchImpl = fetch) {
  const elements = new Map();
  const handlers = new Map();
  let context;
  const makeElement = () => ({
    value: "",
    files: [],
    hidden: false,
    disabled: false,
    textContent: "",
    children: [],
    reportValidity() {
      return true;
    },
    setCustomValidity() {},
    addEventListener(event, callback) {
      handlers.set(`${this.selector}:${event}`, callback);
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    remove() {},
    click() {}
  });
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        const element = makeElement();
        element.selector = selector;
        elements.set(selector, element);
      }
      return elements.get(selector);
    },
    createElement() {
      return makeElement();
    },
    body: { append() {} }
  };
  const mockStorageArea = {
    async get(keys) {
      const currentStorage = vm.runInContext("mockStorage", context);
      if (keys === null) return currentStorage;
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        selected.filter((key) => key in currentStorage).map((key) => [key, currentStorage[key]])
      );
    },
    async set(values) {
      Object.assign(vm.runInContext("mockStorage", context), values);
    }
  };
  const nativeProfile = {
    installationId: "33333333-3333-4333-8333-333333333333",
    apiOrigin: "",
    credential: "",
    deviceId: "",
    deviceProofKey: Buffer.alloc(32, 7).toString("base64")
  };
  const chrome = {
    runtime: {
      id: "a".repeat(32),
      async sendMessage(message) {
        if (message.type !== "DATA_PROFILE_SELECTOR_GET") {
          throw new Error("Unexpected runtime message");
        }
        const current = vm.runInContext("mockStorage", context);
        let profileSelector = current.dataProfileSelector;
        if (typeof profileSelector !== "string") {
          profileSelector = crypto.randomUUID();
          current.dataProfileSelector = profileSelector;
        }
        return { ok: true, profileSelector };
      },
      async sendNativeMessage(_host, message) {
        nativeProfile.profileSelector = message.profileSelector;
        if (message.command === "get") return { ok: true, ...nativeProfile };
        if (message.command === "store") {
          nativeProfile.apiOrigin = message.apiOrigin;
          nativeProfile.credential = message.credential;
          nativeProfile.deviceId = message.deviceId;
          return { ok: true };
        }
        if (message.command === "sign") {
          return {
            ok: true,
            deviceId: nativeProfile.deviceId,
            timestamp: Date.now(),
            nonce: "n".repeat(43),
            signature: "s".repeat(43)
          };
        }
        throw new Error("Unexpected native host command");
      }
    },
    permissions: { async request() { return true; } },
    storage: {
      local: mockStorageArea,
      session: mockStorageArea
    }
  };
  context = vm.createContext({
    AbortController,
    Blob,
    Buffer,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
    btoa,
    chrome,
    console,
    crypto: crypto.webcrypto,
    document,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    window: {
      confirm: () => true,
      setTimeout,
      clearTimeout
    }
  });
  vm.runInContext(`mockStorage = JSON.parse(${JSON.stringify(JSON.stringify(storage))})`, context);
  context.stateStorage = {
    async get(keys = null) {
      const current = vm.runInContext("mockStorage", context);
      if (keys === null) return current;
      const selected = typeof keys === "string" ? [keys] :
        Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(selected.filter((key) => key in current).map((key) => [key, current[key]]));
    },
    async set(values) {
      Object.assign(vm.runInContext("mockStorage", context), values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete vm.runInContext("mockStorage", context)[key];
      }
    },
    onChanged: { addListener() {}, removeListener() {} }
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "options.js"), "utf8");
  vm.runInContext(source, context, { filename: "options.js" });
  return { context, elements, handlers, nativeProfile };
}

test("options exporter reads profile state and verifies an encrypted archive", async () => {
  const sourceData = {
    ganamosSuffix: "f",
    futureSetting: { preserved: true },
    "agentMovement:1760000000000:test": { operation: "withdrawal", amount: 12.5 }
  };
  const { context } = createOptionsContext(sourceData);
  assert.equal(
    vm.runInContext('getDataApiOrigin("https://127.0.0.1:3443")', context),
    "https://127.0.0.1:3443"
  );
  assert.equal(
    vm.runInContext('getDataApiOrigin("https://192.168.1.20:3443")', context),
    "https://192.168.1.20:3443"
  );
  const passphrase = "frase-de-prueba-larga-y-segura";
  const backup = await vm.runInContext(
    `createEncryptedProfileBackup(${JSON.stringify(passphrase)})`,
    context
  );
  const archiveText = await backup.blob.text();
  context.testFile = {
    size: Buffer.byteLength(archiveText),
    text: async () => archiveText
  };
  const imported = await vm.runInContext(
    `decryptAndValidateProfileArchive(testFile, ${JSON.stringify(passphrase)})`,
    context
  );
  const plainImported = JSON.parse(JSON.stringify(imported));
  assert.equal(plainImported.keyCount, 3);
  assert.equal(plainImported.movementCount, 1);
  assert.equal(plainImported.entries[1].key, "futureSetting");
  assert.equal(plainImported.entries[1].value.preserved, true);
  await assert.rejects(
    vm.runInContext(
      `decryptAndValidateProfileArchive(testFile, "otra-frase-incorrecta-y-larga")`,
      context
    ),
    /No se pudo autenticar el respaldo/
  );
});

test("options UI stages, previews, confirms, and resumes an import without exposing the passphrase", async () => {
  const storage = {
    ganamosSuffix: "f",
    futureSetting: { preserved: true },
    "agentMovement:1760000000000:test": { operation: "withdrawal", amount: 12.5 }
  };
  const extensionId = "a".repeat(32);
  const serverId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const token = "T".repeat(43);
  const report = {
    target: {
      serverId,
      workspaceId,
      profileId: "profile-id",
      deviceId: "device-id"
    },
    keyCount: 3,
    movementCount: 1,
    unknownKeyCount: 1,
    conflicts: {
      profileSettings: 0,
      profileSecrets: 0,
      movements: 0,
      legacyKeys: 0
    },
    sharedData: { choices: ["initialize_shared"] }
  };
  const requests = [];
  let committed = false;
  const committedReport = {
    keyCount: 3,
    movementCount: 1,
    preservedUnknownKeys: 1,
    sharedData: "initialized"
  };
  const fetchMock = async (url, options) => {
    const parsed = new URL(url);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ route: parsed.pathname, method, body, headers: options.headers });
    let status = 200;
    let responseBody;
    if (parsed.pathname === "/health") {
      responseBody = { status: "healthy", apiVersion: 1, schemaVersion: 6 };
    } else if (parsed.pathname === "/v1/server-info") {
      responseBody = { serverId, workspaceId, tls: true, apiVersion: 1, schemaVersion: 6 };
    } else if (parsed.pathname === "/v1/enroll") {
      responseBody = {
        credential: token,
        identity: { serverId, workspaceId, profileId: "profile-id", deviceId: "device-id" }
      };
    } else if (parsed.pathname === "/v1/identity") {
      responseBody = { serverId, workspaceId, profileId: "profile-id", deviceId: "device-id" };
    } else if (parsed.pathname.startsWith("/v1/migrations/") && method === "GET" && committed) {
      responseBody = { status: "committed", report: committedReport };
    } else if (parsed.pathname.startsWith("/v1/migrations/") && method === "GET") {
      status = 404;
      responseBody = { code: "migration_not_found", error: "No existe la migración." };
    } else if (parsed.pathname.startsWith("/v1/migrations/") && method === "DELETE") {
      responseBody = { discarded: true };
    } else if (parsed.pathname.startsWith("/v1/migrations/") && parsed.pathname.endsWith("/entries")) {
      responseBody = { accepted: body.entries.length };
    } else if (parsed.pathname.startsWith("/v1/migrations/") && parsed.pathname.endsWith("/validate")) {
      responseBody = { status: "validated", report };
    } else if (parsed.pathname.startsWith("/v1/migrations/") && parsed.pathname.endsWith("/commit")) {
      committed = true;
      responseBody = {
        status: "committed",
        report: committedReport
      };
    } else if (parsed.pathname.startsWith("/v1/migrations/")) {
      responseBody = { status: "staging" };
    } else {
      throw new Error(`Unexpected API request: ${method} ${parsed.pathname}`);
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return JSON.stringify(responseBody);
      }
    };
  };
  const { context, elements, handlers, nativeProfile } = createOptionsContext(storage, fetchMock);
  const passphrase = "otra-frase-de-prueba-larga-y-segura";
  const backup = await vm.runInContext(
    `createEncryptedProfileBackup(${JSON.stringify(passphrase)})`,
    context
  );
  const archiveText = await backup.blob.text();
  elements.get("#dataApiOrigin").value = "https://127.0.0.1:3443";
  elements.get("#importFile").files = [{
    size: Buffer.byteLength(archiveText),
    text: async () => archiveText
  }];
  elements.get("#importPassphrase").value = passphrase;
  elements.get("#dataDeviceName").value = "PC principal / Perfil A";
  elements.get("#dataEnrollmentCode").value = "código-temporal-de-prueba";
  await handlers.get("#importForm:submit")({ preventDefault() {} });

  assert.equal(elements.get("#importPreview").hidden, false);
  assert.match(elements.get("#importStatus").textContent, /Vista previa lista/);
  assert.equal(elements.get("#commitImport").hidden, false);
  assert.equal(requests.some(({ route }) => route.endsWith("/entries")), true);
  assert.equal(requests.some(({ route }) => route.endsWith("/validate")), true);
  const leakedPassphraseRoutes = requests
    .filter(({ headers }) => JSON.stringify(headers).includes(passphrase))
    .map(({ route }) => route);
  assert.deepEqual(leakedPassphraseRoutes, []);
  assert.equal(nativeProfile.apiOrigin, "https://127.0.0.1:3443");
  assert.equal(nativeProfile.credential, token);
  assert.equal(nativeProfile.deviceId, "device-id");
  assert.match(nativeProfile.profileSelector, /^[0-9a-f-]{36}$/);
  assert.equal(
    vm.runInContext("mockStorage.dataProfileSelector", context),
    nativeProfile.profileSelector
  );
  assert.equal(JSON.stringify(vm.runInContext("mockStorage", context)).includes(passphrase), false);
  assert.equal(elements.get("#dataEnrollmentCode").value, "");
  assert.equal(elements.get("#discardImport").hidden, false);

  await handlers.get("#discardImport:click")();
  assert.match(elements.get("#importStatus").textContent, /Staging descartado/);
  assert.equal(elements.get("#importPreview").hidden, true);
  elements.get("#importPassphrase").value = passphrase;
  await handlers.get("#importForm:submit")({ preventDefault() {} });

  elements.get("#sharedDataDecision").value = "initialize_shared";
  await handlers.get("#commitImport:click")();
  assert.match(elements.get("#importStatus").textContent, /Importación confirmada/);
  assert.equal(elements.get("#commitImport").hidden, true);
  const commitRequest = requests.find(({ route }) => route.endsWith("/commit"));
  assert.equal(commitRequest.body.confirm, true);
  assert.equal(commitRequest.body.sharedDataDecision, "initialize_shared");

  elements.get("#importPassphrase").value = passphrase;
  const entriesRequestsBeforeRecovery = requests.filter(({ route }) => route.endsWith("/entries")).length;
  await handlers.get("#importForm:submit")({ preventDefault() {} });
  assert.match(elements.get("#importStatus").textContent, /ya se había importado/);
  assert.equal(elements.get("#commitImport").hidden, true);
  assert.equal(
    requests.filter(({ route }) => route.endsWith("/entries")).length,
    entriesRequestsBeforeRecovery
  );
});
