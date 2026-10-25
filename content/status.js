(() => {
  const HOST_ID = "ganamos-status-replacer";
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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

  function findOwnStatusHeader() {
    return [...document.querySelectorAll('button[data-testid="status-header"]')]
      .find((element) =>
        isVisible(element) && /mi estado/i.test(getLabel(element))) || null;
  }

  function isOwnStatusListVisible() {
    const ownStatusHeader = findOwnStatusHeader();
    return Boolean(ownStatusHeader && !findVisibleStatusGroup());
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
      const display = isStatusListVisible ? "" : "none";
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
      } else {
        host.shadowRoot?.querySelector(".status-popup")?.setAttribute("hidden", "");
      }
    });
  }

  function findViewerStatusMenu(group) {
    const candidates = [...document.querySelectorAll(
      'button[aria-label="Menú"][aria-haspopup="menu"]'
    )].filter((element) => {
      if (!isVisible(element) || element.getAttribute("aria-disabled") === "true") return false;
      if (element.querySelector('svg title, [aria-hidden="true"] svg title')?.textContent?.trim() !== "ic-more-vert") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return centerX >= 0 && centerX <= window.innerWidth &&
        centerY >= 0 && centerY <= Math.min(window.innerHeight * 0.45, 300);
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
    const addCandidate = (element) => {
      if (!isVisible(element) ||
        !hasExactNormalizedLabel(element, ["Eliminar", "Eliminar estado", "Delete", "Delete status"]) ||
        !isNearMenu(element)) return;
      const interactiveAncestor = element.closest(
        'button,[role="menuitem"],[role="option"],[role="button"],[tabindex]'
      );
      candidates.add(interactiveAncestor && isVisible(interactiveAncestor) &&
        hasExactNormalizedLabel(interactiveAncestor,
          ["Eliminar", "Eliminar estado", "Delete", "Delete status"]) &&
        isNearMenu(interactiveAncestor) ? interactiveAncestor : element);
    };

    for (const root of menuRoots) {
      if (hasExactNormalizedLabel(root, ["Eliminar", "Eliminar estado", "Delete", "Delete status"])) {
        addCandidate(root);
      }
      for (const element of root.querySelectorAll(
        'button,[role="menuitem"],[role="option"],[role="button"],[tabindex],span'
      )) {
        addCandidate(element);
      }
    }
    if (!candidates.size) {
      for (const element of document.querySelectorAll(
        'button,[role="menuitem"],[role="option"],[role="button"],[tabindex],span'
      )) {
        addCandidate(element);
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
      const rect = button.getBoundingClientRect();
      const visibleRect = {
        left: Math.max(0, rect.left),
        top: Math.max(0, rect.top),
        right: Math.min(window.innerWidth, rect.right),
        bottom: Math.min(window.innerHeight, rect.bottom)
      };
      if (visibleRect.right <= visibleRect.left ||
        visibleRect.bottom <= visibleRect.top) {
        await sleep(250 + attempt * 250);
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

  async function openOwnStatusViewer() {
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
    return waitFor(
      findVisibleStatusGroup,
      "el visor de Mi estado",
      60_000
    );
  }

  function parseStatusCount(group) {
    const match = STATUS_COUNT_PATTERN.exec(group?.getAttribute("aria-label") || "");
    return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
  }

  async function runStatusStage(name, operation) {
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
    if (!header) return "unknown";
    const thumbnail = findOwnStatusThumbnail();
    const emptyPrompt = hasNormalizedLabel(
      header,
      /haz clic para anadir una actualizacion de estado/i
    );
    if (thumbnail && emptyPrompt) return "unknown";
    if (thumbnail) return "present";
    if (emptyPrompt) return "empty";
    return "unknown";
  }

  async function deleteLatestOwnStatus() {
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
    await waitFor(
      () => {
        const currentMenu = findCurrentMenu();
        if (!currentMenu) return null;
        if (currentMenu.getAttribute("aria-expanded") === "true") return currentMenu;
        return findDeleteMenuItem(currentMenu) ? currentMenu : null;
      },
      "el menú del estado",
      30_000
    );
    const deleteItem = await waitFor(
      () => {
        const currentMenu = findCurrentMenu();
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
    await clickWhatsAppControl(() => findDeleteConfirmation()?.button || null);
    await waitFor(
      () => !isVisible(confirmation.popup),
      "el cierre de la confirmación de eliminación"
    );

    const deletionState = await waitFor(() => {
      const currentGroup = findVisibleStatusGroup();
      const updatedCount = parseStatusCount(currentGroup);
      if (updatedCount && updatedCount.total < previousTotal) return "remaining-statuses";

      if (!currentGroup && findVisibleStatusHeader()) {
        if (!findOwnStatusThumbnail()) return "no-statuses";
      }
      return null;
    }, "la verificación de que WhatsApp eliminó el estado", 60_000);

    if (deletionState === "remaining-statuses") return;
    await waitFor(
      findVisibleStatusHeader,
      "la lista de estados después de eliminar el único estado",
      30_000
    );
    await sleep(1000);
    if (findOwnStatusThumbnail()) {
      throw new Error("WhatsApp cerró la confirmación, pero el estado sigue apareciendo en la lista.");
    }
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

  async function publishStatusImage(file) {
    await openPhotoStatusPicker(file);
    const startingThumbnail = findOwnStatusThumbnail();
    const startingSignature = startingThumbnail
      ? `${getLabel(startingThumbnail)}|${[...startingThumbnail.querySelectorAll("img")]
        .map((image) => image.currentSrc || image.src).join("|")}`
      : null;
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
    await waitFor(
      () => {
        const thumbnail = findOwnStatusThumbnail();
        if (!thumbnail) return null;
        const signature = `${getLabel(thumbnail)}|${[...thumbnail.querySelectorAll("img")]
          .map((image) => image.currentSrc || image.src).join("|")}`;
        return !startingSignature || signature !== startingSignature ? thumbnail : null;
      },
      "la nueva actualización de Mi estado",
      120_000
    );
  }

  async function replaceLatestStatus(file) {
    const started = await chrome.runtime.sendMessage({ type: "STATUS_UPDATE_DEBUGGER_START" });
    if (!started?.ok) {
      throw new Error(started?.error || "No se pudo iniciar el control de WhatsApp mediante Chrome.");
    }
    let operationError;
    let stopError;
    const restoreOverlays = hideExtensionOverlays();
    try {
      await runStatusStage("Abriendo Estados", ensureStatusPage);
      const statusPresence = await runStatusStage("Verificando el estado propio", () =>
        waitFor(() => {
          const presence = getOwnStatusPresence();
          return presence === "unknown" ? null : presence;
        }, "la miniatura de Mi estado o el aviso de que todavía no hay actualizaciones", 30_000)
      );
      if (statusPresence === "present") {
        await runStatusStage("Eliminando el estado más reciente", deleteLatestOwnStatus);
      }
      await runStatusStage("Publicando y verificando el PNG", () => publishStatusImage(file));
    } catch (error) {
      operationError = error;
    } finally {
      restoreOverlays();
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
      throw new Error(
        `${operationError?.message ? `${operationError.message} ` : ""}${stopError.message || "No se pudo cerrar el control de Chrome."}`
      );
    }
    if (operationError) throw operationError;
    return { ok: true };
  }

  async function makePngFile(image) {
    if (typeof image !== "string" || image.length > 7_100_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image)) {
      throw new Error("La imagen recibida no es válida.");
    }
    const binary = atob(image);
    if (!binary.length || binary.length > MAX_IMAGE_BYTES) {
      throw new Error("La imagen debe pesar como máximo 5 MB.");
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((byte, index) => bytes[index] === byte)) {
      throw new Error("El archivo seleccionado no es un PNG válido.");
    }
    return new File([bytes], "estado.png", { type: "image/png" });
  }

  function parseActiveBonusFromFilename(filename) {
    const normalizedName = filename.replace(/\.png$/i, "")
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
      .recycle-icon { font-family: "Segoe UI Symbol", "Arial Unicode MS", sans-serif; font-size: 27px; font-weight: 400; line-height: 1; }
      .status-popup { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: #070c0ddb; backdrop-filter: blur(1px); pointer-events: auto; }
      .status-popup[hidden] { display: none; }
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
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; padding-top: 14px; border-top: 1px solid #344746; }
      .secondary { color: #aab6b5; border-color: #344546; background: transparent; }
      .secondary:hover:not(:disabled) { background: #273535; }
      .accept { color: #f2f7f4; background: #167356; }
      .accept:hover:not(:disabled) { background: #1c8966; }
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
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "status-popup-title");
    panel.setAttribute("tabindex", "-1");
    const title = document.createElement("h2");
    title.className = "title";
    title.id = "status-popup-title";
    title.textContent = "Reemplazar último estado";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Selecciona un PNG de hasta 5 MB. Se reemplazará el estado propio más reciente o, si no hay ninguno, se publicará como nuevo en los perfiles conectados.";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,.png";
    const detection = document.createElement("div");
    detection.className = "detection";
    detection.textContent = "Bono detectado: selecciona una imagen PNG para analizar el nombre.";
    detection.dataset.state = "idle";
    const status = document.createElement("div");
    status.className = "result";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const acceptButton = document.createElement("button");
    acceptButton.type = "button";
    acceptButton.className = "accept";
    acceptButton.textContent = "Aceptar";
    acceptButton.disabled = true;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "secondary";
    closeButton.textContent = "Cerrar";
    let selectedFile = null;
    let selectionGeneration = 0;
    const closePopup = () => {
      if (statusUpdateInProgress) return;
      selectionGeneration += 1;
      popup.hidden = true;
      openButton.setAttribute("aria-expanded", "false");
      selectedFile = null;
      input.value = "";
      acceptButton.disabled = true;
      detection.textContent = "Bono detectado: selecciona una imagen PNG para analizar el nombre.";
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
      acceptButton.disabled = true;
      status.textContent = "";
      if (!file) {
        detection.textContent = "Bono detectado: selecciona una imagen PNG para analizar el nombre.";
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

      if (!/\.png$/i.test(file.name)) {
        status.textContent = "El archivo debe tener extensión .png.";
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        status.textContent = `El archivo pesa ${(file.size / (1024 * 1024)).toFixed(2)} MB; el máximo permitido es 5 MB.`;
        return;
      }
      status.textContent = "Verificando el archivo PNG…";
      try {
        const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (bytes.length !== signature.length ||
          !signature.every((byte, index) => bytes[index] === byte)) {
          throw new Error("El archivo seleccionado no tiene una firma PNG válida.");
        }
      } catch (error) {
        if (currentGeneration === selectionGeneration) {
          status.textContent = error.message;
        }
        return;
      }
      if (currentGeneration !== selectionGeneration) return;
      selectedFile = file;
      acceptButton.disabled = false;
      status.textContent = "PNG válido. Ya puedes aceptar.";
    });

    acceptButton.addEventListener("click", async () => {
      const file = selectedFile;
      if (!file || statusUpdateInProgress) return;
      openButton.disabled = true;
      input.disabled = true;
      acceptButton.disabled = true;
      closeButton.disabled = true;
      statusUpdateInProgress = true;
      status.textContent = "Iniciando en paralelo los perfiles conectados…";
      const host = document.getElementById(HOST_ID);
      const previousDisplay = host?.style.display || "";
      if (host) host.style.display = "none";
      try {
        const id = crypto.randomUUID();
        const [publishResult, localResult] = await Promise.allSettled([
          (async () => {
            const image = await fileToBase64(file);
            return chrome.runtime.sendMessage({
              type: "BRIDGE_STATUS_UPDATE_PUBLISH",
              id,
              image
            });
          })(),
          replaceLatestStatus(file)
        ]);

        const receipt = publishResult.status === "fulfilled" ? publishResult.value : null;
        const local = localResult.status === "fulfilled"
          ? "Perfil principal: publicado."
          : `Perfil principal: error: ${localResult.reason?.message || "no se pudo cambiar el estado."}`;
        if (!receipt?.ok) {
          status.textContent = `${local}\nNo se pudieron iniciar los perfiles secundarios: ${receipt?.error || publishResult.reason?.message || "error de comunicación."}`;
        } else {
          const targets = Array.isArray(receipt.targets) ? receipt.targets : [];
          status.textContent = `${local}\nPerfiles secundarios conectados: ${targets.length}.`;
          try {
            const summary = await collectSecondaryResults(id, targets, (results, pendingCount) => {
              const succeeded = results.filter((result) => result.ok).length;
              const failed = results.filter((result) => !result.ok);
              status.textContent = `${local}\nSecundarios: ${succeeded} publicados, ${failed.length} con error, ${pendingCount} pendientes.`;
            });
            const succeeded = summary.results.filter((result) => result.ok).length;
            const failures = summary.results
              .filter((result) => !result.ok)
              .map((result) => `Perfil ${result.profileId.slice(0, 8)}: ${result.error || "falló"}`);
            if (summary.pending.length) {
              failures.push(...summary.pending.map((profileId) =>
                `Perfil ${profileId.slice(0, 8)}: no respondió a tiempo`));
            }
            status.textContent = `${local}\nSecundarios: ${succeeded} publicados, ${failures.length} con error.${failures.length ? `\n${failures.join("\n")}` : ""}`;
          } catch (error) {
            status.textContent = `${local}\nNo se pudieron obtener todos los resultados secundarios: ${error.message}`;
          }
        }
      } catch (error) {
        status.textContent = `No se pudo iniciar el cambio de estado: ${error.message || "error desconocido."}`;
      } finally {
        try {
          const bonusUpdate = await updateActiveBonusFromFilename(file.name);
          status.textContent += `\n${bonusUpdate}`;
        } catch (error) {
          console.error(
            "[Ganamos balance extension] No se pudo actualizar el bono activo desde el nombre del PNG.",
            error
          );
          status.textContent += `\nNo se pudo actualizar el bono activo: ${error.message || "error desconocido."}`;
        }
        if (host) host.style.display = previousDisplay;
        openButton.disabled = false;
        input.disabled = false;
        closeButton.disabled = false;
        statusUpdateInProgress = false;
        selectedFile = null;
        input.value = "";
        scheduleStatusPageVisibilityUpdate();
      }
    });
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(acceptButton, closeButton);
    panel.append(title, hint, input, detection, status, actions);
    popup.append(panel);
    shadow.append(style, openButton, popup);
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
    makePngFile(message.image)
      .then((file) => replaceLatestStatus(file))
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
