(() => {
  const BRIDGE_URL = "http://127.0.0.1:32145";
  const RETRY_DELAY_MS = 1500;
  const sleep = (delay) => new Promise((resolve) => window.setTimeout(resolve, delay));

  async function sendRuntimeMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  async function runPrimaryBridge() {
    while (true) {
      try {
        const polled = await sendRuntimeMessage({ type: "BRIDGE_POLL" });
        if (!polled?.ok) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        if (!polled.task) continue;

        let result;
        try {
          result = await sendRuntimeMessage({
            type: "BRIDGE_EXECUTE",
            message: polled.task.message
          });
        } catch (error) {
          result = { ok: false, error: error.message || "No se pudo ejecutar la solicitud en el perfil principal." };
        }
        await sendRuntimeMessage({
          type: "BRIDGE_COMPLETE",
          id: polled.task.id,
          result
        });
      } catch (error) {
        console.error("[Ganamos balance extension] Error de conexión con el puente local.", error);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  chrome.storage.local.get(["bridgeRole", "bridgeToken"])
    .then(({ bridgeRole, bridgeToken }) => {
      if (bridgeRole === "primary" && typeof bridgeToken === "string" && bridgeToken) {
        void runPrimaryBridge();
      }
    })
    .catch((error) => console.error("[Ganamos balance extension] No se pudo leer el modo del puente.", error));
})();
