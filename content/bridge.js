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

  async function runPrimaryBonusConfigBridge() {
    while (true) {
      try {
        const result = await sendRuntimeMessage({ type: "BRIDGE_BONUS_CONFIG_PUBLISH" });
        if (!result?.ok) {
          throw new Error(result?.error || "No se pudo publicar la configuración del bono activo.");
        }
        await sleep(20_000);
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo sincronizar el bono activo desde el perfil principal.", error);
        await sleep(5000);
      }
    }
  }

  async function runSecondaryBonusConfigBridge() {
    let revision = 0;
    while (true) {
      try {
        const update = await sendRuntimeMessage({
          type: "BRIDGE_BONUS_CONFIG_POLL",
          revision
        });
        if (!update?.ok) {
          throw new Error(update?.error || "No se pudo consultar la configuración del bono activo.");
        }
        revision = update.revision;
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo recibir el bono activo del perfil principal.", error);
        await sleep(5000);
      }
    }
  }

  chrome.storage.local.get(["bridgeRole", "bridgeToken"])
    .then(({ bridgeRole, bridgeToken }) => {
      if (bridgeRole === "primary" && typeof bridgeToken === "string" && bridgeToken) {
        void runPrimaryBridge();
        void runPrimaryBonusConfigBridge();
      } else if (bridgeRole === "secondary" && typeof bridgeToken === "string" && bridgeToken) {
        void runSecondaryBonusConfigBridge();
      }
    })
    .catch((error) => console.error("[Ganamos balance extension] No se pudo leer el modo del puente.", error));
})();
