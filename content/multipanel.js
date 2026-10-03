(() => {
  const SESSION_KEY = "lux-support-user";

  function readSession() {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return null;
    try {
      const user = JSON.parse(stored);
      return typeof user?.session === "string" ? user.session.trim() : null;
    } catch {
      throw new Error(`No se pudo interpretar el valor de Local Storage "${SESSION_KEY}".`);
    }
  }

  async function publishSession() {
    const session = readSession();
    if (!session) return;
    const response = await chrome.runtime.sendMessage({
      type: "MULTIPANEL_SESSION_UPDATE",
      session
    });
    if (!response?.ok) {
      throw new Error(response?.error || "No se pudo sincronizar la sesión de MultiPanel.");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "MULTIPANEL_READ_SESSION") return;
    try {
      const session = readSession();
      if (!session) throw new Error(`No se encontró "session" en Local Storage → ${SESSION_KEY}.`);
      sendResponse({ ok: true, session });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "No se pudo leer la sesión de MultiPanel." });
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_KEY) return;
    publishSession().catch((error) => console.error("[MultiPanel extension]", error));
  });

  publishSession().catch((error) => console.error("[MultiPanel extension]", error));
})();
