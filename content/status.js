(() => {
  const HOST_ID = "ganamos-status-replacer";
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const STATUS_UPDATE_RECOVERY_KEY = "statusUpdateRecovery";
  const STATUS_UPDATE_RECOVERY_TTL_MS = 24 * 60 * 60_000;
  const STATUS_COUNT_PATTERN = /^Estado\s+(\d+)\s+de\s+(\d+)$/i;
  const EXTENSION_OVERLAY_IDS = [
    HOST_ID,
    "ganamos-balance-extension",
    "ganamos-agent-balance",
    "ganamos-contact-flow-counters",
    "ganamos-pending-withdrawals",
    "ganamos-active-bonus",
    "ganamos-toast-host"
  ];
  const sleep = (delay) => new Promise((resolve) => window.setTimeout(resolve, delay));
  let statusPageVisibilityScheduled = false;
  let statusUpdateInProgress = false;

  function getStatusImageFormat(bytes) {
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length >= pngSignature.length &&
      pngSignature.every((byte, index) => bytes[index] === byte)) {
      return { extension: "png", mimeType: "image/png" };
    }
    if (bytes.length >= 3 && bytes[0] === 255 &&
      bytes[1] === 216 && bytes[2] === 255) {
      return { extension: "jpg", mimeType: "image/jpeg" };
    }
    return null;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  }

  function getLabel(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.getAttribute("data-placeholder"),
      element.innerText,
      element.textContent
    ].find((value) => typeof value === "string" && value.trim())
      ?.replace(/\s+/g, " ").trim() || "";
  }

  function isValidBase64(value) {
    if (typeof value !== "string" || !value.length || value.length % 4 !== 0) return false;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const contentLength = value.length - padding;
    if (padding === 2 && contentLength % 4 !== 2 ||
      padding === 1 && contentLength % 4 !== 3) return false;

    for (let index = 0; index < contentLength; index += 1) {
      const code = value.charCodeAt(index);
      if (!(code >= 65 && code <= 90) && !(code >= 97 && code <= 122) &&
        !(code >= 48 && code <= 57) && code !== 43 && code !== 47) return false;
    }
    return true;
  }

  function hasNormalizedLabel(element, pattern) {
    const normalizedPattern = new RegExp(
      pattern.source.normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
      pattern.flags
    );
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.getAttribute("data-placeholder"),
      element.innerText,
      element.textContent
    ].some((value) => typeof value === "string" &&
      normalizedPattern.test(value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ").trim()));
  }

  function hasExactNormalizedLabel(element, labels) {
    const expected = new Set(labels.map((label) =>
      label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()));
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.innerText,
      element.textContent
    ].some((value) => typeof value === "string" &&
      expected.has(value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ").trim().toLowerCase()));
  }

  function hideExtensionOverlays() {
    const previous = EXTENSION_OVERLAY_IDS
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((element) => ({ element, visibility: element.style.visibility }));
    for (const { element } of previous) element.style.visibility = "hidden";
    return () => {
      for (const { element, visibility } of previous) element.style.visibility = visibility;
    };
  }

  function findButton(pattern) {
    return [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')]
      .find((element) => isVisible(element) && hasNormalizedLabel(element, pattern)) || null;
  }

  function findVisibleStatusGroup() {
    return [...document.querySelectorAll('[role="group"][aria-label^="Estado "]')]
      .find(isVisible) || null;
  }

  function findVisibleStatusHeader() {
    return [...document.querySelectorAll('[data-testid="status-header"]')]
      .find(isVisible) || null;
  }

  function findVisibleEmptyStatusPrompt() {
    const promptPattern = /haz clic para anadir una actualizacion de estado/i;
    return [...document.querySelectorAll('[data-testid="status-header"], main')]
      .find((element) => {
        if (!isVisible(element)) return false;
        const text = element.innerText || "";
        return promptPattern.test(
          text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        );
      }) || null;
  }

  function findOwnStatusHeader() {
    return [...document.querySelectorAll('button[data-testid="status-header"]')]
      .find((element) =>
        isVisible(element) && /mi estado/i.test(getLabel(element))) || null;
  }

  function isOwnStatusListVisible() {
    const ownStatusHeader = findOwnStatusHeader();
    return Boolean(ownStatusHeader && !findVisibleStatusGroup());
  }

  function isWhatsAppDisconnected() {
    const pageText = (document.body?.innerText || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    return /escanea para iniciar sesion|scan (?:the )?qr code|scan to log in|use whatsapp on your phone|usa whatsapp en tu telefono/
      .test(pageText);
  }

  function getDisconnectedButtonPosition() {
    const balancePanel = document.getElementById("ganamos-agent-balance");
    if (balancePanel && isVisible(balancePanel)) {
      const rect = balancePanel.getBoundingClientRect();
      const buttonSize = 34;
      return {
        left: Math.min(
          Math.max(8, Math.round(rect.right + 4)),
          Math.max(8, window.innerWidth - buttonSize - 8)
        ),
        top: Math.min(
          Math.max(8, Math.round(rect.top + (rect.height - buttonSize) / 2)),
          Math.max(8, window.innerHeight - buttonSize - 8)
        )
      };
    }
    return { left: 205, top: 8 };
  }

  function getStatusListScrollbarWidth(header) {
    for (let ancestor = header.parentElement;
      ancestor && ancestor !== document.body && ancestor !== document.documentElement;
      ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!["auto", "scroll", "overlay"].includes(style.overflowY) ||
        ancestor.scrollHeight <= ancestor.clientHeight) continue;
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      return Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - borders);
    }
    return 0;
  }

  function scheduleStatusPageVisibilityUpdate() {
    if (statusPageVisibilityScheduled) return;
    statusPageVisibilityScheduled = true;
    window.requestAnimationFrame(() => {
      statusPageVisibilityScheduled = false;
      if (statusUpdateInProgress) return;
      const host = document.getElementById(HOST_ID);
      if (!host) return;
      const isStatusListVisible = isOwnStatusListVisible();
      const isDisconnected = isWhatsAppDisconnected();
      const display = isStatusListVisible || isDisconnected ? "" : "none";
      if (host.style.display !== display) host.style.display = display;
      if (isStatusListVisible) {
        const statusHeader = findOwnStatusHeader();
        const statusHeaderRect = statusHeader.getBoundingClientRect();
        const buttonSize = 34;
        const left = Math.min(
          Math.max(8, Math.round(
            statusHeaderRect.right - buttonSize - 4 +
            Math.max(0, getStatusListScrollbarWidth(statusHeader) - 9)
          )),
          Math.max(8, window.innerWidth - buttonSize - 8)
        );
        const top = Math.min(
          Math.max(8, Math.round(
            statusHeaderRect.top + (statusHeaderRect.height - buttonSize) / 2
          )),
          Math.max(8, window.innerHeight - buttonSize - 8)
        );
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
      } else if (isDisconnected) {
        const position = getDisconnectedButtonPosition();
        host.style.left = `${position.left}px`;
        host.style.top = `${position.top}px`;
      } else {
        host.shadowRoot?.querySelector(".status-popup")?.setAttribute("hidden", "");
      }
    });
  }

  function findViewerStatusMenu(group) {
    const candidates = [...document.querySelectorAll(
      'button[aria-haspopup="menu"],[role="button"][aria-haspopup="menu"]'
    )].filter((element) => {
      if (!isVisible(element) || element.getAttribute("aria-disabled") === "true") return false;
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX < window.innerWidth / 2 || centerX > window.innerWidth ||
        centerY < 0 || centerY > Math.min(window.innerHeight * 0.45, 300)) return false;
      if (element.getAttribute("aria-expanded") === "true") return true;
      const hasMenuLabel = hasNormalizedLabel(
        element,
        /^(?:menu(?:\s+(?:(?:de|del)\s+)?(?:estado|opciones))?|mas opciones|more options|opciones)$/i
      );
      const iconTitle = element.querySelector(
        "svg title, [aria-hidden=\"true\"] svg title"
      )?.textContent?.trim();
      return hasMenuLabel || /^(?:ic-more-vert|more_vert|more_horiz)$/i.test(iconTitle || "");
    });
    if (!candidates.length) return null;
    const getAncestorDistance = (candidate) => {
      for (let ancestor = group, distance = 0; ancestor && distance <= 10;
        ancestor = ancestor.parentElement, distance += 1) {
        if (ancestor.contains(candidate)) return distance;
      }
      return Number.MAX_SAFE_INTEGER;
    };
    candidates.sort((left, right) =>
      getAncestorDistance(left) - getAncestorDistance(right) ||
      right.getBoundingClientRect().right - left.getBoundingClientRect().right);
    const bestDistance = getAncestorDistance(candidates[0]);
    if (bestDistance !== Number.MAX_SAFE_INTEGER) {
      const equallyScoped = candidates.filter((candidate) =>
        getAncestorDistance(candidate) === bestDistance);
      return equallyScoped.length === 1 ? equallyScoped[0] : null;
    }
    return candidates[0];
  }

  function findDeleteMenuItem(menuButton) {
    const menuId = menuButton.getAttribute("aria-controls");
    const controlledMenu = menuId ? document.getElementById(menuId) : null;
    const menuRoots = controlledMenu && isVisible(controlledMenu)
      ? [controlledMenu]
      : [...document.querySelectorAll('[role="menu"],[role="listbox"]')].filter(isVisible);
    const menuRect = menuButton.getBoundingClientRect();
    const menuCenterX = menuRect.left + menuRect.width / 2;
    const menuCenterY = menuRect.top + menuRect.height / 2;
    const isNearMenu = (element) => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return Math.abs(centerX - menuCenterX) <= 320 &&
        Math.abs(centerY - menuCenterY) <= 320;
    };
    const candidates = new Set();
    const addCandidate = (element, requireProximity) => {
      if (!isVisible(element) ||
        !hasExactNormalizedLabel(element, ["Eliminar", "Eliminar estado", "Delete", "Delete status"]) ||
        requireProximity && !isNearMenu(element)) return;
      const interactiveAncestor = element.closest(
        'button,[role="menuitem"],[role="option"],[role="button"],[tabindex]'
      );
      candidates.add(interactiveAncestor && isVisible(interactiveAncestor) &&
        hasExactNormalizedLabel(interactiveAncestor,
          ["Eliminar", "Eliminar estado", "Delete", "Delete status"]) &&
        (!requireProximity || isNearMenu(interactiveAncestor)) ? interactiveAncestor : element);
    };

    for (const root of menuRoots) {
      if (hasExactNormalizedLabel(root, ["Eliminar", "Eliminar estado", "Delete", "Delete status"])) {
        addCandidate(root, false);
      }
      for (const element of root.querySelectorAll(
        'button,[role="menuitem"],[role="option"],[role="button"],[tabindex],span'
      )) {
        addCandidate(element, false);
      }
    }
    if (!candidates.size) {
      for (const element of document.querySelectorAll(
        'button,[role="menuitem"],[role="option"],[role="button"],[tabindex],span'
      )) {
        addCandidate(element, true);
      }
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  }

  function findStatusPhotoAction() {
    if (!findVisibleStatusHeader()) return null;
    const pattern = /^(?:foto(?:s)?\s+y\s+video(?:s)?|photo(?:s)?\s+(?:and|or)\s+video(?:s)?)$/i;
    const candidates = [...document.querySelectorAll(
      'button,[role="button"],[role="menuitem"],[tabindex],a'
    )].filter((element) => isVisible(element) &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.disabled && hasNormalizedLabel(element, pattern));
    const smallestCandidates = candidates.filter((candidate) =>
      !candidates.some((other) => other !== candidate && candidate.contains(other)));
    return smallestCandidates.length === 1 ? smallestCandidates[0] : null;
  }

  function findDeleteConfirmation() {
    const popups = [...document.querySelectorAll('[data-testid="confirm-popup"]')]
      .filter(isVisible)
      .filter((popup) => {
        const title = popup.querySelector('[data-testid="popup-title"]');
        const style = getComputedStyle(popup);
        const matrix = style.transform === "none" ? null : new DOMMatrixReadOnly(style.transform);
        const animationFinished = Number(style.opacity) >= 0.99 &&
          (!matrix || (Math.abs(matrix.a - 1) < 0.01 && Math.abs(matrix.d - 1) < 0.01));
        return title && animationFinished &&
          hasNormalizedLabel(title, /^elimina\s+\d+\s+actualizacion(?:es)?\s+de\s+estado$/i);
      });
    if (popups.length !== 1) return null;

    const popup = popups[0];
    const groups = [...popup.querySelectorAll('[role="group"]')].filter(isVisible);
    const matches = groups.flatMap((group) => {
      const buttons = [...group.querySelectorAll("button")]
        .filter((button) => isVisible(button) && button.getAttribute("aria-disabled") !== "true");
      const cancelButton = buttons.find((button) =>
        hasNormalizedLabel(button, /^(?:cancelar|cancel)$/i));
      const deleteButton = buttons.find((button) =>
        hasNormalizedLabel(button, /^(?:eliminar|delete)$/i));
      if (!cancelButton || !deleteButton) return [];
      const rect = deleteButton.getBoundingClientRect();
      const hitTarget = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      );
      return hitTarget && deleteButton.contains(hitTarget) ? [deleteButton] : [];
    });
    return matches.length === 1 ? { popup, button: matches[0] } : null;
  }

  async function clickWhatsAppControl(targetOrGetter) {
    const getTarget = typeof targetOrGetter === "function"
      ? targetOrGetter
      : () => targetOrGetter;
    const points = [
      [0.5, 0.5],
      [0.5, 0.3],
      [0.5, 0.7],
      [0.3, 0.5],
      [0.7, 0.5],
      [0.3, 0.3],
      [0.7, 0.7],
      [0.3, 0.7],
      [0.7, 0.3]
    ];
    let lastBlocker = null;
    let controlName = "control de WhatsApp";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      let button = getTarget();
      if (!button || !button.isConnected || !isVisible(button)) {
        await sleep(250 + attempt * 250);
        button = getTarget();
      }
      if (!button || !button.isConnected || !isVisible(button)) {
        continue;
      }
      controlName = getLabel(button) || button.getAttribute("data-testid") || button.tagName.toLowerCase();
      button.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)));

      const currentButton = getTarget();
      if (currentButton && currentButton.isConnected && isVisible(currentButton)) {
        button = currentButton;
      }
      const restoreOverlays = hideExtensionOverlays();
      try {
        const rect = button.getBoundingClientRect();
        const visibleRect = {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          right: Math.min(window.innerWidth, rect.right),
          bottom: Math.min(window.innerHeight, rect.bottom)
        };
        if (visibleRect.right <= visibleRect.left ||
          visibleRect.bottom <= visibleRect.top) {
          continue;
        }
        const width = visibleRect.right - visibleRect.left;
        const height = visibleRect.bottom - visibleRect.top;
        const samples = points.map(([xRatio, yRatio]) => ({
          x: visibleRect.left + width * xRatio,
          y: visibleRect.top + height * yRatio
        })).map((point) => ({
          ...point,
          target: document.elementFromPoint(point.x, point.y)
        }));
        const point = samples.find(({ target }) => target && button.contains(target));
        if (point) {
          const response = await chrome.runtime.sendMessage({
            type: "STATUS_UPDATE_DEBUGGER_CLICK",
            x: point.x,
            y: point.y
          });
          if (!response?.ok) {
            throw new Error(response?.error || "Chrome no pudo hacer clic en el control de WhatsApp.");
          }
          return;
        }
        lastBlocker = samples.find(({ target }) => target)?.target || null;
      } finally {
        restoreOverlays();
      }
      await sleep(250 + attempt * 250);
    }

    const blockerName = lastBlocker
      ? `${lastBlocker.tagName.toLowerCase()}${lastBlocker.id ? `#${lastBlocker.id}` : ""}${lastBlocker.getAttribute("role") ? `[role="${lastBlocker.getAttribute("role")}"]` : ""}${lastBlocker.getAttribute("data-testid") ? `[data-testid="${lastBlocker.getAttribute("data-testid")}"]` : ""}${lastBlocker.getAttribute("aria-label") ? `[aria-label="${lastBlocker.getAttribute("aria-label")}"]` : ""}`
      : "ningún elemento interactivo";
    throw new Error(`No se pudo hacer clic en "${controlName}" tras esperar a WhatsApp: los puntos visibles están cubiertos por ${blockerName}.`);
  }

  async function pressWhatsAppEscape() {
    const response = await chrome.runtime.sendMessage({
      type: "STATUS_UPDATE_DEBUGGER_KEY",
      key: "Escape"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Chrome no pudo cerrar el visor de WhatsApp.");
    }
  }

  async function closeStatusViewerIfOpen() {
    if (!findVisibleStatusGroup()) return;
    await pressWhatsAppEscape();
    await waitFor(
      () => !findVisibleStatusGroup(),
      "el cierre del visor de estados"
    );
  }

  async function waitFor(getter, description, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getter();
      if (value) return value;
      await sleep(150);
    }
    throw new Error(`No apareció ${description} en WhatsApp Web.`);
  }

  async function ensureStatusPage() {
    if (findVisibleStatusHeader()) return;
    await waitFor(
      () => findButton(/^Estados$/i),
      "la pestaña Estados",
      60_000
    );
    await clickWhatsAppControl(() => findButton(/^Estados$/i));
    await waitFor(
      findVisibleStatusHeader,
      "la lista de estados propios",
      60_000
    );
  }

  function findOpenConversationTitle() {
    return [...document.querySelectorAll(
      '[data-testid="conversation-info-header-chat-title"]'
    )].find(isVisible) || null;
  }

  function findVisibleButtonIn(root, pattern) {
    if (!root) return null;
    return [...root.querySelectorAll('button,[role="button"],[role="tab"]')]
      .find((element) => isVisible(element) && hasNormalizedLabel(element, pattern)) || null;
  }

  function findAllChatsFilter(sidebar) {
    for (let ancestor = sidebar, depth = 0;
      ancestor && ancestor !== document.documentElement && depth < 6;
      ancestor = ancestor.parentElement, depth += 1) {
      const candidates = [...ancestor.querySelectorAll(
        'button,[role="button"],[role="tab"]'
      )].filter((element) => isVisible(element) &&
        hasNormalizedLabel(element, /^Todos$/i));
      const innermost = candidates.filter((candidate) =>
        !candidates.some((other) => other !== candidate && candidate.contains(other)));
      if (innermost.length === 1) return innermost[0];
    }
    return null;
  }

  async function returnToWhatsAppChats() {
    const conversationTitle = findOpenConversationTitle();
    if (conversationTitle) {
      const main = conversationTitle.closest("#main") || document.getElementById("main");
      const backButton = [...(main?.querySelectorAll(
        'button,[role="button"],[data-testid="back"]'
      ) || [])].find((element) => isVisible(element) &&
        (element.matches('[data-testid="back"]') || hasNormalizedLabel(
          element,
          /^(?:volver(?:\s+a\s+(?:chats|la lista de chats))?|back|regresar)$/i
        ))) || null;
      if (backButton && isVisible(backButton)) {
        await clickWhatsAppControl(() => backButton.isConnected && isVisible(backButton)
          ? backButton
          : null);
        await sleep(500);
      }
    }

    const chatsButton = await waitFor(
      () => findButton(/^Chats$/i),
      "la pestaña Chats",
      15_000
    );
    await clickWhatsAppControl(() => findButton(/^Chats$/i) || chatsButton);
    const sidebar = await waitFor(() => {
      const current = document.querySelector("#pane-side");
      return current && isVisible(current) ? current : null;
    }, "la lista de chats de WhatsApp", 15_000);
    const allChatsFilter = await waitFor(
      () => findAllChatsFilter(sidebar),
      "el filtro Todos de la lista de chats",
      15_000
    );
    await clickWhatsAppControl(() => findAllChatsFilter(
      document.querySelector("#pane-side")
    ));
    const selectedFilter = () => {
      const current = findAllChatsFilter(document.querySelector("#pane-side"));
      if (!current) return false;
      const pressed = current.getAttribute("aria-pressed");
      const selected = current.getAttribute("aria-selected");
      return pressed === null && selected === null ||
        pressed === "true" || selected === "true";
    };
    await waitFor(selectedFilter, "la selección del filtro Todos", 10_000);
    if (findOpenConversationTitle()) {
      await pressWhatsAppEscape();
      await waitFor(
        () => !findOpenConversationTitle(),
        "el cierre del chat abierto",
        10_000
      );
    }
    const stored = await stateStorage.get("activeBonusConfig");
    if (stored.activeBonusConfig?.markUnreadAfterStatusUpdate === true) {
      const unreadFilter = await waitFor(
        () => findButton(/^(?:No leídos|Unread)$/i),
        "el filtro No Leídos de la lista de chats",
        10_000
      );
      await clickWhatsAppControl(() =>
        findButton(/^(?:No leídos|Unread)$/i) || unreadFilter);
    }
  }

  async function openOwnStatusViewer(pauseStatus = true) {
    await closeStatusViewerIfOpen();
    await ensureStatusPage();
    const header = await waitFor(
      () => [...document.querySelectorAll('button[data-testid="status-header"]')]
        .find(isVisible) || null,
      "el encabezado de Mi estado"
    );
    if (!/Mi estado/i.test(getLabel(header))) {
      throw new Error("No se pudo confirmar que la lista corresponde a Mi estado.");
    }
    await clickWhatsAppControl(() =>
      [...document.querySelectorAll('button[data-testid="status-header"]')]
        .find((element) => isVisible(element) && /mi estado/i.test(getLabel(element))) || null
    );
    const group = await waitFor(
      findVisibleStatusGroup,
      "el visor de Mi estado",
      60_000
    );
    if (pauseStatus) await pauseCurrentStatus(group);
    return group;
  }

  function findStatusPlaybackButton(group, labels) {
    const isPlaybackButton = (button) =>
      isVisible(button) &&
        button.getAttribute("aria-disabled") !== "true" &&
        hasExactNormalizedLabel(button, labels);
    const scopedButton = [...group.querySelectorAll("button,[role=\"button\"]")]
      .find(isPlaybackButton);
    if (scopedButton) return scopedButton;

    const visibleButtons = [...document.querySelectorAll("button,[role=\"button\"]")]
      .filter(isPlaybackButton);
    return visibleButtons.length === 1 ? visibleButtons[0] : null;
  }

  async function pauseCurrentStatus(group) {
    const pauseButton = findStatusPlaybackButton(group, ["Pausar", "Pause"]);
    if (!pauseButton) return false;

    try {
      await clickWhatsAppControl(() => {
        const currentGroup = findVisibleStatusGroup();
        return currentGroup
          ? findStatusPlaybackButton(currentGroup, ["Pausar", "Pause"])
          : null;
      });
      await waitFor(() => {
        const currentGroup = findVisibleStatusGroup();
        return currentGroup
          ? findStatusPlaybackButton(
            currentGroup,
            ["Reproducir", "Play", "Reanudar", "Resume"]
          )
          : null;
      }, "la pausa del estado", 2_000);
      return true;
    } catch (error) {
      console.warn(
        "[Ganamos balance extension] No se pudo confirmar la pausa del estado; se continuará con la eliminación.",
        error
      );
      return false;
    }
  }

  function parseStatusCount(group) {
    const match = STATUS_COUNT_PATTERN.exec(group?.getAttribute("aria-label") || "");
    return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
  }

  async function runStatusStage(name, operation, onStage) {
    onStage?.(name);
    try {
      return await operation();
    } catch (error) {
      throw new Error(`${name}: ${error.message || "falló sin un detalle adicional."}`);
    }
  }

  function findOwnStatusThumbnail() {
    return [...document.querySelectorAll('[data-testid="status-thumbnail"]')]
      .find((thumbnail) => isVisible(thumbnail) &&
        /^mi estado\b/i.test(getLabel(thumbnail).normalize("NFD")
          .replace(/[\u0300-\u036f]/g, ""))) || null;
  }

  function getOwnStatusPresence() {
    const header = findVisibleStatusHeader();
    const emptyPrompt = findVisibleEmptyStatusPrompt();
    if (!header && !emptyPrompt) return "unknown";
    const thumbnail = findOwnStatusThumbnail();
    if (thumbnail && emptyPrompt) return "unknown";
    if (thumbnail) return "present";
    if (emptyPrompt) return "empty";
    return "unknown";
  }

  async function deleteLatestOwnStatus(onDeleteIntent) {
    let group = await openOwnStatusViewer();
    group = await waitFor(() => {
      const currentGroup = findVisibleStatusGroup();
      return parseStatusCount(currentGroup) ? currentGroup : null;
    }, "el contador de estados de Mi estado", 90_000);
    let count = parseStatusCount(group);
    if (!count || count.current < 1 || count.total < count.current) {
      throw new Error("No se pudo identificar con seguridad el estado propio más reciente.");
    }
    for (let step = 0; count.current < count.total && step < count.total; step += 1) {
      const findNext = () =>
        findButton(/(?:estado\s+siguiente|siguiente\s+estado|next\s+status)/i);
      const next = findNext();
      if (!next) {
        throw new Error("WhatsApp no mostró el control para llegar al estado más reciente.");
      }
      const previousCurrent = count.current;
      const previousStepTotal = count.total;
      await clickWhatsAppControl(findNext);
      group = await waitFor(() => {
        const currentGroup = findVisibleStatusGroup();
        const parsed = parseStatusCount(currentGroup);
        return parsed && parsed.current !== previousCurrent ? currentGroup : null;
      }, "el estado más reciente", 60_000);
      count = parseStatusCount(group);
      if (!count || count.current <= previousCurrent ||
        count.total !== previousStepTotal ||
        count.current > count.total) {
        throw new Error("WhatsApp devolvió una secuencia de estados inesperada.");
      }
      await pauseCurrentStatus(group);
    }
    if (count.current !== count.total) {
      throw new Error("No se pudo ubicar el último estado subido.");
    }
    const previousTotal = count.total;

    const findCurrentMenu = () => {
      const currentGroup = findVisibleStatusGroup();
      return currentGroup ? findViewerStatusMenu(currentGroup) : null;
    };
    const menu = findCurrentMenu();
    if (!menu) throw new Error("No se encontró el botón de tres puntos del estado abierto.");
    await clickWhatsAppControl(findCurrentMenu);
    const openMenuButton = await waitFor(() => {
      const currentMenu = findCurrentMenu() ||
        (menu.isConnected && isVisible(menu) ? menu : null);
      if (currentMenu?.getAttribute("aria-expanded") === "true" ||
        currentMenu && findDeleteMenuItem(currentMenu)) return currentMenu;
      return null;
    },
      "el menú del estado",
      30_000
    );
    const deleteItem = await waitFor(
      () => {
        const currentMenu = findCurrentMenu() ||
          (openMenuButton.isConnected && isVisible(openMenuButton) ? openMenuButton : null);
        return currentMenu ? findDeleteMenuItem(currentMenu) : null;
      },
      "la opción Eliminar después de activar los tres puntos del estado"
    );
    await clickWhatsAppControl(() => {
      const currentMenu = findCurrentMenu();
      return currentMenu ? findDeleteMenuItem(currentMenu) : null;
    });

    const confirmation = await waitFor(
      findDeleteConfirmation,
      "la confirmación de eliminación de WhatsApp"
    );
    await new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(resolve)));
    await onDeleteIntent?.(previousTotal);
    await clickWhatsAppControl(() => findDeleteConfirmation()?.button || null);
    await waitFor(
      () => !isVisible(confirmation.popup),
      "el cierre de la confirmación de eliminación"
    );

    const deletionState = await waitFor(() => {
      const currentGroup = findVisibleStatusGroup();
      const updatedCount = parseStatusCount(currentGroup);
      if (updatedCount && updatedCount.total < previousTotal) {
        return { type: "remaining-statuses", total: updatedCount.total };
      }
      if (!currentGroup) return { type: "viewer-closed" };
      return null;
    }, "la verificación de que WhatsApp eliminó el estado", 60_000);

    if (deletionState.type === "remaining-statuses") return deletionState.total;
    await ensureStatusPage();
    const statusPresence = await waitFor(() => {
      const presence = getOwnStatusPresence();
      return presence === "unknown" ? null : presence;
    }, "la lista actualizada de Mi estado", 30_000);
    if (statusPresence === "empty") return 0;

    group = await openOwnStatusViewer(false);
    const updatedGroup = await waitFor(() => {
      const currentGroup = findVisibleStatusGroup();
      const currentCount = parseStatusCount(currentGroup);
      return currentCount && currentCount.total < previousTotal ? currentGroup : null;
    }, "la reducción de la cantidad de estados después de eliminar el más reciente", 30_000);
    const updatedCount = parseStatusCount(updatedGroup);
    if (!updatedCount || updatedCount.total >= previousTotal) {
      throw new Error("WhatsApp cerró el visor, pero no se confirmó la eliminación del estado más reciente.");
    }
    return updatedCount.total;
  }

  async function openPhotoStatusPicker(file) {
    await closeStatusViewerIfOpen();
    await ensureStatusPage();

    if (!findStatusPhotoAction()) {
      const addButton = findButton(/(?:agregar|añadir|nuevo|add|new).*(?:estado|status)|(?:estado|status).*(?:agregar|añadir|nuevo|add|new)/i);
      if (addButton) {
        await clickWhatsAppControl(() =>
          findButton(/(?:agregar|añadir|nuevo|add|new).*(?:estado|status)|(?:estado|status).*(?:agregar|añadir|nuevo|add|new)/i)
        );
      }
      await waitFor(
        findStatusPhotoAction,
        "la opción Fotos y videos",
        90_000
      );
    }

    const findCurrentPhotoButton = () =>
      findVisibleStatusHeader() ? findStatusPhotoAction() : null;
    let cancelUpload;
    const upload = new Promise((resolve, reject) => {
      const cleanup = () => {
        document.removeEventListener("click", interceptFilePicker, true);
        window.clearTimeout(timeout);
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("WhatsApp no abrió el selector de imagen del estado después de esperar 90 segundos."));
      }, 90_000);
      cancelUpload = () => {
        cleanup();
        resolve();
      };
      function interceptFilePicker(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cleanup();
        try {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          resolve();
        } catch (error) {
          reject(new Error(`No se pudo preparar la imagen para WhatsApp: ${error.message}`));
        }
      }
      document.addEventListener("click", interceptFilePicker, true);
    });
    try {
      await clickWhatsAppControl(findCurrentPhotoButton);
    } catch (error) {
      cancelUpload();
      throw error;
    }
    await upload;
  }

  function findStatusCaption() {
    const captions = [...document.querySelectorAll(
      'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]'
    )].filter((element) => isVisible(element) &&
      hasNormalizedLabel(element, /(?:añade un comentario|agrega un comentario|add a caption|write a caption)/i));
    return captions.length === 1 ? captions[0] : null;
  }

  function findStatusPublishButton() {
    const caption = findStatusCaption();
    if (!caption) return null;
    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter((button) => isVisible(button) &&
        !button.disabled && button.getAttribute("aria-disabled") !== "true")
      .filter((button) =>
        hasNormalizedLabel(button, /^(?:enviar(?: estado| actualización)?|send(?: status| update)?|publicar(?: estado)?|compartir(?: estado)?|share)$/i) ||
        [...button.querySelectorAll("svg title")].some((title) =>
          /^(?:ic-send|ic-send-filled|send|send-filled)$/i.test(title.textContent.trim())));
    for (let ancestor = caption.parentElement, depth = 0;
      ancestor && depth < 7;
      ancestor = ancestor.parentElement, depth += 1) {
      const scoped = candidates.filter((button) => ancestor.contains(button));
      if (scoped.length === 1) return scoped[0];
    }

    const captionRect = caption.getBoundingClientRect();
    for (let ancestor = caption.parentElement, depth = 0;
      ancestor && depth < 7;
      ancestor = ancestor.parentElement, depth += 1) {
      const scoped = [...ancestor.querySelectorAll('button,[role="button"]')]
        .filter((button) => {
          if (!isVisible(button) || button.disabled ||
            button.getAttribute("aria-disabled") === "true") return false;
          const rect = button.getBoundingClientRect();
          const centerY = rect.top + rect.height / 2;
          const centerX = rect.left + rect.width / 2;
          return centerX >= captionRect.right - 12 &&
            Math.abs(centerY - (captionRect.top + captionRect.height / 2)) <= 48;
        });
      if (scoped.length === 1) return scoped[0];
    }
    return null;
  }

  async function publishStatusImage(file, previousStatusCount) {
    await openPhotoStatusPicker(file);
    await waitFor(
      findStatusPublishButton,
      "el botón para publicar el estado",
      90_000
    );
    await clickWhatsAppControl(findStatusPublishButton);
    await waitFor(
      () => !findStatusCaption(),
      "el cierre del editor tras enviar el estado",
      120_000
    );
    await openOwnStatusViewer(false);
    try {
      const publishedGroup = await waitFor(() => {
        const currentGroup = findVisibleStatusGroup();
        const count = parseStatusCount(currentGroup);
        return count && count.total > previousStatusCount ? currentGroup : null;
      }, "el aumento del contador de estados después de enviar la imagen", 90_000);
      const count = parseStatusCount(publishedGroup);
      if (!count || count.total < previousStatusCount + 1) {
        throw new Error("WhatsApp no confirmó que la imagen enviada haya agregado una actualización.");
      }
    } finally {
      await closeStatusViewerIfOpen();
    }
  }

  async function getStatusUpdateFingerprint(action, file) {
    const contents = file ? await file.arrayBuffer() : new ArrayBuffer(0);
    const prefix = new TextEncoder().encode(`${action}:`);
    const input = new Uint8Array(prefix.length + contents.byteLength);
    input.set(prefix);
    input.set(new Uint8Array(contents), prefix.length);
    const digest = await crypto.subtle.digest("SHA-256", input);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function getLegacyStatusUpdateFingerprint(file) {
    if (!file) return null;
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function saveStatusUpdateRecovery(recovery) {
    await chrome.storage.local.set({
      [STATUS_UPDATE_RECOVERY_KEY]: {
        ...recovery,
        updatedAt: Date.now()
      }
    });
  }

  async function getCurrentStatusCount() {
    await ensureStatusPage();
    const presence = await waitFor(() => {
      const current = getOwnStatusPresence();
      return current === "unknown" ? null : current;
    }, "la lista de estados propios", 30_000);
    if (presence === "empty") return 0;

    await openOwnStatusViewer(false);
    try {
      const group = await waitFor(() => {
        const currentGroup = findVisibleStatusGroup();
        return parseStatusCount(currentGroup) ? currentGroup : null;
      }, "el contador de estados propios", 30_000);
      return parseStatusCount(group).total;
    } finally {
      await closeStatusViewerIfOpen();
    }
  }

  async function runStatusOperation(action, file, onStage) {
    if (!["delete", "upload", "replace"].includes(action) ||
      action !== "delete" && !(file instanceof File)) {
      throw new Error("La operación de estado solicitada no es válida.");
    }
    const fingerprint = await getStatusUpdateFingerprint(action, file);
    const legacyFingerprint = action === "replace"
      ? await getLegacyStatusUpdateFingerprint(file)
      : null;
    const stored = await chrome.storage.local.get(STATUS_UPDATE_RECOVERY_KEY);
    const savedRecovery = stored[STATUS_UPDATE_RECOVERY_KEY];
    const recoveryAge = Date.now() - savedRecovery?.updatedAt;
    const validRecoveryPhase = savedRecovery?.phase === "starting" ||
      ["deleting", "deleted", "publishing"].includes(savedRecovery?.phase) &&
      Number.isSafeInteger(savedRecovery.previousStatusCount) &&
      savedRecovery.previousStatusCount >= (savedRecovery.phase === "deleting" ? 1 : 0);
    let recovery = [fingerprint, legacyFingerprint].includes(savedRecovery?.fingerprint) &&
      Number.isSafeInteger(savedRecovery.updatedAt) &&
      recoveryAge >= 0 && recoveryAge < STATUS_UPDATE_RECOVERY_TTL_MS &&
      validRecoveryPhase
      ? savedRecovery
      : null;
    const started = await chrome.runtime.sendMessage({ type: "STATUS_UPDATE_DEBUGGER_START" });
    if (!started?.ok) {
      throw new Error(started?.error || "No se pudo iniciar el control de WhatsApp mediante Chrome.");
    }
    let operationError;
    let stopError;
    let operationRecovered = false;
    let navigationWarning;
    try {
      await runStatusStage("Abriendo Estados", ensureStatusPage, onStage);
      if (recovery?.phase === "deleting") {
        const currentCount = await getCurrentStatusCount();
        if (currentCount >= recovery.previousStatusCount) {
          throw new Error(
            "La operación anterior se interrumpió durante la eliminación y no se pudo confirmar. Revisá Mi estado antes de volver a intentarlo; no se repetirá el borrado automáticamente."
          );
        }
        if (action === "delete") {
          await chrome.storage.local.remove(STATUS_UPDATE_RECOVERY_KEY);
          operationRecovered = true;
        } else {
          recovery = {
            fingerprint,
            phase: "deleted",
            previousStatusCount: currentCount
          };
          await saveStatusUpdateRecovery(recovery);
        }
      }
      if (!operationRecovered && action !== "delete" &&
        (recovery?.phase === "deleted" || recovery?.phase === "publishing")) {
        const currentCount = await getCurrentStatusCount();
        if (recovery.phase === "publishing" &&
          currentCount > recovery.previousStatusCount) {
          await chrome.storage.local.remove(STATUS_UPDATE_RECOVERY_KEY);
          operationRecovered = true;
        }
      } else if (!recovery && !operationRecovered) {
        recovery = {
          fingerprint,
          phase: "starting"
        };
        await saveStatusUpdateRecovery(recovery);
      }

      if (!operationRecovered) {
        const statusPresence = await runStatusStage(
          "Verificando el estado propio",
          () => waitFor(() => {
            const presence = getOwnStatusPresence();
            return presence === "unknown" ? null : presence;
          }, "la miniatura de Mi estado o el aviso de que todavía no hay actualizaciones", 30_000),
          onStage
        );
        if (action === "delete") {
          if (statusPresence === "present") {
            await runStatusStage(
              "Eliminando el estado más reciente",
              () => deleteLatestOwnStatus((count) => saveStatusUpdateRecovery({
                fingerprint,
                phase: "deleting",
                previousStatusCount: count
              })),
              onStage
            );
          }
          await chrome.storage.local.remove(STATUS_UPDATE_RECOVERY_KEY);
          operationRecovered = true;
        } else {
          let previousStatusCount = 0;
          if (recovery?.phase === "deleted" || recovery?.phase === "publishing") {
            previousStatusCount = recovery.previousStatusCount;
          } else if (action === "replace" && statusPresence === "present") {
            previousStatusCount = await runStatusStage(
              "Eliminando el estado más reciente",
              () => deleteLatestOwnStatus((count) => saveStatusUpdateRecovery({
                fingerprint,
                phase: "deleting",
                previousStatusCount: count
              })),
              onStage
            );
            recovery = {
              fingerprint,
              phase: "deleted",
              previousStatusCount
            };
            await saveStatusUpdateRecovery(recovery);
          } else if (statusPresence === "present") {
            previousStatusCount = await getCurrentStatusCount();
          }
          if (recovery?.phase === "starting") {
            recovery = {
              fingerprint,
              phase: "deleted",
              previousStatusCount
            };
            await saveStatusUpdateRecovery(recovery);
          }
          recovery = {
            fingerprint,
            phase: "publishing",
            previousStatusCount
          };
          await saveStatusUpdateRecovery(recovery);
          await runStatusStage(
            "Publicando y verificando la imagen",
            () => publishStatusImage(file, previousStatusCount),
            onStage
          );
          await chrome.storage.local.remove(STATUS_UPDATE_RECOVERY_KEY);
        }
      }
      if (action !== "delete") {
        try {
          await runStatusStage(
            "Volviendo a Chats y seleccionando Todos",
            returnToWhatsAppChats,
            onStage
          );
        } catch (error) {
          navigationWarning = error.message || "No se pudo volver a la lista de chats.";
          console.warn(
            "[Ganamos balance extension] La subida se confirmó, pero WhatsApp no volvió a la lista Todos.",
            error
          );
        }
      }
    } catch (error) {
      operationError = error;
    } finally {
      try {
        const stopped = await chrome.runtime.sendMessage({ type: "STATUS_UPDATE_DEBUGGER_STOP" });
        if (!stopped?.ok) {
          stopError = new Error(stopped?.error || "No se pudo cerrar el control de Chrome.");
        }
      } catch (error) {
        stopError = error;
      }
    }
    if (stopError) {
      if (operationError) {
        throw new Error(
          `${operationError.message || ""} ${stopError.message || "No se pudo cerrar el control de Chrome."}`.trim()
        );
      }
      console.error(
        "[Ganamos balance extension] El estado quedó confirmado, pero no se pudo cerrar la sesión debugger de WhatsApp.",
        stopError
      );
    }
    if (operationError) throw operationError;
    return {
      ok: true,
      ...(operationRecovered ? { recovered: true } : {}),
      ...(navigationWarning ? { navigationWarning } : {})
    };
  }

  async function makeStatusImageFile(image) {
    if (typeof image !== "string" || image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !isValidBase64(image)) {
      throw new Error("La imagen recibida no es válida.");
    }
    const binary = atob(image);
    if (!binary.length || binary.length > MAX_IMAGE_BYTES) {
      throw new Error("La imagen debe pesar como máximo 10 MB.");
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const format = getStatusImageFormat(bytes);
    if (!format) throw new Error("El archivo no es un PNG o JPEG válido.");
    return new File([bytes], `estado.${format.extension}`, { type: format.mimeType });
  }

  function parseActiveBonusFromFilename(filename) {
    const normalizedName = filename.replace(/\.(?:png|jpe?g)$/i, "")
      .replace(/\s+\(\d+\)$/, "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ").trim();
    const percentPattern = "(\\d{1,3}(?:[.,]\\d{1,2})?)";
    const parsePercent = (value) => {
      const percent = Number(value.replace(",", "."));
      return Number.isFinite(percent) && percent >= 0 && percent <= 100
        ? percent
        : null;
    };
    const specific = (platform, value) => {
      const percent = parsePercent(value);
      return percent === null ? null : {
        type: "specific",
        platform,
        percent
      };
    };

    if (/^bono\s+(?:misterioso|secreto)$/i.test(normalizedName)) {
      return { type: "mysterious" };
    }
    const specialMatch = new RegExp(
      `^bonos?\\s+${percentPattern}\\s*-\\s*${percentPattern}\\s*\\(10k\\)$`,
      "i"
    ).exec(normalizedName);
    if (specialMatch) {
      const underThreshold = parsePercent(specialMatch[1]);
      const overThreshold = parsePercent(specialMatch[2]);
      return underThreshold === null || overThreshold === null
        ? null
        : { type: "special", underThreshold, overThreshold };
    }

    const doublePatterns = [
      new RegExp(`^ganamos\\s+${percentPattern}%\\s+-\\s*multipanel\\s+${percentPattern}%$`, "i"),
      new RegExp(`^multipanel\\s+${percentPattern}%\\s+-\\s*ganamos\\s+${percentPattern}%$`, "i")
    ];
    for (const [index, pattern] of doublePatterns.entries()) {
      const match = pattern.exec(normalizedName);
      if (!match) continue;
      const firstPercent = parsePercent(match[1]);
      const secondPercent = parsePercent(match[2]);
      if (firstPercent === null || secondPercent === null) return null;
      return index === 0
        ? { type: "double", ganamos: firstPercent, multipanel: secondPercent }
        : { type: "double", ganamos: secondPercent, multipanel: firstPercent };
    }

    const simpleMatch = new RegExp(`^bono\\s+${percentPattern}%$`, "i")
      .exec(normalizedName);
    if (simpleMatch) {
      const percent = parsePercent(simpleMatch[1]);
      return percent === null ? null : { type: "simple", percent };
    }

    const ganamosMatch = new RegExp(`^ganamos\\s+${percentPattern}%$`, "i")
      .exec(normalizedName);
    if (ganamosMatch) return specific("ganamos", ganamosMatch[1]);

    const multiPanelMatch = new RegExp(`^multipanel\\s+${percentPattern}%$`, "i")
      .exec(normalizedName);
    if (multiPanelMatch) return specific("multipanel", multiPanelMatch[1]);

    const customMatch = new RegExp(`^.+?\\s+${percentPattern}%$`, "i")
      .exec(normalizedName);
    return customMatch ? specific("multipanel", customMatch[1]) : null;
  }

  function describeActiveBonus(bonus) {
    if (bonus.type === "simple") return `Simple: ${bonus.percent}%`;
    if (bonus.type === "specific") {
      const platform = bonus.platform === "ganamos" ? "Ganamos" : "MultiPanel";
      return `Específico de ${platform}: ${bonus.percent}%`;
    }
    if (bonus.type === "double") {
      return `Doble: Ganamos ${bonus.ganamos}% + MultiPanel ${bonus.multipanel}%`;
    }
    if (bonus.type === "special") {
      return `Especial: ${bonus.underThreshold}% bajo $10.000 / ${bonus.overThreshold}% desde $10.000`;
    }
    return "Misterioso";
  }

  async function updateActiveBonusFromFilename(filename) {
    const bonus = parseActiveBonusFromFilename(filename);
    if (!bonus) {
      return "Bono activo sin cambios: el nombre del archivo no coincide con un formato reconocido.";
    }

    const stored = await stateStorage.get("activeBonusConfig");
    const current = stored.activeBonusConfig;
    if (!current || current.enabled !== true || current.type === "none") {
      return "Bono activo sin cambios: no había otro bono activo (o estaba seleccionado Ninguno).";
    }

    const settings = { ...current };
    for (const key of [
      "enabled",
      "type",
      "percent",
      "ganamos",
      "multipanel",
      "platform",
      "underThreshold",
      "overThreshold",
      "outcomes"
    ]) {
      delete settings[key];
    }
    const nextConfig = {
      ...settings,
      enabled: true,
      type: bonus.type,
      ...(bonus.type === "simple" ? { percent: bonus.percent } : {}),
      ...(bonus.type === "specific"
        ? { platform: bonus.platform, percent: bonus.percent }
        : {}),
      ...(bonus.type === "double"
        ? { ganamos: bonus.ganamos, multipanel: bonus.multipanel }
        : {}),
      ...(bonus.type === "special"
        ? {
            underThreshold: bonus.underThreshold,
            overThreshold: bonus.overThreshold
          }
        : {}),
      ...(bonus.type === "mysterious" && current.type === "mysterious" &&
        Array.isArray(current.outcomes) ? { outcomes: current.outcomes } : {})
    };
    await stateStorage.set({ activeBonusConfig: nextConfig });
    return `Bono activo actualizado a partir del archivo: ${filename}.`;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const result = String(reader.result || "");
        const separator = result.indexOf(",");
        if (separator < 0) {
          reject(new Error("No se pudo leer la imagen seleccionada."));
          return;
        }
        resolve(result.slice(separator + 1));
      }, { once: true });
      reader.addEventListener("error", () => reject(
        new Error("No se pudo leer la imagen seleccionada.")
      ), { once: true });
      reader.readAsDataURL(file);
    });
  }

  async function collectSecondaryResults(id, targets, onUpdate) {
    const pending = new Set(targets);
    const results = [];
    const deadline = Date.now() + 10 * 60_000;
    let firstCheck = true;
    while ((firstCheck || pending.size) && Date.now() < deadline) {
      firstCheck = false;
      const response = await chrome.runtime.sendMessage({
        type: "BRIDGE_STATUS_UPDATE_RESULTS_GET",
        id
      });
      if (!response?.ok || !Array.isArray(response.results) ||
        !Array.isArray(response.pending)) {
        throw new Error(response?.error || "No se pudieron consultar los resultados secundarios.");
      }
      results.splice(0, results.length, ...response.results);
      for (const profileId of [...pending]) {
        if (!response.pending.includes(profileId)) pending.delete(profileId);
      }
      onUpdate(response.results, pending.size);
      if (pending.size) await sleep(1000);
    }
    return { results, pending: [...pending] };
  }

  function createStatusReplacer() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none"
    });
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { font-family: Arial, Helvetica, sans-serif; font-style: normal; }
      :host { font-size: 14px; line-height: 1.45; color: #e2e8e7; }
      button, input { font-family: inherit; font-size: inherit; line-height: inherit; }
      button { box-sizing: border-box; flex: 0 1 auto; min-width: 86px; min-height: 34px; padding: 0 10px; border: 1px solid transparent; border-radius: 6px; color: #f2f4f3; background: #344546; font-weight: 600; cursor: pointer; transition: background .15s ease, border-color .15s ease, transform .15s ease; }
      button:hover:not(:disabled) { background: #405455; }
      button:active:not(:disabled) { transform: translateY(1px); }
      button:focus-visible, input:focus-visible { outline: 2px solid #00a884; outline-offset: 2px; }
      button:disabled { opacity: .58; cursor: wait; }
      .open-button { position: relative; z-index: 1; display: grid; place-items: center; width: 34px; min-width: 34px; height: 34px; min-height: 34px; padding: 0; pointer-events: auto; font-family: Arial, Helvetica, sans-serif; font-style: normal; color: #7dd3fc; border: 0; border-radius: 4px; background: #161717; }
      .open-button:hover:not(:disabled) { color: #bae6fd; border: 0; background: #202222; }
      .recycle-icon { display: block; width: 1em; height: 1em; font-family: "Segoe UI Symbol", "Arial Unicode MS", sans-serif; font-size: 27px; font-weight: 400; line-height: 1; text-align: center; transform: translate(-0.02em, -0.04em); }
      .status-popup { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: #070c0ddb; backdrop-filter: blur(1px); pointer-events: auto; }
      .status-popup[hidden] { display: none; }
      .run-progress { position: fixed; top: 12px; left: 50%; z-index: 2147483647; display: none; align-items: flex-start; justify-content: space-between; gap: 12px; box-sizing: border-box; width: min(560px, calc(100vw - 24px)); padding: 10px 14px; transform: translateX(-50%); border: 1px solid #167356; border-radius: 8px; color: #e7edef; background: #1d2929f2; box-shadow: 0 5px 18px #0008; font-size: 13px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
      .run-progress[data-visible="true"] { display: flex; }
      .run-progress-text { flex: 1 1 auto; min-width: 0; }
      .close-progress { flex: 0 0 auto; min-width: 0; min-height: 28px; padding: 2px 8px; color: #aab6b5; border-color: #465453; background: #273332; font-size: 12px; }
      .panel { display: grid; gap: 12px; box-sizing: border-box; width: min(500px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; padding: 22px 24px; border: 1px solid #167356; border-radius: 12px; color: #e2e8e7; background: #1d2929; box-shadow: 0 18px 55px #0009; font-size: 14px; line-height: 1.45; }
      .title { margin: 0 0 5px; color: #e7edef; font-size: 20px; font-weight: 600; letter-spacing: 0; }
      .hint { margin: 0 0 3px; color: #aab6b5; font-size: 13px; }
      .detection, .result { color: #aab6b5; font-size: 13px; }
      .result { white-space: pre-wrap; }
      .detection[data-state="error"] { color: #ff8a8a; }
      .detection[data-bonus-type="simple"] { color: #ffffff; }
      .detection[data-bonus-type="double"] { color: #c08cff; }
      .detection[data-bonus-type="specific"][data-platform="ganamos"] { color: #c08cff; }
      .detection[data-bonus-type="specific"][data-platform="multipanel"] { color: #70b7ff; }
      .detection[data-bonus-type="special"] { color: #ffd166; }
      .detection[data-bonus-type="mysterious"] { color: #ff79b0; }
      .exceptions { display: grid; gap: 6px; }
      .exceptions-label, .profile-message { color: #aab6b5; font-size: 12px; }
      .profile-list { display: flex; flex-wrap: wrap; gap: 6px; }
      .profile-toggle { min-width: 0; min-height: 38px; padding: 5px 12px; color: #f2f7f4; border-color: #167356; background: #1b2727; font-size: 15px; font-weight: 600; }
      .profile-toggle[aria-pressed="true"] { border-color: #168461; background: #167356; box-shadow: inset 0 2px 5px #09271e99; transform: translateY(1px); }
      .profile-toggle[aria-pressed="true"]:hover:not(:disabled) { background: #1c8966; }
      .profile-toggle[aria-pressed="false"] { color: #c1ccca; border-color: #465453; background: #273332; box-shadow: 0 2px 3px #0005; }
      .profile-toggle[aria-pressed="false"]:hover:not(:disabled) { background: #344241; }
      .profile-message[data-state="error"] { color: #ff8a8a; }
      .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; padding-top: 14px; border-top: 1px solid #344746; }
      .actions button { min-height: 40px; }
      .secondary { color: #aab6b5; border-color: #344546; background: transparent; }
      .secondary:hover:not(:disabled) { background: #273535; }
      .accept { color: #f2f7f4; background: #167356; }
      .accept:hover:not(:disabled) { background: #1c8966; }
      .replace { grid-column: 1 / -1; color: #f2f7f4; background: #167356; }
      .replace:hover:not(:disabled) { background: #1c8966; }
      .close { grid-column: 1 / -1; }
      input[type="file"] { box-sizing: border-box; width: 100%; min-height: 40px; padding: 8px 11px; border: 1px solid #167356; border-radius: 7px; color: #e7edef; background: #1b2727; font-size: 15px; line-height: 1.4; }
    `;
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "open-button";
    openButton.setAttribute("aria-label", "Cambiar estado");
    openButton.title = "Cambiar estado";
    openButton.setAttribute("aria-haspopup", "dialog");
    openButton.setAttribute("aria-expanded", "false");
    const recycleIcon = document.createElement("span");
    recycleIcon.className = "recycle-icon";
    recycleIcon.setAttribute("aria-hidden", "true");
    recycleIcon.textContent = "\u267B";
    openButton.append(recycleIcon);
    const popup = document.createElement("div");
    popup.className = "status-popup";
    popup.hidden = true;
    const runProgress = document.createElement("div");
    runProgress.className = "run-progress";
    const runProgressText = document.createElement("span");
    runProgressText.className = "run-progress-text";
    runProgressText.setAttribute("role", "status");
    runProgressText.setAttribute("aria-live", "polite");
    const closeProgressButton = document.createElement("button");
    closeProgressButton.type = "button";
    closeProgressButton.className = "close-progress";
    closeProgressButton.textContent = "Cerrar";
    closeProgressButton.setAttribute("aria-label", "Cerrar mensaje de progreso");
    closeProgressButton.title = "Oculta el mensaje; la operación continúa.";
    runProgress.append(runProgressText, closeProgressButton);
    let progressDismissed = false;
    closeProgressButton.addEventListener("click", () => {
      progressDismissed = true;
      runProgress.dataset.visible = "false";
    });
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "status-popup-title");
    panel.setAttribute("tabindex", "-1");
    const title = document.createElement("h2");
    title.className = "title";
    title.id = "status-popup-title";
    title.textContent = "Administrar estados";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Elige una acción: borrar el estado más reciente, subir una imagen sin borrar o borrar y subir. Se aplica al perfil principal y a los secundarios conectados, salvo los que marques como excluidos.";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,.png,image/jpeg,.jpg,.jpeg";
    const detection = document.createElement("div");
    detection.className = "detection";
    detection.textContent = "Bono detectado: selecciona una imagen PNG o JPEG para analizar el nombre.";
    detection.dataset.state = "idle";
    const exceptions = document.createElement("div");
    exceptions.className = "exceptions";
    const exceptionsLabel = document.createElement("div");
    exceptionsLabel.className = "exceptions-label";
    exceptionsLabel.textContent = "Perfiles (pulsa para excluirlos de la operación):";
    const profileList = document.createElement("div");
    profileList.className = "profile-list";
    const profileMessage = document.createElement("div");
    profileMessage.className = "profile-message";
    exceptions.append(exceptionsLabel, profileList, profileMessage);
    const status = document.createElement("div");
    status.className = "result";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "secondary";
    deleteButton.textContent = "Borrar Estado";
    deleteButton.disabled = true;
    const uploadButton = document.createElement("button");
    uploadButton.type = "button";
    uploadButton.className = "accept";
    uploadButton.textContent = "Subir Estado";
    uploadButton.disabled = true;
    const replaceButton = document.createElement("button");
    replaceButton.type = "button";
    replaceButton.className = "replace";
    replaceButton.textContent = "Borrar y Subir";
    replaceButton.disabled = true;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "secondary close";
    closeButton.textContent = "Cerrar";
    let selectedFile = null;
    let selectionGeneration = 0;
    let connectedProfiles = [];
    let primaryProfile = null;
    let profilesLoaded = false;
    let excludedProfileIds = [];
    const updateActionButtons = () => {
      deleteButton.disabled = statusUpdateInProgress || !profilesLoaded;
      uploadButton.disabled = statusUpdateInProgress || !profilesLoaded || !selectedFile;
      replaceButton.disabled = statusUpdateInProgress || !profilesLoaded || !selectedFile;
      closeButton.disabled = statusUpdateInProgress;
    };
    const renderConnectedProfiles = () => {
      profileList.replaceChildren();
      const profiles = [
        ...(primaryProfile ? [{ ...primaryProfile, role: "Principal" }] : []),
        ...connectedProfiles.map((profile) => ({ ...profile, role: "Secundario" }))
      ];
      const collator = new Intl.Collator("es", {
        numeric: true,
        sensitivity: "base"
      });
      profiles.sort((left, right) =>
        collator.compare(left.name, right.name) ||
        left.profileId.localeCompare(right.profileId));
      if (!profiles.length) {
        profileMessage.textContent = "No hay perfiles secundarios conectados en este momento.";
        return;
      }
      profileMessage.textContent = excludedProfileIds.some((profileId) =>
        !profiles.some((profile) => profile.profileId === profileId))
        ? "Las excepciones de perfiles desconectados también se conservan."
        : "";
      for (const profile of profiles) {
        const { profileId } = profile;
        const excluded = excludedProfileIds.includes(profileId);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "profile-toggle";
        button.setAttribute("aria-pressed", String(!excluded));
        button.textContent = profile.name;
        button.setAttribute(
          "aria-label",
          `${profile.name}, ${excluded ? "excluido del envío" : "incluido en el envío"}`
        );
        button.title = profile.name;
        button.addEventListener("click", async () => {
          const nextExcluded = new Set(excludedProfileIds);
          if (excluded) nextExcluded.delete(profileId);
          else nextExcluded.add(profileId);
          profileMessage.dataset.state = "loading";
          profileMessage.textContent = "Guardando excepción…";
          for (const toggle of profileList.querySelectorAll("button")) {
            toggle.disabled = true;
          }
          try {
            const response = await chrome.runtime.sendMessage({
              type: "BRIDGE_STATUS_EXCEPTIONS_SET",
              profileIds: [...nextExcluded]
            });
            if (!response?.ok || !Array.isArray(response.excludedProfileIds)) {
              throw new Error(response?.error || "No se pudieron guardar las excepciones.");
            }
            excludedProfileIds = response.excludedProfileIds;
            renderConnectedProfiles();
            if (response.warning) {
              profileMessage.dataset.state = "error";
              profileMessage.textContent = response.warning;
            } else {
              profileMessage.dataset.state = "";
              profileMessage.textContent = "Excepciones guardadas.";
            }
          } catch (error) {
            profileMessage.dataset.state = "error";
            profileMessage.textContent = error.message || "No se pudieron guardar las excepciones.";
            for (const toggle of profileList.querySelectorAll("button")) {
              toggle.disabled = false;
            }
          }
        });
        profileList.append(button);
      }
    };
    const loadConnectedProfiles = async () => {
      profileMessage.dataset.state = "loading";
      profileMessage.textContent = "Consultando perfiles secundarios conectados…";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "BRIDGE_STATUS_PROFILES_GET"
        });
        if (!response?.ok || !Array.isArray(response.profiles) ||
          !Array.isArray(response.excludedProfileIds) ||
          typeof response.primaryProfile?.profileId !== "string" ||
          typeof response.primaryProfile?.name !== "string") {
          throw new Error(response?.error || "No se pudieron consultar los perfiles secundarios.");
        }
        connectedProfiles = response.profiles;
        primaryProfile = response.primaryProfile;
        excludedProfileIds = response.excludedProfileIds;
        profilesLoaded = true;
        updateActionButtons();
        profileMessage.dataset.state = "";
        renderConnectedProfiles();
      } catch (error) {
        profilesLoaded = false;
        updateActionButtons();
        profileList.replaceChildren();
        profileMessage.dataset.state = "error";
        profileMessage.textContent = error.message || "No se pudieron consultar los perfiles secundarios.";
      }
    };
    const closePopup = () => {
      if (statusUpdateInProgress) return;
      selectionGeneration += 1;
      popup.hidden = true;
      openButton.setAttribute("aria-expanded", "false");
      selectedFile = null;
      input.value = "";
      updateActionButtons();
      detection.textContent = "Bono detectado: selecciona una imagen PNG o JPEG para analizar el nombre.";
      detection.dataset.state = "idle";
      delete detection.dataset.bonusType;
      delete detection.dataset.platform;
      status.textContent = "";
      openButton.focus();
    };
    closeButton.addEventListener("click", closePopup);
    popup.addEventListener("click", (event) => {
      if (event.target === popup) closePopup();
    });
    openButton.addEventListener("click", () => {
      popup.hidden = false;
      openButton.setAttribute("aria-expanded", "true");
      input.focus();
      void loadConnectedProfiles();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !openButton.disabled) {
        event.stopPropagation();
        closePopup();
      }
    });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      const currentGeneration = ++selectionGeneration;
      selectedFile = null;
      updateActionButtons();
      status.textContent = "";
      if (!file) {
        detection.textContent = "Bono detectado: selecciona una imagen PNG o JPEG para analizar el nombre.";
        detection.dataset.state = "idle";
        delete detection.dataset.bonusType;
        delete detection.dataset.platform;
        return;
      }

      const bonus = parseActiveBonusFromFilename(file.name);
      if (!bonus) {
        detection.textContent = "Bono detectado: no se pudo detectar un formato válido en el nombre del archivo.";
        detection.dataset.state = "error";
        delete detection.dataset.bonusType;
        delete detection.dataset.platform;
      } else {
        detection.textContent = `Bono detectado: ${describeActiveBonus(bonus)}.`;
        detection.dataset.state = "success";
        detection.dataset.bonusType = bonus.type;
        if (bonus.type === "specific") {
          detection.dataset.platform = bonus.platform;
        } else {
          delete detection.dataset.platform;
        }
      }

      const fileExtension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
      if (!["png", "jpg", "jpeg"].includes(fileExtension)) {
        status.textContent = "El archivo debe tener extensión .png, .jpg o .jpeg.";
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        status.textContent = `El archivo pesa ${(file.size / (1024 * 1024)).toFixed(2)} MB; el máximo permitido es 10 MB.`;
        return;
      }
      status.textContent = "Verificando la imagen…";
      try {
        const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        const format = getStatusImageFormat(bytes);
        const extensionMatches = format?.extension === "png"
          ? fileExtension === "png"
          : format?.extension === "jpg" && ["jpg", "jpeg"].includes(fileExtension);
        if (!format || !extensionMatches) {
          throw new Error("La extensión del archivo no coincide con una imagen PNG o JPEG válida.");
        }
      } catch (error) {
        if (currentGeneration === selectionGeneration) {
          status.textContent = error.message;
        }
        return;
      }
      if (currentGeneration !== selectionGeneration) return;
      selectedFile = file;
      updateActionButtons();
      status.textContent = profilesLoaded
        ? "Imagen válida. Ya puedes subirla o borrar y subir."
        : "Imagen válida. Esperando la lista de perfiles para confirmar excepciones.";
    });

    const runSelectedStatusAction = async (action) => {
      const file = action === "delete" ? null : selectedFile;
      if (statusUpdateInProgress || !profilesLoaded ||
        action !== "delete" && !file) return;
      statusUpdateInProgress = true;
      updateActionButtons();
      openButton.disabled = true;
      input.disabled = true;
      popup.hidden = true;
      const updateProgress = (text) => {
        runProgressText.textContent = text;
        if (!progressDismissed) runProgress.dataset.visible = "true";
      };
      const actionLabel = action === "delete"
        ? "Borrando el estado"
        : action === "upload"
          ? "Subiendo el estado"
          : "Borrando y subiendo el estado";
      let localProgress = "Preparando perfiles conectados…";
      progressDismissed = false;
      updateProgress(localProgress);
      try {
        const image = file ? await fileToBase64(file) : undefined;
        const collator = new Intl.Collator("es", {
          numeric: true,
          sensitivity: "base"
        });
        const activeProfiles = [
          ...(primaryProfile ? [{ ...primaryProfile, role: "Principal" }] : []),
          ...connectedProfiles.map((profile) => ({ ...profile, role: "Secundario" }))
        ]
          .filter((profile) => !excludedProfileIds.includes(profile.profileId))
          .sort((left, right) =>
            collator.compare(left.name, right.name) ||
            left.profileId.localeCompare(right.profileId));
        const midpoint = Math.ceil(activeProfiles.length / 2);
        const passes = [
          activeProfiles.slice(0, midpoint),
          activeProfiles.slice(midpoint)
        ].filter((profiles) => profiles.length);
        const passSummaries = [];
        if (!activeProfiles.length) {
          passSummaries.push("No hay perfiles incluidos para cambiar el estado.");
        }

        for (const [index, profiles] of passes.entries()) {
          const passLabel = `Pasada ${index + 1} de ${passes.length} (${profiles.length} perfiles)`;
          const secondaryProfileIds = profiles
            .filter((profile) => profile.role === "Secundario")
            .map((profile) => profile.profileId);
          localProgress = `${passLabel}: iniciando…`;
          updateProgress(localProgress);

          let targets = [];
          let id;
          if (secondaryProfileIds.length) {
            id = crypto.randomUUID();
            let receipt;
            try {
              receipt = await chrome.runtime.sendMessage({
                type: "BRIDGE_STATUS_UPDATE_PUBLISH",
                id,
                action,
                targetProfileIds: secondaryProfileIds,
                ...(image ? { image } : {})
              });
            } catch (error) {
              passSummaries.push(
                `${passLabel}: no se pudo iniciar en los perfiles secundarios (${error.message || "error de comunicación."}).`
              );
              break;
            }
            if (!receipt?.ok || receipt.action !== action || !Array.isArray(receipt.targets)) {
              passSummaries.push(
                `${passLabel}: no se pudo confirmar con el puente (${receipt?.error || "confirmación no válida"}).`
              );
              break;
            }
            targets = receipt.targets;
          }

          const localProfileIncluded = profiles.some((profile) =>
            profile.profileId === primaryProfile?.profileId);
          const localPromise = localProfileIncluded
            ? runStatusOperation(action, file, (stage) => {
                localProgress = `${passLabel} — Perfil principal: ${stage}.`;
                updateProgress(localProgress);
              }).then((result) => ({
                text: `Perfil principal: ${action === "delete"
                  ? "estado borrado"
                  : action === "upload"
                    ? "estado subido"
                    : "estado reemplazado"}.${result.navigationWarning
                  ? `\nNo se pudo volver a Chats: ${result.navigationWarning}`
                  : ""}`
              }), (error) => ({
                text: `Perfil principal: error: ${error.message || "no se pudo cambiar el estado."}`
              }))
            : Promise.resolve({ text: "" });
          const secondaryPromise = id
            ? collectSecondaryResults(id, targets, (results, pendingCount) => {
                const succeeded = results.filter((result) => result.ok).length;
                const failed = results.filter((result) => !result.ok);
                const verb = action === "delete" ? "borrados" : "publicados";
                updateProgress(
                  `${localProgress}\n${passLabel} — Secundarios: ${succeeded} ${verb}, ${failed.length} con error, ${pendingCount} pendientes.`
                );
              }).then((summary) => ({ summary }), (error) => ({ error }))
            : Promise.resolve(null);
          const [localResult, secondaryResult] = await Promise.all([
            localPromise,
            secondaryPromise
          ]);
          let passSummary = localResult.text;
          if (secondaryResult?.error) {
            passSummary += `${passSummary ? "\n" : ""}${passLabel} — No se pudieron obtener los resultados secundarios: ${secondaryResult.error.message || "error de comunicación."}`;
            passSummaries.push(passSummary);
            break;
          } else if (secondaryResult?.summary) {
            const { summary } = secondaryResult;
            const succeeded = summary.results.filter((result) => result.ok).length;
            const failures = summary.results
              .filter((result) => !result.ok)
              .map((result) =>
                `Perfil ${result.profileId.slice(0, 8)}: ${result.error || "falló"}`);
            if (summary.pending.length) {
              failures.push(...summary.pending.map((profileId) =>
                `Perfil ${profileId.slice(0, 8)}: no respondió a tiempo`));
            }
            const verb = action === "delete" ? "borrados" : "publicados";
            passSummary += `${passSummary ? "\n" : ""}${passLabel} — Secundarios: ${succeeded} ${verb}, ${failures.length} con error.${failures.length ? `\n${failures.join("\n")}` : ""}`;
          }
          passSummaries.push(passSummary || `${passLabel}: terminado.`);
        }
        if (primaryProfile && excludedProfileIds.includes(primaryProfile.profileId)) {
          passSummaries.unshift(
            `Perfil principal: excluido; no se ${action === "delete" ? "borró" : "publicó"} el estado.`
          );
        }
        status.textContent = passSummaries.join("\n");
      } catch (error) {
        status.textContent = `No se pudo iniciar la operación (${actionLabel.toLowerCase()}): ${error.message || "error desconocido."}`;
      } finally {
        if (file && action !== "delete") {
          try {
            const bonusUpdate = await updateActiveBonusFromFilename(file.name);
            status.textContent += `\n${bonusUpdate}`;
          } catch (error) {
            console.error(
              "[Ganamos balance extension] No se pudo actualizar el bono activo desde el nombre de la imagen.",
              error
            );
            status.textContent += `\nNo se pudo actualizar el bono activo: ${error.message || "error desconocido."}`;
          }
        }
        runProgress.dataset.visible = "false";
        progressDismissed = false;
        popup.hidden = false;
        statusUpdateInProgress = false;
        selectedFile = null;
        input.value = "";
        updateActionButtons();
        openButton.disabled = false;
        input.disabled = false;
        scheduleStatusPageVisibilityUpdate();
      }
    };
    deleteButton.addEventListener("click", () => runSelectedStatusAction("delete"));
    uploadButton.addEventListener("click", () => runSelectedStatusAction("upload"));
    replaceButton.addEventListener("click", () => runSelectedStatusAction("replace"));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(deleteButton, uploadButton, replaceButton, closeButton);
    panel.append(title, hint, input, detection, exceptions, status, actions);
    popup.append(panel);
    shadow.append(style, openButton, popup, runProgress);
    document.documentElement.append(host);
    scheduleStatusPageVisibilityUpdate();
    const observer = new MutationObserver(scheduleStatusPageVisibilityUpdate);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid", "class"]
    });
    window.addEventListener("resize", scheduleStatusPageVisibilityUpdate);
    window.addEventListener("scroll", scheduleStatusPageVisibilityUpdate, true);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "STATUS_UPDATE_LOCAL_EXECUTE") return;
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Origen no autorizado para cambiar el estado." });
      return;
    }
    const action = message.action ?? "replace";
    if (!["delete", "upload", "replace"].includes(action) ||
      action === "delete" && message.image !== undefined ||
      action !== "delete" && typeof message.image !== "string") {
      sendResponse({ ok: false, error: "La operación de estado recibida no es válida." });
      return;
    }
    const filePromise = action === "delete"
      ? Promise.resolve(null)
      : makeStatusImageFile(message.image);
    filePromise
      .then((file) => runStatusOperation(action, file))
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "No se pudo cambiar el estado en este perfil."
      }));
    return true;
  });

  stateStorage.get(["bridgeRole", "bridgeToken"])
    .then(({ bridgeRole, bridgeToken }) => {
      if (bridgeRole === "primary" && typeof bridgeToken === "string" && bridgeToken) {
        createStatusReplacer();
      }
    })
    .catch((error) => console.error(
      "[Ganamos balance extension] No se pudo cargar la configuración del reemplazo de estados.",
      error
    ));
})();
