(() => {
  const BRIDGE_URL = "http://127.0.0.1:32145";
  const RETRY_DELAY_MS = 1500;
  const sleep = (delay) => new Promise((resolve) => window.setTimeout(resolve, delay));
  const platformQueues = {
    ganamos: Promise.resolve(),
    multipanel: Promise.resolve()
  };
  let searchQueue = Promise.resolve();

  async function sendRuntimeMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  function getTaskPlatform(message) {
    if (message.type === "AGENT_BALANCE_REQUEST") return "ganamos";
    if (message.type === "MULTIPANEL_AGENT_BALANCE_REQUEST") return "multipanel";
    if (message.type === "BALANCE_REQUEST" || message.type === "TRANSACTION_REQUEST" ||
      message.type === "CREATE_USER_REQUEST" || message.type === "PASSWORD_RESET_REQUEST") {
      return message.data?.platform === "multipanel" ? "multipanel" : "ganamos";
    }
    if (message.type === "WITHDRAWAL_HISTORY_REQUEST") return "ganamos";
    return null;
  }

  async function executePrimaryTask(task) {
    if (Number.isFinite(task.expiresAt) && Date.now() >= task.expiresAt) return;
    let result;
    try {
      result = await sendRuntimeMessage({
        type: "BRIDGE_EXECUTE",
        message: task.message
      });
    } catch (error) {
      result = { ok: false, error: error.message || "No se pudo ejecutar la solicitud en el perfil principal." };
    }

    try {
      await sendRuntimeMessage({
        type: "BRIDGE_COMPLETE",
        id: task.id,
        result
      });
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudo completar la solicitud del puente.", error);
    }
  }

  function enqueuePrimaryTask(task) {
    if (task.message.type === "EXCHANGE_REQUEST") {
      const exchange = Promise.all([platformQueues.ganamos, platformQueues.multipanel])
        .then(() => executePrimaryTask(task));
      platformQueues.ganamos = exchange;
      platformQueues.multipanel = exchange;
      return;
    }

    const platform = getTaskPlatform(task.message);
    if (platform) {
      platformQueues[platform] = platformQueues[platform]
        .then(() => executePrimaryTask(task));
      return;
    }

    if (task.message.type === "USER_SEARCH_REQUEST") {
      searchQueue = searchQueue.then(() => executePrimaryTask(task));
      return;
    }

    void executePrimaryTask(task);
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
        enqueuePrimaryTask(polled.task);
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

  stateStorage.get(["bridgeRole", "bridgeToken"])
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
