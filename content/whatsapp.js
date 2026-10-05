(() => {
  const HOST_ID = "ganamos-balance-extension";
  const AGENT_BALANCE_HOST_ID = "ganamos-agent-balance";
  const TOAST_HOST_ID = "ganamos-toast-host";
  const AGENT_MOVEMENT_PREFIX = "agentMovement:";
  const AGENT_BALANCE_VIEWS = ["minimized", "balance", "daily", "weekly", "monthly", "total"];
  const AGENT_MOVEMENT_VIEWS = ["daily", "weekly", "monthly", "total"];
  let scheduled = false;
  let activeAccountsKey = null;
  let selectingAgentBalanceText = false;
  let agentBalanceLoading = false;
  let multiPanelAgentBalanceLoading = false;
  let agentBalanceView = "balance";
  let agentBalanceContactKey = null;
  let platformSuffixes = { ganamos: "f", multipanel: "y" };
  let remoteCreateDestinations = [];
  const agentBalanceErrors = {};
  const withdrawalChecksInProgress = new WeakSet();

  chrome.storage.local.get(["ganamosSuffix", "multiPanelSuffix"])
    .then(({ ganamosSuffix, multiPanelSuffix }) => {
      if (/^[a-z]$/i.test(ganamosSuffix || "") && /^[a-z]$/i.test(multiPanelSuffix || "") &&
        ganamosSuffix.toLowerCase() !== multiPanelSuffix.toLowerCase()) {
        platformSuffixes = {
          ganamos: ganamosSuffix.toLowerCase(),
          multipanel: multiPanelSuffix.toLowerCase()
        };
        scheduleUpdate();
      }
    })
    .catch((error) => console.error("[Ganamos balance extension] No se pudieron cargar los sufijos de plataformas.", error));

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.remoteCreateDestinations) {
      remoteCreateDestinations = Array.isArray(changes.remoteCreateDestinations.newValue)
        ? changes.remoteCreateDestinations.newValue
        : [];
    }
    if (areaName !== "local" || (!changes.ganamosSuffix && !changes.multiPanelSuffix)) return;
    const ganamos = changes.ganamosSuffix?.newValue ?? platformSuffixes.ganamos;
    const multipanel = changes.multiPanelSuffix?.newValue ?? platformSuffixes.multipanel;
    if (/^[a-z]$/i.test(ganamos) && /^[a-z]$/i.test(multipanel) &&
      ganamos.toLowerCase() !== multipanel.toLowerCase()) {
      platformSuffixes = { ganamos: ganamos.toLowerCase(), multipanel: multipanel.toLowerCase() };
      scheduleUpdate();
    }
  });

  chrome.storage.local.get("remoteCreateDestinations")
    .then(({ remoteCreateDestinations: storedDestinations }) => {
      remoteCreateDestinations = Array.isArray(storedDestinations) ? storedDestinations : [];
    })
    .catch((error) => console.error("[Ganamos balance extension] No se pudieron cargar las PCs de destino.", error));

  function isVisible(element) {
    return Boolean(element && element.getClientRects().length);
  }

  function isActuallyVisible(element) {
    if (!element || !element.getClientRects().length) return false;
    for (let current = element; current instanceof Element; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" ||
        style.visibility === "collapse" || Number(style.opacity) === 0 ||
        current.getAttribute("aria-hidden") === "true") {
        return false;
      }

      if (current !== element && /(hidden|clip|scroll|auto)/.test(
        `${style.overflow} ${style.overflowX} ${style.overflowY}`
      )) {
        const currentRect = current.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        if (elementRect.right <= currentRect.left || elementRect.left >= currentRect.right ||
          elementRect.bottom <= currentRect.top || elementRect.top >= currentRect.bottom) {
          return false;
        }
      }
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 ||
      rect.right <= 0 || rect.bottom <= 0 ||
      rect.left >= document.documentElement.clientWidth ||
      rect.top >= document.documentElement.clientHeight) {
      return false;
    }

    const hitTarget = document.elementFromPoint(
      Math.min(rect.right - 1, Math.max(rect.left + 1, rect.left + rect.width / 2)),
      Math.min(rect.bottom - 1, Math.max(rect.top + 1, rect.top + rect.height / 2))
    );
    return Boolean(hitTarget && (hitTarget === element || element.contains(hitTarget)));
  }

  function findContactTitle() {
    const explicitTitles = [...document.querySelectorAll('[data-testid="conversation-info-header-chat-title"]')]
      .filter(isVisible);
    if (explicitTitles.length) return explicitTitles.length === 1 ? explicitTitles[0] : null;
    const matches = [...document.querySelectorAll("header h1, header h2, header [role='heading']")]
      .filter(isVisible);
    return matches.length === 1 ? matches[0] : null;
  }

  function isNormalChatOpen(title) {
    const chat = title?.closest("#main") || document.querySelector("#main");
    if (!chat || !isVisible(chat) || !isVisible(title) || document.fullscreenElement) return false;
    const host = document.getElementById(HOST_ID);
    if (host?.shadowRoot?.querySelector(".modal")) return true;
    return [...chat.querySelectorAll('button[aria-label="Emojis, GIF, Stickers"]')]
      .some((button) => {
        return isActuallyVisible(button) && button.getAttribute("aria-disabled") !== "true";
      });
  }

  function getPhoneFromContactTitle(title) {
    const text = title?.textContent?.replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim() || "";
    if (!/^[+\d\s().-]+$/.test(text)) return null;
    const digits = text.replace(/\D/g, "");
    return digits.length >= 4 ? digits : null;
  }

  function positionHost(host, title) {
    const chat = title?.closest("#main") || document.querySelector("#main");
    if (!chat || !title) return;
    const chatRect = chat.getBoundingClientRect();
    const headerRect = title.closest("header")?.getBoundingClientRect();
    const width = Math.max(0, chatRect.width - 16);
    if (!width) return;

    host.style.left = `${chatRect.left + 8}px`;
    host.style.top = `${Math.max(chatRect.top + 8, (headerRect?.bottom ?? chatRect.top) + 40)}px`;
    host.style.width = `${width}px`;
  }

  function getToastStack() {
    let host = document.getElementById(TOAST_HOST_ID);
    if (host) return host.shadowRoot?.querySelector(".toast-stack");

    host = document.createElement("div");
    host.id = TOAST_HOST_ID;
    host.style.visibility = "hidden";
    host.style.pointerEvents = "none";

    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/whatsapp.css");
    stylesheet.addEventListener("load", () => {
      host.style.visibility = "";
    }, { once: true });
    stylesheet.addEventListener("error", () => {
      console.error("[Ganamos balance extension] No se pudo cargar styles/whatsapp.css para las notificaciones.");
      host.style.visibility = "";
    }, { once: true });

    const stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("aria-live", "polite");
    shadow.append(stylesheet, stack);
    document.documentElement.append(host);
    return stack;
  }

  function showToast(_host, username, message, type, toastKey = username) {
    const root = getToastStack();

    for (const toast of root.querySelectorAll(".toast")) {
      if (toast.dataset.toastKey === toastKey) {
        window.clearTimeout(toast.dismissTimer);
        toast.remove();
      }
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.dataset.username = username;
    toast.dataset.toastKey = toastKey;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    const text = document.createElement("span");
    text.className = "toast-message";
    text.textContent = `${username}: ${message}`;
    toast.append(text);

    const dismiss = () => {
      window.clearTimeout(toast.dismissTimer);
      toast.remove();
    };
    if (type === "error") {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "toast-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "Cerrar alerta");
      close.addEventListener("click", dismiss);
      toast.append(close);
    } else if (type !== "warning") {
      toast.dismissTimer = window.setTimeout(dismiss, 3000);
    }
    root.append(toast);
  }

  function dismissToast(toastKey) {
    for (const toast of getToastStack().querySelectorAll(".toast")) {
      if (toast.dataset.toastKey === toastKey) {
        window.clearTimeout(toast.dismissTimer);
        toast.remove();
      }
    }
  }

  function formatCurrency(amount) {
    return new Intl.NumberFormat("es-AR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  function formatBalance(amount) {
    return new Intl.NumberFormat("es-AR", {
      maximumFractionDigits: 2
    }).format(amount);
  }

  const numericInputStates = new WeakMap();

  function normalizeNumericInput(value, preferGrouping = false) {
    const cleaned = value.replace(/[^\d.,]/g, "");
    if (!/\d/.test(cleaned)) {
      return { value: "", integer: "", decimalSeparator: null };
    }
    const commaIndex = cleaned.lastIndexOf(",");
    const dotIndex = cleaned.lastIndexOf(".");
    const isGroupedNumber = /^\d{1,3}(?:\.\d{3})+$/.test(cleaned) ||
      /^\d{1,3}(?:\.\d{3})*\.\d{4,}$/.test(cleaned) ||
      (preferGrouping && /^\d{1,3}(?:\.\d{1,3})+$/.test(cleaned));
    let decimalSeparator = null;

    if (commaIndex >= 0 && dotIndex >= 0) {
      decimalSeparator = commaIndex > dotIndex ? "," : ".";
    } else if (commaIndex >= 0) {
      decimalSeparator = ",";
    } else if (dotIndex >= 0 && !isGroupedNumber) {
      decimalSeparator = ".";
    }

    const integer = (decimalSeparator
      ? cleaned.slice(0, cleaned.lastIndexOf(decimalSeparator))
      : cleaned).replace(/[.,]/g, "") || "0";
    if (!decimalSeparator) {
      return { value: integer, integer, decimalSeparator: null };
    }

    const fraction = cleaned.slice(cleaned.lastIndexOf(decimalSeparator) + 1)
      .replace(/[.,]/g, "");
    return {
      value: `${integer}.${fraction}`,
      integer,
      decimalSeparator,
      fraction
    };
  }

  function formatNumericInput(input, cursor = input.selectionStart, event = null) {
    let raw = input.value;
    const preferGrouping = numericInputStates.get(input)?.grouped === true;
    if (event?.inputType === "insertText" && event.data === "." &&
      cursor > 0 && raw[cursor - 1] === ".") {
      raw = `${raw.slice(0, cursor - 1)},${raw.slice(cursor)}`;
    }

    const prefix = raw.slice(0, cursor);
    const normalized = normalizeNumericInput(raw, preferGrouping);
    const normalizedPrefix = normalizeNumericInput(prefix, preferGrouping);
    const groupedInteger = normalized.integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const hasDecimal = normalized.decimalSeparator !== null;
    const displayInteger = groupedInteger;
    const formatted = `${displayInteger}${hasDecimal ? `,${normalized.fraction}` : ""}`;
    input.value = /\d/.test(raw) ? formatted : "";
    numericInputStates.set(input, {
      grouped: !hasDecimal && /\d\.\d{3}(?:\.\d{3})*$/.test(displayInteger)
    });

    if (typeof cursor !== "number") return;
    let nextCursor = 0;
    const digitsBeforeCursor = (prefix.match(/\d/g) || []).length;
    if (normalizedPrefix.decimalSeparator !== null && hasDecimal) {
      const fractionDigitsBeforeCursor = normalizedPrefix.fraction.length;
      nextCursor = displayInteger.length + 1 + fractionDigitsBeforeCursor;
    } else if (digitsBeforeCursor > 0) {
      let seenDigits = 0;
      for (let index = 0; index < displayInteger.length; index += 1) {
        if (/\d/.test(displayInteger[index])) seenDigits += 1;
        if (seenDigits === digitsBeforeCursor) {
          nextCursor = index + 1;
          break;
        }
      }
    }
    input.setSelectionRange(nextCursor, nextCursor);
  }

  function configureNumericInput(input) {
    input.type = "text";
    input.inputMode = "decimal";
    input.addEventListener("beforeinput", (event) => {
      if (event.data?.includes("-")) event.preventDefault();
    });
    input.addEventListener("input", (event) => formatNumericInput(input, input.selectionStart, event));
  }

  function numericInputValue(input) {
    if (!input?.value) return null;
    const value = Number(normalizeNumericInput(input.value).value);
    return Number.isFinite(value) ? value : null;
  }

  function createAmountShortcuts(input) {
    const shortcuts = document.createElement("div");
    shortcuts.className = "amount-shortcuts";
    shortcuts.setAttribute("role", "group");
    shortcuts.setAttribute("aria-label", "Sumar un monto rápido");
    for (const shortcutAmount of [500, 1000, 2500, 5000, 10000]) {
      const button = document.createElement("button");
      const label = `$${formatBalance(shortcutAmount)}`;
      button.type = "button";
      const buttonLabel = document.createElement("span");
      buttonLabel.textContent = label;
      button.append(buttonLabel);
      button.setAttribute("aria-label", `Sumar ${label} al monto`);
      button.addEventListener("click", () => {
        const currentAmount = numericInputValue(input) || 0;
        const nextAmount = (Math.round(currentAmount * 100) + shortcutAmount * 100) / 100;
        input.value = formatBalance(nextAmount);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
      shortcuts.append(button);
    }
    return shortcuts;
  }

  function createPercentageShortcuts(input) {
    const shortcuts = document.createElement("div");
    shortcuts.className = "amount-shortcuts";
    shortcuts.setAttribute("role", "group");
    shortcuts.setAttribute("aria-label", "Elegir porcentaje de bono");
    for (const percentage of [20, 30, 40, 50, 60]) {
      const button = document.createElement("button");
      button.type = "button";
      const buttonLabel = document.createElement("span");
      buttonLabel.textContent = `${percentage}%`;
      button.append(buttonLabel);
      button.setAttribute("aria-label", `Usar ${percentage}%`);
      button.addEventListener("click", () => {
        input.value = String(percentage);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
      shortcuts.append(button);
    }
    return shortcuts;
  }

  function numericInputString(input) {
    return normalizeNumericInput(input.value).value;
  }

  function hasValidInputPrecision(input) {
    return (normalizeNumericInput(input.value).fraction?.length ?? 0) <= 2;
  }

  function getNextAgentBalanceView(view) {
    const index = AGENT_BALANCE_VIEWS.indexOf(view);
    return AGENT_BALANCE_VIEWS[(index + 1) % AGENT_BALANCE_VIEWS.length];
  }

  function getAgentBalanceViewTitle(view) {
    return {
      minimized: "Ver balances",
      balance: "Ver movimientos del día",
      daily: "Ver movimientos de la semana",
      weekly: "Ver movimientos del mes",
      monthly: "Ver movimientos totales",
      total: "Minimizar balances"
    }[view];
  }

  function isAgentMovementView(view) {
    return AGENT_MOVEMENT_VIEWS.includes(view);
  }

  function selectCurrencyAmount(element) {
    const text = element.firstChild;
    const amount = element.textContent.match(/\$\s*([\d.,]+)/);
    if (!text || !amount) return;
    const start = amount.index + amount[0].indexOf(amount[1]);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + amount[1].length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function createStatisticsIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(namespace, "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("agent-balance-statistics-icon");
    for (const [x, y, height] of [[2, 8, 6], [6, 5, 9], [10, 2, 12]]) {
      const bar = document.createElementNS(namespace, "rect");
      bar.setAttribute("x", String(x));
      bar.setAttribute("y", String(y));
      bar.setAttribute("width", "3");
      bar.setAttribute("height", String(height));
      bar.setAttribute("rx", "0.5");
      icon.append(bar);
    }
    return icon;
  }

  function setAgentBalanceView(host, view) {
    agentBalanceView = view;
    const card = host.shadowRoot?.querySelector(".agent-balance-card");
    const toggle = card?.querySelector(".agent-balance-toggle");
    const rows = card?.querySelector(".agent-balance-rows");
    const movements = card?.querySelector(".agent-movement-view");
    const errors = card?.querySelector(".agent-balance-error-view");
    if (!card || !toggle || !rows || !movements || !errors) return;

    const minimized = view === "minimized";
    const hasErrors = Object.keys(agentBalanceErrors).length > 0;
    card.classList.toggle("is-minimized", minimized);
    card.classList.toggle("has-errors", hasErrors);
    rows.hidden = hasErrors || view !== "balance";
    movements.hidden = hasErrors || !isAgentMovementView(view);
    errors.hidden = !hasErrors;
    host.style.width = minimized && !hasErrors
      ? "28px"
      : "min(210px, calc(100vw - 56px))";
    if (view === "balance" || view === "daily" || view === "weekly") {
      toggle.replaceChildren(createStatisticsIcon());
    } else {
      toggle.textContent = view === "minimized" ? "▸" : "◂";
    }
    toggle.title = getAgentBalanceViewTitle(view);
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!minimized));
    if (isAgentMovementView(view)) void renderAgentMovements(host, view);
  }

  function updateAgentBalanceErrors(host) {
    const card = host.shadowRoot?.querySelector(".agent-balance-card");
    const errors = card?.querySelector(".agent-balance-error-view");
    if (!card || !errors) return;

    const entries = Object.entries(agentBalanceErrors);
    const hasErrors = entries.length > 0;
    card.classList.toggle("has-errors", hasErrors);
    errors.hidden = !hasErrors;
    card.querySelector(".agent-balance-rows").hidden = hasErrors || agentBalanceView !== "balance";
    card.querySelector(".agent-movement-view").hidden = hasErrors ||
      !isAgentMovementView(agentBalanceView);
    host.style.width = agentBalanceView === "minimized" && !hasErrors
      ? "28px"
      : "min(210px, calc(100vw - 56px))";
    errors.replaceChildren();

    for (const [platform, message] of entries) {
      const errorRow = document.createElement("div");
      errorRow.className = "agent-balance-error-row";
      const line = document.createElement("div");
      line.className = "agent-balance-error-line";
      line.dataset.platform = platform;
      line.textContent = `${platform === "ganamos" ? "Ganamos" : "MultiPanel"}: error de conexión`;
      line.title = message;
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "agent-balance-refresh agent-balance-error-refresh";
      refresh.dataset.platform = platform;
      refresh.textContent = "↻";
      refresh.title = `Reintentar conexión con ${platform === "ganamos" ? "Ganamos" : "MultiPanel"}`;
      refresh.setAttribute("aria-label", refresh.title);
      refresh.addEventListener("click", () => {
        if (platform === "ganamos") void refreshAgentBalance(host);
        else void refreshMultiPanelAgentBalance(host);
      });
      errorRow.append(line, refresh);
      errors.append(errorRow);
    }
  }

  function setAgentBalanceError(host, platform, message = null) {
    if (message) agentBalanceErrors[platform] = message;
    else delete agentBalanceErrors[platform];
    updateAgentBalanceErrors(host);
  }

  async function renderAgentMovements(host, view = agentBalanceView) {
    const movementView = host.shadowRoot?.querySelector(".agent-movement-view");
    const list = movementView?.querySelector(".agent-movement-list");
    if (!movementView || !list) return;
    const contactKey = agentBalanceContactKey;
    list.replaceChildren();

    try {
      const stored = await chrome.storage.local.get(null);
      if (contactKey !== agentBalanceContactKey || view !== agentBalanceView) return;
      const movements = Object.entries(stored)
        .filter(([key, record]) =>
          key.startsWith(AGENT_MOVEMENT_PREFIX) &&
          (!contactKey || record?.contactKey === contactKey) &&
          ["deposit", "withdrawal"].includes(record?.operation) &&
          record.status !== "pending-verification")
        .map(([, record]) => record)
        .sort((first, second) => second.timestamp - first.timestamp);

      const now = new Date();
      const start = view === "daily"
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : view === "weekly"
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7)
          : view === "monthly"
            ? new Date(now.getFullYear(), now.getMonth(), 1)
            : null;
      const end = view === "daily"
        ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
        : view === "weekly"
          ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
          : view === "monthly"
            ? new Date(start.getFullYear(), start.getMonth() + 1, 1)
            : null;
      const selectedMovements = start && end
        ? movements.filter((movement) =>
          movement.timestamp >= start.getTime() && movement.timestamp < end.getTime())
        : movements;
      const periodName = {
        daily: "Hoy",
        weekly: "Sem.",
        monthly: "Mes",
        total: "Total"
      }[view] || "Total";

      if (!selectedMovements.length) {
        const empty = document.createElement("div");
        empty.className = "agent-movement-empty";
        empty.textContent = view === "daily"
          ? contactKey ? "Sin movimientos hoy." : "No hay movimientos guardados hoy."
          : view === "weekly" || view === "monthly"
            ? contactKey
              ? `Sin movimientos en ${view === "weekly" ? "la semana" : "el mes"}.`
              : `No hay movimientos guardados en ${view === "weekly" ? "la semana" : "el mes"}.`
          : contactKey
            ? "Sin movimientos registrados."
            : "No hay movimientos guardados.";
        list.append(empty);
        return;
      }

      for (const [label, operation, className] of [
        [`Depósitos ${periodName}`, "deposit", "agent-movement-deposits"],
        [`Retiros ${periodName}`, "withdrawal", "agent-movement-withdrawals"]
      ]) {
        const total = selectedMovements
          .filter((movement) => movement.operation === operation)
          .reduce((sum, movement) => sum + movement.amount, 0);
        const row = document.createElement("div");
        row.className = "agent-movement-total";
        const name = document.createElement("span");
        name.className = className;
        name.textContent = label;
        const amount = document.createElement("span");
        amount.className = className;
        amount.classList.add("agent-movement-copy-value");
        amount.addEventListener("click", () => selectCurrencyAmount(amount));
        amount.textContent = `$${formatCurrency(total)}`;
        row.append(name, amount);
        list.append(row);
      }
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudieron cargar los movimientos.", error);
      if (contactKey !== agentBalanceContactKey || view !== agentBalanceView) return;
      const failure = document.createElement("div");
      failure.className = "agent-movement-empty agent-movement-error";
      failure.textContent = "No se pudieron cargar los movimientos.";
      list.append(failure);
    }
  }

  async function saveAgentMovement(
    contactKey,
    operation,
    amount,
    platform,
    { username, transactionAmount, bonusAmount, fromPlatform, toPlatform, status, verification }
  ) {
    const record = {
      contactKey,
      operation,
      amount: Number(amount),
      platform,
      timestamp: Date.now(),
      username,
      ...(transactionAmount != null ? { transactionAmount: Number(transactionAmount) } : {}),
      ...(bonusAmount != null ? { bonusAmount: Number(bonusAmount) } : {}),
      ...(fromPlatform ? { fromPlatform } : {}),
      ...(toPlatform ? { toPlatform } : {}),
      ...(status ? { status } : {}),
      ...(verification ? { verification } : {})
    };
    const recordKey = `${AGENT_MOVEMENT_PREFIX}${record.timestamp}:${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [recordKey]: record });
  }

  async function findRecentUserWithdrawal(contactKey) {
    const stored = await chrome.storage.local.get(null);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return Object.entries(stored)
      .filter(([key, movement]) =>
        key.startsWith(AGENT_MOVEMENT_PREFIX) &&
        movement?.contactKey === contactKey &&
        movement.operation === "withdrawal" &&
        Number.isFinite(movement.timestamp) &&
        Number.isFinite(movement.amount) &&
        ["ganamos", "multipanel"].includes(movement.platform) &&
        movement.timestamp >= cutoff &&
        movement.timestamp <= Date.now())
      .map(([, movement]) => movement)
      .sort((first, second) => second.timestamp - first.timestamp)[0] || null;
  }

  async function updateLastWithdrawalDisplay(host, contactKey) {
    const label = host.shadowRoot?.querySelector(".last-withdrawal");
    if (!label) return;
    label.hidden = true;
    try {
      const stored = await chrome.storage.local.get(null);
      if (host.dataset.accounts !== contactKey) return;
      const lastWithdrawal = Object.entries(stored)
        .filter(([key, movement]) =>
          key.startsWith(AGENT_MOVEMENT_PREFIX) &&
          movement?.contactKey === contactKey &&
          movement.operation === "withdrawal" &&
          Number.isFinite(movement.timestamp) &&
          ["ganamos", "multipanel"].includes(movement.platform) &&
          movement.timestamp <= Date.now())
        .map(([, movement]) => movement)
        .sort((first, second) => second.timestamp - first.timestamp)[0];
      if (!lastWithdrawal) return;

      const formattedDate = new Intl.DateTimeFormat("es-AR", {
        dateStyle: "short",
        timeStyle: "short"
      }).format(lastWithdrawal.timestamp);
      label.dateTime = new Date(lastWithdrawal.timestamp).toISOString();
      label.textContent = `Último Retiro: ${formattedDate}`;
      label.title = `Último retiro: ${formattedDate}`;
      label.classList.toggle("recent", Date.now() - lastWithdrawal.timestamp < 24 * 60 * 60 * 1000);
      label.hidden = false;
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudo consultar la fecha del último retiro.", error);
    }
  }

  function confirmRecentWithdrawal(root, username, movement) {
    return new Promise((resolve) => {
      let answered = false;
      const finish = (shouldContinue) => {
        if (answered) return;
        answered = true;
        modal.remove();
        resolve(shouldContinue);
      };

      const modal = document.createElement("div");
      modal.className = "modal recent-withdrawal-modal";
      modal.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(false);
      }, true);
      modal.addEventListener("click", (event) => {
        if (event.target === modal) finish(false);
      });

      const dialog = document.createElement("section");
      dialog.className = "dialog";
      dialog.dataset.operation = "recent-withdrawal";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      const title = document.createElement("h2");
      title.textContent = "Retiro reciente";
      const message = document.createElement("p");
      message.className = "notice";
      const date = new Intl.DateTimeFormat("es-AR", {
        dateStyle: "short",
        timeStyle: "short"
      }).format(movement.timestamp);
      const platform = movement.platform === "ganamos" ? "Ganamos" : "MultiPanel";
      const amount = formatCurrency(Number(movement.amount));
      message.textContent =
        `${username} ya tiene un retiro registrado en las últimas 24 horas: $${amount} en ${platform}, el ${date}. ¿Querés continuar igualmente?`;

      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      const actionButtons = document.createElement("div");
      actionButtons.className = "dialog-action-buttons";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = "Cancelar";
      cancel.addEventListener("click", () => finish(false));
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "recent-withdrawal-continue";
      accept.textContent = "Aceptar";
      accept.addEventListener("click", () => finish(true));
      actionButtons.append(cancel, accept);
      actions.append(actionButtons);
      dialog.append(title, message, actions);
      modal.append(dialog);
      root.append(modal);
      cancel.focus();
    });
  }

  async function startWithdrawal(host) {
    if (withdrawalChecksInProgress.has(host)) return;
    withdrawalChecksInProgress.add(host);
    const root = host.shadowRoot?.querySelector(".dialog-root");
    const contactKey = host.dataset.accounts;
    const platform = host.dataset.defaultPlatform ||
      (host.dataset.username ? "ganamos" : "multipanel");
    const username = platform === "ganamos"
      ? host.dataset.username
      : host.dataset.multipanelUsername;

    try {
      if (!root || !contactKey || !username) {
        throw new Error("No se pudo identificar el usuario para verificar retiros recientes.");
      }
      const recentWithdrawal = await findRecentUserWithdrawal(contactKey);
      if (host.dataset.accounts !== contactKey) return;
      if (recentWithdrawal &&
        !(await confirmRecentWithdrawal(root, username, recentWithdrawal))) {
        return;
      }
      if (host.dataset.accounts !== contactKey) return;
      await openTransactionDialog(host, "withdrawal");
    } catch (error) {
      showToast(
        host,
        username || "Chat",
        error.message || "No se pudo verificar el historial reciente; no se abrió el retiro.",
        "error"
      );
    } finally {
      withdrawalChecksInProgress.delete(host);
    }
  }

  function openUserMovementDialog(host) {
    const root = host.shadowRoot?.querySelector(".dialog-root");
    const contactKey = host.dataset.accounts;
    if (!root || !contactKey) return;

    root.replaceChildren();
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      root.replaceChildren();
    }, true);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) root.replaceChildren();
    });

    const dialog = document.createElement("section");
    dialog.className = "dialog movement-history-dialog";
    dialog.dataset.operation = "information";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("div");
    heading.className = "movement-history-heading";
    const title = document.createElement("h2");
    title.textContent = "Movimientos";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "movement-history-close";
    close.textContent = "×";
    close.title = "Cerrar";
    close.setAttribute("aria-label", "Cerrar información de movimientos");
    close.addEventListener("click", () => root.replaceChildren());
    heading.append(title, close);

    const filters = document.createElement("div");
    filters.className = "movement-history-filters";
    const platformLabel = document.createElement("label");
    platformLabel.textContent = "Plataforma";
    const platformSelect = document.createElement("select");
    for (const [value, label] of [
      ["all", "Todas"],
      ["ganamos", "Ganamos"],
      ["multipanel", "MultiPanel"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      platformSelect.append(option);
    }
    platformLabel.append(platformSelect);

    const periodLabel = document.createElement("label");
    periodLabel.textContent = "Período";
    const periodSelect = document.createElement("select");
    for (const [value, label] of [
      ["all", "Todo el historial"],
      ["custom", "Rango de fecha y hora"],
      ["since-withdrawal", "Desde el último retiro"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      periodSelect.append(option);
    }
    periodLabel.append(periodSelect);
    filters.append(platformLabel, periodLabel);

    const dates = document.createElement("div");
    dates.className = "movement-history-dates";
    const fromLabel = document.createElement("label");
    fromLabel.textContent = "Desde";
    const fromInput = document.createElement("input");
    fromInput.type = "datetime-local";
    fromLabel.append(fromInput);
    const toLabel = document.createElement("label");
    toLabel.textContent = "Hasta";
    const toInput = document.createElement("input");
    toInput.type = "datetime-local";
    toLabel.append(toInput);
    dates.append(fromLabel, toLabel);

    const list = document.createElement("div");
    list.className = "movement-history-list";
    list.setAttribute("aria-live", "polite");
    dialog.append(heading, filters, dates, list);
    modal.append(dialog);
    root.append(modal);

    const platformUsernames = {
      ganamos: host.dataset.username,
      multipanel: host.dataset.multipanelUsername
    };
    const defaultPlatform = host.dataset.defaultPlatform || "ganamos";
    title.textContent = `Movimientos ${platformUsernames[defaultPlatform] || ""}`.trim();
    let storedMovements = [];

    const renderMovements = () => {
      const selectedPlatform = platformSelect.value;
      const titlePlatform = selectedPlatform === "all" ? defaultPlatform : selectedPlatform;
      title.textContent = `Movimientos ${platformUsernames[titlePlatform] || ""}`.trim();
      const filtered = storedMovements.filter((movement) =>
        (selectedPlatform === "all" || movement.platform === selectedPlatform ||
          (movement.operation === "exchange" &&
            [movement.fromPlatform, movement.toPlatform].includes(selectedPlatform))));
      const lastWithdrawal = periodSelect.value === "since-withdrawal"
        ? filtered.find((movement) => movement.operation === "withdrawal")
        : null;
      const fromTimestamp = periodSelect.value === "custom" && fromInput.value
        ? new Date(fromInput.value).getTime()
        : null;
      const toTimestamp = periodSelect.value === "custom" && toInput.value
        ? new Date(toInput.value).getTime() + 59_999
        : null;
      dates.hidden = periodSelect.value !== "custom";
      list.replaceChildren();

      let visibleMovements = filtered;
      if (periodSelect.value === "since-withdrawal") {
        visibleMovements = lastWithdrawal
          ? filtered.filter((movement) => movement.timestamp >= lastWithdrawal.timestamp)
          : [];
      } else if (periodSelect.value === "custom") {
        visibleMovements = filtered.filter((movement) =>
          (fromTimestamp === null || movement.timestamp >= fromTimestamp) &&
          (toTimestamp === null || movement.timestamp <= toTimestamp));
      }

      if (!visibleMovements.length) {
        const empty = document.createElement("p");
        empty.className = "movement-history-empty";
        empty.textContent = periodSelect.value === "since-withdrawal" && !lastWithdrawal
          ? "No hay retiros registrados para calcular este período."
          : "No hay movimientos para los filtros seleccionados.";
        list.append(empty);
        return;
      }

      const dateFormatter = new Intl.DateTimeFormat("es-AR", {
        dateStyle: "short",
        timeStyle: "short"
      });
      for (const movement of visibleMovements) {
        const item = document.createElement("article");
        item.className = "movement-history-item";
        item.dataset.platform = movement.fromPlatform || movement.platform;
        item.dataset.operation = movement.operation;
        if (movement.status) item.dataset.status = movement.status;
        const platformName = (platform) => platform === "ganamos" ? "Ganamos" : "MultiPanel";
        item.setAttribute("aria-label", movement.operation === "exchange"
          ? `Intercambio ${platformName(movement.fromPlatform)} a ${platformName(movement.toPlatform)}`
          : platformName(movement.platform));
        const summary = document.createElement("div");
        summary.className = "movement-history-summary";
        const timestamp = document.createElement("time");
        timestamp.dateTime = new Date(movement.timestamp).toISOString();
        timestamp.textContent = dateFormatter.format(movement.timestamp);
        summary.append(timestamp);

        const details = document.createElement("div");
        details.className = "movement-history-details";
        const amount = document.createElement("div");
        amount.className = "movement-history-amount";
        amount.dataset.operation = movement.operation;
        const hasTransactionAmount = Number.isFinite(movement.transactionAmount);
        const transactionAmount = hasTransactionAmount ? movement.transactionAmount : movement.amount;
        if (movement.operation === "exchange") {
          amount.textContent = `$${formatCurrency(movement.amount)}`;
          const description = document.createElement("span");
          description.className = "movement-history-exchange";
          const exchangeStatus = movement.status === "partial"
            ? "Intercambio incompleto"
            : movement.status === "pending-verification"
              ? "Intercambio pendiente de verificación"
              : "Intercambio";
          description.textContent = `${exchangeStatus}: ${platformName(movement.fromPlatform)} → ${platformName(movement.toPlatform)}`;
          details.append(description, amount);
        } else {
          const amountText = `$${formatCurrency(transactionAmount)}`;
          if (movement.status === "pending-verification") {
            amount.textContent = `Pendiente: $${formatCurrency(movement.amount)}`;
          } else {
            const sign = movement.operation === "deposit" ? "+" : "−";
            amount.textContent = `${sign}${amountText}`;
          }
          details.append(amount);
        }
        if (movement.operation === "deposit" && !hasTransactionAmount) {
          amount.title = "Total acreditado; el monto original no está disponible en este registro histórico";
        }
        if (movement.operation === "deposit") {
          if (movement.status === "pending-verification") {
            const verification = document.createElement("div");
            verification.className = "movement-history-verification";
            verification.textContent = "Pendiente de verificación";
            details.append(verification);
          }
          const bonus = document.createElement("div");
          bonus.className = "movement-history-bonus";
          bonus.textContent = Number.isFinite(movement.bonusAmount)
            ? `Bono: $${formatCurrency(movement.bonusAmount)}`
            : "Bono: Dato no Guardado";
          details.append(bonus);
        }
        item.append(summary, details);
        list.append(item);
      }
    };

    const loadMovements = async () => {
      list.replaceChildren();
      const loading = document.createElement("p");
      loading.className = "movement-history-empty";
      loading.textContent = "Cargando movimientos...";
      list.append(loading);
      try {
        const stored = await chrome.storage.local.get(null);
        if (host.dataset.accounts !== contactKey || !root.contains(modal)) return;
        storedMovements = Object.entries(stored)
          .filter(([key, record]) =>
            key.startsWith(AGENT_MOVEMENT_PREFIX) &&
            record?.contactKey === contactKey &&
            ["ganamos", "multipanel"].includes(record.platform) &&
            (!record.username || (
              typeof record.username === "string" &&
              record.username.toLowerCase() === platformUsernames[record.platform]?.toLowerCase()
            )))
          .map(([, record]) => record)
          .filter((record) =>
            Number.isFinite(record.timestamp) &&
            !Number.isNaN(new Date(record.timestamp).getTime()) &&
            Number.isFinite(record.amount) &&
            (["deposit", "withdrawal"].includes(record.operation) ||
              (record.operation === "exchange" &&
                ["ganamos", "multipanel"].includes(record.fromPlatform) &&
                ["ganamos", "multipanel"].includes(record.toPlatform))))
          .sort((first, second) => second.timestamp - first.timestamp);
        renderMovements();
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo cargar el historial del usuario.", error);
        const failure = document.createElement("p");
        failure.className = "movement-history-empty movement-history-error";
        failure.textContent = "No se pudo cargar el historial de movimientos.";
        list.replaceChildren(failure);
      }
    };

    platformSelect.addEventListener("change", renderMovements);
    periodSelect.addEventListener("change", renderMovements);
    fromInput.addEventListener("input", () => {
      periodSelect.value = "custom";
      renderMovements();
    });
    toInput.addEventListener("input", () => {
      periodSelect.value = "custom";
      renderMovements();
    });
    void loadMovements();
    close.focus();
  }

  function createAgentBalancePanel() {
    let host = document.getElementById(AGENT_BALANCE_HOST_ID);
    if (host) return host;

    host = document.createElement("div");
    host.id = AGENT_BALANCE_HOST_ID;
    host.style.left = "68px";
    host.style.top = "2px";
    host.style.width = "min(210px, calc(100vw - 56px))";
    host.style.visibility = "hidden";

    const shadow = host.attachShadow({ mode: "open" });
    for (const eventName of [
      "click",
      "contextmenu",
      "dblclick",
      "mousedown",
      "mouseup",
      "pointerdown",
      "pointerup",
      "selectstart"
    ]) {
      shadow.addEventListener(eventName, (event) => event.stopPropagation());
    }
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/whatsapp.css");
    stylesheet.addEventListener("load", () => {
      host.style.visibility = "";
    }, { once: true });
    stylesheet.addEventListener("error", () => {
      console.error("[Ganamos balance extension] No se pudo cargar styles/whatsapp.css.");
      host.style.visibility = "";
    }, { once: true });

    const card = document.createElement("div");
    card.className = "agent-balance-card";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agent-balance-toggle";
    toggle.addEventListener("click", async () => {
      const view = getNextAgentBalanceView(agentBalanceView);
      setAgentBalanceView(host, view);
      try {
        await chrome.storage.local.set({
          agentBalanceView: view,
          agentBalancesMinimized: view === "minimized"
        });
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo guardar la vista de balances.", error);
      }
    });
    const rows = document.createElement("div");
    rows.className = "agent-balance-rows";
    for (const [platform, refreshTitle, platformName] of [
      ["ganamos", "Actualizar balance del agente Ganamos", "Ganamos"],
      ["multipanel", "Actualizar balance del agente MultiPanel", "MultiPanel"]
    ]) {
      const row = document.createElement("div");
      row.className = "agent-balance-row";
      const label = document.createElement("span");
      label.className = "agent-balance-label";
      label.dataset.platform = platform;
      label.textContent = platformName;
      const amount = document.createElement("span");
      amount.className = "agent-balance-amount";
      amount.dataset.platform = platform;
      amount.setAttribute("aria-live", "polite");
      amount.textContent = "Cargando...";
      amount.addEventListener("click", () => selectCurrencyAmount(amount));
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "agent-balance-refresh";
      refresh.dataset.platform = platform;
      refresh.textContent = "↻";
      refresh.title = refreshTitle;
      refresh.setAttribute("aria-label", refreshTitle);
      refresh.addEventListener("click", () => {
        if (platform === "ganamos") void refreshAgentBalance(host);
        else void refreshMultiPanelAgentBalance(host);
      });
      row.append(label, amount, refresh);
      rows.append(row);
    }
    const movementView = document.createElement("div");
    movementView.className = "agent-movement-view";
    movementView.hidden = true;
    const movementList = document.createElement("div");
    movementList.className = "agent-movement-list";
    movementView.append(movementList);
    const errorView = document.createElement("div");
    errorView.className = "agent-balance-error-view";
    errorView.hidden = true;
    card.append(toggle, rows, movementView, errorView);
    shadow.append(stylesheet, card);
    document.documentElement.append(host);
    chrome.storage.local.get(["agentBalanceView", "agentBalancesMinimized"])
      .then(({ agentBalanceView: storedView, agentBalancesMinimized }) => {
        const view = AGENT_BALANCE_VIEWS.includes(storedView)
          ? storedView
          : agentBalancesMinimized
            ? "minimized"
            : "balance";
        setAgentBalanceView(host, view);
      })
      .catch((error) => console.error("[Ganamos balance extension] No se pudo recuperar la vista de balances.", error));
    return host;
  }

  async function refreshAgentBalance(host = createAgentBalancePanel()) {
    if (agentBalanceLoading) return;
    const label = host.shadowRoot?.querySelector('.agent-balance-label[data-platform="ganamos"]');
    const amount = host.shadowRoot?.querySelector('.agent-balance-amount[data-platform="ganamos"]');
    const refreshButtons = host.shadowRoot
      ? [...host.shadowRoot.querySelectorAll('.agent-balance-refresh[data-platform="ganamos"]')]
      : [];
    if (!label || !amount || !refreshButtons.length) return;

    agentBalanceLoading = true;
    refreshButtons.forEach((refresh) => { refresh.disabled = true; });
    amount.classList.remove("agent-balance-error");
    label.title = "Ganamos: actualizando...";
    amount.title = label.title;
    amount.textContent = "Actualizando...";
    try {
      const response = await chrome.runtime.sendMessage({ type: "AGENT_BALANCE_REQUEST" });
      if (!response?.ok) throw new Error(response?.error || "No se pudo consultar el balance del agente.");
      setAgentBalanceError(host, "ganamos");
      label.title = `Ganamos: $${formatCurrency(Number(response.balance))}`;
      amount.title = label.title;
      amount.textContent = `$${formatCurrency(Number(response.balance))}`;
    } catch (error) {
      label.title = `Ganamos: ${error.message || "error al consultar"}`;
      amount.classList.add("agent-balance-error");
      amount.title = label.title;
      amount.textContent = "Error";
      setAgentBalanceError(host, "ganamos", error.message || "Error al consultar el balance.");
    } finally {
      agentBalanceLoading = false;
      refreshButtons.forEach((refresh) => { refresh.disabled = false; });
    }
  }

  async function refreshMultiPanelAgentBalance(host = createAgentBalancePanel()) {
    if (multiPanelAgentBalanceLoading) return;
    const label = host.shadowRoot?.querySelector('.agent-balance-label[data-platform="multipanel"]');
    const amount = host.shadowRoot?.querySelector('.agent-balance-amount[data-platform="multipanel"]');
    const refreshButtons = host.shadowRoot
      ? [...host.shadowRoot.querySelectorAll('.agent-balance-refresh[data-platform="multipanel"]')]
      : [];
    if (!label || !amount || !refreshButtons.length) return;

    multiPanelAgentBalanceLoading = true;
    refreshButtons.forEach((refresh) => { refresh.disabled = true; });
    amount.classList.remove("agent-balance-error");
    label.title = "MultiPanel: actualizando...";
    amount.title = label.title;
    amount.textContent = "Actualizando...";
    try {
      const response = await chrome.runtime.sendMessage({ type: "MULTIPANEL_AGENT_BALANCE_REQUEST" });
      if (!response?.ok) throw new Error(response?.error || "No se pudo consultar el balance del agente MultiPanel.");
      setAgentBalanceError(host, "multipanel");
      label.title = `MultiPanel: $${formatCurrency(Number(response.balance))}`;
      amount.title = label.title;
      amount.textContent = `$${formatCurrency(Number(response.balance))}`;
    } catch (error) {
      label.title = `MultiPanel: ${error.message || "error al consultar"}`;
      amount.classList.add("agent-balance-error");
      amount.title = label.title;
      amount.textContent = "Error";
      setAgentBalanceError(host, "multipanel", error.message || "Error al consultar el balance.");
    } finally {
      multiPanelAgentBalanceLoading = false;
      refreshButtons.forEach((refresh) => { refresh.disabled = false; });
    }
  }

  function findPlatformUsernames(contactName) {
    const usernames = { ganamos: null, multipanel: null };
    let firstPlatform = null;
    const aliases = contactName.trim().split(/[\s/]+/)
      .map((part) => part.replace(/^[^\p{L}\p{N}._-]+/u, "").replace(/[./]+$/, ""))
      .map((part) => part.match(/^([\p{L}\p{M}\p{N}._-]+?)([a-z])\2*$/iu))
      .filter(Boolean);

    for (const [, base, suffix] of aliases) {
      if (!/^(?=.*\p{L})(?=.*\d)[\p{L}\p{M}\p{N}._-]+$/u.test(base)) continue;
      const normalizedSuffix = suffix.toLowerCase();
      const platform = normalizedSuffix === platformSuffixes.ganamos
        ? "ganamos"
        : normalizedSuffix === platformSuffixes.multipanel
          ? "multipanel"
          : null;
      if (platform) {
        firstPlatform ||= platform;
        usernames[platform] ||= `${base}${normalizedSuffix}`;
      }
    }
    return { ...usernames, firstPlatform };
  }

  function getOrCreateHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;

    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.visibility = "hidden";

    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/whatsapp.css");
    stylesheet.addEventListener("load", () => {
      host.style.visibility = "";
    }, { once: true });
    stylesheet.addEventListener("error", () => {
      console.error("[Ganamos balance extension] No se pudo cargar styles/whatsapp.css.");
      host.style.visibility = "";
    }, { once: true });
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "group");
    const informationButton = document.createElement("button");
    informationButton.type = "button";
    informationButton.className = "user-information-button";
    informationButton.textContent = "i";
    informationButton.title = "Información de depósitos, retiros y bonos";
    informationButton.setAttribute("aria-label", "Información de depósitos, retiros y bonos");
    informationButton.hidden = true;
    informationButton.addEventListener("click", () => openUserMovementDialog(host));
    const exchangeButton = document.createElement("button");
    exchangeButton.type = "button";
    exchangeButton.className = "exchange-button";
    const exchangeIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    exchangeIcon.setAttribute("viewBox", "0 0 24 24");
    exchangeIcon.setAttribute("aria-hidden", "true");
    const exchangeArrows = document.createElementNS("http://www.w3.org/2000/svg", "path");
    exchangeArrows.setAttribute("d", "M4 7h15l-3-3m3 3-3 3M20 17H5l3 3m-3-3 3-3");
    exchangeIcon.append(exchangeArrows);
    exchangeButton.append(exchangeIcon);
    exchangeButton.title = "Intercambiar fichas entre plataformas";
    exchangeButton.setAttribute("aria-label", "Intercambiar fichas entre plataformas");
    exchangeButton.hidden = true;
    exchangeButton.addEventListener("click", () => openExchangeDialog(host));
    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("aria-live", "polite");
    const balanceLabel = document.createElement("span");
    balanceLabel.className = "balance-label";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "refresh";
    refresh.textContent = "↻";
    refresh.title = "Actualizar saldos";
    refresh.setAttribute("aria-label", "Actualizar saldos");
    refresh.addEventListener("click", () => void refreshBalance(host));
    status.append(balanceLabel, refresh);
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const [action, label] of [["deposit", "Depositar"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label;
      button.addEventListener("click", () => openTransactionDialog(host, action));
      actions.append(button);
    }
    const withdrawalGroup = document.createElement("div");
    withdrawalGroup.className = "withdrawal-action-group";
    const withdrawalButton = document.createElement("button");
    withdrawalButton.type = "button";
    withdrawalButton.dataset.action = "withdrawal";
    withdrawalButton.textContent = "Retirar";
    withdrawalButton.addEventListener("click", () => void startWithdrawal(host));
    const passwordResetButton = document.createElement("button");
    passwordResetButton.type = "button";
    passwordResetButton.className = "password-reset-button";
    passwordResetButton.title = "Restaurar contraseña";
    passwordResetButton.setAttribute("aria-label", "Restaurar contraseña");
    passwordResetButton.hidden = true;
    const passwordIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    passwordIcon.setAttribute("viewBox", "0 0 24 24");
    passwordIcon.setAttribute("aria-hidden", "true");
    const passwordIconPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    passwordIconPath.setAttribute("d", "M7 10V7a5 5 0 0 1 10 0v3m-11 0h12a2 2 0 0 1 2 2v7H4v-7a2 2 0 0 1 2-2Zm5 4v3");
    passwordIcon.append(passwordIconPath);
    passwordResetButton.append(passwordIcon);
    passwordResetButton.addEventListener("click", () => openPasswordResetDialog(host));
    withdrawalGroup.append(withdrawalButton);
    actions.append(withdrawalGroup);
    const createUserButton = document.createElement("button");
    createUserButton.type = "button";
    createUserButton.className = "create-user-button";
    createUserButton.textContent = "+";
    createUserButton.title = "Crear usuario";
    createUserButton.setAttribute("aria-label", "Crear usuario");
    createUserButton.hidden = true;
    createUserButton.addEventListener("click", () =>
      openCreateUserDialog(host, host.dataset.createPlatform || null));
    actions.append(createUserButton);
    const dialogRoot = document.createElement("div");
    dialogRoot.className = "dialog-root";
    panel.append(informationButton, exchangeButton, passwordResetButton, actions, status, dialogRoot);
    shadow.append(stylesheet, panel);
    document.documentElement.append(host);
    return host;
  }

  async function refreshBalance(host) {
    const accounts = [
      ["ganamos", host.dataset.username],
      ["multipanel", host.dataset.multipanelUsername]
    ];
    const accountsToFetch = accounts.filter(([, username]) => username);
    if (!host.shadowRoot || !accountsToFetch.length) return;

    const requestAccountsKey = host.dataset.accounts;
    host.balanceStates ||= {};
    for (const [platform] of accountsToFetch) {
      host.balanceStates[platform] = { loading: true };
    }
    renderBalanceRows(host, accounts);

    await Promise.all(accountsToFetch.map(async ([platform, username]) => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "BALANCE_REQUEST",
          data: { nombre: username, platform }
        });
        if (!response?.ok) throw new Error(response?.error || "consulta fallida");
        if (host.dataset.accounts !== requestAccountsKey) return;
        host.balanceStates[platform] = { balance: response.balance };
      } catch (error) {
        if (host.dataset.accounts !== requestAccountsKey) return;
        host.balanceStates[platform] = { error: error.message || "consulta fallida" };
      }
      if (document.getElementById(HOST_ID) === host && host.dataset.accounts === requestAccountsKey) {
        renderBalanceRows(host, accounts);
      }
    }));
  }

  function renderBalanceRows(host, accounts) {
    const status = host.shadowRoot?.querySelector(".status");
    const label = status?.querySelector(".balance-label");
    const refresh = status?.querySelector(".refresh");
    if (!label || !refresh) return;

    label.textContent = accounts.filter(([, username]) => username).map(([platform]) => {
      const state = host.balanceStates?.[platform];
      const platformLabel = platform === "ganamos" ? "Ganamos" : "MultiPanel";
      if (state?.loading) return `${platformLabel}: consultando...`;
      if (state?.error) return `${platformLabel}: ${state.error}`;
      if (state?.balance != null) {
        const balance = parseBalance(state.balance);
        return balance === null
          ? `${platformLabel}: saldo inválido`
          : `${platformLabel}: $${formatBalance(balance)}`;
      }
      return `${platformLabel}: pendiente`;
    }).join(" | ");
    refresh.disabled = accounts.some(([platform, username]) => username && host.balanceStates?.[platform]?.loading);
  }

  function parseBalance(value) {
    let normalized = String(value).trim().replace(/ARS|USD|US\$|\$/gi, "").replace(/\s/g, "");
    const commaIndex = normalized.lastIndexOf(",");
    const dotIndex = normalized.lastIndexOf(".");
    if (commaIndex >= 0 && dotIndex >= 0) {
      const decimalSeparator = commaIndex > dotIndex ? "," : ".";
      const groupingSeparator = decimalSeparator === "," ? /\./g : /,/g;
      normalized = normalized.replace(groupingSeparator, "").replace(decimalSeparator, ".");
    } else if (/[.,]/.test(normalized)) {
      if (/^\d{1,3}(?:[.,]\d{3})+$/.test(normalized)) normalized = normalized.replace(/[.,]/g, "");
      else normalized = normalized.replace(",", ".");
    }
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }

  function createInputAffix(input, text, position = "prefix") {
    const wrapper = document.createElement("span");
    wrapper.className = "input-affix";
    wrapper.dataset.position = position;
    const affix = document.createElement("span");
    affix.textContent = text;
    wrapper.append(input, affix);
    return wrapper;
  }

  async function openExchangeDialog(host) {
    const root = host.shadowRoot?.querySelector(".dialog-root");
    const openedAccountsKey = host.dataset.accounts;
    const usernames = {
      ganamos: host.dataset.username,
      multipanel: host.dataset.multipanelUsername
    };
    const platformName = (platform) => platform === "ganamos" ? "Ganamos" : "MultiPanel";
    if (!root || !usernames.ganamos || !usernames.multipanel) return;
    root.replaceChildren();

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      root.replaceChildren();
    }, true);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) root.replaceChildren();
    });

    const dialog = document.createElement("form");
    dialog.className = "dialog";
    dialog.dataset.operation = "exchange";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = "Intercambio de fichas";
    dialog.append(title);

    const platformFields = document.createElement("div");
    platformFields.className = "exchange-platform-fields";
    const platformSelects = {};
    for (const [direction, labelText] of [["from", "Desde"], ["to", "Hacia"]]) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const select = document.createElement("select");
      select.className = "exchange-platform-select";
      select.dataset.platform = direction === "from" ? "ganamos" : "multipanel";
      for (const [platform, name] of [["ganamos", "Ganamos"], ["multipanel", "MultiPanel"]]) {
        const option = document.createElement("option");
        option.value = platform;
        option.textContent = name;
        select.append(option);
      }
      select.addEventListener("change", () => {
        select.dataset.platform = select.value;
      });
      platformSelects[direction] = select;
      label.append(select);
      platformFields.append(label);
    }
    const cachedBalances = ["ganamos", "multipanel"].map((platform) => ({
      platform,
      balance: parseBalance(host.balanceStates?.[platform]?.balance)
    })).filter(({ balance }) => balance !== null);
    const cachedPreferredSource = cachedBalances.sort((first, second) => second.balance - first.balance)[0]?.platform;
    const preferredSource = cachedPreferredSource ||
      (host.dataset.defaultPlatform === "multipanel" ? "multipanel" : "ganamos");
    platformSelects.from.value = preferredSource;
    platformSelects.to.value = preferredSource === "ganamos" ? "multipanel" : "ganamos";
    platformSelects.from.dataset.platform = platformSelects.from.value;
    platformSelects.to.dataset.platform = platformSelects.to.value;
    let sourceWasManuallyChanged = false;
    const syncPlatformSelections = (changed) => {
      sourceWasManuallyChanged = true;
      const other = changed === "from" ? "to" : "from";
      if (platformSelects[changed].value === platformSelects[other].value) {
        platformSelects[other].value = platformSelects[changed].value === "ganamos"
          ? "multipanel"
          : "ganamos";
      }
      platformSelects.from.dataset.platform = platformSelects.from.value;
      platformSelects.to.dataset.platform = platformSelects.to.value;
    };
    platformSelects.from.addEventListener("change", () => syncPlatformSelections("from"));
    platformSelects.to.addEventListener("change", () => syncPlatformSelections("to"));
    dialog.append(platformFields);

    const amountLabel = document.createElement("label");
    amountLabel.textContent = "Monto";
    const amountInput = document.createElement("input");
    configureNumericInput(amountInput);
    amountInput.required = true;
    amountInput.placeholder = "-";
    amountLabel.append(createInputAffix(amountInput, "$"));
    dialog.append(amountLabel);
    dialog.append(createAmountShortcuts(amountInput));

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const actionButtons = document.createElement("div");
    actionButtons.className = "dialog-action-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => root.replaceChildren());
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.textContent = "Intercambiar";
    actionButtons.append(cancel, confirm);
    actions.append(actionButtons);
    dialog.append(actions);

    dialog.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fromPlatform = platformSelects.from.value;
      const toPlatform = platformSelects.to.value;
      const fromUsername = usernames[fromPlatform];
      const toUsername = usernames[toPlatform];
      const amount = numericInputValue(amountInput);
      if (fromPlatform === toPlatform || amount === null || amount <= 0 ||
        !hasValidInputPrecision(amountInput)) {
        showToast(host, fromUsername || "Chat", "Elegí plataformas distintas e ingresá un monto válido de hasta dos decimales.", "error");
        amountInput.focus();
        return;
      }
      if (host.dataset.accounts !== openedAccountsKey) {
        showToast(host, fromUsername, "El chat cambió; cerrá este formulario y volvé a iniciar el intercambio.", "error");
        return;
      }

      confirm.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "BALANCE_REQUEST",
          data: { nombre: fromUsername, platform: fromPlatform, force: true }
        });
        if (!response?.ok) throw new Error(response?.error || "No se pudo consultar el saldo de origen.");
        if (host.dataset.accounts !== openedAccountsKey) {
          throw new Error("El chat cambió; volvé a iniciar el intercambio.");
        }
        const availableBalance = parseBalance(response.balance);
        if (availableBalance === null || availableBalance <= 0) {
          throw new Error("El saldo de origen no es válido para un intercambio.");
        }
        if (amount > availableBalance + Number.EPSILON) {
          throw new Error(`El monto supera el saldo disponible de $${formatBalance(availableBalance)}.`);
        }
      } catch (error) {
        showToast(host, fromUsername, error.message || "No se pudo validar el saldo de origen.", "error");
        confirm.disabled = false;
        return;
      }

      const amountString = numericInputString(amountInput);
      const toastKey = `exchange:${crypto.randomUUID()}`;
      confirm.disabled = true;
      showToast(host, fromUsername, "Procesando intercambio...", "warning", toastKey);
      root.replaceChildren();
      const saveExchange = async (status) => {
        await saveAgentMovement(openedAccountsKey, "exchange", amount, fromPlatform, {
          username: fromUsername,
          fromPlatform,
          toPlatform,
          status
        });
        if (agentBalanceContactKey === openedAccountsKey) {
          const agentBalanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
          if (agentBalanceHost) void renderAgentMovements(agentBalanceHost);
        }
      };

      try {
        const response = await chrome.runtime.sendMessage({
          type: "EXCHANGE_REQUEST",
          data: { fromPlatform, toPlatform, fromUsername, toUsername, monto: amountString }
        });
        if (response?.partial) {
          let historyError = false;
          try {
            await saveExchange(response.verificationPending ? "pending-verification" : "partial");
          } catch (error) {
            console.error("[Ganamos balance extension] No se pudo guardar el intercambio incompleto.", error);
            historyError = true;
          }
          const message = response.error || (response.verificationPending
            ? "El retiro se confirmó, pero el depósito quedó pendiente de verificación. Revisá ambos saldos antes de repetir la operación."
            : "El retiro se confirmó, pero falló el depósito. Verificá ambos saldos.");
          showToast(host, fromUsername, historyError
            ? `${message} Además, no se pudo guardar el intercambio en el historial.`
            : message, "error", toastKey);
          void refreshBalance(host);
          void refreshAgentBalance();
          void refreshMultiPanelAgentBalance();
          return;
        }
        if (!response?.ok) throw new Error(response?.error || "No se pudo completar el intercambio.");
        try {
          await saveExchange("complete");
        } catch (error) {
          console.error("[Ganamos balance extension] No se pudo guardar el intercambio confirmado.", error);
          showToast(host, fromUsername, "El intercambio se completó, pero no se pudo guardar en el historial.", "error", toastKey);
        }
        showToast(host, fromUsername,
          `Intercambio ${platformName(fromPlatform)} → ${platformName(toPlatform)} ($${formatCurrency(amount)}).`,
          "success", toastKey);
        void refreshBalance(host);
        void refreshAgentBalance();
        void refreshMultiPanelAgentBalance();
      } catch (error) {
        showToast(host, fromUsername, error.message || "No se pudo completar el intercambio.", "error", toastKey);
      } finally {
        confirm.disabled = false;
      }
    });

    modal.append(dialog);
    root.append(modal);
    amountInput.focus();

    void (async () => {
      try {
        const results = await Promise.all(["ganamos", "multipanel"].map(async (platform) => {
          const response = await chrome.runtime.sendMessage({
            type: "BALANCE_REQUEST",
            data: { nombre: usernames[platform], platform, force: true }
          });
          if (!response?.ok) throw new Error(response?.error || `No se pudo consultar el saldo de ${platformName(platform)}.`);
          const balance = parseBalance(response.balance);
          if (balance === null) throw new Error(`El saldo de ${platformName(platform)} no es válido.`);
          host.balanceStates ||= {};
          host.balanceStates[platform] = { balance };
          return { platform, balance };
        }).map((request) => request.catch((error) => ({ error }))));
        if (host.dataset.accounts !== openedAccountsKey || !root.contains(modal) ||
          sourceWasManuallyChanged) return;
        const validBalances = results.filter((result) => !result.error);
        if (!validBalances.length) {
          const failure = results.find((result) => result.error);
          showToast(host, usernames.ganamos, failure.error.message || "No se pudieron consultar los saldos para elegir el origen.", "error");
          return;
        }
        validBalances.sort((first, second) => second.balance - first.balance);
        const bestSource = validBalances[0].platform;
        platformSelects.from.value = bestSource;
        platformSelects.to.value = bestSource === "ganamos" ? "multipanel" : "ganamos";
        platformSelects.from.dataset.platform = platformSelects.from.value;
        platformSelects.to.dataset.platform = platformSelects.to.value;
        if (results.some((result) => result.error)) {
          const failure = results.find((result) => result.error);
          showToast(host, usernames.ganamos, `No se pudo comparar uno de los saldos; se eligió ${platformName(bestSource)} con el saldo consultado. ${failure.error.message}`, "error");
        }
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudieron comparar los saldos para el intercambio.", error);
        if (host.dataset.accounts === openedAccountsKey && root.contains(modal)) {
          showToast(host, usernames.ganamos, error.message || "No se pudieron consultar los saldos para elegir el origen.", "error");
        }
      }
    })();
  }

  async function openTransactionDialog(host, operation) {
    const shadow = host.shadowRoot;
    const root = shadow?.querySelector(".dialog-root");
    const openedAccountsKey = host.dataset.accounts;
    const getPlatformUsername = (platform) =>
      platform === "ganamos" ? host.dataset.username : host.dataset.multipanelUsername;
    let selectedPlatform = host.dataset.defaultPlatform ||
      (host.dataset.username ? "ganamos" : "multipanel");
    if (!root || !getPlatformUsername(selectedPlatform)) return;
    root.replaceChildren();

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      root.replaceChildren();
    }, true);
    const dialog = document.createElement("form");
    dialog.className = "dialog";
    dialog.dataset.operation = operation;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = operation === "deposit" ? "Depositar" : "Retirar";
    const heading = document.createElement("div");
    heading.className = "transaction-heading";
    heading.append(title);
    if (operation === "withdrawal") {
      const lastWithdrawalLabel = document.createElement("time");
      lastWithdrawalLabel.className = "last-withdrawal";
      lastWithdrawalLabel.hidden = true;
      heading.append(lastWithdrawalLabel);
    }
    dialog.append(heading);

    const selector = document.createElement("div");
    selector.className = "platform-selector";
    for (const [platform, label] of [["ganamos", "Ganamos"], ["multipanel", "MultiPanel"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.platform = platform;
      button.textContent = label;
      button.disabled = !getPlatformUsername(platform);
      button.setAttribute("aria-pressed", String(platform === selectedPlatform));
      button.addEventListener("click", () => {
        selectedPlatform = platform;
        for (const option of selector.querySelectorAll("button")) {
          option.setAttribute("aria-pressed", String(option.dataset.platform === selectedPlatform));
        }
        if (operation === "deposit") depositSummary.dataset.platform = selectedPlatform;
        else withdrawalSummary.dataset.platform = selectedPlatform;
        confirm.textContent = "Confirmar";
      });
      selector.append(button);
    }
    dialog.append(selector);

    const amountLabel = document.createElement("label");
    amountLabel.textContent = "Monto";
    const amountEntry = document.createElement("div");
    amountEntry.className = "amount-entry";
    const amountInput = document.createElement("input");
    configureNumericInput(amountInput);
    amountInput.placeholder = "-";
    amountInput.required = true;
    amountLabel.append(createInputAffix(amountInput, "$"));
    amountEntry.append(amountLabel);
    dialog.append(amountEntry);

    dialog.append(createAmountShortcuts(amountInput));

    const depositSummary = document.createElement("span");
    depositSummary.className = "deposit-summary";
    depositSummary.dataset.platform = selectedPlatform;
    depositSummary.setAttribute("aria-live", "polite");
    const withdrawalSummary = document.createElement("div");
    withdrawalSummary.className = "deposit-summary withdrawal-summary";
    withdrawalSummary.dataset.platform = selectedPlatform;
    withdrawalSummary.setAttribute("aria-live", "polite");
    const withdrawalFinalLine = document.createElement("div");
    const recoveryBonusLine = document.createElement("div");
    withdrawalSummary.append(withdrawalFinalLine, recoveryBonusLine);
    let dialogActions;
    const updateDepositSummary = () => {
      depositSummary.hidden = !bonusInput?.value && !bonusPercentInput?.value;
      dialogActions?.classList.toggle("has-deposit-summary", !depositSummary.hidden);
      const amount = numericInputValue(amountInput) || 0;
      const bonus = numericInputValue(bonusInput) || 0;
      depositSummary.textContent = `Depósito Final: $${formatBalance(amount + bonus)} / $${formatBalance(bonus)}`;
    };
    const updateWithdrawalSummary = () => {
      withdrawalSummary.hidden = !loadAmountInput.value && !recoveryPercentInput.value;
      dialogActions?.classList.toggle("has-deposit-summary", !withdrawalSummary.hidden);
      const amount = numericInputValue(amountInput) || 0;
      const load = numericInputValue(loadAmountInput) || 0;
      const percent = numericInputValue(recoveryPercentInput) || 0;
      const bonus = Math.ceil(load * percent / 100);
      withdrawalFinalLine.textContent = `Retiro Final: $${formatBalance(amount - bonus)}`;
      recoveryBonusLine.textContent = `Bono a Recuperar: $${formatBalance(bonus)}`;
    };

    let bonusInput = null;
    let bonusPercentInput = null;
    let loadAmountInput = null;
    let recoveryPercentInput = null;
    if (operation === "deposit") {
      const bonusFields = document.createElement("div");
      bonusFields.className = "bonus-fields";
      const bonusLabel = document.createElement("label");
      bonusLabel.textContent = "Bono fijo";
      bonusInput = document.createElement("input");
      configureNumericInput(bonusInput);
      bonusInput.placeholder = "-";
      bonusLabel.append(createInputAffix(bonusInput, "$"));
      const bonusPercentLabel = document.createElement("label");
      bonusPercentLabel.textContent = "Bono (%)";
      bonusPercentInput = document.createElement("input");
      configureNumericInput(bonusPercentInput);
      bonusPercentInput.placeholder = "-";

      bonusPercentLabel.append(createInputAffix(bonusPercentInput, "%", "suffix"));
      bonusFields.append(bonusLabel, bonusPercentLabel);
      dialog.append(bonusFields);
      dialog.append(createPercentageShortcuts(bonusPercentInput));

      const numberValue = numericInputValue;
      const syncFixedFromPercent = () => {
        const amount = numberValue(amountInput);
        const percent = numberValue(bonusPercentInput);
        bonusInput.value = amount > 0 && percent != null
          ? new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(
            Math.min(Math.ceil(amount * percent / 100), 10000)
          )
          : "";
      };
      const clampBonusPercent = () => {
        const percent = numberValue(bonusPercentInput);
        if (percent === null || percent <= 100) return;
        bonusPercentInput.value = "100";
        formatNumericInput(bonusPercentInput, bonusPercentInput.value.length);
        syncFixedFromPercent();
        updateDepositSummary();
      };
      amountInput.addEventListener("input", syncFixedFromPercent);
      bonusPercentInput.addEventListener("input", syncFixedFromPercent);
      bonusPercentInput.addEventListener("input", clampBonusPercent);
      bonusInput.addEventListener("input", () => {
        const amount = numberValue(amountInput);
        const bonus = numberValue(bonusInput);
        const percent = amount > 0 && bonus != null ? (bonus / amount * 100).toFixed(2) : "";
        bonusPercentInput.value = percent === ""
          ? ""
          : formatBalance(Math.min(Number(percent), 100));
      });
      amountInput.addEventListener("input", updateDepositSummary);
      bonusPercentInput.addEventListener("input", updateDepositSummary);
      bonusInput.addEventListener("input", updateDepositSummary);
      updateDepositSummary();
    }

    if (operation === "withdrawal") {
      const recoveryFields = document.createElement("div");
      recoveryFields.className = "bonus-fields";
      const loadLabel = document.createElement("label");
      loadLabel.textContent = "Carga (Opcional)";
      loadAmountInput = document.createElement("input");
      configureNumericInput(loadAmountInput);
      loadAmountInput.placeholder = "-";
      loadLabel.append(createInputAffix(loadAmountInput, "$"));
      const recoveryPercentLabel = document.createElement("label");
      recoveryPercentLabel.textContent = "Bono (%)";
      recoveryPercentInput = document.createElement("input");
      configureNumericInput(recoveryPercentInput);
      recoveryPercentInput.placeholder = "-";
      recoveryPercentLabel.append(createInputAffix(recoveryPercentInput, "%", "suffix"));
      recoveryFields.append(loadLabel, recoveryPercentLabel);
      dialog.append(recoveryFields);
      dialog.append(createPercentageShortcuts(recoveryPercentInput));
      amountInput.addEventListener("input", updateWithdrawalSummary);
      loadAmountInput.addEventListener("input", updateWithdrawalSummary);
      recoveryPercentInput.addEventListener("input", updateWithdrawalSummary);
      updateWithdrawalSummary();
    }

    const loadWithdrawalBalance = async (balancePlatform, fillAmount = false) => {
      const balanceUsername = getPlatformUsername(balancePlatform);
      const response = await chrome.runtime.sendMessage({
        type: "BALANCE_REQUEST",
        data: { nombre: balanceUsername, platform: balancePlatform, force: true }
      });
      if (!response?.ok) throw new Error(response?.error || "No se pudo consultar el saldo.");
      if (host.dataset.accounts !== openedAccountsKey || selectedPlatform !== balancePlatform) {
        throw new Error("El chat o la plataforma cambió; volvé a consultar el saldo.");
      }

      const balance = parseBalance(response.balance);
      if (balance === null || balance <= 0) {
        throw new Error("El saldo disponible no es válido para un retiro.");
      }
      if (fillAmount) {
        const wholeBalance = Math.floor(balance);
        if (wholeBalance <= 0) {
          throw new Error("El saldo disponible no alcanza para cargar un monto entero.");
        }
        amountInput.value = new Intl.NumberFormat("es-AR").format(wholeBalance);
        formatNumericInput(amountInput, amountInput.value.length);
        amountInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return balance;
    };

    if (operation === "withdrawal") {
      const loadBalanceButton = document.createElement("button");
      loadBalanceButton.type = "button";
      loadBalanceButton.className = "secondary";
      loadBalanceButton.textContent = "Todo";
      loadBalanceButton.addEventListener("click", async () => {
        const balancePlatform = selectedPlatform;
        const balanceUsername = getPlatformUsername(balancePlatform);
        loadBalanceButton.disabled = true;
        try {
          await loadWithdrawalBalance(balancePlatform, true);
        } catch (exception) {
          showToast(host, balanceUsername, exception.message || "No se pudo consultar el saldo.", "error");
        } finally {
          loadBalanceButton.disabled = false;
        }
      });
      amountEntry.append(loadBalanceButton);
    }

    dialogActions = document.createElement("div");
    dialogActions.className = "dialog-actions";
    const actionButtons = document.createElement("div");
    actionButtons.className = "dialog-action-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => root.replaceChildren());
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.textContent = "Confirmar";
    actionButtons.append(cancel, confirm);
    if (operation === "deposit") dialogActions.append(depositSummary, actionButtons);
    else dialogActions.append(withdrawalSummary, actionButtons);
    dialog.append(dialogActions);
    if (operation === "deposit") updateDepositSummary();
    else updateWithdrawalSummary();
    dialog.addEventListener("submit", async (event) => {
      event.preventDefault();
      const amount = numericInputString(amountInput);
      const numericAmount = numericInputValue(amountInput);
      const numericFields = [bonusInput, bonusPercentInput, loadAmountInput, recoveryPercentInput]
        .filter((input) => input?.value);
      const hasInvalidOptionalValue = numericFields.some((input) => {
        const value = numericInputValue(input);
        return value === null || value < 0 || !hasValidInputPrecision(input);
      });
      if (numericAmount === null || numericAmount <= 0 || !hasValidInputPrecision(amountInput) ||
        hasInvalidOptionalValue) {
        const message = hasInvalidOptionalValue || numericAmount > 0
          ? "Los montos y porcentajes deben ser válidos, no negativos y tener hasta dos decimales."
          : "Ingresá un monto mayor a cero.";
        showToast(host, getPlatformUsername(selectedPlatform), message, "error");
        amountInput.focus();
        return;
      }
      if (operation === "withdrawal") {
        const username = getPlatformUsername(selectedPlatform);
        confirm.disabled = true;
        try {
          const currentBalance = await loadWithdrawalBalance(selectedPlatform);
          if (numericAmount > currentBalance + Number.EPSILON) {
            showToast(
              host,
              username,
              `El monto supera el saldo disponible de $${formatBalance(currentBalance)}.`,
              "error"
            );
            return;
          }
        } catch (exception) {
          showToast(host, username, exception.message || "No se pudo validar el saldo del retiro.", "error");
          return;
        } finally {
          confirm.disabled = false;
        }
      }

      const bonus = bonusInput?.value && (numericInputValue(bonusInput) || 0) > 0
        ? { enabled: true, mode: "value", value: numericInputString(bonusInput) }
        : null;
      const username = selectedPlatform === "multipanel"
        ? host.dataset.multipanelUsername
        : host.dataset.username;
      if (host.dataset.accounts !== openedAccountsKey || !username) {
        showToast(host, username || "Chat", "El chat cambió; cerrá este formulario y volvé a iniciar la operación.", "error");
        return;
      }
      confirm.disabled = true;
      showToast(host, username, "Enviando solicitud...", "warning");
      root.replaceChildren();
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TRANSACTION_REQUEST",
          data: { operation, nombre: username, monto: amount, bonus, platform: selectedPlatform }
        });
        if (!response?.ok) throw new Error(response?.error || "La API no confirmó la operación.");
        const amountValue = numericAmount;
        const bonusValue = bonus?.enabled ? Number(bonus.value) : 0;
        const creditedAmount = operation === "deposit" ? amountValue + bonusValue : amountValue;
        const amountSummary = `$${formatCurrency(creditedAmount)}`;
        const bonusSummary = `$${formatCurrency(bonusValue)}`;
        const pendingVerification = operation === "deposit" &&
          response.verification?.status !== "verified";
        let movementSaved = true;
        try {
          await saveAgentMovement(openedAccountsKey, operation, creditedAmount, selectedPlatform, {
            username,
            transactionAmount: amountValue,
            bonusAmount: operation === "deposit" ? bonusValue : 0,
            status: pendingVerification ? "pending-verification" : undefined,
            verification: response.verification
          });
          if (agentBalanceContactKey === openedAccountsKey) {
            const agentBalanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
            if (agentBalanceHost) void renderAgentMovements(agentBalanceHost);
          }
        } catch (error) {
          movementSaved = false;
          console.error("[Ganamos balance extension] No se pudo guardar el movimiento de la operación.", error);
        }
        if (pendingVerification) {
          const verification = response.verification;
          const observed = Number.isFinite(verification?.finalBalance)
            ? ` El saldo consultado pasó de $${formatBalance(verification.initialBalance)} a $${formatBalance(verification.finalBalance)}.`
            : "";
          const historyNotice = movementSaved
            ? ""
            : " Tampoco se pudo guardar el movimiento localmente.";
          showToast(host, username,
            `La plataforma respondió, pero no se pudo confirmar el depósito de ${amountSummary} (incluye $${bonusSummary} de bono). Quedó pendiente de verificación; revisá el saldo o historial antes de volver a cargar.${observed}${historyNotice}`,
            "warning");
        } else {
          showToast(host, username,
            operation === "deposit"
              ? `Depósito - ${selectedPlatform === "ganamos" ? "Ganamos" : "MultiPanel"} ${amountSummary} (+${bonusSummary}).`
              : `Retiro ${selectedPlatform === "ganamos" ? "Ganamos" : "MultiPanel"} (${amountSummary}).`,
            "success");
          if (!movementSaved) {
            showToast(host, username, "La operación se completó, pero no se pudo guardar el movimiento.", "error");
          }
        }
        void refreshBalance(host);
        if (selectedPlatform === "ganamos") void refreshAgentBalance();
        else void refreshMultiPanelAgentBalance();
      } catch (exception) {
        showToast(host, username, exception.message || "No se pudo completar la operación.", "error");
      } finally {
        confirm.disabled = false;
      }
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) root.replaceChildren();
    });
    modal.append(dialog);
    root.append(modal);
    if (operation === "withdrawal") {
      void updateLastWithdrawalDisplay(host, openedAccountsKey);
    }
    amountInput.focus();
  }

  function openCreateUserDialog(host, forcedPlatform = null) {
    const root = host.shadowRoot?.querySelector(".dialog-root");
    const phone = host.dataset.contactPhone || "";
    const accountsKey = host.dataset.accounts;
    const existingUsername = forcedPlatform === "ganamos"
      ? host.dataset.multipanelUsername
      : host.dataset.username;
    if (!root || (!forcedPlatform && phone.length < 4) ||
      (forcedPlatform && (!existingUsername || !["ganamos", "multipanel"].includes(forcedPlatform)))) return;
    root.replaceChildren();

    let selectedPlatform = forcedPlatform || "ganamos";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      root.replaceChildren();
    }, true);

    const dialog = document.createElement("form");
    dialog.className = "dialog";
    dialog.dataset.operation = "create-user";
    dialog.dataset.platform = selectedPlatform;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.textContent = forcedPlatform
      ? `Crear ${forcedPlatform === "ganamos" ? "Ganamos" : "MultiPanel"}`
      : "Crear Usuario";
    dialog.append(title);

    const destinations = remoteCreateDestinations.filter((destination) =>
      typeof destination?.id === "string" && typeof destination.name === "string");
    let selectedDestinationId = destinations.length ? "" : "local";
    let destinationSelect = null;
    if (destinations.length) {
      const destinationLabel = document.createElement("label");
      destinationLabel.textContent = "Equipo destino";
      destinationSelect = document.createElement("select");
      destinationSelect.className = "create-destination-select";
      const placeholderOption = document.createElement("option");
      placeholderOption.value = "";
      placeholderOption.textContent = "Elegí una computadora";
      destinationSelect.append(placeholderOption);
      const localOption = document.createElement("option");
      localOption.value = "local";
      localOption.textContent = "Esta PC";
      destinationSelect.append(localOption);
      for (const destination of destinations) {
        const option = document.createElement("option");
        option.value = destination.id;
        option.textContent = destination.name;
        destinationSelect.append(option);
      }
      destinationLabel.append(destinationSelect);
      dialog.append(destinationLabel);
    }

    const selector = document.createElement("div");
    selector.className = "platform-selector";
    const nicknameLabel = document.createElement("label");
    nicknameLabel.textContent = "Apodo";
    const nicknameInput = document.createElement("input");
    nicknameInput.type = "text";
    nicknameInput.maxLength = 24;
    nicknameInput.required = true;
    nicknameInput.autocomplete = "off";
    if (forcedPlatform && phone.length < 4) {
      const existingPlatform = forcedPlatform === "ganamos" ? "multipanel" : "ganamos";
      nicknameInput.value = existingUsername.replace(
        new RegExp(`${platformSuffixes[existingPlatform]}+$`, "i"),
        ""
      );
    }
    nicknameLabel.append(nicknameInput);
    dialog.append(nicknameLabel);

    const usernameLabel = document.createElement("label");
    usernameLabel.textContent = "Usuario generado";
    const usernameInput = document.createElement("input");
    usernameInput.type = "text";
    usernameInput.readOnly = true;
    usernameInput.setAttribute("aria-live", "polite");
    usernameLabel.append(usernameInput);
    dialog.append(usernameLabel);

    const generatedNickname = () => nicknameInput.value.normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const getGeneratedUsername = () => {
      if (destinations.length && !selectedDestinationId) return "";
      const nickname = generatedNickname();
      const suffix = getSelectedSuffix();
      const phoneSuffix = phone.length >= 4 ? phone.slice(-4) : "";
      return nickname ? `${nickname}${phoneSuffix}${suffix}` : "";
    };
    const getSelectedSuffix = () => {
      const destination = destinations.find((item) => item.id === selectedDestinationId);
      return selectedPlatform === "ganamos"
        ? destination?.ganamosSuffix || platformSuffixes.ganamos
        : destination?.multiPanelSuffix || platformSuffixes.multipanel;
    };
    const updateGeneratedUsername = () => {
      usernameInput.value = getGeneratedUsername();
    };
    destinationSelect?.addEventListener("change", () => {
      selectedDestinationId = destinationSelect.value;
      updateGeneratedUsername();
    });
    nicknameInput.addEventListener("input", updateGeneratedUsername);
    updateGeneratedUsername();

    if (!forcedPlatform) {
      for (const [platform, label] of [["ganamos", "Ganamos"], ["multipanel", "MultiPanel"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.platform = platform;
        button.textContent = label;
        button.setAttribute("aria-pressed", String(platform === selectedPlatform));
        button.addEventListener("click", () => {
          selectedPlatform = platform;
          dialog.dataset.platform = platform;
          for (const option of selector.querySelectorAll("button")) {
            option.setAttribute("aria-pressed", String(option.dataset.platform === selectedPlatform));
          }
          updateGeneratedUsername();
        });
        selector.append(button);
      }
      dialog.insertBefore(selector, nicknameLabel);
    }

    const buttons = document.createElement("div");
    buttons.className = "dialog-actions";
    const actionButtons = document.createElement("div");
    actionButtons.className = "dialog-action-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => root.replaceChildren());
    const create = document.createElement("button");
    create.type = "submit";
    create.textContent = "Crear";
    actionButtons.append(cancel, create);
    buttons.append(actionButtons);
    dialog.append(buttons);

    dialog.addEventListener("submit", async (event) => {
      event.preventDefault();
      const nickname = generatedNickname();
      if (destinations.length && !selectedDestinationId) {
        showToast(host, phone, "Elegí la computadora donde se creará el usuario.", "error");
        destinationSelect.focus();
        return;
      }
      if (!nickname) {
        showToast(host, phone, "Ingresá un apodo con letras o números.", "error");
        nicknameInput.focus();
        return;
      }
      let username = getGeneratedUsername();
      const toastKey = `create-user:${crypto.randomUUID()}`;
      if (host.dataset.accounts !== accountsKey) {
        showToast(host, username, "El contacto cambió; cerrá este formulario y volvé a intentarlo.", "error", toastKey);
        return;
      }

      create.disabled = true;
      showToast(host, username, "Creando usuario...", "warning", toastKey);
      root.replaceChildren();
      try {
        while (true) {
          if (host.dataset.accounts !== accountsKey) {
            throw new Error("El contacto cambió; no se volvió a intentar la creación.");
          }
          const response = await chrome.runtime.sendMessage({
            type: "CREATE_USER_REQUEST",
            data: {
              platform: selectedPlatform,
              username,
              ...(selectedDestinationId && selectedDestinationId !== "local"
                ? { destinationId: selectedDestinationId }
                : {})
            }
          });
          if (response?.usernameExists) {
            const nextUsername = `${username}${getSelectedSuffix()}`;
            const retry = await confirmDuplicateUsername(root, username, nextUsername);
            if (!retry) {
              dismissToast(toastKey);
              return;
            }
            username = nextUsername;
            showToast(host, username, "Probando el nombre alternativo...", "warning", toastKey);
            continue;
          }
          if (!response?.ok) throw new Error(response?.error || "La plataforma no confirmó la creación.");
          const destinationName = destinations.find((item) => item.id === selectedDestinationId)?.name;
          showToast(host, username,
            `Usuario creado${destinationName ? ` en ${destinationName}` : ""}${response.userId ? ` (ID ${response.userId})` : ""}.`,
            "success", toastKey);
          try {
            await navigator.clipboard.writeText(username);
            showToast(host, username, "Usuario copiado al portapapeles.", "success", toastKey);
          } catch (error) {
            console.error("[Ganamos balance extension] No se pudo copiar el usuario al portapapeles.", error);
            showToast(host, username, "El usuario se creó, pero no se pudo copiar al portapapeles.", "error", toastKey);
          }
          return;
        }
      } catch (error) {
        showToast(host, username, error.message || "No se pudo crear el usuario.", "error", toastKey);
      } finally {
        create.disabled = false;
      }
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) root.replaceChildren();
    });

    modal.append(dialog);
    root.append(modal);
    nicknameInput.focus();
  }

  function confirmDuplicateUsername(root, existingUsername, nextUsername) {
    return new Promise((resolve) => {
      let answered = false;
      const finish = (retry) => {
        if (answered) return;
        answered = true;
        root.replaceChildren();
        resolve(retry);
      };
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(false);
      }, true);
      modal.addEventListener("click", (event) => {
        if (event.target === modal) finish(false);
      });

      const dialog = document.createElement("div");
      dialog.className = "dialog";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      const title = document.createElement("h2");
      title.textContent = "Usuario ya existente";
      const message = document.createElement("p");
      message.className = "notice";
      message.textContent = `${existingUsername} ya existe. ¿Querés intentar crearlo como ${nextUsername}?`;
      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      const actionButtons = document.createElement("div");
      actionButtons.className = "dialog-action-buttons";
      const decline = document.createElement("button");
      decline.type = "button";
      decline.className = "secondary";
      decline.textContent = "No";
      decline.addEventListener("click", () => finish(false));
      const accept = document.createElement("button");
      accept.type = "button";
      accept.textContent = "Sí, probar";
      accept.addEventListener("click", () => finish(true));
      actionButtons.append(decline, accept);
      actions.append(actionButtons);
      dialog.append(title, message, actions);
      modal.append(dialog);
      root.replaceChildren(modal);
      decline.focus();
    });
  }

  function openPasswordResetDialog(host) {
    const root = host.shadowRoot?.querySelector(".dialog-root");
    if (!root) return;
    const accountsKey = host.dataset.accounts;
    const availablePlatforms = [
      ["ganamos", host.dataset.username],
      ["multipanel", host.dataset.multipanelUsername]
    ].filter(([, username]) => Boolean(username));
    if (!availablePlatforms.length) return;

    let selectedPlatform = availablePlatforms.some(([platform]) => platform === host.dataset.defaultPlatform)
      ? host.dataset.defaultPlatform
      : availablePlatforms[0][0];
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      root.replaceChildren();
    }, true);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) root.replaceChildren();
    });

    const dialog = document.createElement("form");
    dialog.className = "dialog";
    dialog.dataset.operation = "password-reset";
    dialog.dataset.platform = selectedPlatform;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = "Restaurar contraseña";
    const selector = document.createElement("div");
    selector.className = "platform-selector";
    for (const [platform] of availablePlatforms) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.platform = platform;
      button.textContent = platform === "ganamos" ? "Ganamos" : "MultiPanel";
      button.setAttribute("aria-pressed", String(platform === selectedPlatform));
      button.addEventListener("click", () => {
        selectedPlatform = platform;
        dialog.dataset.platform = platform;
        for (const option of selector.querySelectorAll("button")) {
          option.setAttribute("aria-pressed", String(option.dataset.platform === selectedPlatform));
        }
      });
      selector.append(button);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const actionButtons = document.createElement("div");
    actionButtons.className = "dialog-action-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => root.replaceChildren());
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.textContent = "Aceptar";
    actionButtons.append(cancel, confirm);
    actions.append(actionButtons);
    dialog.append(title, selector, actions);
    dialog.addEventListener("submit", async (event) => {
      event.preventDefault();
      const username = host.dataset[selectedPlatform === "ganamos" ? "username" : "multipanelUsername"];
      if (!username || host.dataset.accounts !== accountsKey) {
        root.replaceChildren();
        showToast(host, username || "Chat", "El contacto cambió; volvé a iniciar la restauración de contraseña.", "error");
        return;
      }
      confirm.disabled = true;
      showToast(host, username, "Restaurando contraseña...", "warning");
      root.replaceChildren();
      try {
        const response = await chrome.runtime.sendMessage({
          type: "PASSWORD_RESET_REQUEST",
          data: { platform: selectedPlatform, nombre: username }
        });
        if (!response?.ok) throw new Error(response?.error || "La plataforma no confirmó la restauración de la contraseña.");
        showToast(host, username, "Contraseña restaurada correctamente.", "success");
      } catch (error) {
        showToast(host, username, error.message || "No se pudo restaurar la contraseña.", "error");
      } finally {
        confirm.disabled = false;
      }
    });

    modal.append(dialog);
    root.replaceChildren(modal);
  }

  function updateContact() {
    const zoomViewOpen = [...document.querySelectorAll('button[aria-label="Acercar"]')]
      .some(isActuallyVisible);
    const agentBalanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
    if (agentBalanceHost) {
      const display = zoomViewOpen ? "none" : "";
      if (agentBalanceHost.style.display !== display) agentBalanceHost.style.display = display;
    }
    if (zoomViewOpen) {
      const host = document.getElementById(HOST_ID);
      if (host && host.style.display !== "none") host.style.display = "none";
      return;
    }

    const title = findContactTitle();
    const isNormalChat = isNormalChatOpen(title);
    const contactTitle = title?.textContent || "";
    const usernames = isNormalChat ? findPlatformUsernames(contactTitle) : null;
    const phone = isNormalChat ? getPhoneFromContactTitle(title) : null;
    if (!usernames?.ganamos && !usernames?.multipanel && !phone) {
      const host = document.getElementById(HOST_ID);
      if (host) host.style.display = "none";
      activeAccountsKey = null;
      const contactChanged = agentBalanceContactKey !== null;
      agentBalanceContactKey = null;
      if (contactChanged && agentBalanceHost && isAgentMovementView(agentBalanceView)) {
        void renderAgentMovements(agentBalanceHost);
      }
      return;
    }

    const host = getOrCreateHost();
    host.style.display = "block";
    positionHost(host, title);
    const accountsKey = JSON.stringify({ usernames, phone });
    if (host.dataset.accounts === accountsKey && activeAccountsKey === accountsKey) return;
    if (host.dataset.accounts && host.dataset.accounts !== accountsKey) {
      host.shadowRoot.querySelector(".dialog-root").replaceChildren();
    }
    host.dataset.accounts = accountsKey;
    host.dataset.username = usernames?.ganamos || "";
    host.dataset.multipanelUsername = usernames?.multipanel || "";
    host.dataset.defaultPlatform = usernames?.firstPlatform || (usernames?.ganamos ? "ganamos" : "multipanel");
    host.dataset.contactPhone = phone || "";
    const hasPlatformUsers = Boolean(usernames?.ganamos || usernames?.multipanel);
    host.shadowRoot.querySelector(".user-information-button").hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".exchange-button").hidden =
      !usernames?.ganamos || !usernames?.multipanel;
    const missingPlatform = usernames?.ganamos && !usernames?.multipanel
      ? "multipanel"
      : usernames?.multipanel && !usernames?.ganamos
        ? "ganamos"
        : null;
    host.shadowRoot.querySelector('[data-action="deposit"]').hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".withdrawal-action-group").hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".password-reset-button").hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".status").hidden = !hasPlatformUsers;
    const createUserButton = host.shadowRoot.querySelector(".create-user-button");
    createUserButton.hidden = !missingPlatform && (!phone || hasPlatformUsers);
    const createFromScratch = !hasPlatformUsers && Boolean(phone);
    createUserButton.dataset.mode = createFromScratch ? "full" : "compact";
    createUserButton.dataset.platform = missingPlatform || "ganamos";
    const createUserLabel = createFromScratch
      ? "Crear Usuario"
      : missingPlatform
      ? `Crear ${missingPlatform === "ganamos" ? "Ganamos" : "MultiPanel"}`
      : "Crear usuario";
    createUserButton.textContent = createFromScratch ? "Crear Usuario" : "+";
    createUserButton.title = createUserLabel;
    createUserButton.setAttribute("aria-label", createUserLabel);
    host.dataset.createPlatform = missingPlatform || "";
    host.balanceStates = {};
    activeAccountsKey = accountsKey;
    agentBalanceContactKey = accountsKey;
    if (agentBalanceHost && isAgentMovementView(agentBalanceView)) {
      void renderAgentMovements(agentBalanceHost);
    }
    if (hasPlatformUsers) void refreshBalance(host);
  }

  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      updateContact();
    });
  }

  function protectAgentBalanceSelection(event) {
    const path = event.composedPath();
    const startedOnBalanceText = path.some((target) =>
      target instanceof Element &&
      (target.classList.contains("agent-balance-label") ||
        target.classList.contains("agent-balance-amount"))
    ) && path.some((target) =>
      target instanceof Element && target.id === AGENT_BALANCE_HOST_ID
    );
    if (event.type === "mousedown" || event.type === "pointerdown") {
      if (startedOnBalanceText) selectingAgentBalanceText = true;
    }
    if (!startedOnBalanceText && !selectingAgentBalanceText) return;
    event.stopImmediatePropagation();
    event.stopPropagation();
    if (event.type === "mouseup" || event.type === "pointerup" || event.type === "pointercancel") {
      window.setTimeout(() => { selectingAgentBalanceText = false; }, 0);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(({ target }) =>
      target.id === HOST_ID || target.id === AGENT_BALANCE_HOST_ID)) return;
    scheduleUpdate();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-hidden", "aria-label", "class", "hidden", "style"],
    childList: true,
    subtree: true,
    characterData: true
  });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);
  for (const eventName of [
    "mousedown",
    "mousemove",
    "mouseup",
    "pointercancel",
    "pointerdown",
    "pointermove",
    "pointerup"
  ]) {
    window.addEventListener(eventName, protectAgentBalanceSelection, true);
  }
  window.addEventListener("blur", () => { selectingAgentBalanceText = false; });
  const agentBalanceHost = createAgentBalancePanel();
  void refreshAgentBalance(agentBalanceHost);
  void refreshMultiPanelAgentBalance(agentBalanceHost);
  window.setInterval(() => {
    void refreshAgentBalance(agentBalanceHost);
    void refreshMultiPanelAgentBalance(agentBalanceHost);
  }, 60_000);
  updateContact();
})();
