(() => {
  const listeners = new Set();
  let polling = false;
  let lastWorkspaceRevision;

  function startPolling() {
    if (polling) return;
    polling = true;
    globalThis.setInterval(() => {
      chrome.runtime.sendMessage({ type: "STATE_POLL" })
        .then((response) => {
          if (!response?.ok) {
            console.error("[Ganamos balance extension] No se pudo sincronizar el estado PostgreSQL.", response?.error);
          }
        })
        .catch((error) => {
          console.error("[Ganamos balance extension] No se pudo sincronizar el estado PostgreSQL.", error);
        });
    }, 10_000);
  }

  function send(type, data = {}) {
    return chrome.runtime.sendMessage({ type, ...data }).then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error || "No se pudo acceder al estado PostgreSQL.");
      }
      if (Number.isSafeInteger(response.revision)) lastWorkspaceRevision = response.revision;
      startPolling();
      return response;
    });
  }

  function keyList(keys) {
    if (keys === null || keys === undefined) return null;
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === "object") return Object.keys(keys);
    throw new TypeError("Las claves de estado solicitadas no son válidas.");
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "STATE_CHANGED" || !message.changes) return;
    for (const listener of listeners) listener(message.changes, "local");
  });

  globalThis.stateStorage = Object.freeze({
    async get(keys = null) {
      const response = await send("STATE_GET", { keys: keyList(keys) });
      const values = response.values || {};
      if (keys && !Array.isArray(keys) && typeof keys === "object") {
        for (const [key, value] of Object.entries(keys)) {
          if (!Object.hasOwn(values, key)) values[key] = value;
        }
      }
      return values;
    },
    async getMovements(filters = {}) {
      const response = await send("MOVEMENTS_GET", { filters });
      return response.movements;
    },
    set(changes) {
      return send("STATE_SET", {
        changes,
        ...(Number.isSafeInteger(lastWorkspaceRevision)
          ? { expectedRevision: lastWorkspaceRevision }
          : {})
      }).then(() => undefined);
    },
    remove(keys) {
      const removes = Array.isArray(keys) ? keys : [keys];
      return send("STATE_REMOVE", {
        removes,
        ...(Number.isSafeInteger(lastWorkspaceRevision)
          ? { expectedRevision: lastWorkspaceRevision }
          : {})
      }).then(() => undefined);
    },
    onChanged: Object.freeze({
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      }
    })
  });
})();
