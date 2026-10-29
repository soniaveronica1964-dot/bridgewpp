(() => {
  const HOST_ID = "ganamos-balance-extension";
  const AGENT_BALANCE_HOST_ID = "ganamos-agent-balance";
  const CONTACT_FLOW_COUNTER_HOST_ID = "ganamos-contact-flow-counters";
  const PENDING_WITHDRAWALS_HOST_ID = "ganamos-pending-withdrawals";
  const ACTIVE_BONUS_HOST_ID = "ganamos-active-bonus";
  const ACTIVE_BONUS_CONFIG_KEY = "activeBonusConfig";
  const PLATFORM_OUTAGE_CONFIG_KEY = "platformOutageConfig";
  const SPORT_BETS_DISABLED_USERS_KEY = "sportBetsDisabledUsers";
  const USER_BONUS_DISABLED_KEY = "userBonusDisabled";
  const USER_ACCUMULATES_BONUSES_KEY = "userAccumulatesBonuses";
  const USER_BLOCKED_KEY = "userBlocked";
  const USER_WITHDRAWAL_LIMIT_KEY = "userWithdrawalLimit";
  const USER_RELATED_CONTACTS_KEY = "userRelatedContacts";
  const CONTACT_VISUAL_TAGS_KEY = "contactVisualTags";
  const DEFAULT_WITHDRAWAL_LIMIT = 150000;
  const HIDDEN_ADVERTISING_PROFILES_KEY = "hiddenAdvertisingProfiles";
  const PROFILE_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CONTACT_FLOW_COUNTERS_KEY = "contactFlowCounters";
  const PENDING_WITHDRAWALS_KEY = "pendingWithdrawals";
  const PENDING_WITHDRAWAL_MESSAGE_MAX_AGE_MS = 60_000;
  const PENDING_WITHDRAWAL_BALANCE_THRESHOLD = 10_000;
  const CONTACT_FLOW_COUNTER_REFRESH_INTERVAL_MS = 5_000;
  const CONTACT_FLOW_MESSAGE_MAX_AGE_MS = 45 * 60_000;
  const CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS = 30_000;
  const CONTACT_FLOW_COUNTED_NUMBER_TTL_MS = 12 * 60 * 60 * 1000;
  const TOAST_HOST_ID = "ganamos-toast-host";
  const AGENT_MOVEMENT_PREFIX = "agentMovement:";
  const AGENT_BALANCE_VIEWS = ["minimized", "balance", "daily", "weekly", "monthly", "total"];
  const AGENT_MOVEMENT_VIEWS = ["daily", "weekly", "monthly", "total"];
  const ACTIVE_BONUS_TYPES = ["none", "simple", "double", "specific", "special", "mysterious"];
  const MYSTERIOUS_BONUS_WEIGHTS = [
    [15, 2],
    [20, 6],
    [25, 9],
    [30, 16],
    [35, 9],
    [40, 6],
    [50, 2]
  ];
  let scheduled = false;
  let activeAccountsKey = null;
  let selectingAgentBalanceText = false;
  let selectingContactUserText = false;
  let agentBalanceLoading = false;
  let multiPanelAgentBalanceLoading = false;
  let agentBalanceView = "balance";
  let agentBalanceContactKey = null;
  let platformSuffixes = { ganamos: "f", multipanel: "y" };
  let platformOutageConfig = { ganamos: false, multipanel: false };
  let remoteCreateDestinations = [];
  let remoteCreateDestinationsLoaded = false;
  let remoteCreateDestinationsLoadPromise = null;
  let contactFlowCounters = { arrived: 0, derived: {}, countedNumbers: [], panels: [] };
  let contactFlowCounterRows = new Map();
  let contactFlowDerivedRows = null;
  let contactFlowPanelConfigRefresh = null;
  let contactFlowCounterSaveQueue = Promise.resolve();
  let contactFlowCountersLoaded = false;
  let contactFlowMessageObserverStarted = false;
  let contactFlowCounterRefreshStarted = false;
  let contactFlowCounterRefreshInProgress = false;
  let contactFlowCountersVersion = 0;
  let pendingWithdrawals = [];
  let pendingWithdrawalsLoaded = false;
  let pendingWithdrawalsExpanded = false;
  let pendingWithdrawalSaveQueue = Promise.resolve();
  let pendingWithdrawalsList = null;
  let pendingWithdrawalsToggle = null;
  let pendingWithdrawalsRenderedSignature = null;
  let pendingWithdrawalsTimer = null;
  let pendingWithdrawalBalanceRefreshInProgress = false;
  const pendingWithdrawalCompletions = new Set();
  let contactVisualTags = {};
  const blockedUserAccountSettings = new Set();
  const loadedBlockedUserAccountSettings = new Set();
  const pendingBlockedUserAccountSettings = new Set();
  const bonusDisabledUserAccountSettings = new Set();
  const loadedBonusDisabledUserAccountSettings = new Set();
  const pendingBonusDisabledUserAccountSettings = new Set();
  let contactVisualTagsLoadPromise = null;
  let contactVisualTagSaveQueue = Promise.resolve();
  let contactTagScanScheduled = false;
  const contactFlowChatNumbers = new WeakMap();
  const processedIncomingMessages = new WeakMap();
  const processedOutgoingMessages = new WeakSet();
  const reportedPendingWithdrawalMessages = new WeakSet();
  const agentBalanceErrors = {};
  const agentBalanceToastErrors = {};
  const withdrawalChecksInProgress = new WeakSet();

  function registerModalEscapeHandler(modal, onEscape) {
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscape();
    }, true);
    modal.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest("button")
        : null;
      if (!button || !modal.contains(button)) return;
      queueMicrotask(() => {
        if (!modal.isConnected) return;
        const input = [...modal.querySelectorAll('input:not([type="hidden"]):not(:disabled)')]
          .find(isRenderedVisible);
        input?.focus();
      });
    });
  }

  function getCalendarDayFilter(daysAgo) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - daysAgo);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { from: start.getTime(), to: end.getTime() };
  }

  function getCalendarWeekFilter(weeksAgo = 0) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday - weeksAgo * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { from: start.getTime(), to: end.getTime() };
  }

  function getCalendarMonthFilter(monthsAgo = 0) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
    return { from: start.getTime(), to: end.getTime() };
  }

  function getAnalyticsPeriodOptions() {
    return [
      ["today", "Hoy", () => getCalendarDayFilter(0)],
      ["yesterday", "Ayer", () => getCalendarDayFilter(1)],
      ["current-week", "Sem. Act", () => getCalendarWeekFilter()],
      ["previous-week", "Sem Pas", () => getCalendarWeekFilter(1)],
      ["current-month", "Mes. Act", () => getCalendarMonthFilter()],
      ["previous-month", "Mes. Pas", () => getCalendarMonthFilter(1)],
      ["all", "Todo", () => ({ days: null })]
    ];
  }

  stateStorage.get(["ganamosSuffix", "multiPanelSuffix"])
    .then(({ ganamosSuffix, multiPanelSuffix }) => {
      if (/^[a-z]$/i.test(ganamosSuffix || "") && /^[a-z]$/i.test(multiPanelSuffix || "") &&
        ganamosSuffix.toLowerCase() !== multiPanelSuffix.toLowerCase()) {
        platformSuffixes = {
          ganamos: ganamosSuffix.toLowerCase(),
          multipanel: multiPanelSuffix.toLowerCase()
        };
        scheduleUpdate();
        scheduleContactTagScan();
      }
    })
    .catch((error) => console.error("[Ganamos balance extension] No se pudieron cargar los sufijos de plataformas.", error));

  stateStorage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[PENDING_WITHDRAWALS_KEY]) {
      pendingWithdrawals = normalizePendingWithdrawals(
        changes[PENDING_WITHDRAWALS_KEY].newValue
      );
      pendingWithdrawalsLoaded = true;
      renderPendingWithdrawals();
    }
    if (areaName === "local" && changes[CONTACT_FLOW_COUNTERS_KEY]) {
      contactFlowCountersVersion++;
      contactFlowCounters = normalizeContactFlowCounters(
        changes[CONTACT_FLOW_COUNTERS_KEY].newValue
      );
      for (const updateRow of contactFlowCounterRows.values()) updateRow();
      contactFlowPanelConfigRefresh?.();
    }
    if (areaName === "local" && changes.activeBonusConfig) {
      const bonusHost = document.getElementById(ACTIVE_BONUS_HOST_ID);
      if (bonusHost) {
        void readActiveBonusConfig()
          .then((config) => updateActiveBonusButton(bonusHost, config))
          .catch((error) => console.error(
            "[Ganamos balance extension] No se pudo actualizar el indicador del bono activo.",
            error
          ));
      }
    }
    if (areaName === "local" && changes[PLATFORM_OUTAGE_CONFIG_KEY]) {
      try {
        platformOutageConfig = validatePlatformOutageConfig(
          changes[PLATFORM_OUTAGE_CONFIG_KEY].newValue
        );
        const outageHost = document.getElementById(ACTIVE_BONUS_HOST_ID);
        if (outageHost) renderPlatformOutageConfig(outageHost);
      } catch (error) {
        console.error(
          "[Ganamos balance extension] No se pudo aplicar la configuración de plataformas caídas.",
          error
        );
      }
    }
    if (areaName === "local" && changes[CONTACT_VISUAL_TAGS_KEY]) {
      contactVisualTags = normalizeContactVisualTags(
        changes[CONTACT_VISUAL_TAGS_KEY].newValue
      );
      const host = document.getElementById(HOST_ID);
      const identities = host ? getHostContactVisualTagIdentities(host) : [];
      const tags = getContactVisualTags(identities);
      const highDepositorInput = host?.shadowRoot?.querySelector(
        'input[aria-label="Cargador alto"]'
      );
      const scammerInput = host?.shadowRoot?.querySelector('input[aria-label="Peligro"]');
      if (highDepositorInput) highDepositorInput.checked = tags?.highDepositor === true;
      if (scammerInput) scammerInput.checked = tags?.scammer === true;
      scheduleContactTagScan();
    }
    if (areaName === "local" &&
      Object.keys(changes).some((key) => key.startsWith("userSetting:"))) {
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith("userSetting:userBlocked:")) {
          loadedBlockedUserAccountSettings.add(key);
          if (change.newValue === true) blockedUserAccountSettings.add(key);
          else blockedUserAccountSettings.delete(key);
        } else if (key.startsWith("userSetting:userBonusDisabled:")) {
          loadedBonusDisabledUserAccountSettings.add(key);
          if (change.newValue === true) bonusDisabledUserAccountSettings.add(key);
          else bonusDisabledUserAccountSettings.delete(key);
        }
      }
      updateContactUserSearchBlockedIndicators(
        document.getElementById(HOST_ID)?.shadowRoot
      );
      scheduleContactTagScan();
      void refreshActiveUserSettings(changes).catch((error) => console.error(
        "[Ganamos balance extension] No se pudieron actualizar las preferencias compartidas del usuario.",
        error
      ));
    }
    if (areaName === "local" && changes.remoteCreateDestinations) {
      remoteCreateDestinations = Array.isArray(changes.remoteCreateDestinations.newValue)
        ? changes.remoteCreateDestinations.newValue
        : [];
      remoteCreateDestinationsLoaded = true;
      renderContactFlowDerivedCounters();
      updateContactFlowCounterVisibility();
      updateActiveBonusVisibility();
      const balanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
      if (balanceHost) {
        setAgentBalancePanelWidth(
          balanceHost,
          agentBalanceView === "minimized",
          Object.keys(agentBalanceErrors).length > 0
        );
        void refreshAgentBalance(balanceHost);
        void refreshMultiPanelAgentBalance(balanceHost);
      }
    }
    if (areaName !== "local" || (!changes.ganamosSuffix && !changes.multiPanelSuffix)) return;
    const ganamos = changes.ganamosSuffix?.newValue ?? platformSuffixes.ganamos;
    const multipanel = changes.multiPanelSuffix?.newValue ?? platformSuffixes.multipanel;
    if (/^[a-z]$/i.test(ganamos) && /^[a-z]$/i.test(multipanel) &&
      ganamos.toLowerCase() !== multipanel.toLowerCase()) {
      platformSuffixes = { ganamos: ganamos.toLowerCase(), multipanel: multipanel.toLowerCase() };
      scheduleUpdate();
      scheduleContactTagScan();
    }
  });

  function loadRemoteCreateDestinations() {
    if (!remoteCreateDestinationsLoadPromise) {
      remoteCreateDestinationsLoadPromise = stateStorage.get("remoteCreateDestinations")
        .then(({ remoteCreateDestinations: storedDestinations }) => {
          remoteCreateDestinations = Array.isArray(storedDestinations) ? storedDestinations : [];
          remoteCreateDestinationsLoaded = true;
          renderContactFlowDerivedCounters();
          updateContactFlowCounterVisibility();
          updateActiveBonusVisibility();
          const balanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
          if (balanceHost) {
            setAgentBalancePanelWidth(
              balanceHost,
              agentBalanceView === "minimized",
              Object.keys(agentBalanceErrors).length > 0
            );
          }
        })
        .catch((error) => {
          remoteCreateDestinationsLoadPromise = null;
          remoteCreateDestinationsLoaded = true;
          updateContactFlowCounterVisibility();
          updateActiveBonusVisibility();
          throw error;
        });
    }
    return remoteCreateDestinationsLoadPromise;
  }

  void loadRemoteCreateDestinations()
    .catch((error) => console.error(
      "[Ganamos balance extension] No se pudieron cargar las PCs de destino.",
      error
    ));

  stateStorage.get([CONTACT_FLOW_COUNTERS_KEY, PENDING_WITHDRAWALS_KEY])
    .then((stored) => {
      const storedCounters = stored[CONTACT_FLOW_COUNTERS_KEY];
      contactFlowCounters = normalizeContactFlowCounters(storedCounters);
      if (JSON.stringify(contactFlowCounters) !== JSON.stringify(storedCounters ?? null)) {
        saveContactFlowCounters();
      }
      pendingWithdrawals = normalizePendingWithdrawals(
        stored[PENDING_WITHDRAWALS_KEY]
      );
      pendingWithdrawalsLoaded = true;
      renderPendingWithdrawals();
      void refreshPendingWithdrawalBalances();
      contactFlowCountersLoaded = true;
      for (const updateRow of contactFlowCounterRows.values()) updateRow();
      startContactFlowMessageObserver();
    })
    .catch((error) => {
      contactFlowCountersLoaded = true;
      console.error(
        "[Ganamos balance extension] No se pudo cargar el estado necesario para los contadores y retiros pendientes.",
        error
      );
      showToast(
        null,
        "Retiros pendientes",
        "No se pudo cargar el almacenamiento; no se registrarán retiros.",
        "error",
        "pending-withdrawals"
      );
      startContactFlowMessageObserver();
    });

  function isVisible(element) {
    return Boolean(element && element.getClientRects().length);
  }

  function isRenderedVisible(element) {
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

    return true;
  }

  function isActuallyVisible(element) {
    if (!isRenderedVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(
      Math.min(rect.right - 1, Math.max(rect.left + 1, rect.left + rect.width / 2)),
      Math.min(rect.bottom - 1, Math.max(rect.top + 1, rect.top + rect.height / 2))
    );
    return Boolean(hitTarget && (hitTarget === element || element.contains(hitTarget)));
  }

  function findContactTitle() {
    const chat = document.querySelector("#main");
    const root = chat || document;
    const explicitTitles = [...root.querySelectorAll('[data-testid="conversation-info-header-chat-title"]')]
      .filter(isVisible);
    if (explicitTitles.length) return explicitTitles.length === 1 ? explicitTitles[0] : null;
    const matches = [...root.querySelectorAll("header h1, header h2, header [role='heading']")]
      .filter(isVisible);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
    const titledHeaderElements = [...root.querySelectorAll("header [title]")]
      .filter(isVisible);
    return titledHeaderElements.length === 1 ? titledHeaderElements[0] : null;
  }

  function findUnblockButton() {
    return [...document.querySelectorAll("button")]
      .find((button) => {
        if (!isVisible(button) || button.getAttribute("aria-disabled") === "true") return false;
        const label = button.textContent.trim().replace(/\s+/g, " ").toLowerCase();
        const hasBlockIcon = [...button.querySelectorAll("svg title")]
          .some((title) => title.textContent.trim().toLowerCase() === "ic-block");
        return button.getAttribute("data-tab") === "10" &&
          (label.includes("desbloquear") || hasBlockIcon);
      }) || null;
  }

  function isNormalChatOpen(title) {
    if (document.fullscreenElement) return false;
    if (findUnblockButton()) return true;
    const chat = title?.closest("#main") || document.querySelector("#main");
    if (!chat || !isVisible(chat) || !isVisible(title)) return false;
    const host = document.getElementById(HOST_ID);
    if (host?.shadowRoot?.querySelector(".modal")) return true;
    const hasEmojiButton = [...chat.querySelectorAll('button[aria-label="Emojis, GIF, Stickers"]')]
      .some((button) =>
        isActuallyVisible(button) && button.getAttribute("aria-disabled") !== "true");
    return hasEmojiButton;
  }

  function getPhoneFromContactTitle(title) {
    const text = title?.textContent?.replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim() || "";
    if (!/^[+\d\s().-]+$/.test(text)) return null;
    const digits = text.replace(/\D/g, "");
    return digits.length >= 4 ? digits : null;
  }

  function getPhoneFromWhatsAppChat(title) {
    const titlePhone = getPhoneFromContactTitle(title);
    const chat = title?.closest("#main") || document.querySelector("#main");
    if (!chat || chat.querySelector('[data-id*="@g.us"]')) return titlePhone;
    const trackedPhone = contactFlowChatNumbers.get(chat);
    if (trackedPhone && /^\d{7,20}$/.test(trackedPhone)) return trackedPhone;
    const chatNumbers = new Set([...chat.querySelectorAll("[data-id]")]
      .map((element) => element.getAttribute("data-id") || "")
      .map((messageId) =>
        messageId.match(/(?:^|_)(\d{7,20})@(?:c\.us|s\.whatsapp\.net)(?:_|$)/i)?.[1])
      .filter(Boolean));
    return chatNumbers.size === 1 ? [...chatNumbers][0] : titlePhone;
  }

  function getPlatformAccountIds(phone, platforms = ["ganamos", "multipanel"]) {
    if (typeof phone !== "string" || !/^\d{4,20}$/.test(phone)) return [];
    return [...new Set(platforms
      .filter((platform) => platform === "ganamos" || platform === "multipanel")
      .map((platform) => `${platform}:${phone}`))];
  }

  function getMovementAccountIds(contactKey, platforms) {
    try {
      const contact = JSON.parse(contactKey);
      return getPlatformAccountIds(contact?.phone, platforms);
    } catch {
      return [];
    }
  }

  function getSportBetsPreferenceId(host) {
    const usernames = {
      ganamos: host.dataset.username?.toLowerCase() || "",
      multipanel: host.dataset.multipanelUsername?.toLowerCase() || ""
    };
    const firstPlatform = host.dataset.defaultPlatform === "multipanel"
      ? "multipanel"
      : "ganamos";
    const accounts = [firstPlatform, firstPlatform === "ganamos" ? "multipanel" : "ganamos"]
      .flatMap((platform) => usernames[platform]
        ? [{ platform, username: usernames[platform] }]
        : []);
    return {
      accounts,
      legacyId: host.dataset.contactPhone
        ? `phone:${host.dataset.contactPhone}`
        : `accounts:${host.dataset.accounts}`
    };
  }

  function getUserAccountSettingKey(setting, { platform, username }) {
    return `userSetting:${setting}:${platform}:${encodeURIComponent(username)}`;
  }

  function getUserPreferenceKeys(preferenceId, setting, legacyKeyBuilder) {
    const accounts = Array.isArray(preferenceId?.accounts) ? preferenceId.accounts : [];
    return {
      accountKeys: accounts.map((account) => getUserAccountSettingKey(setting, account)),
      legacyKey: legacyKeyBuilder(preferenceId?.legacyId || preferenceId)
    };
  }

  async function readUserPreference(preferenceId, setting, legacyKeyBuilder, isValid, fallback) {
    const { accountKeys, legacyKey } = getUserPreferenceKeys(
      preferenceId,
      setting,
      legacyKeyBuilder
    );
    const stored = await stateStorage.get([...accountKeys, legacyKey]);
    for (const key of accountKeys) {
      if (Object.hasOwn(stored, key) && isValid(stored[key])) return stored[key];
    }
    if (Object.hasOwn(stored, legacyKey) && isValid(stored[legacyKey])) {
      const legacyValue = stored[legacyKey];
      if (accountKeys.length) {
        void stateStorage.set(Object.fromEntries(accountKeys.map((key) => [key, legacyValue])))
          .catch((error) => console.error(
            `[Ganamos balance extension] No se pudo trasladar ${setting} a la configuración del usuario.`,
            error
          ));
      }
      return legacyValue;
    }
    return fallback;
  }

  async function saveUserPreference(preferenceId, setting, legacyKeyBuilder, value) {
    const { accountKeys, legacyKey } = getUserPreferenceKeys(
      preferenceId,
      setting,
      legacyKeyBuilder
    );
    const keys = accountKeys.length ? accountKeys : [legacyKey];
    await stateStorage.set(Object.fromEntries(keys.map((key) => [key, value])));
  }

  async function refreshActiveUserSettings(changes) {
    const host = document.getElementById(HOST_ID);
    if (!host || !activeAccountsKey || host.dataset.accounts !== activeAccountsKey) return;
    const preferenceId = getSportBetsPreferenceId(host);
    const settingNames = [
      "sportBetsDisabled",
      "userBonusDisabled",
      "userAccumulatesBonuses",
      "userBlocked",
      "userWithdrawalLimit",
      "userRelatedContacts"
    ];
    const relevantKeys = settingNames.flatMap((setting) =>
      preferenceId.accounts.map((account) => getUserAccountSettingKey(setting, account))
    );
    if (!relevantKeys.some((key) => Object.hasOwn(changes, key))) return;

    const accountsKey = host.dataset.accounts;
    const [
      sportBetsDisabled,
      bonusDisabled,
      accumulatesBonuses,
      blocked,
      withdrawalLimit,
      relatedContacts
    ] =
      await Promise.all([
        readSportBetsDisabled(preferenceId),
        readUserBonusDisabled(preferenceId),
        readUserAccumulatesBonuses(preferenceId),
        readUserBlocked(preferenceId),
        readUserWithdrawalLimit(preferenceId),
        readUserRelatedContacts(preferenceId)
      ]);
    if (host.dataset.accounts !== accountsKey || activeAccountsKey !== accountsKey) return;

    host.sportBetsDisabled = sportBetsDisabled;
    host.dataset.bonusDisabled = String(bonusDisabled);
    host.dataset.accumulatesBonuses = String(accumulatesBonuses);
    host.dataset.withdrawalLimit = String(withdrawalLimit);
    host.dataset.relatedContacts = relatedContacts;
    updateUserBonusDisabledPresentation(host, bonusDisabled);
    updateUserAccumulatesBonusesPresentation(host, accumulatesBonuses);
    updateRelatedContactsIndicator(findContactTitle());
    updateWithdrawalLimitIndicator(findContactTitle());

    const root = host.shadowRoot;
    const sportBetsInput = root.querySelector(
      'input[aria-label="Desactivar detección de apuestas deportivas"]'
    );
    const bonusDisabledInput = root.querySelector('input[aria-label="Bono Desactivado"]');
    const accumulatesBonusesInput = root.querySelector('input[aria-label="Acumula bonos"]');
    const blockedInput = root.querySelector('input[aria-label="Bloqueado"]');
    const withdrawalLimitInput = root.querySelector('input[aria-label="Monto máximo de retiro"]');
    const relatedContactsInput = root.querySelector(
      'textarea[aria-label="Contactos relacionados, separados por /"]'
    );
    if (sportBetsInput) sportBetsInput.checked = sportBetsDisabled;
    if (bonusDisabledInput) bonusDisabledInput.checked = bonusDisabled;
    if (accumulatesBonusesInput) accumulatesBonusesInput.checked = accumulatesBonuses;
    if (blockedInput) blockedInput.checked = blocked;
    if (withdrawalLimitInput) {
      withdrawalLimitInput.value = formatBalance(withdrawalLimit);
      withdrawalLimitInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (relatedContactsInput) relatedContactsInput.value = relatedContacts;

    const userAccounts = [
      ["ganamos", host.dataset.username],
      ["multipanel", host.dataset.multipanelUsername]
    ].filter(([, username]) => username);
    if (sportBetsDisabled) {
      host.sportBetsStates = {};
      renderSportBetsCount(host);
      renderBalanceRows(host, userAccounts);
      updateSportBetsIndicator(findContactTitle(), false);
    } else if (userAccounts.length) {
      host.sportBetsStates ||= {};
      for (const [platform] of userAccounts) {
        host.sportBetsStates[platform] = {
          ...host.sportBetsStates[platform],
          loading: true
        };
      }
      renderSportBetsCount(host);
      renderBalanceRows(host, userAccounts);
      await refreshSportBetsCounts(host, userAccounts, accountsKey, userAccounts);
    }
  }

  function getSportBetsDisabledKey(preferenceId) {
    return `${SPORT_BETS_DISABLED_USERS_KEY}:${encodeURIComponent(preferenceId)}`;
  }

  function getUserBonusDisabledKey(preferenceId) {
    return `${USER_BONUS_DISABLED_KEY}:${encodeURIComponent(preferenceId)}`;
  }

  function getUserAccumulatesBonusesKey(preferenceId) {
    return `${USER_ACCUMULATES_BONUSES_KEY}:${encodeURIComponent(preferenceId)}`;
  }

  function getUserWithdrawalLimitKey(preferenceId) {
    return `${USER_WITHDRAWAL_LIMIT_KEY}:${encodeURIComponent(preferenceId)}`;
  }

  function getUserRelatedContactsKey(preferenceId) {
    return `${USER_RELATED_CONTACTS_KEY}:${encodeURIComponent(preferenceId)}`;
  }

  async function readSportBetsDisabled(preferenceId) {
    return readUserPreference(
      preferenceId,
      "sportBetsDisabled",
      getSportBetsDisabledKey,
      (value) => typeof value === "boolean",
      false
    );
  }

  async function saveSportBetsDisabled(preferenceId, disabled) {
    await saveUserPreference(
      preferenceId,
      "sportBetsDisabled",
      getSportBetsDisabledKey,
      disabled
    );
  }

  async function readUserBonusDisabled(preferenceId) {
    return readUserPreference(
      preferenceId,
      "userBonusDisabled",
      getUserBonusDisabledKey,
      (value) => typeof value === "boolean",
      false
    );
  }

  async function saveUserBonusDisabled(preferenceId, disabled) {
    await saveUserPreference(
      preferenceId,
      "userBonusDisabled",
      getUserBonusDisabledKey,
      disabled
    );
  }

  function getUserAccumulatesBonusesKey(preferenceId) {
    return `${USER_ACCUMULATES_BONUSES_KEY}:${encodeURIComponent(preferenceId)}`;
  }

  async function readUserAccumulatesBonuses(preferenceId) {
    return readUserPreference(
      preferenceId,
      "userAccumulatesBonuses",
      getUserAccumulatesBonusesKey,
      (value) => typeof value === "boolean",
      false
    );
  }

  async function saveUserAccumulatesBonuses(preferenceId, enabled) {
    await saveUserPreference(
      preferenceId,
      "userAccumulatesBonuses",
      getUserAccumulatesBonusesKey,
      enabled
    );
  }

  function getUserBlockedKey(preferenceId) {
    return `${USER_BLOCKED_KEY}:${encodeURIComponent(preferenceId)}`;
  }

  async function readUserBlocked(preferenceId) {
    return readUserPreference(
      preferenceId,
      "userBlocked",
      getUserBlockedKey,
      (value) => typeof value === "boolean",
      false
    );
  }

  async function saveUserBlocked(preferenceId, blocked) {
    await saveUserPreference(
      preferenceId,
      "userBlocked",
      getUserBlockedKey,
      blocked
    );
  }

  async function readUserWithdrawalLimit(preferenceId) {
    return readUserPreference(
      preferenceId,
      "userWithdrawalLimit",
      getUserWithdrawalLimitKey,
      (value) => Number.isFinite(value) && value >= 0,
      DEFAULT_WITHDRAWAL_LIMIT
    );
  }

  async function saveUserWithdrawalLimit(preferenceId, value) {
    await saveUserPreference(
      preferenceId,
      "userWithdrawalLimit",
      getUserWithdrawalLimitKey,
      value
    );
  }

  async function readUserRelatedContacts(preferenceId) {
    return readUserPreference(
      preferenceId,
      "userRelatedContacts",
      getUserRelatedContactsKey,
      (value) => typeof value === "string",
      ""
    );
  }

  async function saveUserRelatedContacts(preferenceId, value) {
    const cleaned = typeof value === "string" ? value.trim() : "";
    await saveUserPreference(
      preferenceId,
      "userRelatedContacts",
      getUserRelatedContactsKey,
      cleaned
    );
  }

  function getContactVisualTagIdentities(usernames, phone, label) {
    const normalizedUsernames = {
      ganamos: typeof usernames?.ganamos === "string" ? usernames.ganamos.toLowerCase() : "",
      multipanel: typeof usernames?.multipanel === "string" ? usernames.multipanel.toLowerCase() : ""
    };
    const accountIdentities = Object.values(normalizedUsernames)
      .filter(Boolean)
      .map((username) => `account:${username}`);
    if (accountIdentities.length) {
      return [
        ...accountIdentities,
        `accounts:${normalizedUsernames.ganamos}|${normalizedUsernames.multipanel}`
      ];
    }
    const normalizedLabel = typeof label === "string"
      ? label.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim().toLowerCase()
      : "";
    const labelPhone = normalizedLabel.match(/^\+?[\d\s().-]{4,}$/)?.[0].replace(/\D/g, "");
    if (labelPhone && /^\d{4,20}$/.test(labelPhone)) return [`phone:${labelPhone}`];
    if (normalizedLabel) return [`label:${normalizedLabel}`];
    if (typeof phone === "string" && /^\d{4,20}$/.test(phone)) return [`phone:${phone}`];
    return [];
  }

  function getHostContactVisualTagIdentities(host) {
    return getContactVisualTagIdentities({
      ganamos: host.dataset.username,
      multipanel: host.dataset.multipanelUsername
    }, host.dataset.contactPhone, findContactTitle()?.textContent);
  }

  function getActiveContactVisualTagIdentities() {
    const host = document.getElementById(HOST_ID);
    if (!host || !activeAccountsKey || host.dataset.accounts !== activeAccountsKey) return null;
    return getHostContactVisualTagIdentities(host);
  }

  function getContactVisualTags(identities, tagsByIdentity = contactVisualTags) {
    const merged = identities.reduce((result, identity) => {
      const tags = tagsByIdentity[identity];
      if (tags?.highDepositor) result.highDepositor = true;
      if (tags?.scammer) result.scammer = true;
      return result;
    }, { highDepositor: false, scammer: false });
    const usernames = new Set(identities
      .filter((identity) => identity.startsWith("account:"))
      .map((identity) => identity.slice("account:".length)));
    for (const [identity, tags] of Object.entries(tagsByIdentity)) {
      if (!identity.startsWith("accounts:")) continue;
      const legacyUsernames = identity.slice("accounts:".length).split("|");
      if (!legacyUsernames.some((username) => usernames.has(username))) continue;
      if (tags.highDepositor) merged.highDepositor = true;
      if (tags.scammer) merged.scammer = true;
    }
    return merged;
  }

  function normalizeContactVisualTags(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const normalized = {};
    for (const [identity, tags] of Object.entries(value)) {
      if (!tags || typeof tags !== "object" || Array.isArray(tags)) continue;
      const cleanTags = {
        highDepositor: tags.highDepositor === true,
        scammer: tags.scammer === true
      };
      if (cleanTags.highDepositor || cleanTags.scammer) normalized[identity] = cleanTags;
    }
    return normalized;
  }

  function updateContactUserSearchBlockedIndicators(root) {
    if (!root) return;
    for (const usernameButton of root.querySelectorAll(".contact-user-search-name")) {
      const displayUsername = usernameButton.textContent.trim();
      const username = displayUsername.toLowerCase();
      const platform = usernameButton.dataset.platform;
      const settingKey = getUserAccountSettingKey("userBlocked", { platform, username });
      const isBlocked = blockedUserAccountSettings.has(settingKey);
      const platformName = platform === "ganamos" ? "Ganamos" : "MultiPanel";
      usernameButton.dataset.blocked = String(isBlocked);
      usernameButton.setAttribute(
        "aria-label",
        `${platformName}: ${displayUsername}${isBlocked ? ", marcado como Bloqueado" : ""}`
      );
      usernameButton.title = isBlocked ? `${displayUsername} — Bloqueado` : displayUsername;
    }
  }

  function loadContactVisualTags() {
    if (!contactVisualTagsLoadPromise) {
      contactVisualTagsLoadPromise = stateStorage.get(CONTACT_VISUAL_TAGS_KEY)
        .then((stored) => {
          contactVisualTags = normalizeContactVisualTags(stored[CONTACT_VISUAL_TAGS_KEY]);
          scheduleContactTagScan();
          return contactVisualTags;
        })
        .catch((error) => {
          console.error("[Ganamos balance extension] No se pudieron cargar las marcas de contactos.", error);
          return contactVisualTags;
        });
    }
    return contactVisualTagsLoadPromise;
  }

  function saveContactVisualTag(identities, tag, enabled) {
    const save = async () => {
      const stored = await stateStorage.get(CONTACT_VISUAL_TAGS_KEY);
      const nextTags = normalizeContactVisualTags(stored[CONTACT_VISUAL_TAGS_KEY]);
      for (const identity of identities) {
        const contactTags = { ...(nextTags[identity] || {}) };
        if (enabled) contactTags[tag] = true;
        else delete contactTags[tag];
        if (contactTags.highDepositor || contactTags.scammer) nextTags[identity] = contactTags;
        else delete nextTags[identity];
      }
      await stateStorage.set({ [CONTACT_VISUAL_TAGS_KEY]: nextTags });
      contactVisualTags = normalizeContactVisualTags(nextTags);
      scheduleContactTagScan();
    };
    contactVisualTagSaveQueue = contactVisualTagSaveQueue.then(save, save);
    return contactVisualTagSaveQueue;
  }

  function getLegacyMovementContactKeys(contactKey) {
    try {
      const contact = JSON.parse(contactKey);
      if (!contact || typeof contact !== "object" || !contact.usernames) return [];
      const usernames = [...new Set([
        contact.usernames.ganamos,
        contact.usernames.multipanel
      ].filter((username) => typeof username === "string" && username))];
      const assignments = [];
      for (const username of usernames) {
        assignments.push({ ganamos: username, multipanel: null });
        assignments.push({ ganamos: null, multipanel: username });
      }
      if (usernames.length > 1) {
        assignments.push({ ganamos: usernames[0], multipanel: usernames[1] });
        assignments.push({ ganamos: usernames[1], multipanel: usernames[0] });
      }
      const phones = [...new Set([
        typeof contact.phone === "string" && /^\d{4,20}$/.test(contact.phone)
          ? contact.phone
          : null,
        null
      ])];
      return [...new Set(phones.flatMap((phone) =>
        assignments.flatMap((assignment) =>
          [null, "ganamos", "multipanel"].map((firstPlatform) => JSON.stringify({
            usernames: { ...assignment, firstPlatform },
            phone
          })))))];
    } catch {
      return [];
    }
  }

  function getMovementAccountFilter(contactKey) {
    const accountIds = getMovementAccountIds(contactKey);
    const legacyContactKeys = getLegacyMovementContactKeys(contactKey);
    if (!legacyContactKeys.length) return { contactKey };
    let usernames;
    try {
      usernames = JSON.parse(contactKey)?.usernames;
    } catch {
      usernames = null;
    }
    return {
      ...(accountIds.length ? { accountIds } : {}),
      legacyContactKeys,
      ...(typeof usernames?.ganamos === "string" && usernames.ganamos
        ? { ganamosUsername: usernames.ganamos }
        : {}),
      ...(typeof usernames?.multipanel === "string" && usernames.multipanel
        ? { multipanelUsername: usernames.multipanel }
        : {})
    };
  }

  function getUnscheduledContactDigits(contactName) {
    return contactName.replace(/[\u200e\u200f\u202a-\u202e]/g, "").match(/\d{4}/)?.[0] || null;
  }

  function positionHost(host, title) {
    const chat = title?.closest("#main") || document.querySelector("#main");
    if (!chat) return;
    const chatRect = chat.getBoundingClientRect();
    const headerRect = title?.closest("header")?.getBoundingClientRect() ||
      chat.querySelector("header")?.getBoundingClientRect();
    const width = Math.max(0, chatRect.width - 16);
    if (!width) return;

    host.style.left = `${chatRect.left + 8}px`;
    host.style.top = `${Math.max(chatRect.top + 8, (headerRect?.bottom ?? chatRect.top) + 40)}px`;
    host.style.width = `${width}px`;
  }

  function formatCompactWithdrawalLimit(amount) {
    return amount >= 1000
      ? `${formatBalance(Math.round(amount / 1000))}K`
      : formatBalance(amount);
  }

  function getContactIndicatorsContainer(panel) {
    let container = panel?.querySelector(".contact-indicators");
    if (!container && panel) {
      container = document.createElement("div");
      container.className = "contact-indicators";
      panel.append(container);
    }
    return container;
  }

  function updateWithdrawalLimitIndicator() {
    const host = document.getElementById(HOST_ID);
    const indicator = host?.shadowRoot?.querySelector(".withdrawal-limit-inline");
    const storedAmount = host?.dataset.withdrawalLimit;
    const isLoading = storedAmount == null || storedAmount === "";
    const amount = Number(storedAmount);
    if (!indicator) return;
    if (isLoading) {
      indicator.textContent = "";
      indicator.hidden = true;
      return;
    }
    indicator.textContent = Number.isFinite(amount) && amount >= 0
      ? formatCompactWithdrawalLimit(amount)
      : "";
    indicator.title = Number.isFinite(amount) && amount >= 0
      ? `Monto máximo de retiro: $${formatBalance(amount)}`
      : "Monto máximo de retiro no disponible";
    if (Number.isFinite(amount) && amount >= 0 && amount !== DEFAULT_WITHDRAWAL_LIMIT) {
      indicator.dataset.comparison = amount < DEFAULT_WITHDRAWAL_LIMIT ? "below" : "above";
    } else {
      delete indicator.dataset.comparison;
    }
    const informationButton = host.shadowRoot.querySelector(".user-information-button");
    const exchangeButton = host.shadowRoot.querySelector(".exchange-button");
    indicator.hidden = !host.dataset.accounts || Boolean(informationButton?.hidden) ||
      !Number.isFinite(amount) || amount < 0;
    indicator.style.left = `${exchangeButton && !exchangeButton.hidden ? 75 : 42}px`;
  }

  function updateRelatedContactsIndicator(title) {
    const host = document.getElementById(HOST_ID);
    const panel = host?.shadowRoot?.querySelector(".panel");
    const container = getContactIndicatorsContainer(panel);
    if (!container) return;
    let indicator = container.querySelector(".related-contacts-indicator");
    const relatedContacts = host?.dataset.relatedContacts?.trim() || "";
    const hasRelatedContacts = relatedContacts.split("/").some((contact) => contact.trim());

    if (!indicator && hasRelatedContacts) {
      indicator = document.createElement("div");
      indicator.className = "related-contacts-indicator";
      indicator.setAttribute("role", "group");
      indicator.tabIndex = 0;
      indicator.setAttribute("aria-label", "Contactos relacionados");
      const symbol = document.createElement("span");
      symbol.className = "related-contacts-indicator__symbol";
      symbol.textContent = "↔️";
      symbol.setAttribute("aria-hidden", "true");
      const popover = document.createElement("div");
      popover.className = "related-contacts-popover";
      popover.setAttribute("role", "group");
      popover.setAttribute("aria-label", "Copiar un contacto relacionado");
      indicator.append(symbol, popover);
    }

    const ball = container.querySelector(".sport-bets-indicator");
    if (indicator) {
      indicator.hidden = !title || !hasRelatedContacts;
      indicator.setAttribute("aria-label", "Contactos relacionados");
      const popover = indicator.querySelector(".related-contacts-popover");
      popover.replaceChildren();
      for (const contact of relatedContacts.split("/").map((value) => value.trim()).filter(Boolean)) {
        const copyContact = document.createElement("button");
        copyContact.type = "button";
        copyContact.className = "related-contact-copy";
        copyContact.setAttribute("role", "listitem");
        copyContact.textContent = contact;
        copyContact.title = `Copiar ${contact}`;
        copyContact.setAttribute("aria-label", `Copiar contacto ${contact}`);
        copyContact.addEventListener("click", async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(contact);
            showToast(
              host,
              host.dataset.username || host.dataset.multipanelUsername || "Chat",
              `Copiado: ${contact}`,
              "success",
              `related-contact:${host.dataset.accounts}:${contact}`
            );
          } catch (error) {
            console.error("[Ganamos balance extension] No se pudo copiar un contacto relacionado.", error);
            showToast(
              host,
              host.dataset.username || host.dataset.multipanelUsername || "Chat",
              `No se pudo copiar ${contact}.`,
              "error",
              `related-contact:${host.dataset.accounts}:${contact}`
            );
          }
        });
        popover.append(copyContact);
      }
      if (indicator.parentElement !== container) container.insertBefore(indicator, ball || null);
      else if (ball && indicator.nextElementSibling !== ball) container.insertBefore(indicator, ball);
    }

    const hasVisibleIndicator = Boolean(indicator && !indicator.hidden);
    const hasVisibleBall = Boolean(ball && !ball.hidden);
    container.hidden = !title || (!hasVisibleIndicator && !hasVisibleBall);
    if (container.hidden) return;

    const chat = title.closest("#main") || document.querySelector("#main");
    const footer = chat?.querySelector("footer");
    if (!footer || !isVisible(footer)) {
      container.hidden = true;
      return;
    }
    const footerRect = footer.getBoundingClientRect();
    if (footerRect.width <= 0 || footerRect.height <= 0) {
      container.hidden = true;
      return;
    }
    container.style.left = `${footerRect.left + 12}px`;
    container.style.top = `${footerRect.top - 12}px`;
  }

  function ensureContactVisualTagStyles() {
    if (document.getElementById("ganamos-contact-visual-tag-styles")) return;
    const stylesheet = document.createElement("link");
    stylesheet.id = "ganamos-contact-visual-tag-styles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/contact-tags.css");
    (document.head || document.documentElement).append(stylesheet);
  }

  function getSidebarPlatformUsernames(row) {
    const titleElements = [...row.querySelectorAll(
      '[data-testid="cell-frame-title"], [data-testid="cell-frame-title"] [title], span[title]'
    )];
    const labels = [
      ...titleElements.flatMap((element) => [
        element.getAttribute("title") || "",
        element.textContent || ""
      ]),
      row.getAttribute("aria-label") || "",
      row.textContent || ""
    ];
    let bestMatch = { ganamos: null, multipanel: null, legacy: {}, firstPlatform: null };
    let bestScore = 0;
    for (const label of labels) {
      const usernames = findPlatformUsernames(label);
      const score = Number(Boolean(usernames.ganamos)) +
        Number(Boolean(usernames.multipanel));
      if (score > bestScore) {
        bestMatch = usernames;
        bestScore = score;
      }
      if (score === 2) break;
    }
    return bestMatch;
  }

  function getSidebarContactIdentity(row) {
    const usernames = getSidebarPlatformUsernames(row);
    const titleElement = row.querySelector('[data-testid="cell-frame-title"]');
    const label = titleElement?.getAttribute("title") || titleElement?.textContent ||
      row.getAttribute("aria-label") || "";
    const dataIds = [row, ...row.querySelectorAll("[data-id]")]
      .map((element) => element.getAttribute("data-id") || "");
    const phone = dataIds.map((value) =>
      value.match(/(\d{4,20})@(?:c\.us|s\.whatsapp\.net)/i)?.[1])
      .find(Boolean) || label.replace(/[\u200e\u200f\u202a-\u202e]/g, "")
        .match(/^\+?[\d\s().-]{4,}$/)?.[0]?.replace(/\D/g, "");
    return getContactVisualTagIdentities(usernames, phone, label);
  }

  function getSidebarBlockedSettingKeys(row) {
    return Object.entries(getSidebarPlatformUsernames(row))
      .filter(([platform, username]) =>
        ["ganamos", "multipanel"].includes(platform) && username)
      .map(([platform, username]) => getUserAccountSettingKey(
        "userBlocked",
        { platform, username: username.toLowerCase() }
      ));
  }

  function getSidebarBonusDisabledSettingKeys(row) {
    return Object.entries(getSidebarPlatformUsernames(row))
      .filter(([platform, username]) =>
        ["ganamos", "multipanel"].includes(platform) && username)
      .map(([platform, username]) => getUserAccountSettingKey(
        "userBonusDisabled",
        { platform, username: username.toLowerCase() }
      ));
  }

  function updateContactSidebarTags() {
    ensureContactVisualTagStyles();
    const sidebar = document.querySelector("#pane-side");
    if (!sidebar) return;
    let rows = [...sidebar.querySelectorAll('[role="row"][data-testid^="list-item-"]')];
    if (!rows.length) rows = [...sidebar.querySelectorAll('[data-testid="cell-frame-container"]')];
    if (!rows.length) rows = [...sidebar.querySelectorAll('[role="listitem"]')];
    const activeIdentities = getActiveContactVisualTagIdentities() || [];
    const blockedSettingsToLoad = new Set();
    const bonusDisabledSettingsToLoad = new Set();
    for (const row of rows) {
      const identities = getSidebarContactIdentity(row);
      const blockedSettingKeys = getSidebarBlockedSettingKeys(row);
      const bonusDisabledSettingKeys = getSidebarBonusDisabledSettingKeys(row);
      for (const key of blockedSettingKeys) {
        if (!loadedBlockedUserAccountSettings.has(key) &&
          !pendingBlockedUserAccountSettings.has(key)) {
          blockedSettingsToLoad.add(key);
        }
      }
      for (const key of bonusDisabledSettingKeys) {
        if (!loadedBonusDisabledUserAccountSettings.has(key) &&
          !pendingBonusDisabledUserAccountSettings.has(key)) {
          bonusDisabledSettingsToLoad.add(key);
        }
      }
      const tags = getContactVisualTags(identities);
      const tag = tags?.scammer && tags?.highDepositor
        ? "high-depositor-and-scammer"
        : tags?.scammer
          ? "scammer"
          : tags?.highDepositor
            ? "high-depositor"
            : null;
      const ariaSelected = row.matches('[aria-selected="true"]') ||
        Boolean(row.querySelector('[aria-selected="true"]'));
      const visualCell = row.matches('[data-testid="cell-frame-container"]')
        ? row
        : row.querySelector('[data-testid="cell-frame-container"]') || row;
      row.removeAttribute("data-extension-contact-tag");
      row.removeAttribute("data-extension-contact-active");
      const isBlocked = blockedSettingKeys.some((key) =>
        blockedUserAccountSettings.has(key));
      const isBonusDisabled = bonusDisabledSettingKeys.some((key) =>
        bonusDisabledUserAccountSettings.has(key));
      const visualTags = [
        tag,
        isBlocked ? "blocked" : null,
        isBonusDisabled ? "bonus-disabled" : null
      ].filter(Boolean);
      visualCell.toggleAttribute("data-extension-user-blocked", isBlocked);
      visualCell.toggleAttribute("data-extension-bonus-disabled", isBonusDisabled);
      if (visualTags.length) {
        visualCell.setAttribute("data-extension-contact-tag", visualTags.join(" "));
        visualCell.toggleAttribute(
          "data-extension-contact-active",
          Boolean(tag) &&
            (identities.some((identity) => activeIdentities.includes(identity)) || ariaSelected)
        );
      } else {
        visualCell.removeAttribute("data-extension-contact-tag");
        visualCell.removeAttribute("data-extension-contact-active");
      }
    }
    if (blockedSettingsToLoad.size) {
      const keys = [...blockedSettingsToLoad];
      for (const key of keys) pendingBlockedUserAccountSettings.add(key);
      void stateStorage.get(keys)
        .then((stored) => {
          for (const key of keys) {
            loadedBlockedUserAccountSettings.add(key);
            if (stored[key] === true) blockedUserAccountSettings.add(key);
            else blockedUserAccountSettings.delete(key);
          }
          scheduleContactTagScan();
        })
        .catch((error) => console.error(
          "[Ganamos balance extension] No se pudo cargar la marca Bloqueado de los chats visibles.",
          error
        ))
        .finally(() => {
          for (const key of keys) pendingBlockedUserAccountSettings.delete(key);
        });
    }
    if (bonusDisabledSettingsToLoad.size) {
      const keys = [...bonusDisabledSettingsToLoad];
      for (const key of keys) pendingBonusDisabledUserAccountSettings.add(key);
      void stateStorage.get(keys)
        .then((stored) => {
          for (const key of keys) {
            loadedBonusDisabledUserAccountSettings.add(key);
            if (stored[key] === true) bonusDisabledUserAccountSettings.add(key);
            else bonusDisabledUserAccountSettings.delete(key);
          }
          scheduleContactTagScan();
        })
        .catch((error) => console.error(
          "[Ganamos balance extension] No se pudo cargar la marca Bonos Desactivados de los chats visibles.",
          error
        ))
        .finally(() => {
          for (const key of keys) pendingBonusDisabledUserAccountSettings.delete(key);
        });
    }
  }

  function scheduleContactTagScan() {
    if (contactTagScanScheduled) return;
    contactTagScanScheduled = true;
    requestAnimationFrame(() => {
      contactTagScanScheduled = false;
      updateContactSidebarTags();
    });
  }

  function nodeTouchesSidebar(node) {
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element && (
      element.closest("#pane-side") ||
      element.matches("#pane-side") ||
      element.querySelector("#pane-side")
    ));
  }

  function updateSportBetsIndicator(title, visible) {
    const host = document.getElementById(HOST_ID);
    const panel = host?.shadowRoot?.querySelector(".panel");
    const container = getContactIndicatorsContainer(panel);
    let ball = container?.querySelector(".sport-bets-indicator");
    if (!visible || !title) {
      if (ball) ball.hidden = true;
      updateRelatedContactsIndicator(title);
      updateWithdrawalLimitIndicator(title);
      return;
    }

    const chat = title.closest("#main") || document.querySelector("#main");
    const footer = chat?.querySelector("footer");
    if (!footer || !isVisible(footer)) {
      if (ball) ball.hidden = true;
      updateRelatedContactsIndicator(title);
      updateWithdrawalLimitIndicator(title);
      return;
    }

    const footerRect = footer.getBoundingClientRect();
    if (footerRect.width <= 0 || footerRect.height <= 0) {
      if (ball) ball.hidden = true;
      updateRelatedContactsIndicator(title);
      updateWithdrawalLimitIndicator(title);
      return;
    }

    if (!ball && container) {
      ball = document.createElement("span");
      ball.className = "sport-bets-indicator";
      ball.textContent = "⚽";
      ball.setAttribute("role", "img");
      ball.setAttribute("aria-label", "Este usuario usa apuestas deportivas");
      ball.title = "Este usuario usa apuestas deportivas";
      container.append(ball);
    }
    if (!ball) {
      updateRelatedContactsIndicator(title);
      return;
    }

    ball.hidden = false;
    updateRelatedContactsIndicator(title);
    updateWithdrawalLimitIndicator(title);
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

  function reportAgentBalanceError(platform, message) {
    if (agentBalanceToastErrors[platform] === message) return;
    agentBalanceToastErrors[platform] = message;
    showToast(
      null,
      platform === "ganamos" ? "Ganamos" : "MultiPanel",
      message,
      "error",
      `agent-balance:${platform}`
    );
  }

  function clearAgentBalanceErrorToast(platform) {
    delete agentBalanceToastErrors[platform];
    dismissToast(`agent-balance:${platform}`);
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

  function isValidBonusPercent(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  }

  function validateMysteriousBonusOutcomes(outcomes) {
    if (!Array.isArray(outcomes) || outcomes.length === 0) return false;
    const seenPercentages = new Set();
    let totalWeight = 0;
    for (const outcome of outcomes) {
      if (!outcome || !isValidBonusPercent(outcome.percent) ||
        !Number.isSafeInteger(outcome.weight) || outcome.weight < 0 ||
        seenPercentages.has(outcome.percent)) return false;
      seenPercentages.add(outcome.percent);
      totalWeight += outcome.weight;
      if (!Number.isSafeInteger(totalWeight)) return false;
    }
    return totalWeight > 0;
  }

  function validateActiveBonusConfig(config) {
    if (!config || typeof config !== "object" ||
      typeof config.enabled !== "boolean" || !ACTIVE_BONUS_TYPES.includes(config.type)) return null;
    if (config.copyBonus !== undefined && typeof config.copyBonus !== "boolean") return null;
    if (config.invertDepositButtons !== undefined &&
      typeof config.invertDepositButtons !== "boolean") return null;
    if (config.activeAdvertising !== undefined &&
      typeof config.activeAdvertising !== "boolean") return null;
    if (config.markUnreadAfterStatusUpdate !== undefined &&
      typeof config.markUnreadAfterStatusUpdate !== "boolean") return null;
    if (config.advertisingPercent !== undefined &&
      config.advertisingPercent !== null &&
      !isValidBonusPercent(config.advertisingPercent)) return null;
    if (config.type === "none") return config;
    const isPercentValid = (value) => value === null || isValidBonusPercent(value);
    const isConfiguredPercent = (value) =>
      isPercentValid(value) && (!config.enabled || isValidBonusPercent(value));
    if (config.type === "simple" && isConfiguredPercent(config.percent)) return config;
    if (config.type === "double" &&
      isConfiguredPercent(config.ganamos) && isConfiguredPercent(config.multipanel)) return config;
    if (config.type === "specific" && ["ganamos", "multipanel"].includes(config.platform) &&
      isConfiguredPercent(config.percent)) return config;
    if (config.type === "special" &&
      isConfiguredPercent(config.underThreshold) && isConfiguredPercent(config.overThreshold)) return config;
    if (config.type === "mysterious" &&
      (config.outcomes === undefined || validateMysteriousBonusOutcomes(config.outcomes))) return config;
    return null;
  }

  async function readActiveBonusConfig() {
    const stored = await stateStorage.get(ACTIVE_BONUS_CONFIG_KEY);
    const config = stored[ACTIVE_BONUS_CONFIG_KEY];
    if (config == null) return null;
    const validated = validateActiveBonusConfig(config);
    if (!validated) throw new Error("La configuración del bono activo no es válida.");
    const requiredKeys = {
      none: [],
      simple: ["percent"],
      double: ["ganamos", "multipanel"],
      specific: ["percent"],
      special: ["underThreshold", "overThreshold"],
      mysterious: []
    }[validated.type];
    const hasRequiredPercents = requiredKeys.every((key) =>
      isValidBonusPercent(validated[key]));
    return {
      ...validated,
      enabled: validated.type !== "none" && (validated.enabled || hasRequiredPercents)
    };
  }

  function getMysteriousBonusOutcomes(config) {
    return Array.isArray(config?.outcomes)
      ? config.outcomes
      : MYSTERIOUS_BONUS_WEIGHTS.map(([percent, weight]) => ({ percent, weight }));
  }

  function chooseMysteriousBonusPercent(config) {
    const outcomes = getMysteriousBonusOutcomes(config);
    const totalWeight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
    const roll = Math.random() * totalWeight;
    let cumulativeWeight = 0;
    for (const outcome of outcomes) {
      cumulativeWeight += outcome.weight;
      if (roll < cumulativeWeight) return outcome.percent;
    }
    for (let index = outcomes.length - 1; index >= 0; index -= 1) {
      if (outcomes[index].weight > 0) return outcomes[index].percent;
    }
    throw new Error("El sorteo misterioso no tiene pesos válidos.");
  }

  function createAmountShortcuts(input) {
    const shortcuts = document.createElement("div");
    shortcuts.className = "amount-shortcuts amount-shortcuts--amount";
    shortcuts.setAttribute("role", "group");
    shortcuts.setAttribute("aria-label", "Sumar un monto rápido");
    const amounts = [
      [500, "$500"],
      [1000, "$1.000"],
      [2500, "$2.500"],
      [3000, "$3.000"],
      [5000, "$5.000"],
      [10000, "$10.000"],
      [20000, "$20.000"]
    ];
    for (const [shortcutAmount, label] of amounts) {
      const button = document.createElement("button");
      button.type = "button";
      const buttonLabel = document.createElement("span");
      buttonLabel.textContent = label;
      button.append(buttonLabel);
      button.setAttribute("aria-label", `Sumar $${formatBalance(shortcutAmount)} al monto`);
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

  function createPercentageShortcuts(input, getActiveBonusPercent = () => null) {
    const shortcuts = document.createElement("div");
    shortcuts.className = "amount-shortcuts";
    shortcuts.setAttribute("role", "group");
    shortcuts.setAttribute("aria-label", "Elegir porcentaje de bono");
    const presetPercentages = [20, 30, 40, 50, 60];
    const activeBonusButton = document.createElement("button");
    activeBonusButton.type = "button";
    activeBonusButton.dataset.activeBonus = "true";
    const activeBonusLabel = document.createElement("span");
    activeBonusButton.append(activeBonusLabel);
    const activeBonusSeparator = document.createElement("span");
    activeBonusSeparator.className = "amount-shortcuts__separator";
    activeBonusSeparator.setAttribute("aria-hidden", "true");
    const updateSelection = () => {
      const selectedPercentage = numericInputValue(input);
      const activeBonusPercent = getActiveBonusPercent();
      const showActiveBonus = activeBonusPercent != null &&
        !presetPercentages.includes(activeBonusPercent);
      shortcuts.classList.toggle("amount-shortcuts--with-active-bonus", showActiveBonus);
      if (showActiveBonus) {
        const label = `${formatBalance(activeBonusPercent)}%`;
        activeBonusButton.dataset.percentage = String(activeBonusPercent);
        activeBonusLabel.textContent = label;
        activeBonusButton.setAttribute("aria-label", `Usar ${label} del bono activo`);
        if (!shortcuts.contains(activeBonusButton)) {
          shortcuts.append(activeBonusSeparator, activeBonusButton);
        }
      } else {
        activeBonusSeparator.remove();
        activeBonusButton.remove();
      }
      for (const button of shortcuts.querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(Number(button.dataset.percentage) === selectedPercentage));
      }
    };
    for (const percentage of presetPercentages) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.percentage = String(percentage);
      const buttonLabel = document.createElement("span");
      buttonLabel.textContent = `${percentage}%`;
      button.append(buttonLabel);
      button.setAttribute("aria-label", `Usar ${percentage}%`);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        input.value = numericInputValue(input) === percentage ? "" : String(percentage);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
      shortcuts.append(button);
    }
    activeBonusButton.addEventListener("click", () => {
      const activeBonusPercent = Number(activeBonusButton.dataset.percentage);
      input.value = numericInputValue(input) === activeBonusPercent ? "" : String(activeBonusPercent);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    input.addEventListener("input", updateSelection);
    return { element: shortcuts, updateSelection };
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

  function hasConfiguredRemoteDestinations() {
    return remoteCreateDestinations.some((destination) =>
      typeof destination?.id === "string" && typeof destination.name === "string");
  }

  function normalizeContactFlowCounters(value) {
    const counters = {
      arrived: 0,
      derived: {},
      generation: 1,
      generationStartedAt: 0,
      countedNumbers: [],
      panels: [],
      adjustmentOperations: [],
      resetOperations: []
    };
    if (!value || typeof value !== "object") return counters;
    const now = Date.now();
    const normalizeCountedNumbers = (numbers) => {
      if (!Array.isArray(numbers)) return [];
      const normalizedByNumber = new Map();
      for (const entry of numbers) {
        const number = entry?.number;
        const countedAt = entry?.countedAt;
        if (typeof number !== "string" || !/^\d{7,20}$/.test(number) ||
          !Number.isSafeInteger(countedAt) || countedAt <= 0 ||
          now - countedAt >= CONTACT_FLOW_COUNTED_NUMBER_TTL_MS) continue;
        const previousCountedAt = normalizedByNumber.get(number);
        if (previousCountedAt === undefined || countedAt > previousCountedAt) {
          normalizedByNumber.set(number, countedAt);
        }
      }
      return [...normalizedByNumber].map(([number, countedAt]) => ({ number, countedAt }));
    };
    if (Number.isSafeInteger(value.arrived) && value.arrived >= 0) {
      counters.arrived = value.arrived;
    }
    if (Number.isSafeInteger(value.generation) && value.generation > 0) {
      counters.generation = value.generation;
    }
    if (Number.isSafeInteger(value.generationStartedAt) && value.generationStartedAt >= 0) {
      counters.generationStartedAt = value.generationStartedAt;
    }
    counters.countedNumbers = normalizeCountedNumbers(value.countedNumbers);
    if (Array.isArray(value.panels)) {
      const panelIds = new Set();
      counters.panels = value.panels.flatMap((panel) => {
        if (!panel || typeof panel !== "object" ||
          typeof panel.id !== "string" || !panel.id ||
          typeof panel.keyword !== "string" || !panel.keyword.trim() ||
          typeof panel.destinationId !== "string" || !panel.destinationId ||
          panelIds.has(panel.id)) return [];
        panelIds.add(panel.id);
        return [{
          id: panel.id,
          title: typeof panel.title === "string" && panel.title.trim()
            ? panel.title.trim()
            : panel.keyword.trim(),
          keyword: panel.keyword,
          destinationId: panel.destinationId,
          count: Number.isSafeInteger(panel.count) && panel.count >= 0 ? panel.count : 0,
          countedNumbers: normalizeCountedNumbers(panel.countedNumbers)
        }];
      });
    }
    if (value.derived && typeof value.derived === "object" && !Array.isArray(value.derived)) {
      for (const [destinationId, count] of Object.entries(value.derived)) {
        if (Number.isSafeInteger(count) && count >= 0) {
          counters.derived[destinationId] = count;
        }
      }
    }
    if (Array.isArray(value.adjustmentOperations)) {
      counters.adjustmentOperations = value.adjustmentOperations.filter((operation) =>
        operation && typeof operation === "object" &&
        PROFILE_ID_PATTERN.test(operation.id) &&
        (operation.target === "arrived" ||
          typeof operation.target === "string" && operation.target.startsWith("destination:")) &&
        Number.isSafeInteger(operation.delta) && operation.delta !== 0 &&
        Number.isSafeInteger(operation.generation) && operation.generation > 0
      ).map(({ id, target, delta, generation }) => ({
        id,
        target,
        delta,
        generation
      }));
    }
    if (Array.isArray(value.resetOperations)) {
      counters.resetOperations = value.resetOperations.filter((operation) =>
        operation && typeof operation === "object" &&
        PROFILE_ID_PATTERN.test(operation.id) &&
        typeof operation.clearCountedNumbers === "boolean"
      ).map(({ id, clearCountedNumbers }) => ({ id, clearCountedNumbers }));
    }
    return counters;
  }

  function pruneExpiredContactFlowNumbers(now = Date.now()) {
    let changed = false;
    const prune = (numbers) => {
      const active = numbers.filter(({ countedAt }) =>
        now - countedAt < CONTACT_FLOW_COUNTED_NUMBER_TTL_MS);
      if (active.length !== numbers.length) changed = true;
      return active;
    };
    contactFlowCounters.countedNumbers = prune(contactFlowCounters.countedNumbers);
    for (const panel of contactFlowCounters.panels) {
      panel.countedNumbers = prune(panel.countedNumbers);
    }
    return changed;
  }

  function getContactFlowCounterValue(key) {
    return key === "arrived" ? contactFlowCounters.arrived : contactFlowCounters.derived[key] || 0;
  }

  function getIncomingMessageDetails(metadataElement) {
    const metadata = metadataElement.getAttribute("data-pre-plain-text");
    const match = metadata?.match(/^\[([^\]]+)\]\s*(.*?):(?:\s|$)/);
    let isIncoming = false;
    const senderText = (match?.[2] || "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();
    const senderDigits = /^[+\d\s().-]+$/.test(senderText)
      ? senderText.replace(/\D/g, "")
      : "";
    let jidMatch = null;
    const chat = metadataElement.closest("#main");
    const chatTitle = chat?.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
      chat?.querySelector("header h1, header h2, header [role='heading']");
    const chatTitleText = chatTitle?.textContent
      ?.replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .trim() || "";
    const chatTitleDigits = /^[+\d\s().-]+$/.test(chatTitleText)
      ? chatTitleText.replace(/\D/g, "")
      : "";
    const normalizeIdentity = (value) => value
      .normalize("NFKC")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
    const senderMatchesChat = Boolean(senderText && (
      senderDigits && senderDigits === chatTitleDigits ||
      normalizeIdentity(senderText) === normalizeIdentity(chatTitleText)
    ));
    const messageContainer = metadataElement.closest(".message-in, .message-out");
    const nestedMessageId = messageContainer?.querySelector("[data-id]")?.getAttribute("data-id") || "";
    if (/@g\.us(?:_|$)/i.test(nestedMessageId)) return null;
    jidMatch = nestedMessageId.match(/(?:^|_)(\d{7,20})@(?:c\.us|s\.whatsapp\.net)(?:_|$)/i);
    for (let ancestor = metadataElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.classList.contains("message-out")) return null;
      if (ancestor.classList.contains("message-in")) isIncoming = true;
      const dataId = ancestor.getAttribute("data-id") || "";
      if (/@g\.us(?:_|$)/i.test(dataId)) return null;
      jidMatch ||= dataId.match(/(?:^|_)(\d{7,20})@(?:c\.us|s\.whatsapp\.net)(?:_|$)/i);
      if (ancestor.matches("#main")) break;
    }
    isIncoming ||= senderMatchesChat;
    if (!isIncoming) return null;
    const chatNumber = getPhoneFromContactTitle(chatTitle);
    const number = jidMatch?.[1] ||
      (/^\d{7,20}$/.test(senderDigits) ? senderDigits : "") ||
      (/^\d{7,20}$/.test(chatNumber || "") ? chatNumber : "");
    const timestamp = match ? parseIncomingMessageTimestamp(match[1]) : null;
    return number && timestamp ? { number, timestamp, chat } : null;
  }

  function parseIncomingMessageTimestamp(value) {
    const timeMatch = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\s*\.?\s*m\s*\.?|p\s*\.?\s*m\s*\.?)?/i);
    if (!timeMatch) return null;
    const dateMatch = value.match(/\b(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})\b/);
    const dateParts = [];
    if (dateMatch) {
      const first = Number(dateMatch[1]);
      const second = Number(dateMatch[2]);
      const third = Number(dateMatch[3]);
      const yearFirst = dateMatch[1].length === 4;
      if (yearFirst) {
        dateParts.push({ year: first, month: second, day: third });
      } else {
        let year = third;
        if (year < 100) year += year >= 70 ? 1900 : 2000;
        dateParts.push({ year, month: second, day: first });
        if (first !== second) dateParts.push({ year, month: first, day: second });
      }
    } else {
      const now = new Date();
      for (const offset of [-1, 0, 1]) {
        const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
        dateParts.push({
          year: candidate.getFullYear(),
          month: candidate.getMonth() + 1,
          day: candidate.getDate()
        });
      }
    }

    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const second = Number(timeMatch[3] || 0);
    const meridiem = timeMatch[4] || "";
    if (minute > 59 || second > 59) return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      if (/p/i.test(meridiem) && hour < 12) hour += 12;
      if (/a/i.test(meridiem) && hour === 12) hour = 0;
    } else if (hour > 23) {
      return null;
    }

    const now = Date.now();
    const candidates = dateParts
      .filter(({ year, month, day }) => month >= 1 && month <= 12 && day >= 1 && day <= 31)
      .map(({ year, month, day }) => {
        const date = new Date(year, month - 1, day, hour, minute, second);
        return date.getFullYear() === year && date.getMonth() === month - 1 &&
          date.getDate() === day
          ? date.getTime()
          : null;
      })
      .filter((timestamp) => Number.isFinite(timestamp));
    if (!candidates.length) return null;
    return candidates.reduce((closest, timestamp) =>
      Math.abs(timestamp - now) < Math.abs(closest - now) ? timestamp : closest);
  }

  function countIncomingMessageNumber(metadataElement) {
    const messageIdentity = getIncomingMessageIdentity(metadataElement);
    if (processedIncomingMessages.get(metadataElement) === messageIdentity) return;
    const details = getIncomingMessageDetails(metadataElement);
    if (!details) return;
    if (details.chat) contactFlowChatNumbers.set(details.chat, details.number);
    const now = Date.now();
    if (pruneExpiredContactFlowNumbers(now)) saveContactFlowCounters();
    if (contactFlowCounters.countedNumbers.some(({ number }) => number === details.number)) {
      processedIncomingMessages.set(metadataElement, messageIdentity);
      return;
    }
    if (now - details.timestamp > CONTACT_FLOW_MESSAGE_MAX_AGE_MS) {
      processedIncomingMessages.set(metadataElement, messageIdentity);
      return;
    }
    if (details.timestamp > now + CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS) return;
    if (contactFlowCounters.arrived >= Number.MAX_SAFE_INTEGER) {
      processedIncomingMessages.set(metadataElement, messageIdentity);
      console.error("[Ganamos balance extension] No se contó un número nuevo: el contador llegó al límite seguro.");
      return;
    }
    processedIncomingMessages.set(metadataElement, messageIdentity);
    contactFlowCounters.countedNumbers.push({ number: details.number, countedAt: now });
    saveContactFlowCounters();
  }

  function getIncomingMessageIdentity(metadataElement) {
    const messageContainer = metadataElement.closest(".message-in, .message-out");
    const chat = metadataElement.closest("#main");
    const chatTitle = chat?.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
      chat?.querySelector("header h1, header h2, header [role='heading']");
    const messageIds = [
      messageContainer?.getAttribute("data-id") || "",
      messageContainer?.querySelector("[data-id]")?.getAttribute("data-id") || ""
    ];
    return JSON.stringify([
      metadataElement.getAttribute("data-pre-plain-text") || "",
      messageIds,
      chatTitle?.textContent?.trim() || ""
    ]);
  }

  function normalizePendingWithdrawals(value) {
    if (!Array.isArray(value)) return [];
    const seenIds = new Set();
    const seenIdentities = new Set();
    return [...value].reverse().flatMap((withdrawal) => {
      const identity = typeof withdrawal?.identity === "string" && withdrawal.identity
        ? withdrawal.identity
        : typeof withdrawal?.phone === "string" && /^\d{7,20}$/.test(withdrawal.phone)
          ? `phone:${withdrawal.phone}`
          : "";
      const inferredUsernames = findPlatformUsernames(
        `${typeof withdrawal?.name === "string" ? withdrawal.name : ""} ${
          typeof withdrawal?.username === "string" ? withdrawal.username : ""
        }`
      );
      const accounts = {
        ganamos: typeof withdrawal?.accounts?.ganamos === "string"
          ? withdrawal.accounts.ganamos
          : inferredUsernames.ganamos || "",
        multipanel: typeof withdrawal?.accounts?.multipanel === "string"
          ? withdrawal.accounts.multipanel
          : inferredUsernames.multipanel || ""
      };
      const balances = Object.fromEntries(["ganamos", "multipanel"].map((platform) => {
        const state = withdrawal?.balances?.[platform];
        const amount = state && typeof state === "object"
          ? state.amount
          : state;
        return [platform, {
          amount: Number.isFinite(amount) ? amount : null,
          checked: state && typeof state === "object" && state.checked === true
        }];
      }));
      if (!withdrawal || typeof withdrawal !== "object" || Array.isArray(withdrawal) ||
        typeof withdrawal.id !== "string" || !withdrawal.id ||
        !identity ||
        !Number.isSafeInteger(withdrawal.createdAt) || withdrawal.createdAt < 0 ||
        seenIds.has(withdrawal.id) || seenIdentities.has(identity)) return [];
      seenIds.add(withdrawal.id);
      seenIdentities.add(identity);
      return [{
        id: withdrawal.id,
        identity,
        name: typeof withdrawal.name === "string" && withdrawal.name.trim()
          ? withdrawal.name.trim()
          : identity,
        accounts,
        balances,
        status: "Pendiente",
        createdAt: withdrawal.createdAt
      }];
    }).reverse();
  }

  function getPendingWithdrawalContact(chatTitleText) {
    const title = chatTitleText.trim();
    const usernames = findPlatformUsernames(title);
    const ganamos = usernames.ganamos?.toLowerCase() || "";
    const multipanel = usernames.multipanel?.toLowerCase() || "";
    const identity = ganamos || multipanel
      ? `accounts:${ganamos}|${multipanel}`
      : /^[+\d\s().-]+$/.test(title)
        ? ""
        : getContactVisualTagIdentities(null, null, title)[0];
    const displayUsernames = [
      usernames.ganamos,
      usernames.multipanel
    ].filter(Boolean);
    return {
      identity,
      name: displayUsernames.join("/") || title || identity,
      accounts: {
        ganamos: usernames.ganamos || "",
        multipanel: usernames.multipanel || ""
      },
      balances: {
        ganamos: { amount: null, checked: false },
        multipanel: { amount: null, checked: false }
      }
    };
  }

  function getPendingWithdrawalBalancesFromOpenContact(contact) {
    const host = document.getElementById(HOST_ID);
    if (!host || host.dataset.accounts !== activeAccountsKey) {
      return contact.balances;
    }
    const hostUsernames = {
      ganamos: host.dataset.username || "",
      multipanel: host.dataset.multipanelUsername || ""
    };
    const balances = { ...contact.balances };
    for (const platform of ["ganamos", "multipanel"]) {
      if (!contact.accounts[platform] ||
        hostUsernames[platform].toLowerCase() !== contact.accounts[platform].toLowerCase()) continue;
      const state = host.balanceStates?.[platform];
      const amount = parseBalance(state?.balance);
      balances[platform] = {
        amount,
        checked: amount !== null || Boolean(state?.error)
      };
    }
    return balances;
  }

  async function refreshPendingWithdrawalBalances() {
    if (!pendingWithdrawalsLoaded || !pendingWithdrawals.length ||
      pendingWithdrawalBalanceRefreshInProgress) return;
    pendingWithdrawalBalanceRefreshInProgress = true;
    let changed = false;
    try {
      await Promise.all(pendingWithdrawals.flatMap((withdrawal) =>
        ["ganamos", "multipanel"]
          .filter((platform) => Boolean(withdrawal.accounts[platform]))
          .map(async (platform) => {
            const username = withdrawal.accounts[platform];
            try {
              const response = await chrome.runtime.sendMessage({
                type: "BALANCE_REQUEST",
                data: { nombre: username, platform }
              });
              if (!response?.ok) {
                throw new Error(response?.error || "No se pudo consultar el saldo.");
              }
              const amount = parseBalance(response.balance);
              if (amount === null) throw new Error("La plataforma devolvió un saldo no válido.");
              const current = pendingWithdrawals.find(({ id }) => id === withdrawal.id);
              if (!current) return;
              current.balances[platform] = { amount, checked: true };
              changed = true;
            } catch (error) {
              console.error(
                `[Ganamos balance extension] No se pudo actualizar el saldo pendiente de ${username}.`,
                error
              );
              const current = pendingWithdrawals.find(({ id }) => id === withdrawal.id);
              if (!current) return;
              current.balances[platform] = {
                amount: current.balances[platform]?.amount ?? null,
                checked: true
              };
              changed = true;
            }
          })
      ));
      if (changed) {
        renderPendingWithdrawals();
        await savePendingWithdrawals();
      }
    } finally {
      pendingWithdrawalBalanceRefreshInProgress = false;
    }
  }

  function getPendingWithdrawalBalanceLines(withdrawal) {
    const accounts = ["ganamos", "multipanel"]
      .map((platform) => ({
        platform,
        username: withdrawal.accounts?.[platform],
        balance: withdrawal.balances?.[platform]?.amount ?? null,
        checked: withdrawal.balances?.[platform]?.checked === true
      }))
      .filter(({ username }) => username);
    if (!accounts.length) return [withdrawal.name];
    if (accounts.some(({ checked }) => !checked)) {
      return accounts.map(({ username, balance, checked }) =>
        `${username} (${balance === null ? checked ? "saldo no disponible" : "consultando saldo" : `$${formatBalance(balance)}`})`);
    }

    const aboveThreshold = accounts.filter(({ balance }) =>
      balance !== null && balance > PENDING_WITHDRAWAL_BALANCE_THRESHOLD);
    const selected = aboveThreshold.length
      ? aboveThreshold
      : accounts.filter(({ balance }) => balance !== null)
        .sort((first, second) => second.balance - first.balance)
        .slice(0, 1);
    if (selected.length) {
      return selected.map(({ username, balance }) =>
        `${username} ($${formatBalance(balance)})`);
    }
    return accounts.map(({ username }) => `${username} (saldo no disponible)`);
  }

  function getPendingWithdrawalUsername(withdrawal) {
    const usernames = ["ganamos", "multipanel"]
      .map((platform) => withdrawal.accounts?.[platform]?.trim())
      .filter(Boolean);
    return usernames.length ? usernames.join(" / ") : withdrawal.name;
  }

  function savePendingWithdrawals() {
    const snapshot = pendingWithdrawals.map((withdrawal) => ({ ...withdrawal }));
    pendingWithdrawalSaveQueue = pendingWithdrawalSaveQueue
      .then(() => stateStorage.set({ [PENDING_WITHDRAWALS_KEY]: snapshot }))
      .catch((error) => {
        console.error(
          "[Ganamos balance extension] No se pudieron guardar los retiros pendientes.",
          error
        );
        showToast(
          null,
          "Retiros pendientes",
          error.message || "No se pudieron guardar los cambios.",
          "error",
          "pending-withdrawals"
        );
        return false;
      });
    return pendingWithdrawalSaveQueue.then((result) => result !== false);
  }

  function normalizeWithdrawalMessageText(value) {
    return value.normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function trackPendingWithdrawal(details) {
    if (!pendingWithdrawalsLoaded || !details.contact.identity) return;
    const now = Date.now();
    if (now - details.timestamp > PENDING_WITHDRAWAL_MESSAGE_MAX_AGE_MS ||
      details.timestamp > now + CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS) return;
    const messageText = normalizeWithdrawalMessageText(details.text);
    if (messageText.includes("proxima victoria")) {
      const withdrawal = [...pendingWithdrawals].reverse().find(
        (pending) => pending.identity === details.contact.identity
      );
      if (withdrawal) void completePendingWithdrawal(withdrawal.id, details.timestamp);
      return;
    }
    if (!messageText.includes("muchas gracias por su paciencia") ||
      pendingWithdrawals.some((withdrawal) =>
        withdrawal.identity === details.contact.identity) ||
      pendingWithdrawals.some((withdrawal) => withdrawal.id === details.messageId)) return;
    pendingWithdrawals.push({
      id: details.messageId,
      identity: details.contact.identity,
      name: details.contact.name,
      accounts: details.contact.accounts,
      balances: getPendingWithdrawalBalancesFromOpenContact(details.contact),
      status: "Pendiente",
      createdAt: details.timestamp
    });
    renderPendingWithdrawals();
    void savePendingWithdrawals();
    void refreshPendingWithdrawalBalances();
  }

  async function completePendingWithdrawal(id, completedAt = Date.now()) {
    const withdrawal = pendingWithdrawals.find((pending) => pending.id === id);
    if (!withdrawal || pendingWithdrawalCompletions.has(id)) return;
    pendingWithdrawalCompletions.add(id);
    try {
      await stateStorage.recordWithdrawal({
        withdrawalId: withdrawal.id,
        username: getPendingWithdrawalUsername(withdrawal),
        createdAt: withdrawal.createdAt,
        completedAt
      });
      const pendingIndex = pendingWithdrawals.findIndex((pending) => pending.id === id);
      if (pendingIndex < 0) return;
      pendingWithdrawals.splice(pendingIndex, 1);
      renderPendingWithdrawals();
      await savePendingWithdrawals();
    } catch (error) {
      console.error(
        `[Ganamos balance extension] No se pudo registrar el retiro completado de ${withdrawal.name}.`,
        error
      );
      showToast(
        null,
        "Historial de retiros",
        error.message || "No se pudo registrar el retiro completado.",
        "error",
        "withdrawal-history"
      );
    } finally {
      pendingWithdrawalCompletions.delete(id);
    }
  }

  function getPendingWithdrawalAge(createdAt, now = Date.now()) {
    return `${Math.floor(Math.max(0, now - createdAt) / 60_000)}m`;
  }

  function renderPendingWithdrawals() {
    const host = document.getElementById(PENDING_WITHDRAWALS_HOST_ID);
    if (!host || !pendingWithdrawalsToggle || !pendingWithdrawalsList) return;
    const homeIntroPanel = document.querySelector('[data-testid="intro-panel"]');
    const isWhatsAppHomeView = isVisible(homeIntroPanel);
    host.style.display = pendingWithdrawalsLoaded && isWhatsAppHomeView &&
      pendingWithdrawals.length
      ? ""
      : "none";
    const count = pendingWithdrawals.length;
    const now = Date.now();
    const longestPendingAge = pendingWithdrawals.reduce(
      (longest, withdrawal) => Math.max(longest, now - withdrawal.createdAt),
      0
    );
    const longestPendingAgeLabel = pendingWithdrawals.length
      ? ` · ${Math.floor(Math.max(0, longestPendingAge) / 60_000)}m`
      : "";
    pendingWithdrawalsToggle.textContent =
      `${count} retiros pendientes${longestPendingAgeLabel}`;
    pendingWithdrawalsToggle.setAttribute("aria-expanded", String(pendingWithdrawalsExpanded));
    pendingWithdrawalsList.hidden = !pendingWithdrawalsExpanded;
    if (!pendingWithdrawalsExpanded) return;
    const signature = JSON.stringify(
      pendingWithdrawals.map(({ id, name, accounts, balances, createdAt }) =>
        [id, name, accounts, balances, getPendingWithdrawalAge(createdAt, now)])
    );
    if (signature === pendingWithdrawalsRenderedSignature) return;
    pendingWithdrawalsList.replaceChildren();
    for (const withdrawal of pendingWithdrawals) {
      const row = document.createElement("div");
      row.className = "pending-withdrawals-item";
      row.setAttribute("role", "listitem");
      const contact = document.createElement("div");
      contact.className = "pending-withdrawals-contact";
      for (const line of getPendingWithdrawalBalanceLines(withdrawal)) {
        const username = document.createElement("span");
        username.className = "pending-withdrawals-username";
        username.textContent = line;
        contact.append(username);
      }
      const age = document.createElement("span");
      age.className = "pending-withdrawals-age";
      age.textContent = getPendingWithdrawalAge(withdrawal.createdAt, now);
      age.setAttribute("aria-label", `Pendiente hace ${age.textContent}`);
      const complete = document.createElement("button");
      complete.type = "button";
      complete.className = "pending-withdrawals-complete";
      complete.title = `Marcar el retiro de ${withdrawal.name} como completado`;
      complete.setAttribute("aria-label", complete.title);
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "m5 12 4 4L19 6");
      icon.append(path);
      complete.append(icon);
      complete.addEventListener("click", () => completePendingWithdrawal(withdrawal.id));
      row.append(contact, age, complete);
      pendingWithdrawalsList.append(row);
    }
    pendingWithdrawalsRenderedSignature = signature;
  }

  function createPendingWithdrawalsPanel() {
    const host = document.createElement("div");
    host.id = PENDING_WITHDRAWALS_HOST_ID;
    host.style.display = "none";
    host.style.top = "12px";
    host.style.right = "12px";
    host.style.left = "auto";
    host.style.width = "320px";
    host.style.maxWidth = "calc(100vw - 24px)";
    host.style.maxHeight = "calc(100vh - 24px)";
    host.style.overflowY = "auto";
    const shadow = host.attachShadow({ mode: "open" });
    for (const eventName of ["click", "mousedown", "pointerdown"]) {
      shadow.addEventListener(eventName, (event) => event.stopPropagation());
    }
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/whatsapp.css");
    stylesheet.addEventListener("error", () => console.error(
      "[Ganamos balance extension] No se pudo cargar styles/whatsapp.css para los retiros pendientes."
    ), { once: true });
    const panel = document.createElement("section");
    panel.className = "pending-withdrawals-panel";
    panel.setAttribute("aria-label", "Retiros pendientes");
    pendingWithdrawalsToggle = document.createElement("button");
    pendingWithdrawalsToggle.type = "button";
    pendingWithdrawalsToggle.className = "pending-withdrawals-toggle";
    pendingWithdrawalsToggle.addEventListener("click", () => {
      pendingWithdrawalsExpanded = !pendingWithdrawalsExpanded;
      renderPendingWithdrawals();
    });
    if (pendingWithdrawalsTimer === null) {
      pendingWithdrawalsTimer = window.setInterval(renderPendingWithdrawals, 60_000);
    }
    pendingWithdrawalsList = document.createElement("div");
    pendingWithdrawalsList.className = "pending-withdrawals-list";
    pendingWithdrawalsList.setAttribute("role", "list");
    panel.append(pendingWithdrawalsToggle, pendingWithdrawalsList);
    shadow.append(stylesheet, panel);
    document.documentElement.append(host);
    renderPendingWithdrawals();
  }

  function reportUntrackablePendingWithdrawal(metadataElement, reason, diagnostic) {
    if (reportedPendingWithdrawalMessages.has(metadataElement)) return;
    reportedPendingWithdrawalMessages.add(metadataElement);
    console.error(
      `[Ganamos balance extension] Se detectó el mensaje de retiro, pero ${reason}.`,
      diagnostic
    );
    showToast(null, "Retiros pendientes", reason, "error", "pending-withdrawals");
  }

  function getOutgoingMessageDetails(metadataElement) {
    const metadata = metadataElement.getAttribute("data-pre-plain-text");
    const match = metadata?.match(/^\[([^\]]+)\]/);
    if (!match) return null;
    const senderMatch = metadata.match(/^\[[^\]]+\]\s*(.*?):(?:\s|$)/);
    const senderName = senderMatch?.[1]
      ?.replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .trim() || "";
    const ancestors = [];
    let messageContainer = null;
    let isIncomingMessage = false;
    for (let ancestor = metadataElement; ancestor; ancestor = ancestor.parentElement) {
      ancestors.push(ancestor);
      if (ancestor.classList.contains("message-in")) {
        isIncomingMessage = true;
      }
      if (!messageContainer &&
        (ancestor.classList.contains("message-out") ||
          ancestor.matches('[data-testid="msg-container"]'))) messageContainer = ancestor;
      if (ancestor.matches("#main")) break;
    }
    const outgoingMessageId = ancestors
      .map((ancestor) => ancestor.getAttribute("data-id") || "")
      .find((id) => /^true_\d{7,20}@(?:c\.us|s\.whatsapp\.net)_/i.test(id));
    if (!messageContainer && outgoingMessageId) {
      messageContainer = ancestors.find((ancestor) =>
        ancestor.getAttribute("data-id") === outgoingMessageId
      ) || metadataElement.parentElement;
    }
    if (!messageContainer) {
      for (const ancestor of ancestors) {
        if (ancestor.matches("#main")) break;
        const descendantOutgoingId = [...ancestor.querySelectorAll("[data-id]")]
          .map((element) => element.getAttribute("data-id") || "")
          .find((id) => /^true_\d{7,20}@(?:c\.us|s\.whatsapp\.net)_/i.test(id));
        if (!descendantOutgoingId) continue;
        messageContainer ||= ancestor;
        break;
      }
    }
    if (!messageContainer) return null;
    const chat = metadataElement.closest("#main");
    const chatTitle = chat?.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
      chat?.querySelector("header h1, header h2, header [role='heading']");
    const messageIds = [
      ...ancestors.map((ancestor) => ancestor.getAttribute("data-id") || ""),
      ...[...messageContainer.querySelectorAll("[data-id]")]
        .map((element) => element.getAttribute("data-id") || "")
    ].filter(Boolean);
    if (messageIds.some((id) => /@g\.us(?:_|$)/i.test(id))) return null;
    const chatTitleText = chatTitle?.textContent
      ?.replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .trim() || "";
    const normalizeIdentity = (value) => value
      .normalize("NFKC")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
    const senderDiffersFromChat = Boolean(senderName && chatTitleText &&
      normalizeIdentity(senderName) !== normalizeIdentity(chatTitleText));
    if (isIncomingMessage ||
      (!messageContainer.classList.contains("message-out") &&
        !outgoingMessageId && !senderDiffersFromChat)) return null;
    const jidMatch = messageIds
      .map((id) => id.match(/(?:^|_)(\d{7,20})@(?:c\.us|s\.whatsapp\.net)(?:_|$)/i))
      .find(Boolean);
    const chatNumber = jidMatch?.[1] ||
      getPhoneFromWhatsAppChat(chatTitle) ||
      contactFlowChatNumbers.get(chat);
    const contact = getPendingWithdrawalContact(chatTitleText);
    if (!contact.identity) {
      const textElements = messageContainer.querySelectorAll(
        '[data-testid="selectable-text"], .selectable-text'
      );
      const text = [
        messageContainer.textContent || "",
        ...[...textElements].map((element) => element.textContent || "")
      ].join("\n");
      if (normalizeWithdrawalMessageText(text).includes("muchas gracias por su paciencia")) {
        reportUntrackablePendingWithdrawal(
          metadataElement,
          "no se pudo identificar un nombre o usuario de la conversación",
          { chatTitle: chatTitleText, messageIds }
        );
      }
    }
    const timestamp = parseIncomingMessageTimestamp(match[1]);
    const textElements = messageContainer.querySelectorAll(
      '[data-testid="selectable-text"], .selectable-text'
    );
    const text = [
      messageContainer.textContent || "",
      ...[...textElements].map((element) => element.textContent || "")
    ].join("\n")
      .normalize("NFKC")
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .toLocaleLowerCase();
    if (!timestamp) {
      if (normalizeWithdrawalMessageText(text).includes("muchas gracias por su paciencia")) {
        reportUntrackablePendingWithdrawal(
          metadataElement,
          "no se pudo interpretar su fecha",
          metadata
        );
      }
      return null;
    }
    const messageId = outgoingMessageId ||
      messageIds.find((id) => /^true_\d{7,20}@(?:c\.us|s\.whatsapp\.net)_/i.test(id)) ||
      `${contact.identity}:${timestamp}`;
    return {
      number: chatNumber && /^\d{7,20}$/.test(chatNumber) ? chatNumber : "",
      timestamp,
      text,
      messageId,
      contact
    };
  }

  function countOutgoingMessagePanels(metadataElement) {
    if (processedOutgoingMessages.has(metadataElement)) return;
    const details = getOutgoingMessageDetails(metadataElement);
    if (!details) return;
    trackPendingWithdrawal(details);
    if (!details.number) return;
    const now = Date.now();
    if (pruneExpiredContactFlowNumbers(now)) saveContactFlowCounters();
    if (now - details.timestamp > CONTACT_FLOW_MESSAGE_MAX_AGE_MS) {
      processedOutgoingMessages.add(metadataElement);
      return;
    }
    if (details.timestamp > now + CONTACT_FLOW_FUTURE_TIMESTAMP_TOLERANCE_MS) return;
    const matchingPanels = contactFlowCounters.panels.filter((panel) =>
      details.text.includes(panel.keyword.normalize("NFKC").toLocaleLowerCase()) &&
      !panel.countedNumbers.some(({ number }) => number === details.number) &&
      remoteCreateDestinations.some((destination) =>
        destination?.id === panel.destinationId &&
        typeof destination.name === "string")
    );
    if (!matchingPanels.length) return;

    processedOutgoingMessages.add(metadataElement);
    for (const panel of matchingPanels) {
      panel.countedNumbers.push({ number: details.number, countedAt: now });
    }
    if (!matchingPanels.length) return;
    contactFlowPanelConfigRefresh?.();
    saveContactFlowCounters();
  }

  function inspectIncomingMessageNode(node, includeDescendants = false) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return;
    const metadataElements = new Set();
    if (element.matches("[data-pre-plain-text]")) metadataElements.add(element);
    const closestMetadata = element.closest("[data-pre-plain-text]");
    if (closestMetadata) metadataElements.add(closestMetadata);
    const messageContainer = element.closest(".message-in, .message-out");
    const scanContainer = messageContainer || (includeDescendants ? element : null);
    if (scanContainer) {
      for (const metadataElement of scanContainer.querySelectorAll("[data-pre-plain-text]")) {
        metadataElements.add(metadataElement);
      }
    }
    for (const metadataElement of metadataElements) {
      countIncomingMessageNumber(metadataElement);
      countOutgoingMessagePanels(metadataElement);
    }
  }

  function startContactFlowMessageObserver() {
    if (!contactFlowCountersLoaded || contactFlowMessageObserverStarted) return;
    contactFlowMessageObserverStarted = true;
    startContactFlowCounterRefresh();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          inspectIncomingMessageNode(node, true);
          const element = node instanceof Element ? node : node.parentElement;
          const metadataElement = element?.matches("[data-pre-plain-text]")
            ? element
            : element?.querySelector("[data-pre-plain-text]");
          if (metadataElement) {
            for (const delay of [150, 500, 1200]) {
              setTimeout(() => {
                if (metadataElement.isConnected) {
                  countIncomingMessageNumber(metadataElement);
                  countOutgoingMessagePanels(metadataElement);
                }
              }, delay);
            }
          }
        }
        if (mutation.type === "attributes" || mutation.type === "characterData") {
          inspectIncomingMessageNode(
            mutation.target,
            Boolean(mutation.target.parentElement?.closest(".message-in, .message-out"))
          );
        }
      }
    });
    for (const metadataElement of document.querySelectorAll("[data-pre-plain-text]")) {
      processedIncomingMessages.set(
        metadataElement,
        getIncomingMessageIdentity(metadataElement)
      );
      processedOutgoingMessages.add(metadataElement);
    }
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-id", "data-pre-plain-text"],
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function startContactFlowCounterRefresh() {
    if (contactFlowCounterRefreshStarted) return;
    contactFlowCounterRefreshStarted = true;
    globalThis.setInterval(() => void refreshContactFlowCounters(), CONTACT_FLOW_COUNTER_REFRESH_INTERVAL_MS);
  }

  async function refreshContactFlowCounters() {
    if (contactFlowCounterRefreshInProgress || !contactFlowCountersLoaded) return;
    contactFlowCounterRefreshInProgress = true;
    try {
      const versionBeforeRead = contactFlowCountersVersion;
      await contactFlowCounterSaveQueue;
      if (contactFlowCountersVersion !== versionBeforeRead) return;
      const stored = await stateStorage.get(CONTACT_FLOW_COUNTERS_KEY);
      if (contactFlowCountersVersion !== versionBeforeRead) return;
      const refreshed = normalizeContactFlowCounters(stored[CONTACT_FLOW_COUNTERS_KEY]);
      const local = contactFlowCounters;
      const mergePendingNumbers = (confirmed, pending, generationStartedAt) => {
        const merged = new Map(confirmed.map((entry) => [entry.number, entry]));
        for (const entry of pending) {
          if (entry.countedAt < generationStartedAt || merged.has(entry.number)) continue;
          merged.set(entry.number, entry);
        }
        return [...merged.values()];
      };
      const localPanels = new Map(local.panels.map((panel) => [panel.id, panel]));
      const pendingOperations = (confirmed, pending) => {
        const merged = new Map(confirmed.map((operation) => [operation.id, operation]));
        for (const operation of pending) {
          if (!merged.has(operation.id)) merged.set(operation.id, operation);
        }
        return [...merged.values()];
      };
      const reconciled = {
        ...refreshed,
        countedNumbers: mergePendingNumbers(
          refreshed.countedNumbers,
          local.countedNumbers,
          refreshed.generationStartedAt
        ),
        panels: refreshed.panels.map((panel) => ({
          ...panel,
          countedNumbers: mergePendingNumbers(
            panel.countedNumbers,
            localPanels.get(panel.id)?.countedNumbers || [],
            refreshed.generationStartedAt
          )
        })),
        adjustmentOperations: pendingOperations(
          refreshed.adjustmentOperations,
          local.adjustmentOperations
        ),
        resetOperations: pendingOperations(
          refreshed.resetOperations,
          local.resetOperations
        )
      };
      if (JSON.stringify(reconciled) === JSON.stringify(local)) return;
      contactFlowCounters = reconciled;
      for (const updateRow of contactFlowCounterRows.values()) updateRow();
      contactFlowPanelConfigRefresh?.();
      if (reconciled.adjustmentOperations.length || reconciled.resetOperations.length ||
        reconciled.countedNumbers.length !== refreshed.countedNumbers.length ||
        reconciled.panels.some((panel, index) =>
          panel.countedNumbers.length !== refreshed.panels[index].countedNumbers.length)) {
        saveContactFlowCounters();
      }
    } catch (error) {
      console.error(
        "[Ganamos balance extension] No se pudieron refrescar los contadores compartidos.",
        error
      );
    } finally {
      contactFlowCounterRefreshInProgress = false;
    }
  }

  function createContactFlowCountersSnapshot(counters) {
    return {
      arrived: counters.arrived,
      derived: { ...counters.derived },
      generation: counters.generation,
      generationStartedAt: counters.generationStartedAt,
      countedNumbers: counters.countedNumbers.map((entry) => ({ ...entry })),
      panels: counters.panels.map((panel) => ({
        ...panel,
        countedNumbers: panel.countedNumbers.map((entry) => ({ ...entry }))
      })),
      adjustmentOperations: counters.adjustmentOperations.map((operation) => ({ ...operation })),
      resetOperations: counters.resetOperations.map((operation) => ({ ...operation }))
    };
  }

  function saveContactFlowCounters() {
    contactFlowCountersVersion++;
    const snapshot = createContactFlowCountersSnapshot(contactFlowCounters);
    contactFlowCounterSaveQueue = contactFlowCounterSaveQueue
      .then(() => stateStorage.set({ [CONTACT_FLOW_COUNTERS_KEY]: snapshot }))
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudieron guardar los contadores de llegados y derivados.",
        error
      ));
  }

  function queueContactFlowCounterAdjustment(target, delta) {
    if (!delta) return;
    contactFlowCounters.adjustmentOperations.push({
      id: crypto.randomUUID(),
      target,
      delta,
      generation: contactFlowCounters.generation
    });
  }

  function createContactFlowCounterRow(key, label) {
    const row = document.createElement("div");
    row.className = "contact-flow-counter";
    const name = document.createElement("span");
    name.className = "contact-flow-counter-name";
    name.textContent = label;
    name.title = label;
    const controls = document.createElement("div");
    controls.className = "contact-flow-counter-controls";
    const decrement = document.createElement("button");
    decrement.type = "button";
    decrement.className = "contact-flow-counter-step";
    decrement.textContent = "▼";
    decrement.title = `Restar uno a ${label}`;
    decrement.setAttribute("aria-label", decrement.title);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.inputMode = "numeric";
    input.className = "contact-flow-counter-value";
    input.setAttribute("aria-label", label);
    const increment = document.createElement("button");
    increment.type = "button";
    increment.className = "contact-flow-counter-step";
    increment.textContent = "▲";
    increment.title = `Sumar uno a ${label}`;
    increment.setAttribute("aria-label", increment.title);
    const updateRow = () => {
      const count = getContactFlowCounterValue(key);
      if (document.activeElement !== input) input.value = String(count);
      decrement.disabled = count === 0;
      increment.disabled = count >= Number.MAX_SAFE_INTEGER;
    };
    const adjustCounter = (delta) => {
      const count = getContactFlowCounterValue(key);
      const nextCount = count + delta;
      if (!delta || !Number.isSafeInteger(nextCount) || nextCount < 0) return;
      queueContactFlowCounterAdjustment(
        key === "arrived" ? "arrived" : `destination:${key}`,
        delta
      );
      if (key === "arrived") contactFlowCounters.arrived = nextCount;
      else contactFlowCounters.derived[key] = nextCount;
      updateRow();
      saveContactFlowCounters();
    };
    const commitValue = () => {
      const count = Number(input.value);
      if (!input.value || !Number.isSafeInteger(count) || count < 0) {
        updateRow();
        return;
      }
      adjustCounter(count - getContactFlowCounterValue(key));
    };
    decrement.addEventListener("click", () => {
      adjustCounter(-1);
    });
    increment.addEventListener("click", () => {
      adjustCounter(1);
    });
    input.addEventListener("change", commitValue);
    controls.append(increment, input, decrement);
    row.append(name, controls);
    contactFlowCounterRows.set(key, updateRow);
    updateRow();
    return row;
  }

  function renderContactFlowDerivedCounters() {
    if (!contactFlowDerivedRows) return;
    contactFlowDerivedRows.replaceChildren();
    contactFlowCounterRows = new Map(
      [...contactFlowCounterRows].filter(([key]) => key === "arrived")
    );
    const destinations = remoteCreateDestinations.filter((destination) =>
      typeof destination?.id === "string" && typeof destination.name === "string");
    if (!destinations.length) {
      const empty = document.createElement("span");
      empty.className = "contact-flow-counter-empty";
      empty.textContent = "Sin conexiones";
      contactFlowDerivedRows.append(empty);
      return;
    }
    for (const destination of destinations) {
      contactFlowDerivedRows.append(
        createContactFlowCounterRow(destination.id, destination.name)
      );
    }
  }

  function updateContactFlowCounterVisibility() {
    const host = document.getElementById(CONTACT_FLOW_COUNTER_HOST_ID);
    if (!host) return;
    host.style.display = remoteCreateDestinationsLoaded && hasConfiguredRemoteDestinations()
      ? ""
      : "none";
  }

  function resetContactFlowCounters(clearCountedNumbers = true) {
    const generation = contactFlowCounters.generation + 1;
    contactFlowCounters.resetOperations.push({
      id: crypto.randomUUID(),
      clearCountedNumbers
    });
    contactFlowCounters = {
      arrived: 0,
      derived: {},
      generation,
      generationStartedAt: Date.now(),
      countedNumbers: clearCountedNumbers ? [] : contactFlowCounters.countedNumbers,
      panels: contactFlowCounters.panels.map((panel) => ({
        ...panel,
        count: 0,
        countedNumbers: clearCountedNumbers ? [] : panel.countedNumbers
      })),
      adjustmentOperations: contactFlowCounters.adjustmentOperations,
      resetOperations: contactFlowCounters.resetOperations
    };
    for (const updateRow of contactFlowCounterRows.values()) updateRow();
    contactFlowPanelConfigRefresh?.();
    saveContactFlowCounters();
  }

  function openContactFlowPanelConfiguration(triggerButton) {
    if (document.querySelector("#ganamos-contact-flow-panel-config")) return;
    const dialogHost = document.createElement("div");
    dialogHost.id = "ganamos-contact-flow-panel-config";
    dialogHost.style.position = "fixed";
    dialogHost.style.inset = "0";
    dialogHost.style.zIndex = "2147483647";
    dialogHost.style.width = "100vw";
    dialogHost.style.height = "100vh";
    dialogHost.style.pointerEvents = "none";
    const shadow = dialogHost.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/whatsapp.css");
    stylesheet.addEventListener("error", () => console.error(
      "[Ganamos balance extension] No se pudo cargar styles/whatsapp.css para configurar los paneles."
    ), { once: true });
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.pointerEvents = "auto";
    const destinations = remoteCreateDestinations.filter((destination) =>
      typeof destination?.id === "string" && typeof destination.name === "string");
    const closeDialog = () => {
      contactFlowPanelConfigRefresh = null;
      dialogHost.remove();
      triggerButton.focus();
    };
    let closeAddDialog = () => {};
    registerModalEscapeHandler(modal, () => {
      if (addModal.style.display !== "none") closeAddDialog();
      else closeDialog();
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeDialog();
    });
    const dialog = document.createElement("section");
    dialog.className = "dialog contact-flow-panel-dialog";
    dialog.dataset.operation = "contact-flow-panels";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("h2");
    heading.id = "contact-flow-panel-heading";
    heading.textContent = "Configurar paneles derivados";
    dialog.setAttribute("aria-labelledby", heading.id);
    const description = document.createElement("p");
    description.className = "contact-flow-panel-description";
    description.textContent = "Importar JSON reemplaza los paneles actuales y conserva los totales de los contadores.";
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "contact-flow-panel-add-button";
    addButton.textContent = "Agregar Panel";
    addButton.disabled = destinations.length === 0;
    const transferActions = document.createElement("div");
    transferActions.className = "contact-flow-panel-transfer-actions";
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "secondary";
    exportButton.textContent = "Exportar JSON";
    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "secondary";
    importButton.textContent = "Importar JSON";
    const importFileInput = document.createElement("input");
    importFileInput.type = "file";
    importFileInput.accept = ".json,application/json";
    importFileInput.hidden = true;
    const transferStatus = document.createElement("p");
    transferStatus.className = "contact-flow-panel-status";
    transferStatus.setAttribute("role", "status");
    transferStatus.setAttribute("aria-live", "polite");
    transferStatus.hidden = true;
    transferActions.append(exportButton, importButton, importFileInput);
    exportButton.addEventListener("click", () => {
      transferStatus.hidden = true;
      transferStatus.className = "contact-flow-panel-status";
      try {
        const panels = contactFlowCounters.panels.map((panel) => {
          const destination = destinations.find(({ id }) => id === panel.destinationId);
          if (!destination) {
            throw new Error(`No se encontró la PC asociada al panel "${panel.title}".`);
          }
          return {
            title: panel.title,
            keyword: panel.keyword,
            destination: destination.name
          };
        });
        const content = JSON.stringify({
          format: "bridgewpp-contact-flow-panels",
          version: 1,
          panels
        }, null, 2);
        const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
        const download = document.createElement("a");
        download.href = url;
        download.download = `bridgewpp-paneles-${new Date().toISOString().slice(0, 10)}.json`;
        download.hidden = true;
        document.body.append(download);
        download.click();
        download.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        transferStatus.textContent = "Configuración de paneles exportada.";
        transferStatus.hidden = false;
      } catch (error) {
        transferStatus.textContent = `No se pudo exportar la configuración: ${error.message}`;
        transferStatus.className = "contact-flow-panel-status contact-flow-panel-error";
        transferStatus.hidden = false;
      }
    });
    importButton.addEventListener("click", () => {
      transferStatus.hidden = true;
      importFileInput.value = "";
      importFileInput.click();
    });
    importFileInput.addEventListener("change", async () => {
      const file = importFileInput.files?.[0];
      if (!file) return;
      transferStatus.hidden = true;
      transferStatus.className = "contact-flow-panel-status";
      try {
        const imported = JSON.parse(await file.text());
        if (!imported || typeof imported !== "object" || Array.isArray(imported) ||
          imported.format !== "bridgewpp-contact-flow-panels" || imported.version !== 1 ||
          !Array.isArray(imported.panels)) {
          throw new Error("El archivo no tiene un formato de paneles compatible.");
        }
        const destinationsByName = new Map(destinations.map((destination) => [
          destination.name.trim().toLocaleLowerCase(),
          destination
        ]));
        const panels = imported.panels.map((panel, index) => {
          if (!panel || typeof panel !== "object" || Array.isArray(panel) ||
            typeof panel.title !== "string" || !panel.title.trim() || panel.title.trim().length > 80 ||
            typeof panel.keyword !== "string" || !panel.keyword.trim() || panel.keyword.trim().length > 120 ||
            typeof panel.destination !== "string" || !panel.destination.trim()) {
            throw new Error(`El panel ${index + 1} tiene datos incompletos o inválidos.`);
          }
          const destination = destinationsByName.get(panel.destination.trim().toLocaleLowerCase());
          if (!destination) {
            throw new Error(`No hay una PC configurada con el nombre "${panel.destination}".`);
          }
          return {
            id: crypto.randomUUID(),
            title: panel.title.trim(),
            keyword: panel.keyword.trim(),
            destinationId: destination.id,
            count: 0,
            countedNumbers: []
          };
        });
        const importedCounters = {
          ...contactFlowCounters,
          panels
        };
        await contactFlowCounterSaveQueue;
        contactFlowCountersVersion++;
        await stateStorage.set({
          [CONTACT_FLOW_COUNTERS_KEY]: createContactFlowCountersSnapshot(importedCounters)
        });
        contactFlowCounters = normalizeContactFlowCounters(importedCounters);
        for (const updateRow of contactFlowCounterRows.values()) updateRow();
        contactFlowPanelConfigRefresh?.();
        transferStatus.textContent = `Se importaron ${panels.length} paneles. Los paneles actuales fueron reemplazados.`;
        transferStatus.hidden = false;
      } catch (error) {
        transferStatus.textContent = `No se pudo importar la configuración: ${error.message}`;
        transferStatus.className = "contact-flow-panel-status contact-flow-panel-error";
        transferStatus.hidden = false;
      }
    });
    const listHeading = document.createElement("h3");
    listHeading.className = "contact-flow-panel-list-heading";
    listHeading.textContent = "Paneles configurados";
    const panelList = document.createElement("div");
    panelList.className = "contact-flow-panel-list";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "secondary contact-flow-panel-close-button";
    closeButton.textContent = "Cerrar";
    closeButton.addEventListener("click", closeDialog);

    const addModal = document.createElement("div");
    addModal.className = "modal contact-flow-panel-add-modal";
    addModal.style.display = "none";
    addModal.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === addModal) closeAddDialog();
    });
    const addDialog = document.createElement("section");
    addDialog.className = "dialog contact-flow-panel-add-dialog";
    addDialog.dataset.operation = "contact-flow-panel-add";
    addDialog.setAttribute("role", "dialog");
    addDialog.setAttribute("aria-modal", "true");
    const addHeading = document.createElement("h2");
    addHeading.id = "contact-flow-panel-add-heading";
    addHeading.textContent = "Agregar Panel";
    addDialog.setAttribute("aria-labelledby", addHeading.id);
    let editingPanelId = null;
    const form = document.createElement("form");
    form.className = "contact-flow-panel-form";
    const titleLabel = document.createElement("label");
    titleLabel.htmlFor = "contact-flow-panel-title";
    titleLabel.textContent = "Título";
    const titleInput = document.createElement("input");
    titleInput.id = "contact-flow-panel-title";
    titleInput.type = "text";
    titleInput.autocomplete = "off";
    titleInput.required = true;
    titleInput.maxLength = 80;
    const keywordLabel = document.createElement("label");
    keywordLabel.htmlFor = "contact-flow-panel-keyword";
    keywordLabel.textContent = "Palabra clave (texto)";
    const keywordInput = document.createElement("input");
    keywordInput.id = "contact-flow-panel-keyword";
    keywordInput.type = "text";
    keywordInput.inputMode = "text";
    keywordInput.autocomplete = "off";
    keywordInput.required = true;
    keywordInput.maxLength = 120;
    keywordInput.placeholder = "Ej.: 5491123456789";
    const destinationLabel = document.createElement("label");
    destinationLabel.htmlFor = "contact-flow-panel-destination";
    destinationLabel.textContent = "PC asociada";
    const destinationSelect = document.createElement("select");
    destinationSelect.id = "contact-flow-panel-destination";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Elegí una PC";
    destinationSelect.append(emptyOption);
    for (const destination of destinations) {
      const option = document.createElement("option");
      option.value = destination.id;
      option.textContent = destination.name;
      destinationSelect.append(option);
    }
    const error = document.createElement("p");
    error.className = "contact-flow-panel-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Guardar Panel";
    submit.disabled = destinations.length === 0;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => closeAddDialog());
    const formActions = document.createElement("div");
    formActions.className = "dialog-actions contact-flow-panel-form-actions";
    formActions.append(cancel, submit);
    form.append(
      titleLabel,
      titleInput,
      keywordLabel,
      keywordInput,
      destinationLabel,
      destinationSelect,
      error,
      formActions
    );
    addDialog.append(addHeading, form);
    addModal.append(addDialog);
    closeAddDialog = () => {
      addModal.style.display = "none";
      editingPanelId = null;
      addHeading.textContent = "Agregar Panel";
      submit.textContent = "Guardar Panel";
      titleInput.value = "";
      keywordInput.value = "";
      error.hidden = true;
      addButton.focus();
    };
    const openAddDialog = (panel = null) => {
      editingPanelId = panel?.id || null;
      addHeading.textContent = panel ? "Editar Panel" : "Agregar Panel";
      submit.textContent = panel ? "Guardar cambios" : "Guardar Panel";
      titleInput.value = panel?.title || "";
      keywordInput.value = panel?.keyword || "";
      destinationSelect.value = panel?.destinationId || "";
      error.hidden = true;
      addModal.style.display = "";
      titleInput.focus();
    };
    addButton.addEventListener("click", () => {
      openAddDialog();
    });

    const renderPanelList = () => {
      panelList.replaceChildren();
      if (!contactFlowCounters.panels.length) {
        const empty = document.createElement("p");
        empty.className = "contact-flow-panel-empty";
        empty.textContent = "Todavía no hay paneles configurados.";
        panelList.append(empty);
        return;
      }
      const destinationOrder = new Map(
        destinations.map((destination, index) => [destination.id, index])
      );
      const sortedPanels = [...contactFlowCounters.panels].sort((left, right) => {
        const leftDestinationOrder = destinationOrder.get(left.destinationId) ?? Number.MAX_SAFE_INTEGER;
        const rightDestinationOrder = destinationOrder.get(right.destinationId) ?? Number.MAX_SAFE_INTEGER;
        return leftDestinationOrder - rightDestinationOrder ||
          left.title.localeCompare(right.title, "es", { sensitivity: "base" });
      });
      for (const panel of sortedPanels) {
        const row = document.createElement("div");
        row.className = "contact-flow-panel-item";
        const destinationIndex = destinations.findIndex(({ id }) => id === panel.destinationId);
        const destinationColors = ["#ffd166", "#c08cff", "#ffffff"];
        row.style.setProperty(
          "--contact-flow-panel-color",
          destinationColors[destinationIndex] || "#ffffff"
        );
        const details = document.createElement("div");
        details.className = "contact-flow-panel-item-details";
        const title = document.createElement("strong");
        title.textContent = panel.title;
        const keyword = document.createElement("span");
        keyword.className = "contact-flow-panel-item-keyword";
        keyword.textContent = `(${panel.keyword})`;
        details.append(title, keyword);
        const count = document.createElement("input");
        count.className = "contact-flow-panel-item-count";
        count.type = "number";
        count.value = String(panel.count);
        count.readOnly = true;
        count.tabIndex = -1;
        count.setAttribute("aria-label", `Conteo del panel ${panel.title}`);
        const actions = document.createElement("div");
        actions.className = "contact-flow-panel-item-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "contact-flow-panel-edit";
        edit.textContent = "Editar";
        edit.setAttribute("aria-label", `Editar el panel ${panel.title}`);
        edit.addEventListener("click", () => openAddDialog(panel));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "contact-flow-panel-remove";
        remove.textContent = "Quitar";
        remove.setAttribute("aria-label", `Quitar el panel ${panel.title}`);
        remove.addEventListener("click", () => {
          contactFlowCounters.panels = contactFlowCounters.panels.filter(({ id }) => id !== panel.id);
          saveContactFlowCounters();
          renderPanelList();
        });
        actions.append(edit, remove);
        const pill = document.createElement("div");
        pill.className = "contact-flow-panel-pill";
        pill.append(details, actions);
        row.append(pill, count);
        panelList.append(row);
      }
    };
    contactFlowPanelConfigRefresh = renderPanelList;
    renderPanelList();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = titleInput.value.trim();
      const keyword = keywordInput.value.trim();
      const destinationId = destinationSelect.value;
      if (!title || !keyword ||
        !destinations.some(({ id }) => id === destinationId)) {
        error.textContent = "Ingresá un título y una palabra clave, y seleccioná una PC configurada.";
        error.hidden = false;
        return;
      }
      const editingPanel = contactFlowCounters.panels.find(({ id }) => id === editingPanelId);
      if (editingPanel) {
        if (editingPanel.destinationId !== destinationId) {
          const oldDerived = getContactFlowCounterValue(editingPanel.destinationId);
          const newDerived = getContactFlowCounterValue(destinationId);
          if (newDerived > Number.MAX_SAFE_INTEGER - editingPanel.count) {
            error.textContent = "No se puede cambiar la PC: el contador de destino llegó al límite seguro.";
            error.hidden = false;
            return;
          }
          const adjustedOldDerived = Math.max(0, oldDerived - editingPanel.count);
          queueContactFlowCounterAdjustment(
            `destination:${editingPanel.destinationId}`,
            adjustedOldDerived - oldDerived
          );
          queueContactFlowCounterAdjustment(
            `destination:${destinationId}`,
            editingPanel.count
          );
          contactFlowCounters.derived[editingPanel.destinationId] = adjustedOldDerived;
          contactFlowCounters.derived[destinationId] = newDerived + editingPanel.count;
          editingPanel.destinationId = destinationId;
          for (const updateRow of contactFlowCounterRows.values()) updateRow();
        }
        editingPanel.title = title;
        editingPanel.keyword = keyword;
      } else {
        contactFlowCounters.panels.push({
          id: crypto.randomUUID(),
          title,
          keyword,
          destinationId,
          count: 0,
          countedNumbers: []
        });
      }
      saveContactFlowCounters();
      renderPanelList();
      closeAddDialog();
    });
    dialog.append(
      heading,
      description,
      addButton,
      transferActions,
      transferStatus,
      listHeading,
      panelList,
      closeButton
    );
    modal.append(dialog);
    modal.append(addModal);
    shadow.append(stylesheet, modal);
    document.documentElement.append(dialogHost);
    addButton.focus();
  }

  function openContactFlowResetConfirmation(resetButton) {
    const dialogHost = document.createElement("div");
    dialogHost.style.position = "fixed";
    dialogHost.style.inset = "0";
    dialogHost.style.zIndex = "2147483647";
    dialogHost.style.width = "100vw";
    dialogHost.style.height = "100vh";
    dialogHost.style.pointerEvents = "none";
    const shadow = dialogHost.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/whatsapp.css");
    stylesheet.addEventListener("error", () => console.error(
      "[Ganamos balance extension] No se pudo cargar styles/whatsapp.css para confirmar el reinicio."
    ), { once: true });
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.pointerEvents = "auto";
    registerModalEscapeHandler(modal, () => {
      dialogHost.remove();
      resetButton.focus();
    });
    modal.addEventListener("click", (event) => {
      if (event.target !== modal) return;
      dialogHost.remove();
      resetButton.focus();
    });
    const dialog = document.createElement("section");
    dialog.className = "dialog contact-flow-reset-dialog";
    dialog.dataset.operation = "contact-flow-reset";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("h2");
    heading.id = "contact-flow-reset-heading";
    heading.textContent = "¿Reiniciar contadores?";
    const message = document.createElement("p");
    message.id = "contact-flow-reset-message";
    message.textContent = "Elegí si también querés borrar el registro de números ya contabilizados. En ambos casos los contadores volverán a cero y se conservará la configuración de los paneles.";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", message.id);
    const actions = document.createElement("div");
    actions.className = "dialog-actions contact-flow-reset-actions";
    const resetEverything = document.createElement("button");
    resetEverything.type = "button";
    resetEverything.className = "contact-flow-reset-all";
    resetEverything.textContent = "Reiniciar todo";
    resetEverything.title = "Pone los contadores en cero y borra los registros de números contados.";
    resetEverything.addEventListener("click", () => {
      if (!window.confirm("¿Reiniciar todo? También se borrarán los registros de números ya contabilizados.")) {
        return;
      }
      resetContactFlowCounters(true);
      dialogHost.remove();
      resetButton.focus();
    });
    const actionSpacer = document.createElement("span");
    actionSpacer.className = "contact-flow-reset-spacer";
    actionSpacer.setAttribute("aria-hidden", "true");
    const secondaryActions = document.createElement("div");
    secondaryActions.className = "contact-flow-reset-secondary-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => {
      dialogHost.remove();
      resetButton.focus();
    });
    const resetValues = document.createElement("button");
    resetValues.type = "button";
    resetValues.textContent = "Reiniciar";
    resetValues.title = "Pone los contadores en cero y conserva los registros de números contados.";
    resetValues.addEventListener("click", () => {
      resetContactFlowCounters(false);
      dialogHost.remove();
      resetButton.focus();
    });
    secondaryActions.append(cancel, resetValues);
    actions.append(resetEverything, actionSpacer, secondaryActions);
    dialog.append(heading, message, actions);
    modal.append(dialog);
    shadow.append(stylesheet, modal);
    document.documentElement.append(dialogHost);
    cancel.focus();
  }

  async function copyContactFlowCounters() {
    const destinations = remoteCreateDestinations.filter((destination) =>
      typeof destination?.id === "string" && typeof destination.name === "string");
    const derivedTotal = destinations.reduce(
      (total, destination) => total + getContactFlowCounterValue(destination.id),
      0
    );
    const effectiveness = contactFlowCounters.arrived
      ? Math.round(derivedTotal / contactFlowCounters.arrived * 100)
      : 0;
    const derivedLines = destinations.map((destination) =>
      `${destination.name.replace(/\s+/g, " ").trim()}: ${getContactFlowCounterValue(destination.id)}`);
    const text = [
      "*CONTEO DE PUBLICIDAD:*",
      `*Efectividad: ${effectiveness}%*`,
      "",
      `*Llegados: ${contactFlowCounters.arrived}*`,
      "",
      `*Derivados: ${derivedTotal}*`,
      ...derivedLines
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast(null, "Conteo de publicidad", "Copiado al portapapeles.", "success");
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudo copiar el conteo al portapapeles.", error);
      showToast(
        null,
        "Conteo de publicidad",
        error.message || "No se pudo copiar al portapapeles.",
        "error"
      );
    }
  }

  function createContactFlowActionButton(action, title, pathData, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "contact-flow-counter-action";
    button.title = title;
    button.setAttribute("aria-label", title);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    for (const path of pathData) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
      element.setAttribute("d", path);
      icon.append(element);
    }
    button.dataset.action = action;
    button.append(icon);
    button.addEventListener("click", onClick);
    return button;
  }

  function createContactFlowCounterPanel() {
    const host = document.createElement("div");
    host.id = CONTACT_FLOW_COUNTER_HOST_ID;
    host.style.display = "none";
    host.style.left = "0";
    host.style.top = "250px";
    host.style.width = "64px";
    host.style.maxHeight = "calc(100vh - 200px)";
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
      console.error("[Ganamos balance extension] No se pudo cargar styles/whatsapp.css para los contadores.");
      host.style.visibility = "";
    }, { once: true });
    const panel = document.createElement("section");
    panel.className = "contact-flow-counter-panel";
    panel.setAttribute("aria-label", "Contadores de llegados y derivados");
    const arrivedHeading = document.createElement("h2");
    arrivedHeading.textContent = "Llegados";
    const arrivedRows = document.createElement("div");
    arrivedRows.className = "contact-flow-counter-rows";
    arrivedRows.append(createContactFlowCounterRow("arrived", "Total"));
    const derivedHeading = document.createElement("button");
    derivedHeading.type = "button";
    derivedHeading.className = "contact-flow-counter-configure";
    derivedHeading.textContent = "Derivados";
    derivedHeading.title = "Configurar paneles de conteo";
    derivedHeading.setAttribute("aria-haspopup", "dialog");
    derivedHeading.addEventListener("click", () =>
      openContactFlowPanelConfiguration(derivedHeading));
    contactFlowDerivedRows = document.createElement("div");
    contactFlowDerivedRows.className = "contact-flow-counter-rows";
    const actions = document.createElement("div");
    actions.className = "contact-flow-counter-actions";
    const resetButton = createContactFlowActionButton(
      "reset",
      "Reiniciar contador",
      ["M20 11a8 8 0 1 1-2.34-5.66L20 8", "M20 3v5h-5"],
      () => openContactFlowResetConfirmation(resetButton)
    );
    const copyButton = createContactFlowActionButton(
      "copy",
      "Copiar al portapapeles",
      ["M8 8V4a2 2 0 0 1 2-2h9l3 3v13a2 2 0 0 1-2 2h-4", "M3 8h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z", "M16 2v4h5"],
      () => void copyContactFlowCounters()
    );
    actions.append(resetButton, copyButton);
    panel.append(arrivedHeading, arrivedRows, derivedHeading, contactFlowDerivedRows, actions);
    shadow.append(stylesheet, panel);
    document.documentElement.append(host);
    renderContactFlowDerivedCounters();
    updateContactFlowCounterVisibility();
    return host;
  }

  function validatePlatformOutageConfig(config) {
    if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.ganamos !== "boolean" || typeof config.multipanel !== "boolean" ||
      Object.keys(config).some((key) => !["ganamos", "multipanel"].includes(key))) {
      throw new Error("La configuración de plataformas caídas no es válida.");
    }
    return { ganamos: config.ganamos, multipanel: config.multipanel };
  }

  async function readPlatformOutageConfig() {
    const stored = await stateStorage.get(PLATFORM_OUTAGE_CONFIG_KEY);
    const config = stored[PLATFORM_OUTAGE_CONFIG_KEY];
    return config == null
      ? { ganamos: false, multipanel: false }
      : validatePlatformOutageConfig(config);
  }

  function renderPlatformOutageConfig(host) {
    const label = host.shadowRoot?.querySelector(".platform-outage-label");
    if (label) {
      label.textContent = platformOutageConfig.ganamos && platformOutageConfig.multipanel
        ? "Ambas\nCaídas"
        : platformOutageConfig.ganamos
          ? "Ganamos\nCaído"
          : platformOutageConfig.multipanel
            ? "MultiPanel\nCaído"
            : "";
    }
    for (const button of host.shadowRoot?.querySelectorAll(".platform-outage-toggle") || []) {
      const down = platformOutageConfig[button.dataset.platform];
      button.setAttribute("aria-pressed", String(down));
    }
  }

  async function togglePlatformOutage(host, platform, button) {
    const buttons = [...(host.shadowRoot?.querySelectorAll(".platform-outage-toggle") || [])];
    buttons.forEach((control) => { control.disabled = true; });
    try {
      const current = await readPlatformOutageConfig();
      const next = { ...current, [platform]: !current[platform] };
      await stateStorage.set({ [PLATFORM_OUTAGE_CONFIG_KEY]: next });
      platformOutageConfig = next;
      renderPlatformOutageConfig(host);
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudo guardar la configuración de plataformas caídas.", error);
      showToast(
        host,
        "Plataformas",
        error.message || "No se pudo guardar la configuración.",
        "error",
        `platform-outage:${platform}`
      );
    } finally {
      buttons.forEach((control) => { control.disabled = false; });
      button.focus();
    }
  }

  function updateActiveBonusVisibility(zoomViewOpen = [...document.querySelectorAll('button[aria-label="Acercar"]')]
    .some(isRenderedVisible)) {
    const host = document.getElementById(ACTIVE_BONUS_HOST_ID);
    if (!host) return;
    host.style.display = zoomViewOpen || hasConfiguredRemoteDestinations() ? "none" : "";
  }

  function setAgentBalancePanelWidth(host, minimized, hasErrors) {
    host.style.width = minimized && !hasErrors
      ? "28px"
      : `min(${hasConfiguredRemoteDestinations() ? 320 : 230}px, calc(100vw - 56px))`;
  }

  function updateActiveBonusButton(host, config) {
    const button = host.shadowRoot?.querySelector(".active-bonus-button");
    const percentLabel = host.shadowRoot?.querySelector(".active-bonus-percent-label");
    const label = host.shadowRoot?.querySelector(".active-bonus-type-label");
    if (!button || !percentLabel || !label) return;
    const enabled = Boolean(config?.enabled && config.type !== "none");
    const bonusPercentages = {
      simple: `${config?.percent}%`,
      double: `${config?.ganamos}/${config?.multipanel}%`,
      specific: `${config?.percent}%`,
      special: `${config?.underThreshold}/${config?.overThreshold}%`,
      mysterious: "?%"
    };
    const bonusNames = {
      simple: "Simple",
      double: "Doble",
      specific: config?.platform === "multipanel" ? "MultiPanel" : "Ganamos",
      special: "Especial",
      mysterious: "Misterioso"
    };
    const bonusName = enabled ? bonusNames[config.type] : "Sin bono";
    host.dataset.bonusType = enabled ? config.type : "none";
    host.dataset.copyBonus = String(config?.copyBonus === true);
    host.dataset.invertDepositButtons = String(config?.invertDepositButtons === true);
    host.dataset.activeAdvertising = String(config?.activeAdvertising === true);
    host.dataset.markUnreadAfterStatusUpdate = String(
      config?.markUnreadAfterStatusUpdate === true
    );
    host.dataset.advertisingReady = String(
      config?.activeAdvertising === true && isValidBonusPercent(config.advertisingPercent)
    );
    updateDepositBonusBypassVisibility(enabled, config?.invertDepositButtons === true);
    updateDepositAdvertisingVisibility(
      config?.activeAdvertising === true && isValidBonusPercent(config.advertisingPercent)
    );
    if (enabled && config.type === "specific") host.dataset.platform = config.platform;
    else delete host.dataset.platform;
    percentLabel.textContent = enabled ? bonusPercentages[config.type] : "";
    label.textContent = bonusName;
    button.setAttribute("aria-pressed", String(enabled));
    button.title = enabled ? `Configurar bono activo: ${bonusName}` : "Configuración de bono activo";
    button.setAttribute("aria-label", button.title);
  }

  function updateDepositBonusBypassVisibility(bonusEnabled, invertDepositButtons = false) {
    const accountHost = document.getElementById(HOST_ID);
    const bypassButton = accountHost?.shadowRoot?.querySelector(".deposit-bonus-bypass");
    const depositButton = accountHost?.shadowRoot?.querySelector('[data-action="deposit"]');
    const bonusDisabled = accountHost?.dataset.bonusDisabled === "true";
    if (bypassButton) {
      bypassButton.dataset.appliesBonus = String(invertDepositButtons);
      bypassButton.title = !bonusEnabled
        ? "Depositar"
        : invertDepositButtons
          ? "Depositar aplicando el bono automático"
          : "Depositar sin aplicar el bono automático";
      bypassButton.setAttribute("aria-label", bypassButton.title);
    }
    if (depositButton) {
      depositButton.dataset.bonusDisabled = String(bonusDisabled);
      depositButton.title = bonusDisabled || !bonusEnabled
        ? "Depositar"
        : invertDepositButtons
          ? "Depositar sin aplicar el bono automático"
          : "Depositar aplicando el bono automático";
      depositButton.setAttribute("aria-label", depositButton.title);
    }
    if (!bypassButton) return;
    const hasPlatformUsers = Boolean(accountHost?.dataset.username || accountHost?.dataset.multipanelUsername);
    bypassButton.hidden = bonusDisabled || !bonusEnabled || !hasPlatformUsers;
  }

  function updateUserBonusDisabledPresentation(host, disabled) {
    host.dataset.bonusDisabled = String(disabled);
    const label = host.shadowRoot?.querySelector(".bonus-disabled-label");
    if (label) label.hidden = !disabled;
    const activeBonusHost = document.getElementById(ACTIVE_BONUS_HOST_ID);
    updateDepositBonusBypassVisibility(
      Boolean(activeBonusHost?.dataset.bonusType && activeBonusHost.dataset.bonusType !== "none"),
      activeBonusHost?.dataset.invertDepositButtons === "true"
    );
    updateDepositAdvertisingVisibility(activeBonusHost?.dataset.advertisingReady === "true");
  }

  function updateUserAccumulatesBonusesPresentation(host, enabled) {
    host.dataset.accumulatesBonuses = String(enabled);
    const label = host.shadowRoot?.querySelector(".accumulates-bonuses-label");
    if (label) label.hidden = !enabled;
  }

  function updateDepositAdvertisingVisibility(advertisingEnabled) {
    const accountHost = document.getElementById(HOST_ID);
    const advertisingButton = accountHost?.shadowRoot?.querySelector(".deposit-advertising-button");
    if (!advertisingButton) return;
    const hasPlatformUsers = Boolean(accountHost?.dataset.username || accountHost?.dataset.multipanelUsername);
    advertisingButton.hidden = !advertisingEnabled || !hasPlatformUsers;
    advertisingButton.title = "Depositar con bono de publicidad";
    advertisingButton.setAttribute("aria-label", advertisingButton.title);
    const bypassButton = accountHost.shadowRoot.querySelector(".deposit-bonus-bypass");
    const actions = accountHost.shadowRoot.querySelector(".actions");
    actions?.classList.toggle(
      "has-advertising-deposit-buttons",
      !advertisingButton.hidden && Boolean(bypassButton && !bypassButton.hidden)
    );
  }

  async function openActiveBonusDialog(host) {
    let savedConfig = null;
    let savedOutageConfig;
    try {
      [savedConfig, savedOutageConfig] = await Promise.all([
        readActiveBonusConfig(),
        readPlatformOutageConfig()
      ]);
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudieron cargar las configuraciones del panel.", error);
      showToast(host, "Configuración", error.message || "No se pudo cargar la configuración.", "error");
      return;
    }
    platformOutageConfig = savedOutageConfig;

    const root = host.shadowRoot?.querySelector(".active-bonus-dialog-root");
    if (!root) return;
    root.replaceChildren();

    const modal = document.createElement("div");
    modal.className = "modal";
    registerModalEscapeHandler(modal, () => {
      root.replaceChildren();
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) root.replaceChildren();
    });

    const dialog = document.createElement("form");
    dialog.className = "dialog active-bonus-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const tabs = document.createElement("div");
    tabs.className = "active-bonus-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Sección del bono activo");
    const createTab = (id, label, selected) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "active-bonus-tab";
      tab.id = `active-bonus-tab-${id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `active-bonus-panel-${id}`);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.textContent = label;
      tabs.append(tab);
      return tab;
    };
    const bonusTab = createTab("bonus", "Colocar Bono Activo", true);
    const settingsTab = createTab("settings", "Configuración", false);
    const bonusPanel = document.createElement("div");
    bonusPanel.className = "active-bonus-tab-panel";
    bonusPanel.id = "active-bonus-panel-bonus";
    bonusPanel.setAttribute("role", "tabpanel");
    bonusPanel.setAttribute("aria-labelledby", bonusTab.id);
    const settingsPanel = document.createElement("div");
    settingsPanel.className = "active-bonus-tab-panel";
    settingsPanel.id = "active-bonus-panel-settings";
    settingsPanel.setAttribute("role", "tabpanel");
    settingsPanel.setAttribute("aria-labelledby", settingsTab.id);
    settingsPanel.hidden = true;
    const setActiveTab = (tabName, moveFocus = false) => {
      const showSettings = tabName === "settings";
      bonusTab.setAttribute("aria-selected", String(!showSettings));
      bonusTab.tabIndex = showSettings ? -1 : 0;
      settingsTab.setAttribute("aria-selected", String(showSettings));
      settingsTab.tabIndex = showSettings ? 0 : -1;
      bonusPanel.hidden = showSettings;
      settingsPanel.hidden = !showSettings;
      if (moveFocus) (showSettings ? settingsTab : bonusTab).focus();
    };
    bonusTab.addEventListener("click", () => setActiveTab("bonus"));
    settingsTab.addEventListener("click", () => setActiveTab("settings"));
    tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextTab = event.key === "Home" || event.key === "ArrowLeft"
        ? "bonus"
        : "settings";
      setActiveTab(nextTab, true);
    });
    const typeSelector = document.createElement("div");
    typeSelector.className = "active-bonus-type-selector";
    typeSelector.setAttribute("role", "group");
    typeSelector.setAttribute("aria-label", "Tipo de bono");
    const bonusTypes = [
      ["none", "Ninguno"],
      ["simple", "Simple"],
      ["double", "Doble"],
      ["specific", "Específico"],
      ["special", "Especial (+$10K)"],
      ["mysterious", "Misterioso"]
    ];
    let selectedBonusType = savedConfig?.type || "simple";
    for (const [value, label] of bonusTypes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "active-bonus-type-button";
      button.dataset.type = value;
      button.textContent = label;
      button.setAttribute("aria-pressed", String(value === selectedBonusType));
      button.addEventListener("click", () => {
        selectedBonusType = value;
        updateTypeFields();
      });
      typeSelector.append(button);
    }
    dialog.dataset.bonusType = selectedBonusType;
    const fields = document.createElement("div");
    fields.className = "active-bonus-fields";
    const content = document.createElement("div");
    content.className = "active-bonus-content";
    const percentInputs = {};
    const createPercentField = (key, labelText) => {
      const field = document.createElement("div");
      field.className = "active-bonus-percent-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      configureNumericInput(input);
      input.inputMode = "decimal";
      input.placeholder = "-";
      input.id = `${ACTIVE_BONUS_HOST_ID}-${key}`;
      label.htmlFor = input.id;
      input.setAttribute("aria-label", labelText);
      field.append(label, createInputAffix(input, "%", "suffix"));
      field.append(createPercentageShortcuts(input).element);
      percentInputs[key] = input;
      return field;
    };
    const groups = {};
    const createGroup = (type) => {
      const group = document.createElement("div");
      group.className = "active-bonus-type-fields";
      group.dataset.type = type;
      groups[type] = group;
      fields.append(group);
      return group;
    };

    const noneGroup = createGroup("none");
    const noneDescription = document.createElement("p");
    noneDescription.className = "active-bonus-none-description";
    noneDescription.textContent = "No se aplicará ningún bono automáticamente.";
    noneGroup.append(noneDescription);
    createGroup("simple").append(createPercentField("percent", "Porcentaje"));
    createGroup("double").append(
      createPercentField("ganamos", "Ganamos"),
      createPercentField("multipanel", "MultiPanel")
    );

    const specificGroup = createGroup("specific");
    const platformLabel = document.createElement("label");
    platformLabel.className = "active-bonus-platform-field";
    platformLabel.textContent = "Plataforma";
    const platformSelect = document.createElement("select");
    for (const [value, label] of [["ganamos", "Ganamos"], ["multipanel", "MultiPanel"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      platformSelect.append(option);
    }
    platformSelect.value = savedConfig?.platform || "ganamos";
    dialog.dataset.platform = platformSelect.value;
    platformLabel.append(platformSelect);
    specificGroup.append(platformLabel, createPercentField("specificPercent", "Porcentaje"));
    createGroup("special").append(
      createPercentField("underThreshold", "Menos de $10.000"),
      createPercentField("overThreshold", "Desde $10.000")
    );
    const mysteriousGroup = createGroup("mysterious");
    const probabilityHeading = document.createElement("p");
    probabilityHeading.className = "active-bonus-probability-heading";
    probabilityHeading.textContent = "Probabilidades por depósito";
    const outcomeList = document.createElement("div");
    outcomeList.className = "active-bonus-outcome-list";
    const outcomeRows = [];
    const updateOutcomeDenominators = () => {
      const totalWeight = outcomeRows.reduce((total, { weightInput }) =>
        total + (weightInput.value === "" ? 0 : Number(weightInput.value)), 0);
      for (const { weightInput } of outcomeRows) {
        const denominator = weightInput.closest(".input-affix")?.querySelector("span");
        if (denominator) denominator.textContent = `/${totalWeight}`;
      }
    };
    const addOutcomeRow = (outcome = { percent: null, weight: 0 }) => {
      const row = document.createElement("div");
      row.className = "active-bonus-outcome-row";
      const percentField = document.createElement("span");
      percentField.className = "active-bonus-outcome-field";
      const percentInput = document.createElement("input");
      configureNumericInput(percentInput);
      percentInput.placeholder = "%";
      percentInput.setAttribute("aria-label", "Porcentaje del sorteo");
      percentField.append(createInputAffix(percentInput, "%", "suffix"));
      const weightField = document.createElement("span");
      weightField.className = "active-bonus-outcome-field";
      const weightInput = document.createElement("input");
      weightInput.type = "number";
      weightInput.min = "0";
      weightInput.step = "1";
      weightInput.value = String(outcome.weight);
      weightInput.setAttribute("aria-label", "Peso de probabilidad");
      weightField.append(createInputAffix(weightInput, "/0", "suffix"));
      weightInput.addEventListener("input", updateOutcomeDenominators);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "active-bonus-outcome-remove";
      remove.textContent = "×";
      remove.title = "Eliminar este porcentaje";
      remove.setAttribute("aria-label", "Eliminar este porcentaje");
      remove.addEventListener("click", () => {
        row.remove();
        outcomeRows.splice(outcomeRows.indexOf(rowData), 1);
        updateOutcomeDenominators();
      });
      const rowData = { row, percentInput, weightInput };
      if (outcome.percent !== null && outcome.percent !== undefined) {
        percentInput.value = String(outcome.percent);
        percentInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      row.append(percentField, weightField, remove);
      outcomeList.append(row);
      outcomeRows.push(rowData);
      updateOutcomeDenominators();
    };
    const configuredOutcomes = savedConfig?.type === "mysterious"
      ? getMysteriousBonusOutcomes(savedConfig)
      : MYSTERIOUS_BONUS_WEIGHTS.map(([percent, weight]) => ({ percent, weight }));
    for (const outcome of configuredOutcomes) addOutcomeRow(outcome);
    const addOutcome = document.createElement("button");
    addOutcome.type = "button";
    addOutcome.className = "active-bonus-outcome-add secondary";
    addOutcome.textContent = "+ Agregar porcentaje";
    addOutcome.addEventListener("click", () => {
      addOutcomeRow();
      outcomeRows[outcomeRows.length - 1].percentInput.focus();
    });
    mysteriousGroup.append(probabilityHeading, outcomeList, addOutcome);
    const updateTypeFields = () => {
      dialog.dataset.bonusType = selectedBonusType;
      dialog.classList.toggle("has-mysterious-outcomes", selectedBonusType === "mysterious");
      for (const [type, group] of Object.entries(groups)) {
        group.hidden = type !== selectedBonusType;
      }
      for (const button of typeSelector.querySelectorAll(".active-bonus-type-button")) {
        button.setAttribute("aria-pressed", String(button.dataset.type === selectedBonusType));
      }
      platformLabel.hidden = selectedBonusType !== "specific";
    };
    platformSelect.addEventListener("change", () => {
      dialog.dataset.platform = platformSelect.value;
    });
    updateTypeFields();

    if (savedConfig) {
      for (const [key, input] of Object.entries(percentInputs)) {
        const value = key === "specificPercent"
          ? savedConfig.type === "specific" ? savedConfig.percent : null
          : savedConfig[key];
        if (value !== null && value !== undefined) {
          input.value = String(value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }

    const error = document.createElement("p");
    error.className = "active-bonus-error";
    error.hidden = true;
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const actionButtons = document.createElement("div");
    actionButtons.className = "dialog-action-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => root.replaceChildren());
    const createBonusSettingToggle = (text, checked) => {
      const label = document.createElement("label");
      label.className = "active-bonus-setting-toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      const toggleSwitch = document.createElement("span");
      toggleSwitch.className = "active-bonus-setting-switch";
      toggleSwitch.setAttribute("aria-hidden", "true");
      const toggleText = document.createElement("span");
      toggleText.textContent = text;
      label.append(input, toggleSwitch, toggleText);
      return { label, input };
    };
    const bonusSettings = document.createElement("div");
    bonusSettings.className = "active-bonus-settings";
    const { label: copyBonusLabel, input: copyBonusInput } =
      createBonusSettingToggle("Copiar Bono", savedConfig?.copyBonus === true);
    copyBonusLabel.classList.add("active-bonus-setting-toggle--copy");
    const { label: invertDepositButtonsLabel, input: invertDepositButtonsInput } =
      createBonusSettingToggle("Invertir B. Dep.", savedConfig?.invertDepositButtons === true);
    invertDepositButtonsLabel.classList.add("active-bonus-setting-toggle--invert");
    const { label: markUnreadLabel, input: markUnreadInput } =
      createBonusSettingToggle("Marcar No Leídos", savedConfig?.markUnreadAfterStatusUpdate === true);
    markUnreadLabel.classList.add("active-bonus-setting-toggle--unread");
    const { label: activeAdvertisingLabel, input: activeAdvertisingInput } =
      createBonusSettingToggle("Publi Activa", savedConfig?.activeAdvertising === true);
    const advertisingSetting = document.createElement("span");
    advertisingSetting.className = "active-bonus-advertising-setting";
    const advertisingPercentLabel = document.createElement("label");
    advertisingPercentLabel.className = "active-bonus-advertising-percent";
    advertisingPercentLabel.textContent = "Bono Publi";
    const advertisingPercentInput = document.createElement("input");
    configureNumericInput(advertisingPercentInput);
    advertisingPercentInput.inputMode = "decimal";
    advertisingPercentInput.placeholder = "%";
    advertisingPercentInput.setAttribute("aria-label", "Porcentaje de bono de publicidad");
    advertisingPercentInput.value = savedConfig?.advertisingPercent == null
      ? ""
      : formatBalance(savedConfig.advertisingPercent);
    advertisingPercentLabel.append(createInputAffix(advertisingPercentInput, "%", "suffix"));
    const updateAdvertisingPercentVisibility = () => {
      advertisingPercentLabel.hidden = !activeAdvertisingInput.checked;
    };
    activeAdvertisingInput.addEventListener("change", updateAdvertisingPercentVisibility);
    updateAdvertisingPercentVisibility();
    advertisingSetting.append(activeAdvertisingLabel, advertisingPercentLabel);
    bonusSettings.append(
      copyBonusLabel,
      invertDepositButtonsLabel,
      markUnreadLabel,
      advertisingSetting
    );
    const outageSettings = document.createElement("div");
    outageSettings.className = "platform-outage-settings";
    const outageHeading = document.createElement("span");
    outageHeading.className = "platform-outage-heading";
    outageHeading.textContent = "Disponibilidad de plataformas";
    const outageButtons = document.createElement("div");
    outageButtons.className = "platform-outage-buttons";
    for (const [platform, label] of [
      ["ganamos", "Ganamos Caído"],
      ["multipanel", "MultiPanel Caído"]
    ]) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "platform-outage-toggle";
      toggle.dataset.platform = platform;
      toggle.textContent = label;
      toggle.setAttribute("aria-pressed", String(savedOutageConfig[platform]));
      toggle.addEventListener("click", () =>
        void togglePlatformOutage(host, platform, toggle));
      outageButtons.append(toggle);
    }
    outageSettings.append(outageHeading, outageButtons);
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Guardar";
    actionButtons.append(cancel, save);
    actions.append(actionButtons);
    content.append(fields);
    const formLayout = document.createElement("div");
    formLayout.className = "active-bonus-layout";
    formLayout.append(typeSelector, content);
    const profileExceptions = document.createElement("section");
    profileExceptions.className = "active-bonus-profile-exceptions";
    const profileExceptionsLabel = document.createElement("div");
    profileExceptionsLabel.className = "active-bonus-profile-label";
    profileExceptionsLabel.textContent = "Perfiles (pulsa para excluirlos de la operación):";
    const profileList = document.createElement("div");
    profileList.className = "active-bonus-profile-list";
    const profileMessage = document.createElement("div");
    profileMessage.className = "active-bonus-profile-message";
    profileMessage.setAttribute("role", "status");
    profileMessage.setAttribute("aria-live", "polite");
    profileMessage.textContent = "Consultando perfiles secundarios conectados…";
    profileExceptions.append(profileExceptionsLabel, profileList, profileMessage);
    let excludedProfileIds = [];
    let primaryProfile = null;
    let connectedProfiles = [];
    const renderConnectedProfiles = () => {
      profileList.replaceChildren();
      const profiles = [
        ...(primaryProfile ? [primaryProfile] : []),
        ...connectedProfiles
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
        const excluded = excludedProfileIds.includes(profile.profileId);
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "active-bonus-profile-toggle";
        toggle.textContent = profile.name;
        toggle.title = profile.name;
        toggle.setAttribute("aria-pressed", String(!excluded));
        toggle.setAttribute(
          "aria-label",
          `${profile.name}, ${excluded ? "excluido del envío" : "incluido en el envío"}`
        );
        toggle.addEventListener("click", async () => {
          const nextExcluded = new Set(excludedProfileIds);
          if (excluded) nextExcluded.delete(profile.profileId);
          else nextExcluded.add(profile.profileId);
          profileMessage.dataset.state = "loading";
          profileMessage.textContent = "Guardando excepción…";
          for (const button of profileList.querySelectorAll("button")) {
            button.disabled = true;
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
          } catch (saveError) {
            profileMessage.dataset.state = "error";
            profileMessage.textContent =
              saveError.message || "No se pudieron guardar las excepciones.";
            for (const button of profileList.querySelectorAll("button")) {
              button.disabled = false;
            }
          }
        });
        profileList.append(toggle);
      }
    };
    const loadConnectedProfiles = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "BRIDGE_STATUS_PROFILES_GET"
        });
        if (!response?.ok || !Array.isArray(response.profiles) ||
          !Array.isArray(response.excludedProfileIds) ||
          typeof response.primaryProfile?.profileId !== "string" ||
          typeof response.primaryProfile?.name !== "string" ||
          response.profiles.some((profile) =>
            typeof profile?.profileId !== "string" ||
            typeof profile.name !== "string")) {
          throw new Error(response?.error || "No se pudieron consultar los perfiles secundarios.");
        }
        if (!profileExceptions.isConnected) return;
        connectedProfiles = response.profiles;
        primaryProfile = response.primaryProfile;
        excludedProfileIds = response.excludedProfileIds;
        profileMessage.dataset.state = "";
        renderConnectedProfiles();
      } catch (loadError) {
        if (!profileExceptions.isConnected) return;
        profileMessage.dataset.state = "error";
        profileMessage.textContent =
          loadError.message || "No se pudieron consultar los perfiles secundarios.";
      }
    };
    bonusPanel.append(formLayout);
    bonusPanel.append(profileExceptions);
    settingsPanel.append(bonusSettings, outageSettings);
    dialog.append(tabs, bonusPanel, settingsPanel, error, actions);
    modal.append(dialog);
    root.append(modal);
    void loadConnectedProfiles();

    dialog.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      const readPercent = (input) => {
        if (!input.value) return { value: null, invalid: false };
        const value = numericInputValue(input);
        return {
          value,
          invalid: value === null || !isValidBonusPercent(value) || !hasValidInputPrecision(input)
        };
      };
      const percentages = Object.fromEntries(Object.entries(percentInputs)
        .map(([key, input]) => [key, readPercent(input)]));
      const selectedType = selectedBonusType;
      const requiredKeys = {
        none: [],
        simple: ["percent"],
        double: ["ganamos", "multipanel"],
        specific: ["specificPercent"],
        special: ["underThreshold", "overThreshold"],
        mysterious: []
      }[selectedType];
      const relevantKeys = requiredKeys;
      const invalidPercent = relevantKeys.some((key) => percentages[key].invalid);
      const missingPercent = requiredKeys.some((key) => percentages[key].value === null);
      const advertisingPercent = advertisingPercentInput.value
        ? numericInputValue(advertisingPercentInput)
        : null;
      const invalidAdvertisingPercent = (activeAdvertisingInput.checked &&
        advertisingPercent === null) || (advertisingPercentInput.value &&
        (!isValidBonusPercent(advertisingPercent) ||
          !hasValidInputPrecision(advertisingPercentInput)));
      const mysteriousOutcomes = outcomeRows.map(({ percentInput, weightInput }) => ({
        percent: numericInputValue(percentInput),
        weight: weightInput.value === "" ? null : Number(weightInput.value)
      }));
      const invalidMysteriousOutcomes = selectedType === "mysterious" &&
        (mysteriousOutcomes.some((outcome, index) =>
          !isValidBonusPercent(outcome.percent) ||
          !hasValidInputPrecision(outcomeRows[index].percentInput) ||
          !Number.isSafeInteger(outcome.weight) || outcome.weight < 0) ||
          new Set(mysteriousOutcomes.map(({ percent }) => percent)).size !== mysteriousOutcomes.length ||
          !validateMysteriousBonusOutcomes(mysteriousOutcomes));
      if (invalidPercent || missingPercent || invalidMysteriousOutcomes || invalidAdvertisingPercent) {
        error.textContent = invalidPercent
          ? "Los porcentajes deben estar entre 0 y 100 y tener hasta dos decimales."
          : invalidAdvertisingPercent
            ? "Ingresá un porcentaje de publicidad válido entre 0 y 100, con hasta dos decimales."
          : missingPercent
            ? "Completá todos los porcentajes del tipo de bono seleccionado."
            : "Revisá los porcentajes y pesos: no debe haber porcentajes repetidos y la suma de los pesos debe ser mayor que cero.";
        error.hidden = false;
        return;
      }

      const config = {
        enabled: selectedType !== "none",
        type: selectedType,
        copyBonus: copyBonusInput.checked,
        invertDepositButtons: invertDepositButtonsInput.checked,
        markUnreadAfterStatusUpdate: markUnreadInput.checked,
        activeAdvertising: activeAdvertisingInput.checked,
        advertisingPercent
      };
      if (selectedType === "simple") config.percent = percentages.percent.value;
      if (selectedType === "double") {
        config.ganamos = percentages.ganamos.value;
        config.multipanel = percentages.multipanel.value;
      }
      if (selectedType === "specific") {
        config.platform = platformSelect.value;
        config.percent = percentages.specificPercent.value;
      }
      if (selectedType === "special") {
        config.underThreshold = percentages.underThreshold.value;
        config.overThreshold = percentages.overThreshold.value;
      }
      if (selectedType === "mysterious") config.outcomes = mysteriousOutcomes;

      save.disabled = true;
      try {
        await stateStorage.set({ [ACTIVE_BONUS_CONFIG_KEY]: config });
        updateActiveBonusButton(host, config);
        root.replaceChildren();
      } catch (saveError) {
        console.error("[Ganamos balance extension] No se pudo guardar la configuración del bono activo.", saveError);
        error.textContent = "No se pudo guardar la configuración. Intentá nuevamente.";
        error.hidden = false;
      } finally {
        save.disabled = false;
      }
    });
    cancel.focus();
  }

  function createActiveBonusHost() {
    let host = document.getElementById(ACTIVE_BONUS_HOST_ID);
    if (host) return host;

    host = document.createElement("div");
    host.id = ACTIVE_BONUS_HOST_ID;
    host.style.left = "13px";
    host.style.bottom = "95px";
    host.style.width = "38px";
    host.style.height = "58px";
    host.style.pointerEvents = "none";
    host.style.visibility = "hidden";
    host.style.display = "none";

    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("styles/whatsapp.css");
    stylesheet.addEventListener("load", () => {
      host.style.visibility = "";
    }, { once: true });
    stylesheet.addEventListener("error", () => {
      console.error("[Ganamos balance extension] No se pudo cargar styles/whatsapp.css para el bono activo.");
      host.style.visibility = "";
    }, { once: true });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "active-bonus-button";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const definitions = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    gradient.id = "active-bonus-icon-gradient";
    gradient.setAttribute("x1", "0");
    gradient.setAttribute("y1", "0");
    gradient.setAttribute("x2", "1");
    gradient.setAttribute("y2", "1");
    for (const [offset, color] of [["0%", "#c08cff"], ["100%", "#70b7ff"]]) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      gradient.append(stop);
    }
    definitions.append(gradient);
    icon.append(definitions);
    const giftIcon = document.createElementNS("http://www.w3.org/2000/svg", "g");
    giftIcon.classList.add("active-bonus-icon-gift");
    const giftPaths = [
      ["path", "M3 10h18v11H3z"],
      ["path", "M2 7h20v3H2z"],
      ["path", "M12 7v14"],
      ["path", "M12 7H7.5a2.5 2.5 0 1 1 2.2-3.7L12 7Z"],
      ["path", "M12 7h4.5a2.5 2.5 0 1 0-2.2-3.7L12 7Z"]
    ];
    for (const [tag, pathData] of giftPaths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", tag);
      path.setAttribute("d", pathData);
      giftIcon.append(path);
    }
    const settingsIcon = document.createElementNS("http://www.w3.org/2000/svg", "g");
    settingsIcon.classList.add("active-bonus-icon-settings");
    for (const pathData of [
      "M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z",
      "M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.3.9a7.8 7.8 0 0 0-2.6-1.5L14 2h-4l-.5 2.9a7.8 7.8 0 0 0-2.6 1.5l-2.3-.9-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.3-.9a7.8 7.8 0 0 0 2.6 1.5L10 21h4l.5-2.9a7.8 7.8 0 0 0 2.6-1.5l2.3.9 2-3.5-2-1.5Z"
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      settingsIcon.append(path);
    }
    icon.append(giftIcon, settingsIcon);
    button.append(icon);
    button.title = "Colocar bono activo";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => void openActiveBonusDialog(host));
    const indicators = document.createElement("div");
    indicators.className = "active-bonus-indicators";
    indicators.setAttribute("aria-label", "Preferencias de bonos y publicidad");
    const outageLabel = document.createElement("span");
    outageLabel.className = "platform-outage-label";
    outageLabel.setAttribute("role", "status");
    outageLabel.setAttribute("aria-live", "polite");
    const analyticsIndicators = document.createElement("div");
    analyticsIndicators.className = "active-bonus-analytics-indicators";
    const createIndicator = (name, label, paths) => {
      const isButton = name === "advertising" || name === "withdrawals";
      const indicator = document.createElement(isButton ? "button" : "span");
      if (isButton) {
        indicator.type = "button";
        indicator.addEventListener("click", () => name === "withdrawals"
          ? createWithdrawalHistoryDialog(host)
          : createAdvertisingAnalyticsDialog(host));
      }
      indicator.className = `active-bonus-indicator active-bonus-indicator--${name}`;
      indicator.title = isButton
        ? `${label}: abrir ${name === "withdrawals" ? "historial" : "estadísticas"}`
        : label;
      indicator.setAttribute("aria-label", indicator.title);
      if (!isButton) indicator.setAttribute("role", "img");
      const indicatorIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      indicatorIcon.setAttribute("viewBox", "0 0 24 24");
      indicatorIcon.setAttribute("aria-hidden", "true");
      indicatorIcon.setAttribute("focusable", "false");
      for (const pathData of paths) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData);
        indicatorIcon.append(path);
      }
      indicator.append(indicatorIcon);
      return indicator;
    };
    analyticsIndicators.append(
      createIndicator("withdrawals", "Retiros", [
        "M6 3h12v18H6z",
        "M9 8h6",
        "M9 12h6",
        "M9 16h3",
        "M16 16h2"
      ]),
      createIndicator("advertising", "Publicidad activa", [
        "M3 11v2h3l11 5V6L6 11H3Z",
        "M6 13l2 6h4l-2.7-4.8",
        "M20 9c1.2 1.7 1.2 4.3 0 6"
      ])
    );
    indicators.append(outageLabel, analyticsIndicators);
    const settingsIndicators = document.createElement("span");
    settingsIndicators.className = "active-bonus-setting-indicators";
    settingsIndicators.append(
      createIndicator("unread", "Marcar No Leídos", [
        "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z",
        "M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z"
      ]),
      createIndicator("copy", "Copiar Bono", [
        "M8 8V4a2 2 0 0 1 2-2h9l3 3v13a2 2 0 0 1-2 2h-4",
        "M3 8h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"
      ]),
      createIndicator("invert", "Invertir botones de depósito", [
        "M7 3v18m0 0-4-4m4 4 4-4",
        "M17 21V3m0 0-4 4m4-4 4 4"
      ])
    );
    indicators.append(settingsIndicators);
    const percentLabel = document.createElement("span");
    percentLabel.className = "active-bonus-percent-label";
    const label = document.createElement("span");
    label.className = "active-bonus-type-label";
    const root = document.createElement("div");
    root.className = "active-bonus-dialog-root";
    shadow.append(stylesheet, button, indicators, percentLabel, label, root);
    button.style.pointerEvents = "auto";
    root.style.pointerEvents = "auto";
    document.documentElement.append(host);
    if (remoteCreateDestinationsLoaded) updateActiveBonusVisibility();
    void readPlatformOutageConfig()
      .then((config) => {
        platformOutageConfig = config;
        renderPlatformOutageConfig(host);
      })
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudo cargar la configuración de plataformas caídas.",
        error
      ));
    void readActiveBonusConfig()
      .then((config) => updateActiveBonusButton(host, config))
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudo recuperar la configuración del bono activo.",
        error
      ));
    return host;
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
    setAgentBalancePanelWidth(host, minimized, hasErrors);
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
    setAgentBalancePanelWidth(host, agentBalanceView === "minimized", hasErrors);
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

  async function getConfiguredRemoteBalanceDestinations(host) {
    await loadRemoteCreateDestinations();
    const destinations = remoteCreateDestinations.filter((destination) =>
      typeof destination?.id === "string" && typeof destination.name === "string");
    setAgentBalancePanelWidth(
      host,
      agentBalanceView === "minimized",
      Object.keys(agentBalanceErrors).length > 0
    );
    return destinations;
  }

  async function renderRemoteAgentBalances(host, platform, label, amount, destinations) {
    const results = await Promise.all(destinations.map(async (destination) => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "REMOTE_AGENT_BALANCE_REQUEST",
          data: { destinationId: destination.id, platform }
        });
        if (!response?.ok) throw new Error(response?.error || "No se pudo consultar el balance.");
        const balance = Number(response.balance);
        if (!Number.isFinite(balance)) throw new Error("La PC devolvió un balance no numérico.");
        return { destination, balance, error: null };
      } catch (error) {
        return { destination, balance: null, error: error.message || "Error al consultar el balance." };
      }
    }));

    const readings = results.map(({ balance, error }) =>
      balance === null ? "Error" : `$${formatCurrency(balance)}`);
    const names = results.map(({ destination }) => destination.name);
    const failures = results.filter(({ error }) => error);
    if (failures.length) {
      setAgentBalanceError(host, platform);
      reportAgentBalanceError(
        platform,
        failures.map(({ destination, error }) => `${destination.name}: ${error}`).join(" | ")
      );
    } else {
      setAgentBalanceError(host, platform);
      clearAgentBalanceErrorToast(platform);
    }
    amount.classList.toggle("agent-balance-error", failures.length > 0);
    amount.textContent = readings.join(" / ");
    amount.title = results.map(({ destination, balance, error }) =>
      `${destination.name}: ${error || `$${formatCurrency(balance)}`}`).join("\n");
    label.title = `${platform === "ganamos" ? "Ganamos" : "MultiPanel"}: ${names.join(" / ")}`;
  }

  async function renderAgentMovements(host, view = agentBalanceView) {
    const movementView = host.shadowRoot?.querySelector(".agent-movement-view");
    const list = movementView?.querySelector(".agent-movement-list");
    if (!movementView || !list) return;
    const contactKey = agentBalanceContactKey;
    list.replaceChildren();

    try {
      const now = new Date();
      const start = view === "daily"
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : view === "weekly"
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7)
          : view === "monthly"
            ? new Date(now.getFullYear(), now.getMonth(), 1)
            : null;
      const storedMovements = await stateStorage.getMovements({
        ownProfile: true,
        ...(contactKey ? getMovementAccountFilter(contactKey) : {}),
        ...(start ? { since: start.getTime() } : {})
      });
      if (contactKey !== agentBalanceContactKey || view !== agentBalanceView) return;
      const allMovements = storedMovements
        .filter((record) => ["deposit", "withdrawal"].includes(record?.operation))
        .sort((first, second) => second.timestamp - first.timestamp);
      const movements = allMovements
        .filter((record) => record.status !== "pending-verification");
      const pendingDeposits = allMovements
        .filter((record) =>
          record.operation === "deposit" && record.status === "pending-verification");

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
      const selectedPendingDeposits = start && end
        ? pendingDeposits.filter((movement) =>
          movement.timestamp >= start.getTime() && movement.timestamp < end.getTime())
        : pendingDeposits;
      const periodName = {
        daily: "Hoy",
        weekly: "Sem.",
        monthly: "Mes",
        total: "Total"
      }[view] || "Total";

      if (!selectedMovements.length && !selectedPendingDeposits.length) {
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

      if (selectedMovements.length) {
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
      }
      if (selectedPendingDeposits.length) {
        const pendingTotal = selectedPendingDeposits
          .reduce((sum, movement) => sum + movement.amount, 0);
        const row = document.createElement("div");
        row.className = "agent-movement-total";
        const name = document.createElement("span");
        name.className = "agent-movement-pending";
        name.textContent = `Cargas pendientes (${selectedPendingDeposits.length}) ${periodName}`;
        const amount = document.createElement("span");
        amount.className = "agent-movement-pending";
        amount.classList.add("agent-movement-copy-value");
        amount.addEventListener("click", () => selectCurrencyAmount(amount));
        amount.textContent = `$${formatCurrency(pendingTotal)}`;
        row.append(name, amount);
        list.append(row);
      }
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudieron cargar los movimientos.", error);
      if (contactKey !== agentBalanceContactKey || view !== agentBalanceView) return;
      const failure = document.createElement("div");
      failure.className = "agent-movement-empty agent-movement-error";
      failure.textContent =
        `No se pudieron cargar los movimientos: ${error.message || "error desconocido."}`;
      list.append(failure);
    }
  }

  async function saveAgentMovement(
    contactKey,
    operation,
    amount,
    platform,
    {
      username,
      transactionAmount,
      bonusAmount,
      fromPlatform,
      toPlatform,
      status,
      verification,
      depositType
    }
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
      ...(verification ? { verification } : {}),
      ...(operation === "deposit" && depositType ? { depositType } : {})
    };
    const accountIds = getMovementAccountIds(
      contactKey,
      operation === "exchange" ? [fromPlatform, toPlatform] : [platform]
    );
    if (accountIds.length) record.accountIds = accountIds;
    const recordKey = `${AGENT_MOVEMENT_PREFIX}${record.timestamp}:${crypto.randomUUID()}`;
    await stateStorage.set({ [recordKey]: record });
    if (operation === "withdrawal") {
      const host = document.getElementById(HOST_ID);
      if (host && host.dataset.accounts === contactKey) {
        void updateWithdrawalButtonState(host, contactKey);
      }
    }
  }

  async function findRecentUserWithdrawal(contactKey) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const movements = await stateStorage.getMovements({
      ...getMovementAccountFilter(contactKey),
      operation: "withdrawal",
      since: cutoff,
      limit: 1
    });
    return movements.filter((movement) =>
      Number.isFinite(movement.timestamp) &&
      Number.isFinite(movement.amount) &&
      ["ganamos", "multipanel"].includes(movement.platform) &&
      movement.timestamp <= Date.now())[0] || null;
  }

  async function updateWithdrawalButtonState(host, contactKey) {
    const button = host.shadowRoot?.querySelector('button[data-action="withdrawal"]');
    if (!button) return;
    if (host.recentWithdrawalTimer) {
      window.clearTimeout(host.recentWithdrawalTimer);
      host.recentWithdrawalTimer = null;
    }
    button.classList.remove("recent-withdrawal");
    button.textContent = "Retirar";
    button.title = "Retirar";

    try {
      const recentWithdrawal = await findRecentUserWithdrawal(contactKey);
      if (host.dataset.accounts !== contactKey) return;
      if (!recentWithdrawal) return;

      const withdrawalTime = new Intl.DateTimeFormat("es-AR", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(recentWithdrawal.timestamp);
      button.classList.add("recent-withdrawal");
      button.textContent = `Ret. (${withdrawalTime})`;
      button.title = `Hubo un retiro en las últimas 24 horas (${withdrawalTime})`;
      const timeUntilExpiry = recentWithdrawal.timestamp + 24 * 60 * 60 * 1000 - Date.now();
      if (timeUntilExpiry > 0) {
        host.recentWithdrawalTimer = window.setTimeout(
          () => void updateWithdrawalButtonState(host, contactKey),
          timeUntilExpiry + 100
        );
      }
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudo verificar si hubo un retiro reciente.", error);
    }
  }

  async function updateLastWithdrawalDisplay(host, contactKey) {
    const label = host.shadowRoot?.querySelector(".last-withdrawal");
    if (!label) return;
    label.hidden = true;
    try {
      const [lastWithdrawal] = await stateStorage.getMovements({
        ...getMovementAccountFilter(contactKey),
        operation: "withdrawal",
        limit: 1
      });
      if (host.dataset.accounts !== contactKey) return;
      if (!lastWithdrawal ||
        !Number.isFinite(lastWithdrawal.timestamp) ||
        !["ganamos", "multipanel"].includes(lastWithdrawal.platform) ||
        lastWithdrawal.timestamp > Date.now()) return;

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
      registerModalEscapeHandler(modal, () => {
        finish(false);
      });
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

  function confirmDisabledBonusDeposit(root, username, amount, bonus) {
    return new Promise((resolve) => {
      let answered = false;
      const finish = (shouldContinue) => {
        if (answered) return;
        answered = true;
        modal.remove();
        resolve(shouldContinue);
      };

      const modal = document.createElement("div");
      modal.className = "modal bonus-disabled-modal";
      registerModalEscapeHandler(modal, () => finish(false));
      modal.addEventListener("click", (event) => {
        if (event.target === modal) finish(false);
      });

      const dialog = document.createElement("section");
      dialog.className = "dialog";
      dialog.dataset.operation = "bonus-disabled-confirmation";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      const title = document.createElement("h2");
      title.textContent = "Bono desactivado";
      const message = document.createElement("p");
      message.className = "notice";
      message.textContent =
        `${username}: el depósito incluye un bono de $${formatCurrency(bonus)}. ¿Querés continuar con la carga de $${formatCurrency(amount + bonus)}?`;

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
      accept.className = "bonus-disabled-continue";
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

  async function startWithdrawal(host, { skipMovementRecord = false } = {}) {
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
      if (!skipMovementRecord) {
        const recentWithdrawal = await findRecentUserWithdrawal(contactKey);
        if (host.dataset.accounts !== contactKey) return;
        if (recentWithdrawal &&
          !(await confirmRecentWithdrawal(root, username, recentWithdrawal))) {
          return;
        }
      }
      if (host.dataset.accounts !== contactKey) return;
      await openTransactionDialog(host, "withdrawal", { skipMovementRecord });
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
    registerModalEscapeHandler(modal, () => {
      root.replaceChildren();
    });
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

    const tabs = document.createElement("div");
    tabs.className = "active-bonus-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Sección de movimientos");
    const createTab = (id, label, selected) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "active-bonus-tab";
      tab.id = `movement-history-tab-${id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `movement-history-panel-${id}`);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.textContent = label;
      tabs.append(tab);
      return tab;
    };
    const movementsTab = createTab("movements", "Movimientos", true);
    const settingsTab = createTab("settings", "Configuración", false);
    const movementsPanel = document.createElement("div");
    movementsPanel.className = "active-bonus-tab-panel";
    movementsPanel.id = "movement-history-panel-movements";
    movementsPanel.setAttribute("role", "tabpanel");
    movementsPanel.setAttribute("aria-labelledby", movementsTab.id);
    const settingsPanel = document.createElement("div");
    settingsPanel.className = "active-bonus-tab-panel movement-history-settings-panel";
    settingsPanel.id = "movement-history-panel-settings";
    settingsPanel.setAttribute("role", "tabpanel");
    settingsPanel.setAttribute("aria-labelledby", settingsTab.id);
    settingsPanel.hidden = true;
    const setSettingLabel = (element, emoji, text) => {
      const icon = document.createElement("span");
      icon.className = "movement-history-setting-emoji";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = emoji;
      element.append(icon, document.createTextNode(text));
    };
    const sportBetsSettingHeading = document.createElement("h3");
    sportBetsSettingHeading.className = "movement-history-settings-heading";
    sportBetsSettingHeading.textContent = "Apuestas deportivas";
    const sportBetsSetting = document.createElement("label");
    sportBetsSetting.className = "active-bonus-setting-toggle";
    const sportBetsDisabledInput = document.createElement("input");
    sportBetsDisabledInput.type = "checkbox";
    sportBetsDisabledInput.setAttribute("aria-label", "Desactivar detección de apuestas deportivas");
    const sportBetsSettingSwitch = document.createElement("span");
    sportBetsSettingSwitch.className = "active-bonus-setting-switch";
    const sportBetsSettingText = document.createElement("span");
    setSettingLabel(sportBetsSettingText, "⚽", "Desactivar detección");
    sportBetsSetting.append(sportBetsDisabledInput, sportBetsSettingSwitch, sportBetsSettingText);
    const bonusDisabledSetting = document.createElement("label");
    bonusDisabledSetting.className = "active-bonus-setting-toggle";
    const bonusDisabledInput = document.createElement("input");
    bonusDisabledInput.type = "checkbox";
    bonusDisabledInput.setAttribute("aria-label", "Bono Desactivado");
    const bonusDisabledSwitch = document.createElement("span");
    bonusDisabledSwitch.className = "active-bonus-setting-switch";
    const bonusDisabledText = document.createElement("span");
    setSettingLabel(bonusDisabledText, "⚠️", "Bono Desactivado");
    bonusDisabledSetting.append(bonusDisabledInput, bonusDisabledSwitch, bonusDisabledText);
    const accumulatesBonusesSetting = document.createElement("label");
    accumulatesBonusesSetting.className = "active-bonus-setting-toggle";
    const accumulatesBonusesInput = document.createElement("input");
    accumulatesBonusesInput.type = "checkbox";
    accumulatesBonusesInput.setAttribute("aria-label", "Acumula bonos");
    const accumulatesBonusesSwitch = document.createElement("span");
    accumulatesBonusesSwitch.className = "active-bonus-setting-switch";
    const accumulatesBonusesText = document.createElement("span");
    setSettingLabel(accumulatesBonusesText, "♻️", "Acumula bonos");
    accumulatesBonusesSetting.append(
      accumulatesBonusesInput,
      accumulatesBonusesSwitch,
      accumulatesBonusesText
    );
    const bonusSettingsToggleGroup = document.createElement("div");
    bonusSettingsToggleGroup.className = "movement-history-contact-tag-options";
    bonusSettingsToggleGroup.append(bonusDisabledSetting, accumulatesBonusesSetting);
    const bonusSettingHeading = document.createElement("h3");
    bonusSettingHeading.className = "movement-history-settings-heading";
    bonusSettingHeading.textContent = "Bono automático";
    const contactTagsHeading = document.createElement("h3");
    contactTagsHeading.className = "movement-history-settings-heading";
    contactTagsHeading.textContent = "Marcas del contacto";
    const userStatusHeading = document.createElement("h3");
    userStatusHeading.className = "movement-history-settings-heading";
    userStatusHeading.textContent = "Estado del usuario";
    const contactTagOptions = document.createElement("div");
    contactTagOptions.className = "movement-history-contact-tag-options";
    const createContactTagSetting = (text, ariaLabel, emoji) => {
      const setting = document.createElement("label");
      setting.className = "active-bonus-setting-toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-label", ariaLabel);
      const toggle = document.createElement("span");
      toggle.className = "active-bonus-setting-switch";
      const label = document.createElement("span");
      setSettingLabel(label, emoji, text);
      setting.append(input, toggle, label);
      return { setting, input };
    };
    const highDepositorTagSetting = createContactTagSetting("Cargador alto", "Cargador alto", "💸");
    const scammerTagSetting = createContactTagSetting("Peligro", "Peligro", "⛔");
    const blockedUserSetting = createContactTagSetting("Bloqueado", "Bloqueado", "🚫");
    contactTagOptions.append(highDepositorTagSetting.setting, scammerTagSetting.setting);
    const userStatusOptions = document.createElement("div");
    userStatusOptions.className = "movement-history-contact-tag-options";
    userStatusOptions.append(blockedUserSetting.setting);
    const relatedContactsHeading = document.createElement("h3");
    relatedContactsHeading.className = "movement-history-settings-heading";
    setSettingLabel(relatedContactsHeading, "↔️", "Contactos relacionados");
    const relatedContactsInput = document.createElement("textarea");
    relatedContactsInput.className = "movement-history-related-contacts";
    relatedContactsInput.rows = 2;
    relatedContactsInput.maxLength = 1200;
    relatedContactsInput.placeholder = "usuario1 / usuario2";
    relatedContactsInput.setAttribute("aria-label", "Contactos relacionados, separados por /");
    const withdrawalLimitLabel = document.createElement("label");
    withdrawalLimitLabel.className = "movement-history-withdrawal-limit";
    withdrawalLimitLabel.textContent = "Monto máximo";
    const withdrawalLimitInput = document.createElement("input");
    configureNumericInput(withdrawalLimitInput);
    withdrawalLimitInput.value = formatBalance(DEFAULT_WITHDRAWAL_LIMIT);
    withdrawalLimitInput.setAttribute("aria-label", "Monto máximo de retiro");
    withdrawalLimitLabel.append(createInputAffix(withdrawalLimitInput, "$"));
    const withdrawalLimitEntry = document.createElement("div");
    withdrawalLimitEntry.className = "amount-entry movement-history-limit-entry";
    withdrawalLimitEntry.append(withdrawalLimitLabel);
    const withdrawalLimitShortcuts = document.createElement("div");
    withdrawalLimitShortcuts.className = "amount-shortcuts withdrawal-limit-shortcuts";
    withdrawalLimitShortcuts.setAttribute("role", "group");
    withdrawalLimitShortcuts.setAttribute("aria-label", "Elegir monto máximo de retiro");
    const withdrawalLimitPresets = [100000, 150000, 200000, 250000, 300000];
    const updateWithdrawalLimitShortcuts = () => {
      const currentValue = numericInputValue(withdrawalLimitInput);
      for (const button of withdrawalLimitShortcuts.querySelectorAll("button")) {
        const amount = Number(button.dataset.amount);
        button.setAttribute("aria-pressed", String(amount === currentValue));
      }
    };
    for (const amount of withdrawalLimitPresets) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.amount = String(amount);
      const buttonLabel = document.createElement("span");
      buttonLabel.textContent = `$${formatBalance(amount)}`;
      button.append(buttonLabel);
      button.setAttribute("aria-label", `Establecer máximo en $${formatBalance(amount)}`);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        withdrawalLimitInput.value = formatBalance(amount);
        withdrawalLimitInput.dispatchEvent(new Event("input", { bubbles: true }));
        withdrawalLimitInput.dispatchEvent(new Event("change", { bubbles: true }));
        withdrawalLimitInput.focus();
      });
      withdrawalLimitShortcuts.append(button);
    }
    withdrawalLimitInput.addEventListener("input", updateWithdrawalLimitShortcuts);
    updateWithdrawalLimitShortcuts();
      const createSettingsSection = (heading, ...content) => {
        const section = document.createElement("section");
        section.className = "movement-history-settings-section";
        section.append(heading, ...content);
        return section;
      };
      const sportBetsSettingsSection = createSettingsSection(
        sportBetsSettingHeading,
        sportBetsSetting
      );
      const bonusSettingsSection = createSettingsSection(
        bonusSettingHeading,
        bonusSettingsToggleGroup
      );
      const contactTagsSettingsSection = createSettingsSection(
        contactTagsHeading,
        contactTagOptions
      );
      const userStatusSettingsSection = createSettingsSection(
        userStatusHeading,
        userStatusOptions
      );
      const relatedContactsSettingsSection = createSettingsSection(
        relatedContactsHeading,
        relatedContactsInput
      );
      const withdrawalSettingsHeading = document.createElement("h3");
      withdrawalSettingsHeading.className = "movement-history-settings-heading";
      withdrawalSettingsHeading.textContent = "Límite de retiro";
      const withdrawalSettingsSection = createSettingsSection(
        withdrawalSettingsHeading,
        withdrawalLimitEntry,
        withdrawalLimitShortcuts
      );
    settingsPanel.append(
        sportBetsSettingsSection,
        bonusSettingsSection,
        contactTagsSettingsSection,
        userStatusSettingsSection,
        relatedContactsSettingsSection,
        withdrawalSettingsSection
    );
    const setActiveTab = (tabName, moveFocus = false) => {
      const showSettings = tabName === "settings";
      dialog.dataset.settingsActive = String(showSettings);
      movementsTab.setAttribute("aria-selected", String(!showSettings));
      movementsTab.tabIndex = showSettings ? -1 : 0;
      settingsTab.setAttribute("aria-selected", String(showSettings));
      settingsTab.tabIndex = showSettings ? 0 : -1;
      movementsPanel.hidden = showSettings;
      settingsPanel.hidden = !showSettings;
      if (moveFocus) (showSettings ? settingsTab : movementsTab).focus();
    };
    movementsTab.addEventListener("click", () => setActiveTab("movements"));
    settingsTab.addEventListener("click", () => setActiveTab("settings"));
    tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextTab = event.key === "Home" || event.key === "ArrowLeft"
        ? "movements"
        : "settings";
      setActiveTab(nextTab, true);
    });

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
    const totals = document.createElement("div");
    totals.className = "movement-history-totals";
    totals.setAttribute("aria-live", "polite");
    const createTotal = (label, operation, colorClass) => {
      const item = document.createElement("span");
      item.className = `movement-history-total-item ${colorClass}`;
      item.dataset.operation = operation;
      item.title = label;
      item.setAttribute("aria-label", label);
      const value = document.createElement("span");
      value.className = "movement-history-total-value";
      item.append(value);
      totals.append(item);
      return { item, value, label };
    };
    const depositTotal = createTotal("Depósitos", "deposit", "movement-history-total-deposits");
    const bonusTotal = createTotal("Bonos", "bonus", "movement-history-total-bonuses");
    const withdrawalTotal = createTotal("Retiros", "withdrawal", "movement-history-total-withdrawals");
    const differenceTotal = createTotal("Diferencia", "difference", "movement-history-total-difference");
    movementsPanel.append(filters, dates, list, totals);
    dialog.append(heading, tabs, movementsPanel, settingsPanel);
    modal.append(dialog);
    root.append(modal);

    const platformUsernames = {
      ganamos: host.dataset.username,
      multipanel: host.dataset.multipanelUsername
    };
    const preferenceId = getSportBetsPreferenceId(host);
    const contactTagIdentities = getHostContactVisualTagIdentities(host);
    const userAccounts = Object.entries(platformUsernames)
      .filter(([, username]) => username);
    const defaultPlatform = host.dataset.defaultPlatform || "ganamos";
    title.textContent = `Movimientos ${platformUsernames[defaultPlatform] || ""}`.trim();
    let storedMovements = [];
    let savedWithdrawalLimit = DEFAULT_WITHDRAWAL_LIMIT;
    let savedRelatedContacts = "";

    const loadSportBetsSetting = async () => {
      sportBetsDisabledInput.disabled = true;
      bonusDisabledInput.disabled = true;
      accumulatesBonusesInput.disabled = true;
      highDepositorTagSetting.input.disabled = true;
      scammerTagSetting.input.disabled = true;
      blockedUserSetting.input.disabled = true;
      relatedContactsInput.disabled = true;
      withdrawalLimitInput.disabled = true;
      try {
        const [
          disabled,
          bonusDisabled,
          accumulatesBonuses,
          blocked,
          withdrawalLimit,
          loadedContactVisualTags,
          relatedContacts
        ] = await Promise.all([
          readSportBetsDisabled(preferenceId),
          readUserBonusDisabled(preferenceId),
          readUserAccumulatesBonuses(preferenceId),
          readUserBlocked(preferenceId),
          readUserWithdrawalLimit(preferenceId),
          loadContactVisualTags(),
          readUserRelatedContacts(preferenceId)
        ]);
        if (host.dataset.accounts !== contactKey || !root.contains(modal)) return;
        sportBetsDisabledInput.checked = disabled;
        bonusDisabledInput.checked = bonusDisabled;
        accumulatesBonusesInput.checked = accumulatesBonuses;
        blockedUserSetting.input.checked = blocked;
        const contactTags = getContactVisualTags(
          contactTagIdentities,
          loadedContactVisualTags
        );
        highDepositorTagSetting.input.checked = contactTags.highDepositor === true;
        scammerTagSetting.input.checked = contactTags.scammer === true;
        savedWithdrawalLimit = withdrawalLimit;
        withdrawalLimitInput.value = formatBalance(withdrawalLimit);
        savedRelatedContacts = relatedContacts;
        relatedContactsInput.value = relatedContacts;
        updateWithdrawalLimitShortcuts();
        updateUserBonusDisabledPresentation(host, bonusDisabled);
        updateUserAccumulatesBonusesPresentation(host, accumulatesBonuses);
        host.dataset.relatedContacts = relatedContacts;
        updateRelatedContactsIndicator(findContactTitle());
      } catch (error) {
        console.error(
          "[Ganamos balance extension] No se pudo cargar la configuración de apuestas deportivas.",
          error
        );
      } finally {
        if (root.contains(modal)) {
          sportBetsDisabledInput.disabled = false;
          bonusDisabledInput.disabled = false;
          accumulatesBonusesInput.disabled = false;
          highDepositorTagSetting.input.disabled = !contactTagIdentities.length;
          scammerTagSetting.input.disabled = !contactTagIdentities.length;
          blockedUserSetting.input.disabled = preferenceId.accounts.length === 0;
          relatedContactsInput.disabled = false;
          withdrawalLimitInput.disabled = false;
        }
      }
    };

    sportBetsDisabledInput.addEventListener("change", async () => {
      const disabled = sportBetsDisabledInput.checked;
      const previousDisabled = host.sportBetsDisabled === true;
      sportBetsDisabledInput.disabled = true;
      if (host.dataset.accounts === contactKey) host.sportBetsDisabled = disabled;
      try {
        await saveSportBetsDisabled(preferenceId, disabled);
        if (host.dataset.accounts !== contactKey || activeAccountsKey !== contactKey) return;
        if (disabled) {
          host.sportBetsStates = {};
          renderSportBetsCount(host);
          renderBalanceRows(host, userAccounts);
          updateSportBetsIndicator(findContactTitle(), false);
        } else {
          host.sportBetsStates ||= {};
          for (const [platform] of userAccounts) {
            host.sportBetsStates[platform] = {
              ...host.sportBetsStates[platform],
              loading: true
            };
          }
          renderSportBetsCount(host);
          renderBalanceRows(host, userAccounts);
          await refreshSportBetsCounts(host, userAccounts, contactKey, userAccounts);
        }
      } catch (error) {
        if (host.dataset.accounts === contactKey) {
          host.sportBetsDisabled = previousDisabled;
          if (!previousDisabled && activeAccountsKey === contactKey) {
            for (const [platform] of userAccounts) {
              host.sportBetsStates[platform] = {
                ...host.sportBetsStates[platform],
                loading: true
              };
            }
            renderSportBetsCount(host);
            renderBalanceRows(host, userAccounts);
            void refreshSportBetsCounts(host, userAccounts, contactKey, userAccounts);
          }
        }
        sportBetsDisabledInput.checked = previousDisabled;
        showToast(
          host,
          platformUsernames[host.dataset.defaultPlatform] || "Chat",
          error.message || "No se pudo guardar la configuración de apuestas deportivas.",
          "error"
        );
      } finally {
        if (root.contains(modal)) sportBetsDisabledInput.disabled = false;
      }
    });
    bonusDisabledInput.addEventListener("change", async () => {
      const disabled = bonusDisabledInput.checked;
      const previousDisabled = host.dataset.bonusDisabled === "true";
      bonusDisabledInput.disabled = true;
      if (host.dataset.accounts === contactKey) {
        updateUserBonusDisabledPresentation(host, disabled);
      }
      try {
        await saveUserBonusDisabled(preferenceId, disabled);
        if (host.dataset.accounts !== contactKey || activeAccountsKey !== contactKey) return;
      } catch (error) {
        if (host.dataset.accounts === contactKey) {
          updateUserBonusDisabledPresentation(host, previousDisabled);
        }
        bonusDisabledInput.checked = previousDisabled;
        showToast(
          host,
          platformUsernames[host.dataset.defaultPlatform] || "Chat",
          error.message || "No se pudo guardar la configuración del bono.",
          "error"
        );
      } finally {
        if (root.contains(modal)) bonusDisabledInput.disabled = false;
      }
    });
    accumulatesBonusesInput.addEventListener("change", async () => {
      const enabled = accumulatesBonusesInput.checked;
      const previousEnabled = host.dataset.accumulatesBonuses === "true";
      accumulatesBonusesInput.disabled = true;
      if (host.dataset.accounts === contactKey) {
        updateUserAccumulatesBonusesPresentation(host, enabled);
      }
      try {
        await saveUserAccumulatesBonuses(preferenceId, enabled);
        if (host.dataset.accounts !== contactKey || activeAccountsKey !== contactKey) return;
      } catch (error) {
        if (host.dataset.accounts === contactKey) {
          updateUserAccumulatesBonusesPresentation(host, previousEnabled);
        }
        accumulatesBonusesInput.checked = previousEnabled;
        showToast(
          host,
          platformUsernames[host.dataset.defaultPlatform] || "Chat",
          error.message || "No se pudo guardar la configuración Acumula bonos.",
          "error"
        );
      } finally {
        if (root.contains(modal)) accumulatesBonusesInput.disabled = false;
      }
    });
    const bindContactTagSetting = (input, tag) => {
      input.addEventListener("change", async () => {
        if (!contactTagIdentities.length) return;
        const previousValue = getContactVisualTags(contactTagIdentities)[tag] === true;
        input.disabled = true;
        try {
          await saveContactVisualTag(contactTagIdentities, tag, input.checked);
          if (host.dataset.accounts !== contactKey || activeAccountsKey !== contactKey) return;
        } catch (error) {
          input.checked = previousValue;
          showToast(
            host,
            platformUsernames[host.dataset.defaultPlatform] || "Chat",
            error.message || "No se pudo guardar la marca del contacto.",
            "error"
          );
        } finally {
          if (root.contains(modal)) input.disabled = false;
        }
      });
    };
    bindContactTagSetting(highDepositorTagSetting.input, "highDepositor");
    bindContactTagSetting(scammerTagSetting.input, "scammer");
    blockedUserSetting.input.addEventListener("change", async () => {
      const blocked = blockedUserSetting.input.checked;
      const previousBlocked = !blocked;
      blockedUserSetting.input.disabled = true;
      try {
        await saveUserBlocked(preferenceId, blocked);
        if (host.dataset.accounts !== contactKey || activeAccountsKey !== contactKey) return;
      } catch (error) {
        blockedUserSetting.input.checked = previousBlocked;
        showToast(
          host,
          platformUsernames[host.dataset.defaultPlatform] || "Chat",
          error.message || "No se pudo guardar la configuración Bloqueado.",
          "error"
        );
      } finally {
        if (root.contains(modal)) blockedUserSetting.input.disabled = false;
      }
    });
    relatedContactsInput.addEventListener("change", async () => {
      const previousContacts = savedRelatedContacts;
      const nextContacts = relatedContactsInput.value.trim();
      relatedContactsInput.disabled = true;
      try {
        await saveUserRelatedContacts(preferenceId, nextContacts);
        savedRelatedContacts = nextContacts;
        if (host.dataset.accounts !== contactKey || activeAccountsKey !== contactKey) return;
        host.dataset.relatedContacts = nextContacts;
        updateRelatedContactsIndicator(findContactTitle());
      } catch (error) {
        relatedContactsInput.value = previousContacts;
        showToast(
          host,
          platformUsernames[host.dataset.defaultPlatform] || "Chat",
          error.message || "No se pudieron guardar los contactos relacionados.",
          "error"
        );
      } finally {
        if (root.contains(modal)) relatedContactsInput.disabled = false;
      }
    });
    withdrawalLimitInput.addEventListener("change", async () => {
      const previousLimit = savedWithdrawalLimit;
      const nextLimit = numericInputValue(withdrawalLimitInput);
      if (!withdrawalLimitInput.value || !Number.isFinite(nextLimit) || nextLimit < 0 ||
        !hasValidInputPrecision(withdrawalLimitInput)) {
        withdrawalLimitInput.value = formatBalance(previousLimit);
        updateWithdrawalLimitShortcuts();
        return;
      }
      withdrawalLimitInput.disabled = true;
      try {
        await saveUserWithdrawalLimit(preferenceId, nextLimit);
        savedWithdrawalLimit = nextLimit;
        if (host.dataset.accounts !== contactKey || activeAccountsKey !== contactKey) return;
        host.dataset.withdrawalLimit = String(nextLimit);
        updateWithdrawalLimitIndicator(findContactTitle());
      } catch (error) {
        withdrawalLimitInput.value = formatBalance(previousLimit);
        updateWithdrawalLimitShortcuts();
        showToast(
          host,
          platformUsernames[host.dataset.defaultPlatform] || "Chat",
          error.message || "No se pudo guardar el monto máximo de retiro.",
          "error"
        );
      } finally {
        if (root.contains(modal)) withdrawalLimitInput.disabled = false;
      }
    });
    void loadSportBetsSetting();

    const openMovementEditDialog = (movement, editButton) => {
      const editorModal = document.createElement("div");
      editorModal.className = "modal movement-history-edit-modal";
      const closeEditor = () => {
        editorModal.remove();
        editButton.focus();
      };
      registerModalEscapeHandler(editorModal, closeEditor);
      editorModal.addEventListener("click", (event) => {
        if (event.target === editorModal) closeEditor();
      });

      const editor = document.createElement("form");
      editor.className = "dialog movement-history-edit-dialog";
      editor.dataset.operation = "movement-edit";
      editor.setAttribute("role", "dialog");
      editor.setAttribute("aria-modal", "true");
      const editorTitle = document.createElement("h2");
      editorTitle.textContent = "Editar movimiento";
      const dateLabel = document.createElement("label");
      dateLabel.textContent = "Fecha y horario";
      const dateInput = document.createElement("input");
      dateInput.type = "datetime-local";
      dateInput.required = true;
      dateInput.setAttribute("aria-label", "Fecha y horario del movimiento");
      const movementDate = new Date(movement.timestamp);
      const localDate = new Date(
        movement.timestamp - movementDate.getTimezoneOffset() * 60_000
      );
      dateInput.value = localDate.toISOString().slice(0, 16);
      dateLabel.append(dateInput);

      const amountLabel = document.createElement("label");
      amountLabel.textContent = movement.operation === "deposit" &&
        Number.isFinite(movement.transactionAmount)
        ? "Monto de la carga"
        : "Monto";
      const amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.min = "0.01";
      amountInput.step = "0.01";
      amountInput.required = true;
      amountInput.setAttribute("aria-label", amountLabel.textContent);
      const displayedAmount = movement.operation === "deposit" &&
        Number.isFinite(movement.transactionAmount)
        ? movement.transactionAmount
        : movement.amount;
      amountInput.value = String(displayedAmount);
      amountLabel.append(amountInput);

      const error = document.createElement("p");
      error.className = "movement-history-edit-error";
      error.setAttribute("role", "alert");
      error.hidden = true;
      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = "Cancelar";
      cancel.addEventListener("click", closeEditor);
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "Guardar cambios";
      actions.append(cancel, save);
      editor.append(editorTitle, dateLabel, amountLabel, error, actions);
      editorModal.append(editor);
      root.append(editorModal);

      editor.addEventListener("submit", async (event) => {
        event.preventDefault();
        const amount = Number(amountInput.value);
        const timestamp = new Date(dateInput.value).getTime();
        if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(timestamp)) {
          error.textContent = "Ingresá un horario y un monto válidos.";
          error.hidden = false;
          return;
        }
        if (host.dataset.accounts !== contactKey) {
          error.textContent = "El chat cambió; cerrá y volvé a abrir el historial.";
          error.hidden = false;
          return;
        }

        save.disabled = true;
        cancel.disabled = true;
        error.hidden = true;
        const { recordKey, ...record } = movement;
        const updatedMovement = { ...record, timestamp };
        if (movement.operation === "deposit" &&
          Number.isFinite(movement.transactionAmount)) {
          updatedMovement.transactionAmount = amount;
          updatedMovement.amount = amount +
            (Number.isFinite(movement.bonusAmount) ? movement.bonusAmount : 0);
        } else {
          updatedMovement.amount = amount;
        }
        try {
          await stateStorage.set({ [recordKey]: updatedMovement });
          storedMovements = storedMovements.map((candidate) =>
            candidate.recordKey === recordKey
              ? { ...updatedMovement, recordKey }
              : candidate
          ).sort((first, second) => second.timestamp - first.timestamp);
          closeEditor();
          renderMovements();
          const balanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
          if (balanceHost && agentBalanceContactKey === contactKey &&
            isAgentMovementView(agentBalanceView)) {
            void renderAgentMovements(balanceHost, agentBalanceView);
          }
          if (movement.operation === "withdrawal" && host.dataset.accounts === contactKey) {
            void updateWithdrawalButtonState(host, contactKey);
            void updateLastWithdrawalDisplay(host, contactKey);
          }
        } catch (saveError) {
          console.error("[Ganamos balance extension] No se pudo editar el movimiento.", saveError);
          error.textContent = saveError.message || "No se pudo guardar el movimiento.";
          error.hidden = false;
          save.disabled = false;
          cancel.disabled = false;
        }
      });
      dateInput.focus();
    };

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

      const sums = visibleMovements.reduce((total, movement) => {
        if (movement.operation === "deposit") {
          if (Number.isFinite(movement.transactionAmount)) {
            total.deposits += movement.transactionAmount;
          } else if (Number.isFinite(movement.bonusAmount)) {
            total.deposits += Math.max(0, movement.amount - movement.bonusAmount);
          } else {
            total.unknownDeposits += 1;
          }
          if (Number.isFinite(movement.bonusAmount)) {
            total.bonuses += movement.bonusAmount;
          }
        } else if (movement.operation === "withdrawal") {
          total.withdrawals += movement.amount;
        }
        return total;
      }, { deposits: 0, withdrawals: 0, bonuses: 0, unknownDeposits: 0 });
      depositTotal.value.textContent = `$${formatCurrency(sums.deposits)}`;
      withdrawalTotal.value.textContent = `$${formatCurrency(sums.withdrawals)}`;
      bonusTotal.value.textContent = `$${formatCurrency(sums.bonuses)}`;
      const difference = sums.deposits - sums.withdrawals;
      const differenceSign = difference > 0 ? "positive" : difference < 0 ? "negative" : "zero";
      differenceTotal.item.dataset.sign = differenceSign;
      differenceTotal.value.dataset.sign = differenceSign;
      differenceTotal.value.textContent = difference === 0
        ? `$${formatCurrency(0)}`
        : `${difference > 0 ? "+" : "−"}$${formatCurrency(Math.abs(difference))}`;
      for (const total of [depositTotal, withdrawalTotal, bonusTotal, differenceTotal]) {
        total.item.setAttribute("aria-label", `${total.label}: ${total.value.textContent}`);
      }
      if (sums.unknownDeposits) {
        const explanation = `No incluye ${sums.unknownDeposits} depósito(s) histórico(s) cuyo monto original y bono no se guardaron por separado.`;
        depositTotal.item.title = `Depósitos. ${explanation}`;
      } else {
        depositTotal.item.title = "Depósitos";
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
        if (movement.operation === "deposit" && movement.depositType === "advertising") {
          item.dataset.depositType = "advertising";
        }
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
        if (typeof movement.recordKey === "string" &&
          movement.recordKey.startsWith(AGENT_MOVEMENT_PREFIX)) {
          if (movement.operation === "deposit" && movement.status === "pending-verification") {
            const confirmMovement = document.createElement("button");
            confirmMovement.type = "button";
            confirmMovement.className = "movement-history-confirm";
            confirmMovement.textContent = "✓";
            confirmMovement.title = "Confirmar depósito";
            confirmMovement.setAttribute("aria-label", "Confirmar depósito pendiente");
            confirmMovement.addEventListener("click", async () => {
              if (!window.confirm(
                "¿Confirmás que este depósito fue acreditado? Solo confirmalo después de verificarlo en la plataforma."
              )) return;

              confirmMovement.disabled = true;
              try {
                const { recordKey, ...record } = movement;
                const verification = movement.verification &&
                  typeof movement.verification === "object" &&
                  !Array.isArray(movement.verification)
                  ? movement.verification
                  : {};
                const confirmedMovement = {
                  ...record,
                  status: "confirmed",
                  verification: {
                    ...verification,
                    status: "manually-confirmed",
                    manuallyConfirmedAt: Date.now()
                  }
                };
                await stateStorage.set({ [recordKey]: confirmedMovement });
                storedMovements = storedMovements.map((candidate) =>
                  candidate.recordKey === recordKey ? { ...confirmedMovement, recordKey } : candidate);
                renderMovements();
                const balanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
                if (balanceHost && agentBalanceContactKey === contactKey &&
                  isAgentMovementView(agentBalanceView)) {
                  void renderAgentMovements(balanceHost, agentBalanceView);
                }
                showToast(
                  host,
                  platformUsernames[movement.platform] || "Chat",
                  "Depósito marcado como confirmado.",
                  "success"
                );
              } catch (error) {
                console.error("[Ganamos balance extension] No se pudo confirmar el depósito pendiente.", error);
                confirmMovement.disabled = false;
                showToast(
                  host,
                  platformUsernames[movement.platform] || "Chat",
                  error.message || "No se pudo confirmar el depósito.",
                  "error"
                );
              }
            });
            item.append(confirmMovement);
          }
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "movement-history-edit";
          edit.title = "Editar fecha, horario y monto";
          edit.setAttribute("aria-label", `Editar fecha, horario y monto del movimiento de $${formatCurrency(movement.amount)}`);
          const editIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          editIcon.setAttribute("viewBox", "0 0 24 24");
          editIcon.setAttribute("aria-hidden", "true");
          const editPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          editPath.setAttribute("d", "m16.5 3.5 4 4M4 20l4.5-1 11-11a2.12 2.12 0 0 0-3-3l-11 11L4 20Zm0 0h4");
          editIcon.append(editPath);
          edit.append(editIcon);
          edit.addEventListener("click", () => openMovementEditDialog(movement, edit));
          item.append(edit);
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "movement-history-delete";
          remove.textContent = "×";
          remove.title = "Eliminar movimiento";
          remove.setAttribute("aria-label", "Eliminar movimiento");
          remove.addEventListener("click", async () => {
            const description = movement.operation === "deposit"
              ? "depósito"
              : movement.operation === "withdrawal"
                ? "retiro"
                : "intercambio";
            if (!window.confirm(
              `¿Eliminar este movimiento (${description} de $${formatCurrency(movement.amount)})? Esta acción no se puede deshacer.`
            )) return;

            remove.disabled = true;
            try {
              await stateStorage.remove(movement.recordKey);
              storedMovements = storedMovements.filter((candidate) =>
                candidate.recordKey !== movement.recordKey);
              renderMovements();
              const balanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
              if (balanceHost && agentBalanceContactKey === contactKey &&
                isAgentMovementView(agentBalanceView)) {
                void renderAgentMovements(balanceHost, agentBalanceView);
              }
              if (movement.operation === "withdrawal" && host.dataset.accounts === contactKey) {
                void updateWithdrawalButtonState(host, contactKey);
                void updateLastWithdrawalDisplay(host, contactKey);
              }
            } catch (error) {
              console.error("[Ganamos balance extension] No se pudo eliminar el movimiento.", error);
              remove.disabled = false;
              showToast(
                host,
                platformUsernames[movement.platform] || "Chat",
                error.message || "No se pudo eliminar el movimiento.",
                "error"
              );
            }
          });
          item.append(remove);
        }
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
        const movements = await stateStorage.getMovements(getMovementAccountFilter(contactKey));
        if (host.dataset.accounts !== contactKey || !root.contains(modal)) return;
        const legacyUpdates = {};
        for (const movement of movements) {
          if (Array.isArray(movement.accountIds) || typeof movement.recordKey !== "string") continue;
          const accountIds = getMovementAccountIds(
            contactKey,
            movement.operation === "exchange"
              ? [movement.fromPlatform, movement.toPlatform]
              : [movement.platform]
          );
          if (accountIds.length) {
            const { recordKey, ...record } = movement;
            legacyUpdates[recordKey] = { ...record, accountIds };
          }
        }
        const legacyEntries = Object.entries(legacyUpdates);
        try {
          for (let index = 0; index < legacyEntries.length; index += 100) {
            await stateStorage.set(Object.fromEntries(legacyEntries.slice(index, index + 100)));
          }
        } catch (error) {
          console.error("[Ganamos balance extension] No se pudieron vincular movimientos heredados a las cuentas.", error);
          showToast(
            host,
            platformUsernames[defaultPlatform] || "Chat",
            `Se mostraron los movimientos anteriores, pero no se pudieron vincular para futuros cambios de nombre: ${error.message || "error desconocido."}`,
            "error"
          );
        }
        storedMovements = movements
          .filter((record) =>
            ["ganamos", "multipanel"].includes(record.platform))
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

  function createWithdrawalHistoryDialog(host) {
    const shadow = host.shadowRoot;
    if (!shadow || shadow.querySelector(".advertising-analytics-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.className = "advertising-analytics-backdrop";
    let closeDialog = () => backdrop.remove();
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog();
    });
    const dialog = document.createElement("section");
    dialog.className = "advertising-analytics-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "withdrawal-history-title");
    registerModalEscapeHandler(dialog, () => closeDialog());

    const header = document.createElement("header");
    header.className = "advertising-analytics-header";
    const title = document.createElement("h2");
    title.id = "withdrawal-history-title";
    title.textContent = "Historial de retiros";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "advertising-analytics-close";
    close.textContent = "×";
    close.title = "Cerrar historial";
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", () => closeDialog());
    header.append(title, close);

    const periods = document.createElement("div");
    periods.className = "advertising-analytics-periods";
    const shifts = document.createElement("div");
    shifts.className = "advertising-analytics-periods withdrawal-history-shifts";
    shifts.setAttribute("role", "group");
    shifts.setAttribute("aria-label", "Filtrar por turno");
    const customRange = document.createElement("div");
    customRange.className = "advertising-analytics-custom-range";
    customRange.hidden = true;
    const fromLabel = document.createElement("label");
    fromLabel.textContent = "Desde";
    const fromInput = document.createElement("input");
    fromInput.type = "datetime-local";
    fromInput.setAttribute("aria-label", "Fecha y hora desde");
    fromLabel.append(fromInput);
    const toLabel = document.createElement("label");
    toLabel.textContent = "Hasta";
    const toInput = document.createElement("input");
    toInput.type = "datetime-local";
    toInput.setAttribute("aria-label", "Fecha y hora hasta");
    toLabel.append(toInput);
    const rangeError = document.createElement("span");
    rangeError.className = "advertising-analytics-range-error";
    rangeError.setAttribute("role", "alert");
    customRange.append(fromLabel, toLabel, rangeError);

    const tabs = document.createElement("div");
    tabs.className = "advertising-analytics-tabs";
    tabs.classList.add("withdrawal-history-tabs");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Vista del historial de retiros");
    const body = document.createElement("div");
    body.className = "advertising-analytics-body";
    const tabButtons = new Map();
    let requestSequence = 0;
    let activeTab = "all";
    let activeFilters = {};
    let activePeriod = "today";
    const selectedShifts = new Set();
    let loadedWithdrawals = null;
    let profiles = [];
    let hiddenProfileIds = [];
    let canManageHiddenProfiles = true;
    let profileVisibilitySaveInProgress = false;

    const render = () => {
      if (!loadedWithdrawals) return;
      const filteredWithdrawals = selectedShifts.size === 0 || selectedShifts.size === 3
        ? loadedWithdrawals
        : loadedWithdrawals.filter((withdrawal) => {
          const hour = new Date(withdrawal.createdAt).getHours();
          return selectedShifts.has("night") && hour < 8 ||
            selectedShifts.has("morning") && hour >= 8 && hour < 16 ||
            selectedShifts.has("afternoon") && hour >= 16;
        });
      renderWithdrawalHistory(
        filteredWithdrawals,
        profiles,
        body,
        activeTab,
        hiddenProfileIds,
        canManageHiddenProfiles,
        profileVisibilitySaveInProgress,
        changeHiddenProfile,
        invertHiddenProfiles
      );
    };
    for (const [name, label] of [["all", "Todos"], ["profile", "P/Panel"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(name === activeTab));
      button.addEventListener("click", () => {
        activeTab = name;
        for (const [tabName, tabButton] of tabButtons) {
          tabButton.setAttribute("aria-pressed", String(tabName === activeTab));
        }
        render();
      });
      tabButtons.set(name, button);
      tabs.append(button);
    }

    const formatDateTimeInput = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const setRangeInputs = (filters) => {
      if (!Number.isSafeInteger(filters.from) || !Number.isSafeInteger(filters.to)) return;
      fromInput.value = formatDateTimeInput(new Date(filters.from));
      toInput.value = formatDateTimeInput(new Date(filters.to - 60_000));
    };
    const load = async (filters, period) => {
      const currentRequest = ++requestSequence;
      activeFilters = filters;
      activePeriod = period;
      loadedWithdrawals = null;
      for (const button of periods.querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.period === period));
      }
      rangeError.textContent = "";
      body.replaceChildren();
      const loading = document.createElement("p");
      loading.className = "advertising-analytics-state advertising-analytics-loading";
      loading.textContent = "Cargando retiros...";
      body.append(loading);
      try {
        const settings = await stateStorage.get([
          HIDDEN_ADVERTISING_PROFILES_KEY,
          "bridgeRole"
        ]);
        const savedProfileIds = settings[HIDDEN_ADVERTISING_PROFILES_KEY] ?? [];
        if (!Array.isArray(savedProfileIds) || savedProfileIds.length > 1000 ||
          savedProfileIds.some((profileId) =>
            typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) ||
          new Set(savedProfileIds).size !== savedProfileIds.length) {
          throw new Error("La configuración de paneles minimizados no es válida.");
        }
        const history = await stateStorage.getWithdrawals(filters);
        const { withdrawals } = history;
        if (!Array.isArray(withdrawals) || withdrawals.some((withdrawal) =>
          !withdrawal || typeof withdrawal.withdrawalId !== "string" ||
          typeof withdrawal.username !== "string" ||
          !Number.isSafeInteger(withdrawal.createdAt) ||
          !Number.isSafeInteger(withdrawal.completedAt) ||
          !Number.isSafeInteger(withdrawal.durationMs) ||
          typeof withdrawal.profileId !== "string" ||
          typeof withdrawal.profileName !== "string")) {
          throw new Error("La API de datos devolvió un historial de retiros incompleto.");
        }
        if (!Array.isArray(history.profiles) || history.profiles.some((profile) =>
          !profile || typeof profile.profile_id !== "string" ||
          !PROFILE_ID_PATTERN.test(profile.profile_id) ||
          typeof profile.profile_name !== "string")) {
          throw new Error("La API de datos devolvió una lista de paneles incompleta.");
        }
        if (!backdrop.isConnected || currentRequest !== requestSequence) return;
        hiddenProfileIds = savedProfileIds;
        canManageHiddenProfiles = settings.bridgeRole !== "secondary";
        profiles = history.profiles;
        loadedWithdrawals = withdrawals;
        render();
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo cargar el historial de retiros.", error);
        if (!backdrop.isConnected || currentRequest !== requestSequence) return;
        const failure = document.createElement("p");
        failure.className = "advertising-analytics-state advertising-analytics-error";
        failure.textContent =
          `No se pudo cargar el historial: ${error.message || "error desconocido."}`;
        body.replaceChildren(failure);
      }
    };
    const changeHiddenProfile = async (profileIds, shouldHide) => {
      if (!canManageHiddenProfiles || profileVisibilitySaveInProgress) return;
      profileVisibilitySaveInProgress = true;
      render();
      try {
        const targets = Array.isArray(profileIds) ? profileIds : [profileIds];
        const next = new Set(hiddenProfileIds);
        for (const profileId of targets) {
          if (shouldHide) next.add(profileId);
          else next.delete(profileId);
        }
        await stateStorage.set({
          [HIDDEN_ADVERTISING_PROFILES_KEY]: [...next].sort()
        });
        hiddenProfileIds = [...next].sort();
        profileVisibilitySaveInProgress = false;
        render();
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo guardar la configuración de paneles minimizados.", error);
        const failure = document.createElement("p");
        failure.className = "advertising-analytics-state advertising-analytics-error";
        failure.textContent =
          `No se pudo guardar la configuración: ${error.message || "error desconocido."}`;
        body.replaceChildren(failure);
      } finally {
        profileVisibilitySaveInProgress = false;
      }
    };
    const invertHiddenProfiles = async () => {
      if (!canManageHiddenProfiles || profileVisibilitySaveInProgress) return;
      profileVisibilitySaveInProgress = true;
      render();
      try {
        const hidden = new Set(hiddenProfileIds);
        const groups = new Map();
        for (const profile of profiles) {
          if (profile.profile_name.trim().toLocaleLowerCase() === "publi") continue;
          const key = profile.profile_name.trim().toLocaleLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(profile.profile_id);
        }
        const next = new Set(hiddenProfileIds);
        for (const profileIds of groups.values()) {
          const groupIsHidden = profileIds.some((profileId) => hidden.has(profileId));
          for (const profileId of profileIds) {
            if (groupIsHidden) next.delete(profileId);
            else next.add(profileId);
          }
        }
        const nextProfileIds = [...next].sort();
        await stateStorage.set({
          [HIDDEN_ADVERTISING_PROFILES_KEY]: nextProfileIds
        });
        hiddenProfileIds = nextProfileIds;
        profileVisibilitySaveInProgress = false;
        render();
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo invertir la selección de paneles.", error);
        const failure = document.createElement("p");
        failure.className = "advertising-analytics-state advertising-analytics-error";
        failure.textContent =
          `No se pudo invertir la selección: ${error.message || "error desconocido."}`;
        body.replaceChildren(failure);
      } finally {
        profileVisibilitySaveInProgress = false;
      }
    };
    const handleHiddenProfilesChanged = (changes, areaName) => {
      if (areaName !== "local" || !changes[HIDDEN_ADVERTISING_PROFILES_KEY] ||
        profileVisibilitySaveInProgress || !backdrop.isConnected) return;
      void load(activeFilters, activePeriod);
    };
    stateStorage.onChanged.addListener(handleHiddenProfilesChanged);
    closeDialog = () => {
      stateStorage.onChanged.removeListener(handleHiddenProfilesChanged);
      backdrop.remove();
    };

    for (const [period, label, getFilter] of getAnalyticsPeriodOptions()) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.period = period;
      button.textContent = label;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        const filters = period === "all" ? {} : getFilter();
        setRangeInputs(filters);
        void load(filters, period);
      });
      periods.append(button);
    }
    for (const [shift, label] of [
      ["night", "Turno Noche"],
      ["morning", "Turno Mañana"],
      ["afternoon", "Turno Tarde"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.shift = shift;
      button.textContent = label;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        if (selectedShifts.has(shift)) selectedShifts.delete(shift);
        else selectedShifts.add(shift);
        button.setAttribute("aria-pressed", String(selectedShifts.has(shift)));
        render();
      });
      shifts.append(button);
    }
    const customButton = document.createElement("button");
    customButton.type = "button";
    customButton.dataset.period = "custom";
    customButton.textContent = "Personalizado";
    customButton.setAttribute("aria-expanded", "false");
    customButton.setAttribute("aria-pressed", "false");
    customButton.addEventListener("click", () => {
      customRange.hidden = !customRange.hidden;
      customButton.setAttribute("aria-expanded", String(!customRange.hidden));
      customButton.setAttribute("aria-pressed", String(!customRange.hidden));
      if (!customRange.hidden) fromInput.focus();
    });
    periods.append(customButton);

    const parseDate = (value) => {
      if (!value) return null;
      const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (!parts) return null;
      const [, year, month, day, hour, minute] = parts.map(Number);
      const date = new Date(year, month - 1, day, hour, minute);
      return date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date.getHours() === hour &&
        date.getMinutes() === minute
        ? date
        : null;
    };
    const updateCustomRange = () => {
      const start = parseDate(fromInput.value);
      const selectedEnd = parseDate(toInput.value);
      const showRangeError = (message) => {
        requestSequence += 1;
        rangeError.textContent = message;
        if (!body.querySelector(".advertising-analytics-loading")) return;
        const state = document.createElement("p");
        state.className = "advertising-analytics-state";
        state.textContent = "Completá un rango válido para cargar los retiros.";
        body.replaceChildren(state);
      };
      if (!start || !selectedEnd) {
        showRangeError("Seleccioná ambas fechas para ver los retiros.");
        return;
      }
      if (start > selectedEnd) {
        showRangeError("La fecha desde debe ser anterior o igual a la fecha hasta.");
        return;
      }
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 0, 0);
      if (selectedEnd > endOfToday) {
        showRangeError("La fecha hasta no puede ser futura.");
        return;
      }
      rangeError.textContent = "";
      void load({ from: start.getTime(), to: selectedEnd.getTime() + 60_000 }, "custom");
    };
    const today = new Date();
    const maxToday = new Date(today);
    maxToday.setHours(23, 59, 0, 0);
    toInput.max = formatDateTimeInput(maxToday);
    fromInput.value = formatDateTimeInput(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
    toInput.value = formatDateTimeInput(today);
    fromInput.addEventListener("change", updateCustomRange);
    toInput.addEventListener("change", updateCustomRange);

    dialog.append(header, periods, shifts, customRange, tabs, body);
    backdrop.append(dialog);
    shadow.append(backdrop);
    void load(getCalendarDayFilter(0), "today");
  }

  function renderWithdrawalHistory(
    withdrawals,
    profiles,
    body,
    activeTab,
    hiddenProfileIds,
    canManageHiddenProfiles,
    profileVisibilitySaveInProgress,
    onToggleProfile,
    onInvertProfiles
  ) {
    body.replaceChildren();
    const tableWrap = document.createElement("div");
    tableWrap.className = "advertising-analytics-table-wrap";
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const labels = activeTab === "profile"
      ? ["Fecha y hora", "Usuario", "Tiempo hasta completar"]
      : ["Fecha y hora", "Usuario", "Tiempo hasta completar", "Computadora"];
    for (const label of labels) {
      const cell = document.createElement("th");
      cell.textContent = label;
      headerRow.append(cell);
    }
    head.append(headerRow);
    table.append(head);
    const bodyRows = document.createElement("tbody");
    const dateTime = new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short",
      timeStyle: "short"
    });
    const duration = (milliseconds) => {
      const minutes = Math.floor(milliseconds / 60_000);
      const hours = Math.floor(minutes / 60);
      return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
    };
    const durationClass = (milliseconds) => {
      if (milliseconds < 10 * 60_000) return "withdrawal-duration--fast";
      if (milliseconds < 15 * 60_000) return "withdrawal-duration--moderate";
      if (milliseconds <= 20 * 60_000) return "withdrawal-duration--slow";
      return "withdrawal-duration--late";
    };
    const appendRecord = (withdrawal) => {
      const row = document.createElement("tr");
      const values = [
        dateTime.format(new Date(withdrawal.createdAt)),
        withdrawal.username,
        duration(withdrawal.durationMs),
        ...(activeTab === "profile" ? [] : [withdrawal.profileName])
      ];
      for (const [index, value] of values.entries()) {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (index === 2) {
          cell.classList.add(durationClass(withdrawal.durationMs));
        }
        row.append(cell);
      }
      bodyRows.append(row);
    };
    const hiddenIds = new Set(hiddenProfileIds);
    const groupsByName = new Map();
    const profileGroupsById = new Map();
    for (const profile of profiles) {
      const name = profile.profile_name.trim();
      const key = name.toLocaleLowerCase();
      if (!groupsByName.has(key)) {
        groupsByName.set(key, {
          profileName: name,
          profileIds: [],
          hidden: false
        });
      }
      const group = groupsByName.get(key);
      group.profileIds.push(profile.profile_id);
      group.hidden ||= hiddenIds.has(profile.profile_id);
      profileGroupsById.set(profile.profile_id, group);
    }
    const profileGroups = [...groupsByName.values()];
    const visibleWithdrawals = withdrawals.filter((withdrawal) => {
      const group = profileGroupsById.get(withdrawal.profileId);
      return group ? !group.hidden : !hiddenIds.has(withdrawal.profileId);
    });
    const orderedWithdrawals = [...visibleWithdrawals].sort(
      (first, second) => second.createdAt - first.createdAt
    );

    if (activeTab === "profile") {
      const eligibleProfiles = profileGroups.filter(
        (group) => group.profileName.toLocaleLowerCase() !== "publi"
      );
      const appendPanelSettings = (title, hidden) => {
        const panelList = eligibleProfiles.filter(
          (group) => group.hidden === hidden
        );
        if (!panelList.length) return;
        const section = document.createElement("section");
        section.className = "advertising-analytics-section advertising-analytics-minimized";
        const heading = document.createElement("h3");
        heading.textContent = title;
        section.append(heading);
        const buttons = document.createElement("div");
        buttons.className = "advertising-analytics-minimized-buttons";
        for (const group of panelList) {
          const action = document.createElement("button");
          action.type = "button";
          action.className = "advertising-analytics-profile-action";
          action.textContent = group.profileName;
          action.disabled = !canManageHiddenProfiles || profileVisibilitySaveInProgress;
          action.title = canManageHiddenProfiles
            ? hidden
              ? `Habilitar ${group.profileName}`
              : `Deshabilitar ${group.profileName} en el historial de retiros`
            : "Solo el perfil principal puede cambiar los paneles.";
          action.setAttribute("aria-label", action.title);
          action.addEventListener("click", () => onToggleProfile(group.profileIds, !hidden));
          buttons.append(action);
        }
        section.append(buttons);
        body.append(section);
      };
      appendPanelSettings("Paneles activos", false);
      appendPanelSettings("Paneles deshabilitados", true);
      const invert = document.createElement("button");
      invert.type = "button";
      invert.className = "advertising-analytics-profile-action advertising-analytics-invert";
      invert.textContent = "Invertir selección";
      invert.disabled = !canManageHiddenProfiles || profileVisibilitySaveInProgress ||
        !eligibleProfiles.length;
      invert.title = canManageHiddenProfiles
        ? "Deshabilitar los paneles activos y habilitar los deshabilitados."
        : "Solo el perfil principal puede cambiar los paneles.";
      invert.addEventListener("click", () => onInvertProfiles());
      body.append(invert);
      if (!canManageHiddenProfiles) {
        const note = document.createElement("p");
        note.className = "advertising-analytics-note";
        note.textContent = "La configuración de paneles se hereda del perfil principal.";
        body.append(note);
      }

      const activeProfiles = eligibleProfiles.filter((group) => !group.hidden);
      for (const group of activeProfiles) {
        const groupProfileIds = new Set(group.profileIds);
        const profileWithdrawals = orderedWithdrawals.filter(
          (withdrawal) => groupProfileIds.has(withdrawal.profileId)
        );
        const section = document.createElement("section");
        section.className = "advertising-analytics-section";
        const heading = document.createElement("h3");
        heading.textContent = `${group.profileName} · ${profileWithdrawals.length} retiros`;
        section.append(heading);
        if (!profileWithdrawals.length) {
          const empty = document.createElement("p");
          empty.className = "advertising-analytics-state";
          empty.textContent = "Sin retiros registrados en este período.";
          section.append(empty);
          body.append(section);
          continue;
        }
        const panelWrap = document.createElement("div");
        panelWrap.className = "advertising-analytics-table-wrap";
        const panelTable = table.cloneNode(true);
        const panelBody = document.createElement("tbody");
        for (const withdrawal of profileWithdrawals) {
          const row = document.createElement("tr");
          const values = [
            dateTime.format(new Date(withdrawal.createdAt)),
            withdrawal.username,
            duration(withdrawal.durationMs)
          ];
          for (const [index, value] of values.entries()) {
            const cell = document.createElement("td");
            cell.textContent = value;
            if (index === 2) {
              cell.classList.add(durationClass(withdrawal.durationMs));
            }
            row.append(cell);
          }
          panelBody.append(row);
        }
        panelTable.append(panelBody);
        panelWrap.append(panelTable);
        section.append(panelWrap);
        body.append(section);
      }
      if (!eligibleProfiles.length) {
        const empty = document.createElement("p");
        empty.className = "advertising-analytics-state";
        empty.textContent = "No hay paneles disponibles.";
        body.append(empty);
      }
      return;
    }

    if (!orderedWithdrawals.length) {
      const emptyRow = document.createElement("tr");
      const emptyCell = document.createElement("td");
      emptyCell.colSpan = labels.length;
      emptyCell.textContent = "No hay retiros registrados en este período.";
      emptyRow.append(emptyCell);
      bodyRows.append(emptyRow);
    } else {
      for (const withdrawal of orderedWithdrawals) appendRecord(withdrawal);
    }
    table.append(bodyRows);
    tableWrap.append(table);
    body.append(tableWrap);
  }

  function createAdvertisingAnalyticsDialog(host) {
    const shadow = host.shadowRoot;
    if (!shadow) return;
    if (shadow.querySelector(".advertising-analytics-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.className = "advertising-analytics-backdrop";
    let closeDialog = () => backdrop.remove();
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog();
    });
    const dialog = document.createElement("section");
    dialog.className = "advertising-analytics-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "advertising-analytics-title");
    registerModalEscapeHandler(dialog, () => closeDialog());

    const header = document.createElement("header");
    header.className = "advertising-analytics-header";
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    title.id = "advertising-analytics-title";
    title.textContent = "Estadísticas de publicidad";
    heading.append(title);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "advertising-analytics-close";
    close.textContent = "×";
    close.title = "Cerrar estadísticas";
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", () => closeDialog());
    header.append(heading, close);

    const tabs = document.createElement("div");
    tabs.className = "advertising-analytics-tabs";
    const periods = document.createElement("div");
    periods.className = "advertising-analytics-periods";
    const customRange = document.createElement("div");
    customRange.className = "advertising-analytics-custom-range";
    customRange.hidden = true;
    const fromLabel = document.createElement("label");
    fromLabel.textContent = "Desde";
    const fromInput = document.createElement("input");
    fromInput.type = "datetime-local";
    fromInput.setAttribute("aria-label", "Fecha y hora desde");
    fromLabel.append(fromInput);
    const toLabel = document.createElement("label");
    toLabel.textContent = "Hasta";
    const toInput = document.createElement("input");
    toInput.type = "datetime-local";
    toInput.setAttribute("aria-label", "Fecha y hora hasta");
    toLabel.append(toInput);
    const rangeError = document.createElement("span");
    rangeError.className = "advertising-analytics-range-error";
    rangeError.setAttribute("role", "alert");
    customRange.append(fromLabel, toLabel, rangeError);
    const body = document.createElement("div");
    body.className = "advertising-analytics-body";

    let requestSequence = 0;
    let activeTab = "summary";
    let loadedStats = null;
    let activeFilters;
    let activePeriod = "current-month";
    let hiddenProfileIds = [];
    let canManageHiddenProfiles = true;
    let profileVisibilitySaveInProgress = false;
    const tabButtons = new Map();
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Sección de estadísticas");
    const selectTab = (tab) => {
      activeTab = tab;
      for (const [name, button] of tabButtons) {
        button.setAttribute("aria-pressed", String(name === activeTab));
      }
      if (loadedStats) {
        renderAdvertisingAnalytics(
          loadedStats,
          body,
          activeTab,
          hiddenProfileIds,
          canManageHiddenProfiles,
          profileVisibilitySaveInProgress,
          changeHiddenProfile,
          invertHiddenProfiles
        );
      }
    };
    for (const [name, label] of [
      ["summary", "Resumen"],
      ["platform", "P/Plataforma"],
      ["profile", "P/Panel"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(name === activeTab));
      button.addEventListener("click", () => selectTab(name));
      tabButtons.set(name, button);
      tabs.append(button);
    }
    const load = async (filters, period) => {
      const currentRequest = ++requestSequence;
      activeFilters = filters;
      activePeriod = period;
      loadedStats = null;
      for (const button of periods.querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.period === period));
      }
      rangeError.textContent = "";
      body.replaceChildren();
      const loading = document.createElement("p");
      loading.className = "advertising-analytics-state advertising-analytics-loading";
      loading.textContent = "Cargando estadísticas...";
      body.append(loading);
      try {
        const settings = await stateStorage.get([
          HIDDEN_ADVERTISING_PROFILES_KEY,
          "bridgeRole"
        ]);
        const savedProfileIds = settings[HIDDEN_ADVERTISING_PROFILES_KEY] ?? [];
        if (!Array.isArray(savedProfileIds) || savedProfileIds.length > 1000 ||
          savedProfileIds.some((profileId) =>
            typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) ||
          new Set(savedProfileIds).size !== savedProfileIds.length) {
          throw new Error("La configuración de paneles minimizados no es válida.");
        }
        hiddenProfileIds = savedProfileIds;
        canManageHiddenProfiles = settings.bridgeRole !== "secondary";
        const stats = await stateStorage.getAdvertisingStats(filters, hiddenProfileIds);
        if (!backdrop.isConnected || currentRequest !== requestSequence) return;
        loadedStats = stats;
        renderAdvertisingAnalytics(
          stats,
          body,
          activeTab,
          hiddenProfileIds,
          canManageHiddenProfiles,
          profileVisibilitySaveInProgress,
          changeHiddenProfile,
          invertHiddenProfiles
        );
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudieron cargar las estadísticas de publicidad.", error);
        if (!backdrop.isConnected || currentRequest !== requestSequence) return;
        const failure = document.createElement("p");
        failure.className = "advertising-analytics-state advertising-analytics-error";
        failure.textContent =
          `No se pudieron cargar las estadísticas: ${error.message || "error desconocido."}`;
        body.replaceChildren(failure);
      }
    };
    const changeHiddenProfile = async (profileIds, shouldHide) => {
      if (!canManageHiddenProfiles || profileVisibilitySaveInProgress) return;
      profileVisibilitySaveInProgress = true;
      try {
        const targets = Array.isArray(profileIds) ? profileIds : [profileIds];
        const next = new Set(hiddenProfileIds);
        for (const profileId of targets) {
          if (shouldHide) next.add(profileId);
          else next.delete(profileId);
        }
        await stateStorage.set({
          [HIDDEN_ADVERTISING_PROFILES_KEY]: [...next].sort()
        });
        profileVisibilitySaveInProgress = false;
        await load(activeFilters, activePeriod);
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo guardar la configuración de paneles minimizados.", error);
        const failure = document.createElement("p");
        failure.className = "advertising-analytics-state advertising-analytics-error";
        failure.textContent =
          `No se pudo guardar la configuración: ${error.message || "error desconocido."}`;
        body.replaceChildren(failure);
      } finally {
        profileVisibilitySaveInProgress = false;
      }
    };
    const invertHiddenProfiles = async () => {
      if (!canManageHiddenProfiles || profileVisibilitySaveInProgress) return;
      profileVisibilitySaveInProgress = true;
      try {
        const hidden = new Set(hiddenProfileIds);
        const groups = new Map();
        for (const profile of [
          ...(loadedStats?.profiles || []),
          ...(loadedStats?.hiddenProfiles || [])
        ]) {
          const key = profile.display_name.trim().toLocaleLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(profile.profile_id);
        }
        const next = new Set(hiddenProfileIds);
        for (const profileIds of groups.values()) {
          const groupIsHidden = profileIds.some((profileId) => hidden.has(profileId));
          for (const profileId of profileIds) {
            if (groupIsHidden) next.delete(profileId);
            else next.add(profileId);
          }
        }
        await stateStorage.set({
          [HIDDEN_ADVERTISING_PROFILES_KEY]: [...next].sort()
        });
        profileVisibilitySaveInProgress = false;
        await load(activeFilters, activePeriod);
      } catch (error) {
        console.error("[Ganamos balance extension] No se pudo invertir la selección de paneles.", error);
        const failure = document.createElement("p");
        failure.className = "advertising-analytics-state advertising-analytics-error";
        failure.textContent =
          `No se pudo invertir la selección: ${error.message || "error desconocido."}`;
        body.replaceChildren(failure);
      } finally {
        profileVisibilitySaveInProgress = false;
      }
    };
    const handleHiddenProfilesChanged = (changes, areaName) => {
      if (areaName !== "local" || !changes[HIDDEN_ADVERTISING_PROFILES_KEY] ||
        profileVisibilitySaveInProgress || !backdrop.isConnected) return;
      void load(activeFilters, activePeriod);
    };
    stateStorage.onChanged.addListener(handleHiddenProfilesChanged);
    closeDialog = () => {
      stateStorage.onChanged.removeListener(handleHiddenProfilesChanged);
      backdrop.remove();
    };
    const formatDateTime = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    for (const [period, label, getFilter] of getAnalyticsPeriodOptions()) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.period = period;
      button.textContent = label;
      button.setAttribute("aria-pressed", String(period === "current-month"));
      button.addEventListener("click", () => {
        const filters = getFilter();
        if (Number.isSafeInteger(filters.from) && Number.isSafeInteger(filters.to)) {
          fromInput.value = formatDateTime(new Date(filters.from));
          toInput.value = formatDateTime(new Date(filters.to - 60_000));
        }
        void load(filters, period);
      });
      periods.append(button);
    }
    const customButton = document.createElement("button");
    customButton.type = "button";
    customButton.dataset.period = "custom";
    customButton.textContent = "Personalizado";
    customButton.setAttribute("aria-expanded", "false");
    customButton.setAttribute("aria-pressed", "false");
    customButton.addEventListener("click", () => {
      customRange.hidden = !customRange.hidden;
      customButton.setAttribute("aria-expanded", String(!customRange.hidden));
      customButton.setAttribute("aria-pressed", String(!customRange.hidden));
      if (!customRange.hidden) fromInput.focus();
    });
    periods.append(customButton);
    const parseDate = (value) => {
      if (!value) return null;
      const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (!parts) return null;
      const [, year, month, day, hour, minute] = parts.map(Number);
      const date = new Date(year, month - 1, day, hour, minute);
      return date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date.getHours() === hour &&
        date.getMinutes() === minute
        ? date
        : null;
    };
    const updateCustomRange = () => {
      const start = parseDate(fromInput.value);
      const selectedEnd = parseDate(toInput.value);
      const showRangeError = (message) => {
        requestSequence += 1;
        rangeError.textContent = message;
        if (body.querySelector(".advertising-analytics-loading")) {
          const state = document.createElement("p");
          state.className = "advertising-analytics-state";
          state.textContent = "Completá un rango válido para cargar las estadísticas.";
          body.replaceChildren(state);
        }
      };
      if (!start || !selectedEnd) {
        showRangeError("Seleccioná ambas fechas para ver las estadísticas.");
        return;
      }
      if (start > selectedEnd) {
        showRangeError("La fecha desde debe ser anterior o igual a la fecha hasta.");
        return;
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endOfToday = new Date(today);
      endOfToday.setHours(23, 59, 0, 0);
      if (selectedEnd > endOfToday) {
        showRangeError("La fecha hasta no puede ser futura.");
        return;
      }
      rangeError.textContent = "";
      void load({
        from: start.getTime(),
        to: selectedEnd.getTime() + 60_000
      }, "custom");
    };
    const today = new Date();
    const maxToday = new Date(today);
    maxToday.setHours(23, 59, 0, 0);
    toInput.max = formatDateTime(maxToday);
    const defaultFrom = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    fromInput.value = formatDateTime(defaultFrom);
    toInput.value = formatDateTime(today);
    fromInput.addEventListener("change", updateCustomRange);
    toInput.addEventListener("change", updateCustomRange);
    dialog.append(header, periods, customRange, tabs, body);
    backdrop.append(dialog);
    shadow.append(backdrop);
    void load(getCalendarMonthFilter(), "current-month");
  }

  function renderAdvertisingAnalytics(
    stats,
    body,
    activeTab,
    hiddenProfileIds = [],
    canManageHiddenProfiles = false,
    profileVisibilitySaveInProgress = false,
    onToggleProfile = () => {},
    onInvertProfiles = () => {}
  ) {
    const summary = stats.summary;
    const money = (minor) => `$${formatCurrency(Number(minor || 0) / 100)}`;
    const count = (value) => new Intl.NumberFormat("es-AR").format(Number(value || 0));
    const rate = (value, total) => {
      const denominator = Number(total);
      return Number.isFinite(denominator) && denominator > 0
        ? `${(Number(value) / denominator * 100).toFixed(1)}%`
        : "—";
    };
    body.replaceChildren();

    if (activeTab === "summary") {
      const cards = document.createElement("div");
      cards.className = "advertising-analytics-kpis";
      for (const [label, value] of [
        ["Cargas confirmadas", count(summary.deposits)],
        ["Importe cargado", money(summary.transaction_minor)],
        ["Bonos otorgados", money(summary.bonus_minor)],
        ["Total acreditado", money(summary.credited_minor)]
      ]) {
        const card = document.createElement("div");
        card.className = "advertising-analytics-kpi";
        const name = document.createElement("span");
        name.textContent = label;
        const amount = document.createElement("strong");
        amount.textContent = value;
        card.append(name, amount);
        cards.append(card);
      }
      body.append(cards);

      const pending = document.createElement("p");
      pending.className = "advertising-analytics-pending";
      pending.textContent =
        `${count(summary.customers)} contactos identificados · ${count(summary.pending_deposits)} cargas pendientes excluidas de los importes.`;
      body.append(pending);

      for (const [tierKey, title] of [
        ["one_load", "Actual · retorno de 1 carga o más"],
        ["two_loads", "Retorno de 2 cargas o más"],
        ["more_than_five_loads", "Retorno de más de 5 cargas"]
      ]) {
        const tier = summary.return_tiers?.[tierKey];
        if (!tier) {
          throw new Error(`La API no devolvió los datos de retorno para «${title}».`);
        }
        const returns = document.createElement("section");
        returns.className = "advertising-analytics-section";
        const returnTitle = document.createElement("h3");
        returnTitle.textContent = title;
        const returnGrid = document.createElement("div");
        returnGrid.className = "advertising-analytics-return-grid";
        for (const [label, key] of [
          ["Depósitos posteriores", "customers_with_later_deposit"],
          ["Con publicidad", "customers_with_later_advertising"],
          ["1–7 días", "customers_returned_within_7_days"],
          ["8–30 días", "customers_returned_between_7_and_30_days"],
          ["Más de 30 días", "customers_returned_after_30_days"]
        ]) {
          const item = document.createElement("div");
          item.className = "advertising-analytics-return-item";
          const value = document.createElement("strong");
          value.textContent = `${count(tier[key])} (${rate(tier[key], tier.cohort_customers)})`;
          const name = document.createElement("span");
          name.textContent = label;
          item.append(value, name);
          returnGrid.append(item);
        }
        returns.append(returnTitle, returnGrid);
        body.append(returns);
      }
      return;
    }

    const tableConfig = activeTab === "platform"
      ? {
        title: "Por plataforma",
        rows: stats.platforms,
        getName: (row) => row.platform === "ganamos" ? "Ganamos" :
          row.platform === "multipanel" ? "MultiPanel" : row.platform || "Sin plataforma",
        profiles: false
      }
      : {
        title: "Por perfil Chrome",
        rows: stats.profiles,
        getName: (row) => row.display_name,
        profiles: true
      };
    const { title: titleText, getName, profiles } = tableConfig;
    let { rows } = tableConfig;
    if (profiles) {
      const groupedRows = new Map();
      for (const row of rows) {
        const name = getName(row).trim();
        const key = name.toLocaleLowerCase();
        if (!groupedRows.has(key)) {
          groupedRows.set(key, {
            ...row,
            display_name: name,
            profileIds: [],
            deposits: 0,
            customers: 0,
            returning_customers: 0,
            transaction_minor: 0,
            bonus_minor: 0,
            credited_minor: 0
          });
        }
        const group = groupedRows.get(key);
        group.profileIds.push(row.profile_id);
        for (const field of [
          "deposits",
          "customers",
          "returning_customers",
          "transaction_minor",
          "bonus_minor",
          "credited_minor"
        ]) {
          group[field] += Number(row[field] || 0);
        }
      }
      rows = [...groupedRows.values()];
    }
    const section = document.createElement("section");
    section.className = "advertising-analytics-section";
    const titleElement = document.createElement("h3");
    titleElement.textContent = titleText;
    const tableWrap = document.createElement("div");
    tableWrap.className = "advertising-analytics-table-wrap";
    const table = document.createElement("table");
    const headerRow = document.createElement("tr");
    for (const label of [
      "Origen",
      "Cargas",
      "Retorno",
      "% de Retorno",
      "Importe",
      "Bonos",
      ...(profiles ? ["Acción"] : [])
    ]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      headerRow.append(cell);
    }
    const tableHead = document.createElement("thead");
    tableHead.append(headerRow);
    const tableBody = document.createElement("tbody");
    const tableFoot = document.createElement("tfoot");
    if (!rows.length) {
      const emptyRow = document.createElement("tr");
      const emptyCell = document.createElement("td");
      emptyCell.colSpan = profiles ? 7 : 6;
      emptyCell.textContent = "Sin cargas confirmadas en este período.";
      emptyRow.append(emptyCell);
      tableBody.append(emptyRow);
    }
    const profileIdsForName = (name) => {
      const key = name.trim().toLocaleLowerCase();
      return [...new Set([
        ...(stats.profiles || []),
        ...(stats.hiddenProfiles || [])
      ].filter((profile) => profile.display_name.trim().toLocaleLowerCase() === key)
        .map((profile) => profile.profile_id))];
    };
    for (const row of rows) {
      const tableRow = document.createElement("tr");
      for (const value of [
        getName(row),
        count(row.deposits),
        count(row.returning_customers),
        rate(row.returning_customers, row.customers),
        money(row.transaction_minor),
        money(row.bonus_minor)
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tableRow.append(cell);
      }
      if (profiles) {
        const actionCell = document.createElement("td");
        const minimize = document.createElement("button");
        minimize.type = "button";
        minimize.className = "advertising-analytics-profile-action";
        minimize.textContent = "Minimizar";
        minimize.disabled = !canManageHiddenProfiles || profileVisibilitySaveInProgress;
        minimize.title = canManageHiddenProfiles
          ? `Minimizar ${getName(row)}`
          : "Solo el perfil principal puede cambiar los paneles minimizados.";
        minimize.setAttribute("aria-label", minimize.title);
        minimize.addEventListener("click", () =>
          onToggleProfile(profileIdsForName(getName(row)), true));
        actionCell.append(minimize);
        tableRow.append(actionCell);
      }
      tableBody.append(tableRow);
    }
    const totalRow = document.createElement("tr");
    for (const value of [
      "Total",
      count(summary.deposits),
      count(summary.customers_with_later_deposit),
      rate(summary.customers_with_later_deposit, summary.customers),
      money(summary.transaction_minor),
      money(summary.bonus_minor)
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      totalRow.append(cell);
    }
    if (profiles) {
      const actionCell = document.createElement("td");
      totalRow.append(actionCell);
    }
    tableFoot.append(totalRow);
    table.append(tableHead, tableBody, tableFoot);
    tableWrap.append(table);
    section.append(titleElement, tableWrap);
    if (profiles && hiddenProfileIds.length) {
      const minimized = document.createElement("div");
      minimized.className = "advertising-analytics-minimized";
      const minimizedTitle = document.createElement("h3");
      minimizedTitle.textContent = "Paneles minimizados";
      const minimizedButtons = document.createElement("div");
      minimizedButtons.className = "advertising-analytics-minimized-buttons";
      const hiddenNames = new Map();
      for (const profile of stats.hiddenProfiles || []) {
        const key = profile.display_name.trim().toLocaleLowerCase();
        if (!hiddenNames.has(key)) hiddenNames.set(key, {
          name: profile.display_name.trim(),
          profileIds: []
        });
        hiddenNames.get(key).profileIds.push(profile.profile_id);
      }
      for (const profileId of hiddenProfileIds) {
        const profile = (stats.hiddenProfiles || []).find(
          (hiddenProfile) => hiddenProfile.profile_id === profileId
        );
        const key = profile?.display_name.trim().toLocaleLowerCase() || `unknown:${profileId}`;
        if (!hiddenNames.has(key)) hiddenNames.set(key, {
          name: profile?.display_name.trim() || "Panel no disponible",
          profileIds: [profileId]
        });
        if (!hiddenNames.get(key).profileIds.includes(profileId)) {
          hiddenNames.get(key).profileIds.push(profileId);
        }
      }
      for (const group of hiddenNames.values()) {
        const profileName = group.name;
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "advertising-analytics-profile-action";
        restore.textContent = profileName;
        restore.disabled = !canManageHiddenProfiles || profileVisibilitySaveInProgress;
        restore.title = canManageHiddenProfiles
          ? `Devolver ${profileName} a la lista`
          : "Solo el perfil principal puede cambiar los paneles minimizados.";
        restore.setAttribute("aria-label", restore.title);
        restore.addEventListener("click", () => onToggleProfile([
          ...new Set([...group.profileIds, ...profileIdsForName(profileName)])
        ], false));
        minimizedButtons.append(restore);
      }
      const invert = document.createElement("button");
      invert.type = "button";
      invert.className = "advertising-analytics-profile-action advertising-analytics-invert";
      invert.textContent = "Invertir selección";
      invert.disabled = !canManageHiddenProfiles || profileVisibilitySaveInProgress;
      invert.title = canManageHiddenProfiles
        ? "Restaurar los paneles minimizados y minimizar los activos."
        : "Solo el perfil principal puede cambiar los paneles minimizados.";
      invert.addEventListener("click", () => onInvertProfiles());
      minimizedButtons.append(invert);
      minimized.append(minimizedTitle, minimizedButtons);
      if (!canManageHiddenProfiles) {
        const note = document.createElement("p");
        note.className = "advertising-analytics-note";
        note.textContent = "La configuración se hereda del perfil principal.";
        minimized.append(note);
      }
      section.append(minimized);
    }
    body.append(section);
  }

  function createAgentBalancePanel() {
    let host = document.getElementById(AGENT_BALANCE_HOST_ID);
    if (host) return host;

    host = document.createElement("div");
    host.id = AGENT_BALANCE_HOST_ID;
    host.style.left = "68px";
    host.style.top = "2px";
    setAgentBalancePanelWidth(
      host,
      agentBalanceView === "minimized",
      Object.keys(agentBalanceErrors).length > 0
    );
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
        await stateStorage.set({
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
      amount.addEventListener("click", () => void copyAgentBalanceAmount(host, amount));
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
    stateStorage.get(["agentBalanceView", "agentBalancesMinimized"])
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
      const destinations = await getConfiguredRemoteBalanceDestinations(host);
      if (destinations.length) {
        await renderRemoteAgentBalances(host, "ganamos", label, amount, destinations);
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: "AGENT_BALANCE_REQUEST" });
      if (!response?.ok) throw new Error(response?.error || "No se pudo consultar el balance del agente.");
      setAgentBalanceError(host, "ganamos");
      clearAgentBalanceErrorToast("ganamos");
      label.title = `Ganamos: $${formatCurrency(Number(response.balance))}`;
      amount.title = label.title;
      amount.textContent = `$${formatCurrency(Number(response.balance))}`;
    } catch (error) {
      label.title = `Ganamos: ${error.message || "error al consultar"}`;
      amount.classList.add("agent-balance-error");
      amount.title = label.title;
      amount.textContent = "Error";
      const message = error.message || "Error al consultar el balance.";
      setAgentBalanceError(host, "ganamos", message);
      reportAgentBalanceError("ganamos", message);
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
      const destinations = await getConfiguredRemoteBalanceDestinations(host);
      if (destinations.length) {
        await renderRemoteAgentBalances(host, "multipanel", label, amount, destinations);
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: "MULTIPANEL_AGENT_BALANCE_REQUEST" });
      if (!response?.ok) throw new Error(response?.error || "No se pudo consultar el balance del agente MultiPanel.");
      setAgentBalanceError(host, "multipanel");
      clearAgentBalanceErrorToast("multipanel");
      label.title = `MultiPanel: $${formatCurrency(Number(response.balance))}`;
      amount.title = label.title;
      amount.textContent = `$${formatCurrency(Number(response.balance))}`;
    } catch (error) {
      label.title = `MultiPanel: ${error.message || "error al consultar"}`;
      amount.classList.add("agent-balance-error");
      amount.title = label.title;
      amount.textContent = "Error";
      const message = error.message || "Error al consultar el balance.";
      setAgentBalanceError(host, "multipanel", message);
      reportAgentBalanceError("multipanel", message);
    } finally {
      multiPanelAgentBalanceLoading = false;
      refreshButtons.forEach((refresh) => { refresh.disabled = false; });
    }
  }

  async function copyAgentBalanceAmount(host, amount) {
    const match = amount.textContent.match(/\$\s*([\d.,]+)/);
    if (!match) return;
    const platform = amount.dataset.platform;
    const platformName = platform === "ganamos" ? "Ganamos" : "MultiPanel";
    await copyContactValue(
      host,
      platformName,
      match[1],
      "el balance",
      `copy-agent-balance:${platform}`
    );
  }

  function findPlatformUsernames(contactName) {
    const usernames = { ganamos: null, multipanel: null };
    const legacy = { ganamos: null, multipanel: null };
    let firstPlatform = null;
    const parseAlias = (part) => {
      const match = part
        .replace(/^[^\p{L}\p{N}._-]+/u, "")
        .replace(/[^\p{L}\p{M}\p{N}._-]+$/u, "")
        .match(/^([\p{L}\p{M}\p{N}._-]+?)([a-z])(\2*)$/iu);
      if (!match ||
        !/^(?=.*\p{L})(?=.*\d)[\p{L}\p{M}\p{N}._-]+$/u.test(match[1])) {
        return null;
      }
      return match;
    };
    const aliases = contactName.trim().split(/[\s/.\\]+/)
      .map(parseAlias)
      .filter(Boolean);

    for (const [, base, suffix, repeatedSuffix] of aliases) {
      const normalizedSuffix = suffix.toLowerCase();
      const fullSuffix = `${suffix}${repeatedSuffix}`.toLowerCase();
      const platform = normalizedSuffix === platformSuffixes.ganamos
        ? "ganamos"
        : normalizedSuffix === platformSuffixes.multipanel
          ? "multipanel"
          : null;
      if (platform) {
        firstPlatform ||= platform;
        usernames[platform] ||= `${base}${fullSuffix}`;
        continue;
      }
      const legacyPlatform = ["n", "t"].includes(normalizedSuffix)
        ? "ganamos"
        : ["z", "w", "p", "b"].includes(normalizedSuffix)
          ? "multipanel"
          : null;
      if (legacyPlatform && !legacy[legacyPlatform]) {
        legacy[legacyPlatform] = { base, username: `${base}${fullSuffix}` };
      }
    }
    return { ...usernames, legacy, firstPlatform };
  }

  function normalizeRescheduleUsername(username, suffix) {
    return username.trim().toLocaleLowerCase()
      .replace(new RegExp(`${suffix}+$`, "i"), suffix);
  }

  function getUsernameBase(username, platform) {
    const suffix = platformSuffixes[platform];
    return username.replace(new RegExp(`${suffix}+$`, "i"), "");
  }

  async function searchRescheduleCounterpart(base, platform) {
    const digitGroups = base.match(/\d{4,}/g) || [];
    const digits = digitGroups[digitGroups.length - 1]?.slice(-4) || "";
    if (!digits) {
      throw new Error("El usuario debe incluir al menos cuatro números consecutivos para buscar su cuenta complementaria.");
    }

    await loadRemoteCreateDestinations();
    const profiles = [
      {
        name: "Esta PC",
        suffix: platformSuffixes[platform],
        request: () => chrome.runtime.sendMessage({
          type: "USER_SEARCH_REQUEST",
          data: { digits }
        })
      },
      ...remoteCreateDestinations
        .filter((destination) =>
          typeof destination?.id === "string" &&
          typeof destination.name === "string" &&
          /^[a-z]$/i.test(destination[
            platform === "ganamos" ? "ganamosSuffix" : "multiPanelSuffix"
          ] || ""))
        .map((destination) => ({
          name: destination.name,
          suffix: destination[
            platform === "ganamos" ? "ganamosSuffix" : "multiPanelSuffix"
          ].toLowerCase(),
          request: () => chrome.runtime.sendMessage({
            type: "REMOTE_USER_SEARCH_REQUEST",
            data: { destinationId: destination.id, digits }
          })
        }))
    ];
    const results = await Promise.all(profiles.map(async (profile) => {
      try {
        const response = await profile.request();
        if (!response?.ok) {
          throw new Error(response?.error || "La búsqueda no se completó.");
        }
        const usernames = response[platform];
        if (!Array.isArray(usernames)) {
          throw new Error("La respuesta de búsqueda no tiene un formato válido.");
        }
        const suffix = profile.suffix;
        const expected = normalizeRescheduleUsername(`${base}${suffix}`, suffix);
        const match = usernames.find((username) =>
          typeof username === "string" &&
          normalizeRescheduleUsername(username, suffix) === expected);
        return {
          username: match || null,
          error: response.errors?.[platform] || null,
          profile: profile.name
        };
      } catch (error) {
        return {
          username: null,
          error: error.message || "No se pudo completar la búsqueda.",
          profile: profile.name
        };
      }
    }));

    const found = results.find((result) => result.username);
    if (found) return found.username;
    const errors = results.filter((result) => result.error)
      .map((result) => `${result.profile}: ${result.error}`);
    if (errors.length) {
      throw new Error(`No se pudo verificar si existe la cuenta complementaria. ${errors.join(" ")}`);
    }
    throw new Error(`No se encontró ${base}${platformSuffixes[platform]} en ${platform === "ganamos" ? "Ganamos" : "MultiPanel"}.`);
  }

  async function getRescheduledContactName(host) {
    const title = findContactTitle();
    const usernames = findPlatformUsernames(title?.textContent || "");
    const existing = {
      ganamos: usernames.ganamos || "",
      multipanel: usernames.multipanel || ""
    };
    const presentPlatforms = ["ganamos", "multipanel"]
      .filter((platform) => existing[platform]);
    if (!presentPlatforms.length) {
      throw new Error("No se encontró un usuario de Ganamos o MultiPanel en el nombre del contacto.");
    }

    const firstPlatform = usernames.firstPlatform || presentPlatforms[0];
    const secondPlatform = firstPlatform === "ganamos" ? "multipanel" : "ganamos";
    if (presentPlatforms.length === 2) {
      return `${existing[firstPlatform]}/${existing[secondPlatform]}`;
    }

    const sourcePlatform = presentPlatforms[0];
    const targetPlatform = sourcePlatform === "ganamos" ? "multipanel" : "ganamos";
    const username = existing[sourcePlatform];
    const base = getUsernameBase(username, sourcePlatform);
    if (!base || base === username) {
      throw new Error(`No se pudo identificar la base del usuario ${username}.`);
    }
    const counterpart = await searchRescheduleCounterpart(base, targetPlatform);
    if (document.getElementById(HOST_ID) !== host ||
      host.dataset.accounts !== host.dataset.rescheduleAccounts ||
      normalizeContactDisplayName(findContactTitle()?.textContent || "") !==
        host.dataset.rescheduleTitle) {
      throw new Error("El chat cambió durante la búsqueda. Volvé a abrir Reagendar en el contacto correcto.");
    }
    return `${username}/${counterpart}`;
  }

  function normalizeContactDisplayName(value) {
    return value.replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ").trim();
  }

  function findWhatsAppControls(root, labels) {
    const expected = new Set(labels.map((label) => label.toLocaleLowerCase()));
    return [...root.querySelectorAll('button,[role="button"]')]
      .filter(isRenderedVisible)
      .filter((control) => [
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.textContent
      ].some((label) => typeof label === "string" &&
        expected.has(label.replace(/\s+/g, " ").trim().toLocaleLowerCase())));
  }

  async function waitForWhatsAppElement(getter, description, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const element = getter();
      if (element) return element;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
    throw new Error(`No apareció ${description} en WhatsApp.`);
  }

  function findContactEditorDialog() {
    return [...document.querySelectorAll(
      '[role="dialog"],[aria-modal="true"],[data-animate-modal-popup="true"]'
    )].find((dialog) =>
      isRenderedVisible(dialog) &&
      [...dialog.querySelectorAll('input:not([type="hidden"])')].some(isRenderedVisible)) || null;
  }

  function getContactEditorFieldLabel(input) {
    return [
      input.getAttribute("aria-label"),
      input.getAttribute("placeholder"),
      ...[...(input.labels || [])].map((label) => label.textContent),
      input.parentElement?.textContent
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").toLocaleLowerCase();
  }

  function setContactEditorField(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (!setter) throw new Error("No se pudo actualizar el campo del nombre del contacto.");
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }

  async function renameWhatsAppContact(host, expectedName) {
    const originalTitle = findContactTitle();
    if (!originalTitle) throw new Error("No se encontró el encabezado del chat abierto.");
    const expectedTitle = normalizeContactDisplayName(expectedName);
    const isCurrentContact = () =>
      document.getElementById(HOST_ID) === host &&
      host.dataset.accounts === host.dataset.rescheduleAccounts &&
      normalizeContactDisplayName(findContactTitle()?.textContent || "") ===
        normalizeContactDisplayName(host.dataset.rescheduleTitle || "");
    const existingDialog = findContactEditorDialog();

    if (!existingDialog) {
      const opener = originalTitle.closest('button,[role="button"]') || originalTitle;
      opener.click();
    }

    const editButton = await waitForWhatsAppElement(() => {
      const matches = findWhatsAppControls(document, ["Editar", "Edit"]);
      return matches.length === 1 ? matches[0] : null;
    }, "la opción para editar el contacto");
    if (!isCurrentContact()) {
      throw new Error("El chat cambió antes de abrir la edición del contacto.");
    }
    editButton.click();

    const dialog = await waitForWhatsAppElement(
      findContactEditorDialog,
      "el formulario para editar el contacto"
    );
    if (!isCurrentContact()) {
      throw new Error("El chat cambió antes de editar el nombre del contacto.");
    }
    const inputs = [...dialog.querySelectorAll('input:not([type="hidden"])')]
      .filter((input) =>
        isRenderedVisible(input) &&
        !input.disabled &&
        ["text", ""].includes(input.type));
    if (!inputs.length || inputs.length > 2) {
      throw new Error("WhatsApp no mostró campos de nombre reconocibles para este contacto.");
    }
    const firstName = inputs.find((input) =>
      /\b(first name|nombre)\b/i.test(getContactEditorFieldLabel(input)));
    const lastName = inputs.find((input) =>
      /\b(last name|apellido)\b/i.test(getContactEditorFieldLabel(input)));
    const firstNameInput = firstName || inputs.find((input) => input !== lastName) || inputs[0];
    const lastNameInput = lastName || inputs.find((input) => input !== firstNameInput);
    setContactEditorField(firstNameInput, expectedName);
    if (lastNameInput) setContactEditorField(lastNameInput, "");

    if (!isCurrentContact()) {
      throw new Error("El chat cambió antes de guardar el nombre del contacto.");
    }
    const saveButtons = findWhatsAppControls(dialog, ["Guardar", "Save"]);
    if (saveButtons.length !== 1) {
      throw new Error("No se encontró un único botón para guardar el nombre del contacto.");
    }
    saveButtons[0].click();
    await waitForWhatsAppElement(() => {
      const title = findContactTitle();
      return title &&
        normalizeContactDisplayName(title.textContent || "") === expectedTitle
        ? title
        : null;
    }, "la actualización del nombre del contacto", 15_000);
  }

  async function rescheduleContact(host) {
    const title = findContactTitle();
    if (!title) return;
    const originalTitle = normalizeContactDisplayName(title.textContent || "");
    const accountsKey = host.dataset.accounts;
    const confirmed = window.confirm(
      "¿Reagendar este contacto? Se buscará la cuenta complementaria y, si existe, el nombre quedará como usuario/usuario."
    );
    if (!confirmed) return;

    host.dataset.rescheduleTitle = originalTitle;
    host.dataset.rescheduleAccounts = accountsKey;
    const button = host.shadowRoot.querySelector(".reschedule-button");
    if (button) button.disabled = true;
    const toastKey = `reschedule:${accountsKey}`;
    try {
      showToast(host, originalTitle, "Buscando la cuenta complementaria...", "warning", toastKey);
      const expectedName = await getRescheduledContactName(host);
      if (document.getElementById(HOST_ID) !== host ||
        host.dataset.accounts !== accountsKey ||
        normalizeContactDisplayName(findContactTitle()?.textContent || "") !== originalTitle) {
        throw new Error("El chat cambió. Volvé a abrir Reagendar en el contacto correcto.");
      }
      await renameWhatsAppContact(host, expectedName);
      showToast(host, expectedName, `Contacto reagendado como ${expectedName}.`, "success", toastKey);
    } catch (error) {
      console.error("[Ganamos balance extension] No se pudo reagendar el contacto.", error);
      showToast(host, originalTitle, error.message || "No se pudo reagendar el contacto.", "error", toastKey);
    } finally {
      if (button?.isConnected) button.disabled = false;
      delete host.dataset.rescheduleTitle;
      delete host.dataset.rescheduleAccounts;
    }
  }

  function getOrCreateHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;

    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.zIndex = "2147483646";
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
    const rescheduleButton = document.createElement("button");
    rescheduleButton.type = "button";
    rescheduleButton.className = "reschedule-button";
    rescheduleButton.title = "Reagendar contacto";
    rescheduleButton.setAttribute("aria-label", rescheduleButton.title);
    rescheduleButton.hidden = true;
    const rescheduleIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    rescheduleIcon.setAttribute("viewBox", "0 0 24 24");
    rescheduleIcon.setAttribute("aria-hidden", "true");
    rescheduleIcon.setAttribute("focusable", "false");
    const reschedulePerson = document.createElementNS("http://www.w3.org/2000/svg", "path");
    reschedulePerson.setAttribute(
      "d",
      "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 9a7 7 0 0 0-14 0"
    );
    rescheduleIcon.append(reschedulePerson);
    rescheduleButton.append(rescheduleIcon);
    rescheduleButton.addEventListener("click", () => void rescheduleContact(host));
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
    const withdrawalLimitIndicator = document.createElement("span");
    withdrawalLimitIndicator.className = "withdrawal-limit-inline";
    withdrawalLimitIndicator.textContent = "-";
    withdrawalLimitIndicator.title = "Cargando monto máximo de retiro";
    withdrawalLimitIndicator.hidden = true;
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
    const balanceLine = document.createElement("div");
    balanceLine.className = "balance-line";
    balanceLine.append(balanceLabel, refresh);
    const balanceContent = document.createElement("div");
    balanceContent.className = "balance-content";
    const sportBetsLabel = document.createElement("span");
    sportBetsLabel.className = "sport-bets-label";
    sportBetsLabel.hidden = true;
    const bonusDisabledLabel = document.createElement("span");
    bonusDisabledLabel.className = "sport-bets-label bonus-disabled-label";
    bonusDisabledLabel.textContent = "Bonos Desactivados";
    bonusDisabledLabel.hidden = true;
    const accumulatesBonusesLabel = document.createElement("span");
    accumulatesBonusesLabel.className = "sport-bets-label accumulates-bonuses-label";
    accumulatesBonusesLabel.textContent = "Acumula Bonos";
    accumulatesBonusesLabel.hidden = true;
    balanceContent.append(balanceLine, sportBetsLabel, bonusDisabledLabel, accumulatesBonusesLabel);
    status.append(balanceContent);
    const actions = document.createElement("div");
    actions.className = "actions";
    const depositGroup = document.createElement("div");
    depositGroup.className = "deposit-action-group";
    const bypassBonusButton = document.createElement("button");
    bypassBonusButton.type = "button";
    bypassBonusButton.className = "deposit-bonus-bypass";
    bypassBonusButton.title = "Depositar sin aplicar el bono automático";
    bypassBonusButton.setAttribute("aria-label", bypassBonusButton.title);
    bypassBonusButton.hidden = true;
    const bypassBonusIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    bypassBonusIcon.setAttribute("viewBox", "0 0 24 24");
    bypassBonusIcon.setAttribute("aria-hidden", "true");
    bypassBonusIcon.setAttribute("focusable", "false");
    for (const pathData of [
      "M3 10h18v11H3z",
      "M2 7h20v3H2z",
      "M12 7v14",
      "M12 7H7.5a2.5 2.5 0 1 1 2.2-3.7L12 7Z",
      "M12 7h4.5a2.5 2.5 0 1 0-2.2-3.7L12 7Z",
      "M4 4l16 16"
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      bypassBonusIcon.append(path);
    }
    bypassBonusButton.append(bypassBonusIcon);
    bypassBonusButton.addEventListener("click", () =>
      openTransactionDialog(host, "deposit", { depositButtonRole: "compact" }));
    void readActiveBonusConfig()
      .then((config) => {
        updateDepositBonusBypassVisibility(
          Boolean(config?.enabled && config.type !== "none"),
          config?.invertDepositButtons === true
        );
        updateDepositAdvertisingVisibility(
          config?.activeAdvertising === true && isValidBonusPercent(config.advertisingPercent)
        );
      })
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudo actualizar el botón para omitir el bono.",
        error
      ));
    const depositButton = document.createElement("button");
    depositButton.type = "button";
    depositButton.dataset.action = "deposit";
    depositButton.textContent = "Depositar";
    depositButton.addEventListener("click", () =>
      openTransactionDialog(host, "deposit", { depositButtonRole: "main" }));
    const advertisingButton = document.createElement("button");
    advertisingButton.type = "button";
    advertisingButton.className = "deposit-advertising-button";
    advertisingButton.title = "Depositar con bono de publicidad";
    advertisingButton.setAttribute("aria-label", advertisingButton.title);
    advertisingButton.hidden = true;
    const advertisingIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    advertisingIcon.setAttribute("viewBox", "0 0 24 24");
    advertisingIcon.setAttribute("aria-hidden", "true");
    advertisingIcon.setAttribute("focusable", "false");
    for (const pathData of [
      "M3 11v2h3l11 5V6L6 11H3Z",
      "M6 13l2 6h4l-2.7-4.8",
      "M20 9c1.2 1.7 1.2 4.3 0 6"
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      advertisingIcon.append(path);
    }
    advertisingButton.append(advertisingIcon);
    advertisingButton.addEventListener("click", () =>
      void openTransactionDialog(host, "deposit", { advertisingDeposit: true }));
    depositGroup.append(advertisingButton, bypassBonusButton, depositButton);
    actions.append(depositGroup);
    const withdrawalGroup = document.createElement("div");
    withdrawalGroup.className = "withdrawal-action-group";
    const withdrawalButton = document.createElement("button");
    withdrawalButton.type = "button";
    withdrawalButton.dataset.action = "withdrawal";
    withdrawalButton.textContent = "Retirar";
    withdrawalButton.addEventListener("click", () => void startWithdrawal(host));
    const untrackedWithdrawalButton = document.createElement("button");
    untrackedWithdrawalButton.type = "button";
    untrackedWithdrawalButton.className = "untracked-withdrawal-button";
    untrackedWithdrawalButton.title = "Retirar sin registrar en movimientos";
    untrackedWithdrawalButton.setAttribute("aria-label", untrackedWithdrawalButton.title);
    const untrackedWithdrawalIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    untrackedWithdrawalIcon.setAttribute("viewBox", "0 0 24 24");
    untrackedWithdrawalIcon.setAttribute("aria-hidden", "true");
    untrackedWithdrawalIcon.setAttribute("focusable", "false");
    const untrackedWithdrawalArrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    untrackedWithdrawalArrow.setAttribute("d", "M12 15V3m0 0-4 4m4-4 4 4M5 13v7h14v-7");
    untrackedWithdrawalIcon.append(untrackedWithdrawalArrow);
    untrackedWithdrawalButton.append(untrackedWithdrawalIcon);
    untrackedWithdrawalButton.addEventListener("click", () =>
      void startWithdrawal(host, { skipMovementRecord: true }));
    const passwordResetButton = document.createElement("button");
    passwordResetButton.type = "button";
    passwordResetButton.className = "password-reset-button";
    passwordResetButton.title = "Restaurar contraseña";
    passwordResetButton.setAttribute("aria-label", "Restaurar contraseña");
    passwordResetButton.hidden = true;
    passwordResetButton.append(createPasswordResetIcon());
    passwordResetButton.addEventListener("click", () => {
      const candidates = host.passwordResetCandidates || [];
      openPasswordResetDialog(host, candidates.length ? candidates : null);
    });
    withdrawalGroup.append(withdrawalButton, untrackedWithdrawalButton);
    actions.append(withdrawalGroup);
    const createUserButton = document.createElement("button");
    createUserButton.type = "button";
    createUserButton.className = "create-user-button";
    createUserButton.textContent = "+";
    createUserButton.title = "Crear usuario";
    createUserButton.setAttribute("aria-label", "Crear usuario");
    createUserButton.hidden = true;
    createUserButton.addEventListener("click", () => {
      const platform = host.dataset.createPlatform || null;
      const migration = host.legacyMigrations?.find(({ platform: itemPlatform }) =>
        itemPlatform === platform) || null;
      openCreateUserDialog(host, platform, migration);
    });
    actions.append(createUserButton);
    const legacyMigrationButtons = document.createElement("div");
    legacyMigrationButtons.className = "legacy-migration-buttons";
    legacyMigrationButtons.hidden = true;
    actions.append(legacyMigrationButtons);
    const dialogRoot = document.createElement("div");
    dialogRoot.className = "dialog-root";
    const contactUserSearch = document.createElement("section");
    contactUserSearch.className = "contact-user-search";
    contactUserSearch.hidden = true;
    contactUserSearch.setAttribute("aria-live", "polite");
    const contactUserSearchTitle = document.createElement("div");
    contactUserSearchTitle.className = "contact-user-search-title";
    contactUserSearchTitle.textContent = "Usuarios Existentes Encontrados:";
    const contactUserSearchResults = document.createElement("div");
    contactUserSearchResults.className = "contact-user-search-results";
    contactUserSearch.append(contactUserSearchTitle, contactUserSearchResults);
    panel.append(
      informationButton,
      rescheduleButton,
      exchangeButton,
      withdrawalLimitIndicator,
      passwordResetButton,
      actions,
      status,
      contactUserSearch,
      dialogRoot
    );
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
    const sportBetsAccounts = accountsToFetch.filter(([platform]) =>
      platform === "ganamos" || platform === "multipanel");
    renderBalanceRows(host, accounts);

    const balanceRequests = accountsToFetch.map(async ([platform, username]) => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "BALANCE_REQUEST",
          data: { nombre: username, platform }
        });
        if (!response?.ok) throw new Error(response?.error || "consulta fallida");
        if (host.dataset.accounts !== requestAccountsKey) return;
        host.balanceStates[platform] = { balance: response.balance };
        dismissToast(`balance:${requestAccountsKey}:${platform}`);
      } catch (error) {
        if (host.dataset.accounts !== requestAccountsKey) return;
        const message = error.message || "consulta fallida";
        host.balanceStates[platform] = { error: message };
        showToast(host, username, message, "error", `balance:${requestAccountsKey}:${platform}`);
      }
      if (document.getElementById(HOST_ID) === host && host.dataset.accounts === requestAccountsKey) {
        renderBalanceRows(host, accounts);
      }
    });
    const sportBetsRequest = sportBetsAccounts.length
      ? (async () => {
        const preferenceId = getSportBetsPreferenceId(host);
        let disabled = false;
        try {
          disabled = await readSportBetsDisabled(preferenceId);
        } catch (error) {
          console.error(
            "[Ganamos balance extension] No se pudo cargar la configuración de apuestas deportivas.",
            error
          );
        }
        if (host.dataset.accounts !== requestAccountsKey || activeAccountsKey !== requestAccountsKey) return;
        host.sportBetsDisabled = disabled;
        host.sportBetsStates ||= {};
        if (disabled) {
          host.sportBetsStates = {};
          renderSportBetsCount(host);
          renderBalanceRows(host, accounts);
          return;
        }
        for (const [platform] of sportBetsAccounts) {
          host.sportBetsStates[platform] = {
            ...host.sportBetsStates[platform],
            loading: true
          };
        }
        renderSportBetsCount(host);
        await refreshSportBetsCounts(host, sportBetsAccounts, requestAccountsKey, accounts);
      })()
      : Promise.resolve();
    await Promise.all([...balanceRequests, sportBetsRequest]);
  }

  async function refreshSportBetsCounts(host, accountsToFetch, requestAccountsKey, accounts) {
    const isCurrentRequest = () =>
      document.getElementById(HOST_ID) === host &&
      host.dataset.accounts === requestAccountsKey &&
      activeAccountsKey === requestAccountsKey &&
      host.sportBetsDisabled !== true;
    await Promise.all(accountsToFetch.map(async ([platform, username]) => {
      const toastKey = `sport-bets:${requestAccountsKey}:${platform}`;
      const platformName = platform === "ganamos" ? "Ganamos" : "MultiPanel";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "SPORT_BETS_REQUEST",
          data: { nombre: username, platform }
        });
        if (!response?.ok || !Number.isSafeInteger(response.count) || response.count < 0 ||
          typeof response.hasBets !== "boolean") {
          throw new Error(response?.error || "La respuesta de apuestas deportivas no es válida.");
        }
        if (!isCurrentRequest()) return;
        host.sportBetsStates[platform] = {
          count: response.count,
          hasBets: response.hasBets
        };
        dismissToast(toastKey);
      } catch (error) {
        if (!isCurrentRequest()) return;
        host.sportBetsStates[platform] = {
          ...host.sportBetsStates[platform],
          error: error.message || `No se pudieron consultar las apuestas de ${platformName}.`,
          loading: false
        };
        console.error(
          `[Ganamos balance extension] No se pudieron consultar las apuestas deportivas de ${platformName}.`,
          error
        );
        showToast(
          host,
          username,
          `${platformName}: ${host.sportBetsStates[platform].error}`,
          "error",
          toastKey
        );
      }
    }));
    if (isCurrentRequest()) {
      renderSportBetsCount(host);
      renderBalanceRows(host, accounts);
      const title = findContactTitle();
      updateSportBetsIndicator(
        title,
        Object.values(host.sportBetsStates).some((state) => state?.hasBets === true)
      );
    }
  }

  async function copyContactValue(host, platform, value, kind, toastKey) {
    if (!value) return;
    const message = `Copiado ${kind} ${value} al portapapeles.`;
    try {
      await navigator.clipboard.writeText(value);
      showToast(host, platform, message, "success", toastKey);
    } catch (error) {
      console.error(
        `[Ganamos balance extension] No se pudo copiar ${kind} de ${platform}.`,
        error
      );
      showToast(host, platform, `No se pudo copiar ${kind} al portapapeles.`, "error", toastKey);
    }
  }

  async function copyContactPlatformUsername(host, platform) {
    const username = host.dataset[
      platform === "ganamos" ? "username" : "multipanelUsername"
    ];
    if (!username) return;
    const platformName = platform === "ganamos" ? "Ganamos" : "MultiPanel";
    await copyContactValue(
      host,
      platformName,
      username,
      "el usuario",
      `copy-balance:${platform}:username`
    );
  }

  function renderBalanceRows(host, accounts) {
    const status = host.shadowRoot?.querySelector(".status");
    const label = status?.querySelector(".balance-label");
    const refresh = status?.querySelector(".refresh");
    if (!label || !refresh) return;

    const visibleAccounts = accounts.filter(([, username]) => username);
    label.replaceChildren();
    visibleAccounts.forEach(([platform], index) => {
      if (index > 0) label.append(document.createTextNode(" | "));
      const state = host.balanceStates?.[platform];
      const platformLabel = platform === "ganamos" ? "Ganamos" : "MultiPanel";
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "balance-platform-copy";
      copyButton.textContent = platformLabel;
      copyButton.title = `Copiar usuario de ${platformLabel}`;
      copyButton.setAttribute("aria-label", copyButton.title);
      copyButton.addEventListener("click", () =>
        void copyContactPlatformUsername(host, platform));
      label.append(copyButton);

      let balanceText;
      if (state?.loading) balanceText = "consultando...";
      else if (state?.error) balanceText = state.error;
      else if (state?.balance != null) {
        const balance = parseBalance(state.balance);
        balanceText = balance === null ? "saldo inválido" : `$${formatBalance(balance)}`;
      } else balanceText = "pendiente";
      label.append(document.createTextNode(`: ${balanceText}`));
    });
    refresh.disabled = Object.values(host.sportBetsStates || {})
      .some((state) => state?.loading) ||
      accounts.some(([platform, username]) => username && host.balanceStates?.[platform]?.loading);
  }

  function renderSportBetsCount(host) {
    const label = host.shadowRoot?.querySelector(".sport-bets-label");
    if (!label) return;
    const counts = ["ganamos", "multipanel"]
      .map((platform) => ({
        platform,
        count: host.sportBetsStates?.[platform]?.count
      }))
      .filter(({ count }) => Number.isSafeInteger(count) && count > 0)
      .map(({ platform, count }) => {
        const plural = count === 1 ? "" : "s";
        const platformName = platform === "ganamos" ? "Ganamos" : "MultiPanel";
        return `${platformName}: ${count} apuesta${plural} deportiva${plural} activa${plural}`;
      });
    if (counts.length) {
      label.textContent = counts.join(" | ");
      label.hidden = false;
    } else {
      label.textContent = "";
      label.hidden = true;
    }
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
    registerModalEscapeHandler(modal, () => {
      root.replaceChildren();
    });
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
    const amountEntry = document.createElement("div");
    amountEntry.className = "amount-entry";
    const amountInput = document.createElement("input");
    configureNumericInput(amountInput);
    amountInput.required = true;
    amountInput.placeholder = "-";
    amountLabel.append(createInputAffix(amountInput, "$"));
    amountEntry.append(amountLabel);
    const createBalanceShortcut = (label, roundingUnit, title) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary withdrawal-rounding-shortcut";
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", async () => {
        const fromPlatform = platformSelects.from.value;
        const fromUsername = usernames[fromPlatform];
        button.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({
            type: "BALANCE_REQUEST",
            data: { nombre: fromUsername, platform: fromPlatform, force: true }
          });
          if (!response?.ok) {
            throw new Error(response?.error || "No se pudo consultar el saldo de origen.");
          }
          if (host.dataset.accounts !== openedAccountsKey ||
            platformSelects.from.value !== fromPlatform) {
            throw new Error("El chat o la plataforma de origen cambió; volvé a consultar el saldo.");
          }
          const balance = parseBalance(response.balance);
          if (balance === null || balance <= 0) {
            throw new Error("El saldo de origen no es válido para un intercambio.");
          }
          const wholeBalance = Math.floor(balance / roundingUnit) * roundingUnit;
          if (wholeBalance <= 0) {
            throw new Error(roundingUnit === 1
              ? "El saldo disponible no alcanza para cargar un monto entero."
              : `El saldo disponible no alcanza para cargar un múltiplo de ${formatBalance(roundingUnit)}.`);
          }
          amountInput.value = new Intl.NumberFormat("es-AR").format(wholeBalance);
          formatNumericInput(amountInput, amountInput.value.length);
          amountInput.dispatchEvent(new Event("input", { bubbles: true }));
          amountInput.focus();
        } catch (error) {
          showToast(
            host,
            fromUsername,
            error.message || "No se pudo consultar el saldo de origen.",
            "error"
          );
        } finally {
          button.disabled = false;
        }
      });
      return button;
    };
    amountEntry.append(
      ...[1000, 100, 10].map((roundingUnit) => createBalanceShortcut(
        `${roundingUnit}↓`,
        roundingUnit,
        `Completar el saldo redondeado hacia abajo al múltiplo de ${formatBalance(roundingUnit)}`
      )),
      createBalanceShortcut("Todo", 1, "Completar con todo el saldo disponible")
    );
    dialog.append(amountEntry);
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

  async function openTransactionDialog(host, operation, {
    skipAutomaticBonus = false,
    skipMovementRecord = false,
    depositButtonRole = null,
    advertisingDeposit = false
  } = {}) {
    const shadow = host.shadowRoot;
    const root = shadow?.querySelector(".dialog-root");
    const openedAccountsKey = host.dataset.accounts;
    const getPlatformUsername = (platform) =>
      platform === "ganamos" ? host.dataset.username : host.dataset.multipanelUsername;
    const contactPreferredPlatform = host.dataset.defaultPlatform ||
      (host.dataset.username ? "ganamos" : "multipanel");
    const outagePreferredPlatform = platformOutageConfig.ganamos !== platformOutageConfig.multipanel
      ? platformOutageConfig.ganamos
        ? "multipanel"
        : "ganamos"
      : contactPreferredPlatform;
    let selectedPlatform = getPlatformUsername(outagePreferredPlatform)
      ? outagePreferredPlatform
      : getPlatformUsername(contactPreferredPlatform)
        ? contactPreferredPlatform
        : host.dataset.username
          ? "ganamos"
          : "multipanel";
    let activeBonusConfig = null;
    let activeBonusConfigLoadFailed = false;
    let bonusDisabled = host.dataset.bonusDisabled === "true";
    if (operation === "deposit") {
      try {
        activeBonusConfig = await readActiveBonusConfig();
      } catch (error) {
        activeBonusConfigLoadFailed = true;
        console.error("[Ganamos balance extension] No se pudo cargar el bono activo para el depósito.", error);
        showToast(host, getPlatformUsername(selectedPlatform), "No se pudo cargar el bono activo para este depósito.", "error");
      }
    }
    if (operation === "deposit" && !advertisingDeposit) {
      try {
        bonusDisabled = await readUserBonusDisabled(getSportBetsPreferenceId(host));
        if (host.dataset.accounts !== openedAccountsKey) return;
        updateUserBonusDisabledPresentation(host, bonusDisabled);
      } catch (error) {
        console.error(
          "[Ganamos balance extension] No se pudo cargar la configuración de bono por usuario.",
          error
        );
      }
    }
    if (advertisingDeposit && activeBonusConfigLoadFailed) return;
    if (operation === "deposit" && !advertisingDeposit && depositButtonRole) {
      skipAutomaticBonus = bonusDisabled ||
        Boolean(activeBonusConfig?.invertDepositButtons) === (depositButtonRole === "main");
    }
    if (advertisingDeposit &&
      (!activeBonusConfig?.activeAdvertising ||
        !isValidBonusPercent(activeBonusConfig.advertisingPercent))) {
      showToast(
        host,
        getPlatformUsername(selectedPlatform),
        "Activá Publi Activa y configurá un porcentaje válido antes de usar este depósito.",
        "error"
      );
      return;
    }
    const mysteriousBonusPercent = activeBonusConfig?.enabled && activeBonusConfig.type === "mysterious"
      ? chooseMysteriousBonusPercent(activeBonusConfig)
      : null;
    let applyPlatformBonus = () => {};
    if (!root || !getPlatformUsername(selectedPlatform)) return;
    root.replaceChildren();

    const modal = document.createElement("div");
    modal.className = "modal";
    if (advertisingDeposit) modal.dataset.advertisingDeposit = "true";
    if (operation === "deposit" && bonusDisabled && !advertisingDeposit) {
      modal.dataset.bonusDisabled = "true";
    }
    registerModalEscapeHandler(modal, () => {
      root.replaceChildren();
    });
    const dialog = document.createElement("form");
    dialog.className = "dialog";
    dialog.dataset.operation = operation;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = operation === "deposit"
      ? (advertisingDeposit ? "Depositar (Publi)" : "Depositar")
      : skipMovementRecord ? "Retirar (Excepción)" : "Retirar";
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
    const platformButtons = new Map();
    for (const [platform, label] of [["ganamos", "Ganamos"], ["multipanel", "MultiPanel"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.platform = platform;
      button.disabled = !getPlatformUsername(platform);
      button.textContent = operation === "withdrawal"
        ? button.disabled ? label : `${label} (consultando...)`
        : label;
      platformButtons.set(platform, button);
      button.setAttribute("aria-pressed", String(platform === selectedPlatform));
      button.addEventListener("click", () => {
        selectedPlatform = platform;
        for (const option of selector.querySelectorAll("button")) {
          option.setAttribute("aria-pressed", String(option.dataset.platform === selectedPlatform));
        }
        if (operation === "deposit") depositSummary.dataset.platform = selectedPlatform;
        else withdrawalSummary.dataset.platform = selectedPlatform;
        if (operation === "deposit") applyPlatformBonus();
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
      depositSummary.textContent = `Depósito: $${formatBalance(amount + bonus)} / $${formatBalance(bonus)}`;
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
    let lastAutomaticWithdrawalAdjustment = null;
    let loadingLastDeposit = false;
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
      bonusPercentInput.addEventListener("beforeinput", (event) => {
        if (!event.inputType.startsWith("insert")) return;
        const insertedText = event.data ?? event.dataTransfer?.getData("text/plain");
        if (insertedText == null) return;
        const start = bonusPercentInput.selectionStart ?? bonusPercentInput.value.length;
        const end = bonusPercentInput.selectionEnd ?? start;
        const candidate = `${bonusPercentInput.value.slice(0, start)}${insertedText}${bonusPercentInput.value.slice(end)}`;
        const normalized = normalizeNumericInput(candidate);
        if (!normalized.integer) return;
        const value = Number(normalized.value);
        if ((normalized.integer.length > 2 && normalized.integer !== "100") ||
          (Number.isFinite(value) && value > 100)) {
          event.preventDefault();
        }
      });
      bonusPercentInput.placeholder = "-";

      bonusPercentLabel.append(createInputAffix(bonusPercentInput, "%", "suffix"));
      bonusFields.append(bonusLabel, bonusPercentLabel);
      dialog.append(bonusFields);

      const numberValue = numericInputValue;
      const maximumBonus = advertisingDeposit ? 5000 : 10000;
      const syncFixedFromPercent = () => {
        const amount = numberValue(amountInput);
        const percent = numberValue(bonusPercentInput);
        bonusInput.value = amount > 0 && percent != null
          ? new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(
            Math.min(Math.ceil(amount * percent / 100), maximumBonus)
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
        bonusPercentageShortcuts.updateSelection();
      });
      let manuallyChangedBonusPercent = false;
      let applyingAutomaticBonusPercent = false;
      let specialBonusThresholdExceeded = (numberValue(amountInput) || 0) >= 10_000;
      const getActiveBonusPercent = () => {
        if (advertisingDeposit) return activeBonusConfig.advertisingPercent;
        if (skipAutomaticBonus || !activeBonusConfig?.enabled) return null;
        switch (activeBonusConfig.type) {
          case "simple":
            return activeBonusConfig.percent;
          case "double":
            return activeBonusConfig[selectedPlatform];
          case "specific":
            return activeBonusConfig.platform === selectedPlatform
              ? activeBonusConfig.percent
              : null;
          case "special":
            return (numberValue(amountInput) || 0) >= 10_000
              ? activeBonusConfig.overThreshold
              : activeBonusConfig.underThreshold;
          case "mysterious":
            return mysteriousBonusPercent;
          default:
            return null;
        }
      };
      const applyAutomaticBonusPercent = () => {
        applyingAutomaticBonusPercent = true;
        try {
          const percentage = getActiveBonusPercent();
          bonusPercentInput.value = percentage == null ? "" : String(percentage);
          bonusPercentInput.dispatchEvent(new Event("input", { bubbles: true }));
        } finally {
          applyingAutomaticBonusPercent = false;
        }
      };
      bonusPercentInput.addEventListener("input", () => {
        if (!applyingAutomaticBonusPercent) manuallyChangedBonusPercent = true;
      });
      applyPlatformBonus = () => {
        if (advertisingDeposit) {
          manuallyChangedBonusPercent = false;
          applyAutomaticBonusPercent();
          return;
        }
        if (skipAutomaticBonus || !activeBonusConfig?.enabled ||
          !["double", "specific"].includes(activeBonusConfig.type)) return;
        manuallyChangedBonusPercent = false;
        applyAutomaticBonusPercent();
      };
      amountInput.addEventListener("input", () => {
        const thresholdExceeded = (numberValue(amountInput) || 0) >= 10_000;
        if (!advertisingDeposit && !skipAutomaticBonus &&
          activeBonusConfig?.enabled && activeBonusConfig.type === "special" &&
          thresholdExceeded !== specialBonusThresholdExceeded) {
          specialBonusThresholdExceeded = thresholdExceeded;
          manuallyChangedBonusPercent = false;
          applyAutomaticBonusPercent();
        }
      });
      amountInput.addEventListener("input", updateDepositSummary);
      bonusPercentInput.addEventListener("input", updateDepositSummary);
      bonusInput.addEventListener("input", updateDepositSummary);
      const bonusPercentageShortcuts = createPercentageShortcuts(
        bonusPercentInput,
        getActiveBonusPercent
      );
      dialog.append(bonusPercentageShortcuts.element);
      if (advertisingDeposit || (!skipAutomaticBonus && activeBonusConfig?.enabled)) {
        applyAutomaticBonusPercent();
      }
      updateDepositSummary();
    }

    if (operation === "withdrawal") {
      const recoveryFields = document.createElement("div");
      recoveryFields.className = "bonus-fields bonus-fields--withdrawal";
      const loadLastDepositButton = document.createElement("button");
      loadLastDepositButton.type = "button";
      loadLastDepositButton.className = "load-last-deposit";
      loadLastDepositButton.textContent = "↻";
      loadLastDepositButton.title = "Cargar los datos del último depósito de esta plataforma";
      loadLastDepositButton.setAttribute("aria-label", loadLastDepositButton.title);
      recoveryFields.append(loadLastDepositButton);
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
      dialog.append(createPercentageShortcuts(recoveryPercentInput).element);
      const clearAutomaticWithdrawalAdjustment = () => {
        if (!loadingLastDeposit) lastAutomaticWithdrawalAdjustment = null;
      };
      amountInput.addEventListener("input", () => {
        clearAutomaticWithdrawalAdjustment();
        updateWithdrawalSummary();
      });
      loadAmountInput.addEventListener("input", () => {
        clearAutomaticWithdrawalAdjustment();
        updateWithdrawalSummary();
      });
      recoveryPercentInput.addEventListener("input", () => {
        clearAutomaticWithdrawalAdjustment();
        updateWithdrawalSummary();
      });
      updateWithdrawalSummary();
    }

    const loadWithdrawalBalance = async (balancePlatform, fillAmount = false, roundingUnit = 1) => {
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
        const wholeBalance = Math.floor(balance / roundingUnit) * roundingUnit;
        if (wholeBalance <= 0) {
          throw new Error(roundingUnit === 1
            ? "El saldo disponible no alcanza para cargar un monto entero."
            : `El saldo disponible no alcanza para cargar un múltiplo de ${formatBalance(roundingUnit)}.`);
        }
        amountInput.value = new Intl.NumberFormat("es-AR").format(wholeBalance);
        formatNumericInput(amountInput, amountInput.value.length);
        amountInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return balance;
    };

    const loadWithdrawalSelectorBalances = async () => {
      const requests = [...platformButtons].filter(([platform, button]) =>
        !button.disabled && getPlatformUsername(platform));
      await Promise.all(requests.map(async ([platform, button]) => {
        try {
          const response = await chrome.runtime.sendMessage({
            type: "BALANCE_REQUEST",
            data: {
              nombre: getPlatformUsername(platform),
              platform,
              force: true
            }
          });
          if (!response?.ok) {
            throw new Error(response?.error || `No se pudo consultar el saldo de ${platform}.`);
          }
          const balance = parseBalance(response.balance);
          if (balance === null) throw new Error(`El saldo de ${platform} no es válido.`);
          if (host.dataset.accounts !== openedAccountsKey || !root.contains(modal)) return;
          button.textContent = `${platform === "ganamos" ? "Ganamos" : "MultiPanel"} ($${formatBalance(balance)})`;
          button.title = `Saldo disponible: $${formatBalance(balance)}`;
          button.setAttribute("aria-label", `${button.title}, ${platform === "ganamos" ? "Ganamos" : "MultiPanel"}`);
        } catch (error) {
          if (host.dataset.accounts !== openedAccountsKey || !root.contains(modal)) return;
          const platformName = platform === "ganamos" ? "Ganamos" : "MultiPanel";
          button.textContent = `${platformName} (sin saldo)`;
          button.title = error.message || `No se pudo consultar el saldo de ${platformName}.`;
          button.setAttribute("aria-label", `${platformName}: no se pudo consultar el saldo`);
          console.error(
            `[Ganamos balance extension] No se pudo consultar el saldo de ${platformName} para el selector de retiro.`,
            error
          );
          showToast(
            host,
            getPlatformUsername(platform),
            `${platformName}: ${button.title}`,
            "error",
            `withdrawal-selector-balance:${openedAccountsKey}:${platform}`
          );
        }
      }));
    };

    if (operation === "withdrawal") {
      const recoveryFields = dialog.querySelector(".bonus-fields--withdrawal");
      const loadLastDepositButton = recoveryFields?.querySelector(".load-last-deposit");
      loadLastDepositButton?.addEventListener("click", async () => {
        const balancePlatform = selectedPlatform;
        const balanceUsername = getPlatformUsername(balancePlatform);
        loadLastDepositButton.disabled = true;
        try {
          const movements = await stateStorage.getMovements({
            ...getMovementAccountFilter(openedAccountsKey),
            operation: "deposit",
          });
          if (host.dataset.accounts !== openedAccountsKey ||
            selectedPlatform !== balancePlatform) {
            throw new Error("El chat o la plataforma cambió; volvé a cargar el último depósito.");
          }
          const movement = movements.find((candidate) =>
            candidate?.operation === "deposit" && candidate.platform === balancePlatform);
          if (!movement) {
            throw new Error("No hay depósitos registrados para este usuario en esta plataforma.");
          }
          const baseAmount = Number(movement.transactionAmount);
          const bonusAmount = Number(movement.bonusAmount);
          if (movement.operation !== "deposit" || movement.platform !== balancePlatform ||
            !Number.isFinite(baseAmount) || baseAmount <= 0 ||
            !Number.isFinite(bonusAmount) || bonusAmount < 0) {
            throw new Error("El último depósito no tiene una carga y un bono válidos guardados.");
          }
          const bonusPercent = Math.round(bonusAmount / baseAmount * 10_000) / 100;
          if (bonusPercent > 100) {
            throw new Error("El porcentaje del último bono supera el máximo permitido.");
          }
          const currentAmount = numericInputValue(amountInput);
          const alreadyAdjusted = lastAutomaticWithdrawalAdjustment &&
            currentAmount === lastAutomaticWithdrawalAdjustment.amount &&
            baseAmount === lastAutomaticWithdrawalAdjustment.baseAmount &&
            bonusPercent === lastAutomaticWithdrawalAdjustment.bonusPercent;

          loadingLastDeposit = true;
          try {
            loadAmountInput.value = formatBalance(baseAmount);
            recoveryPercentInput.value = formatBalance(bonusPercent);
            loadAmountInput.dispatchEvent(new Event("input", { bubbles: true }));
            recoveryPercentInput.dispatchEvent(new Event("input", { bubbles: true }));
          } finally {
            loadingLastDeposit = false;
          }

          if (alreadyAdjusted) return;
          lastAutomaticWithdrawalAdjustment = null;
          const recoveryBonus = Math.ceil(baseAmount * bonusPercent / 100);
          if (currentAmount === null || currentAmount <= 0 || recoveryBonus <= 0) return;

          let availableBalance;
          try {
            availableBalance = await loadWithdrawalBalance(balancePlatform);
          } catch (error) {
            throw new Error(
              `Se cargaron la carga y el bono, pero no se ajustó el monto porque no se pudo validar el saldo: ${error.message || "error desconocido"}`
            );
          }
          const adjustedAmount = currentAmount + recoveryBonus;
          if (adjustedAmount <= availableBalance + Number.EPSILON) {
            amountInput.value = formatBalance(adjustedAmount);
            formatNumericInput(amountInput, amountInput.value.length);
            amountInput.dispatchEvent(new Event("input", { bubbles: true }));
            lastAutomaticWithdrawalAdjustment = {
              amount: adjustedAmount,
              baseAmount,
              bonusPercent
            };
          }
        } catch (error) {
          console.error("[Ganamos balance extension] No se pudieron cargar los datos del último depósito.", error);
          showToast(
            host,
            balanceUsername,
            error.message || "No se pudieron cargar los datos del último depósito.",
            "error"
          );
        } finally {
          loadLastDepositButton.disabled = false;
        }
      });
    }

    if (operation === "withdrawal") {
      const createBalanceShortcut = (label, roundingUnit, title) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        if (roundingUnit > 1) button.classList.add("withdrawal-rounding-shortcut");
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", title);
        button.addEventListener("click", async () => {
          const balancePlatform = selectedPlatform;
          const balanceUsername = getPlatformUsername(balancePlatform);
          button.disabled = true;
          try {
            await loadWithdrawalBalance(balancePlatform, true, roundingUnit);
          } catch (exception) {
            showToast(host, balanceUsername, exception.message || "No se pudo consultar el saldo.", "error");
          } finally {
            button.disabled = false;
          }
        });
        return button;
      };
      amountEntry.append(
        ...[1000, 100, 10].map((roundingUnit) => createBalanceShortcut(
          `${roundingUnit}↓`,
          roundingUnit,
          `Completar el saldo redondeado hacia abajo al múltiplo de ${formatBalance(roundingUnit)}`
        )),
        createBalanceShortcut("Todo", 1, "Completar con todo el saldo disponible")
      );
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
      let numericAmount = numericInputValue(amountInput);
      const amountIsEmpty = amountInput.value.trim() === "";
      const numericBonus = numericInputValue(bonusInput);
      if (operation === "deposit" && (amountIsEmpty || numericAmount === 0) &&
        numericBonus !== null && numericBonus >= 1 && hasValidInputPrecision(bonusInput)) {
        amountInput.value = "1";
        bonusInput.value = formatBalance(numericBonus - 1);
        if (bonusPercentInput) bonusPercentInput.value = "";
        numericAmount = numericInputValue(amountInput);
        updateDepositSummary();
      }
      const amount = numericInputString(amountInput);
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

      if (operation === "withdrawal") {
        const username = getPlatformUsername(selectedPlatform);
        confirm.disabled = true;
        try {
          const maximumWithdrawal = await readUserWithdrawalLimit(
            getSportBetsPreferenceId(host)
          );
          if (host.dataset.accounts !== openedAccountsKey) return;
          if (numericAmount > maximumWithdrawal && !window.confirm(
            `${username}: el retiro de $${formatCurrency(numericAmount)} supera el máximo configurado de $${formatCurrency(maximumWithdrawal)}. ¿Querés continuar igualmente?`
          )) return;
        } catch (error) {
          showToast(
            host,
            username,
            error.message || "No se pudo consultar el monto máximo de retiro.",
            "error"
          );
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
      const bonusValue = bonus?.enabled ? Number(bonus.value) : 0;
      if (operation === "deposit" && bonusDisabled && !advertisingDeposit && bonusValue > 0) {
        confirm.disabled = true;
        const shouldContinue = await confirmDisabledBonusDeposit(
          root,
          username,
          numericAmount,
          bonusValue
        );
        confirm.disabled = false;
        if (!shouldContinue || host.dataset.accounts !== openedAccountsKey) return;
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
        let bonusClipboardWriteFailed = false;
        if (operation === "deposit" && activeBonusConfig?.copyBonus === true && bonusValue > 0) {
          try {
            await navigator.clipboard.writeText(String(Math.round(bonusValue)));
          } catch (error) {
            bonusClipboardWriteFailed = true;
            console.error("[Ganamos balance extension] No se pudo copiar el bono al portapapeles.", error);
          }
        }
        const creditedAmount = operation === "deposit" ? amountValue + bonusValue : amountValue;
        const amountSummary = `$${formatCurrency(creditedAmount)}`;
        const bonusSummary = `$${formatCurrency(bonusValue)}`;
        const pendingVerification = operation === "deposit" &&
          response.verification?.status !== "verified";
        let movementSaved = true;
        if (!skipMovementRecord) {
          try {
            await saveAgentMovement(openedAccountsKey, operation, creditedAmount, selectedPlatform, {
              username,
              transactionAmount: amountValue,
              bonusAmount: operation === "deposit" ? bonusValue : 0,
              ...(advertisingDeposit ? { depositType: "advertising" } : {}),
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
            "error");
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
        if (bonusClipboardWriteFailed) {
          showToast(host, username, "El depósito se completó, pero no se pudo copiar el bono al portapapeles.", "error");
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
      void loadWithdrawalSelectorBalances();
    }
    amountInput.focus();
  }

  function openCreateUserDialog(
    host,
    forcedPlatform = null,
    migration = null,
    initialAliasBase = ""
  ) {
    const root = host.shadowRoot?.querySelector(".dialog-root");
    const phone = host.dataset.contactPhone || "";
    const accountsKey = host.dataset.accounts;
    const existingUsername = forcedPlatform === "ganamos"
      ? host.dataset.multipanelUsername
      : host.dataset.username;
    if (!root || (!forcedPlatform && phone.length < 4) ||
      (forcedPlatform && (!["ganamos", "multipanel"].includes(forcedPlatform) ||
        (!migration && !initialAliasBase && !existingUsername))) ||
      (migration && (migration.platform !== forcedPlatform ||
        typeof migration.base !== "string" || !migration.base)) ||
      (initialAliasBase && typeof initialAliasBase !== "string")) return;
    root.replaceChildren();

    let selectedPlatform = forcedPlatform || "ganamos";
    const modal = document.createElement("div");
    modal.className = "modal";
    registerModalEscapeHandler(modal, () => {
      root.replaceChildren();
    });

    const dialog = document.createElement("form");
    dialog.className = "dialog";
    dialog.dataset.operation = "create-user";
    dialog.dataset.platform = selectedPlatform;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.textContent = migration
      ? `Migrar usuario ${forcedPlatform === "ganamos" ? "Ganamos" : "MultiPanel"}`
      : forcedPlatform
      ? `Crear ${forcedPlatform === "ganamos" ? "Ganamos" : "MultiPanel"}`
      : "Crear Usuario";
    dialog.append(title);

    const destinations = remoteCreateDestinations.filter((destination) =>
      typeof destination?.id === "string" && typeof destination.name === "string");
    let selectedDestinationId = "";
    if (remoteCreateDestinations.length) {
      const destinationField = document.createElement("div");
      destinationField.className = "destination-field";
      const destinationLabel = document.createElement("span");
      destinationLabel.textContent = "Equipo destino";
      const destinationButtons = document.createElement("div");
      destinationButtons.className = "destination-selector";
      destinationButtons.setAttribute("role", "group");
      destinationButtons.setAttribute("aria-label", "Equipo destino");
      for (let index = 1; index <= 3; index += 1) {
        const destination = destinations.find((item) => item.id === `remote-${index}`);
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = destination?.name || `PC ${index}`;
        button.title = destination?.name || `PC ${index} no configurada`;
        button.disabled = !destination;
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-label", destination
          ? `${migration ? "Migrar usuario en" : "Crear en"} ${destination.name}`
          : `PC ${index} no configurada`);
        button.addEventListener("click", () => {
          if (!destination) return;
          selectedDestinationId = destination.id;
          for (const option of destinationButtons.querySelectorAll("button")) {
            option.setAttribute("aria-pressed", String(option === button));
          }
          updateGeneratedUsername();
        });
        destinationButtons.append(button);
      }
      destinationField.append(destinationLabel, destinationButtons);
      dialog.append(destinationField);
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
    if (migration) {
      nicknameInput.value = migration.base;
      nicknameInput.readOnly = true;
      nicknameLabel.firstChild.textContent = "Usuario antiguo";
    } else if (initialAliasBase) {
      nicknameInput.value = initialAliasBase;
    } else if (forcedPlatform && phone.length < 4) {
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
      if (remoteCreateDestinations.length && !selectedDestinationId) return "";
      const nickname = generatedNickname();
      const suffix = getSelectedSuffix();
      if (migration) return `${migration.base}${suffix}`;
      if (initialAliasBase) return nickname ? `${nickname}${suffix}` : "";
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
      if (remoteCreateDestinations.length && !selectedDestinationId) {
        showToast(host, phone, "Elegí la computadora donde se creará el usuario.", "error");
        dialog.querySelector(".destination-selector button:not(:disabled)")?.focus();
        return;
      }
      if (!migration && !nickname) {
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
      showToast(host, username, migration ? "Migrando usuario..." : "Creando usuario...", "warning", toastKey);
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
              ...(selectedDestinationId ? { destinationId: selectedDestinationId } : {})
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
            `${migration ? "Usuario migrado" : "Usuario creado"}${destinationName ? ` en ${destinationName}` : ""}${response.userId ? ` (ID ${response.userId})` : ""}.`,
            "success", toastKey);
          try {
            await navigator.clipboard.writeText(username);
            showToast(host, username, `Copiado el usuario ${username} al portapapeles.`, "success", toastKey);
          } catch (error) {
            console.error("[Ganamos balance extension] No se pudo copiar el usuario al portapapeles.", error);
            showToast(host, username,
              `El usuario se ${migration ? "migró" : "creó"}, pero no se pudo copiar al portapapeles.`,
              "error",
              toastKey);
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
      registerModalEscapeHandler(modal, () => {
        finish(false);
      });
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

  function createPasswordResetIcon() {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M7 10V7a5 5 0 0 1 10 0v3m-11 0h12a2 2 0 0 1 2 2v7H4v-7a2 2 0 0 1 2-2Zm5 4v3");
    icon.append(path);
    return icon;
  }

  function openPasswordResetDialog(host, targetUsers = null) {
    const root = host.shadowRoot?.querySelector(".dialog-root");
    if (!root) return;
    const accountsKey = host.dataset.accounts;
    const isCandidateSelection = Array.isArray(targetUsers) && targetUsers.length > 0;
    const availablePlatforms = [
      ["ganamos", host.dataset.username],
      ["multipanel", host.dataset.multipanelUsername]
    ].filter(([, username]) => Boolean(username));
    if (isCandidateSelection &&
      (host.dataset.username || host.dataset.multipanelUsername || !host.dataset.contactPhone ||
        targetUsers.some(({ platform, username, destinationId }) =>
          !["ganamos", "multipanel"].includes(platform) ||
          typeof username !== "string" ||
          (destinationId != null && typeof destinationId !== "string")))) return;
    if (isCandidateSelection ? !targetUsers.length : !availablePlatforms.length) return;

    let selectedCandidate = isCandidateSelection ? targetUsers[0] : null;
    let selectedPlatform = selectedCandidate?.platform ||
      (availablePlatforms.some(([platform]) => platform === host.dataset.defaultPlatform)
        ? host.dataset.defaultPlatform
        : availablePlatforms[0][0]);
    const modal = document.createElement("div");
    modal.className = "modal";
    registerModalEscapeHandler(modal, () => {
      root.replaceChildren();
    });
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
    selector.className = isCandidateSelection
      ? "platform-selector password-reset-user-selector"
      : "platform-selector";
    const options = isCandidateSelection
      ? targetUsers
      : availablePlatforms.map(([platform, username]) => ({ platform, username }));
    for (const candidate of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.platform = candidate.platform;
      button.textContent = isCandidateSelection
        ? `${candidate.username}${candidate.sourceName ? ` · ${candidate.sourceName}` : ""}`
        : candidate.platform === "ganamos" ? "Ganamos" : "MultiPanel";
      button.setAttribute("aria-pressed", String(isCandidateSelection
        ? candidate === selectedCandidate
        : candidate.platform === selectedPlatform));
      button.addEventListener("click", () => {
        if (isCandidateSelection) {
          selectedCandidate = candidate;
          selectedPlatform = candidate.platform;
        } else {
          selectedPlatform = candidate.platform;
        }
        dialog.dataset.platform = selectedPlatform;
        for (const option of selector.querySelectorAll("button")) {
          option.setAttribute("aria-pressed", String(option === button));
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
      const username = selectedCandidate?.username ||
        host.dataset[selectedPlatform === "ganamos" ? "username" : "multipanelUsername"];
      if (!username || host.dataset.accounts !== accountsKey ||
        (isCandidateSelection && !host.passwordResetCandidates?.includes(selectedCandidate))) {
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
          data: {
            platform: selectedPlatform,
            nombre: username,
            ...(selectedCandidate?.destinationId
              ? { destinationId: selectedCandidate.destinationId }
              : {})
          }
        });
        if (!response?.ok) throw new Error(response?.error || "La plataforma no confirmó la restauración de la contraseña.");
        showToast(host, username,
          selectedPlatform === "multipanel"
            ? "Contraseña restaurada y todos los links de MultiPanel activados."
            : "Contraseña restaurada correctamente.",
          "success");
      } catch (error) {
        showToast(host, username, error.message || "No se pudo restaurar la contraseña.", "error");
      } finally {
        confirm.disabled = false;
      }
    });

    modal.append(dialog);
    root.replaceChildren(modal);
  }

  async function searchExistingContactUsers(host, digits, accountsKey) {
    const section = host.shadowRoot?.querySelector(".contact-user-search");
    const resultsContainer = section?.querySelector(".contact-user-search-results");
    if (!section || !resultsContainer) return;
    section.hidden = true;
    resultsContainer.replaceChildren();
    host.passwordResetCandidates = [];
    host.shadowRoot.querySelector(".password-reset-button").hidden = true;

    const isCurrentContact = () =>
      document.getElementById(HOST_ID) === host && host.dataset.accounts === accountsKey;
    const appendSearchResult = async (name, result, requestError = null, destinationId = null) => {
      if (requestError) {
        console.error(`[Ganamos balance extension] No se pudieron buscar usuarios en ${name}.`, requestError);
        showToast(host, name, String(requestError), "error", `user-search:${name}:${digits}`);
        const error = document.createElement("div");
        error.className = "contact-user-search-error";
        error.textContent = `${name}: no se pudo completar la búsqueda.`;
        error.title = String(requestError);
        resultsContainer.append(error);
        return;
      }
      dismissToast(`user-search:${name}:${digits}`);
      const namesByPlatform = [];
      result ||= {};
      result.errors ||= {};
      for (const platform of ["ganamos", "multipanel"]) {
        const names = result?.[platform];
        if (!Array.isArray(names)) {
          result.errors[platform] ||= "La respuesta de búsqueda no tiene un formato válido.";
          continue;
        }
        for (const username of names) {
          if (typeof username === "string" && username.includes(digits)) {
            namesByPlatform.push({ username, platform, destinationId, sourceName: name });
          }
        }
      }
      if (!host.dataset.username && !host.dataset.multipanelUsername &&
        host.dataset.contactPhone.length >= 4) {
        host.passwordResetCandidates.push(...namesByPlatform);
        if (namesByPlatform.length) {
          host.shadowRoot.querySelector(".password-reset-button").hidden = false;
        }
      }

      const blockedSettingKeys = [...new Set(namesByPlatform.map(({ username, platform }) =>
        getUserAccountSettingKey("userBlocked", {
          platform,
          username: username.toLowerCase()
        })))];
      if (blockedSettingKeys.length) {
        try {
          const storedBlockedSettings = await stateStorage.get(blockedSettingKeys);
          if (!isCurrentContact()) return;
          for (const key of blockedSettingKeys) {
            loadedBlockedUserAccountSettings.add(key);
            if (storedBlockedSettings[key] === true) blockedUserAccountSettings.add(key);
            else blockedUserAccountSettings.delete(key);
          }
          dismissToast(`user-search-blocked:${name}:${digits}`);
        } catch (error) {
          console.error(
            `[Ganamos balance extension] No se pudo cargar la marca Bloqueado de los usuarios encontrados en ${name}.`,
            error
          );
          showToast(
            host,
            name,
            "No se pudo consultar la configuración Bloqueado de los usuarios encontrados.",
            "error",
            `user-search-blocked:${name}:${digits}`
          );
        }
      }
      if (!isCurrentContact()) return;
      if (namesByPlatform.length) {
        const row = document.createElement("div");
        row.className = "contact-user-search-row";
        const pcLabel = document.createElement("span");
        pcLabel.className = "contact-user-search-pc";
        pcLabel.textContent = `${name}: `;
        row.append(pcLabel);
        namesByPlatform.forEach(({ username, platform }, index) => {
          if (index) row.append(document.createTextNode(" / "));
          const usernameLabel = document.createElement("button");
          usernameLabel.type = "button";
          usernameLabel.className = "contact-user-search-name";
          usernameLabel.textContent = username;
          usernameLabel.dataset.platform = platform;
          usernameLabel.setAttribute(
            "aria-label",
            `${platform === "ganamos" ? "Ganamos" : "MultiPanel"}: ${username}`
          );
          usernameLabel.title = username;
          usernameLabel.addEventListener("click", () =>
            void copyContactValue(
              host,
              platform === "ganamos" ? "Ganamos" : "MultiPanel",
              username,
              "el usuario",
              `copy-search:${destinationId || "local"}:${platform}:${username}`
            ));
          row.append(usernameLabel);
        });
        resultsContainer.append(row);
        updateContactUserSearchBlockedIndicators(resultsContainer);
      }

      for (const [platform, message] of Object.entries(result?.errors || {})) {
        if (!["ganamos", "multipanel"].includes(platform) || !message) continue;
        console.error(`[Ganamos balance extension] No se pudieron buscar usuarios en ${name} (${platform}).`, message);
        showToast(
          host,
          name,
          `${platform === "ganamos" ? "Ganamos" : "MultiPanel"}: ${message}`,
          "error",
          `user-search:${name}:${digits}:${platform}`
        );
        const error = document.createElement("div");
        error.className = "contact-user-search-error";
        error.textContent = `${name}: error al consultar ${platform === "ganamos" ? "Ganamos" : "MultiPanel"}.`;
        error.title = String(message);
        resultsContainer.append(error);
      }
      for (const platform of ["ganamos", "multipanel"]) {
        if (!result.errors[platform]) dismissToast(`user-search:${name}:${digits}:${platform}`);
      }
    };

    try {
      const stored = await stateStorage.get("remoteCreateDestinations");
      const destinations = Array.isArray(stored.remoteCreateDestinations)
        ? stored.remoteCreateDestinations.filter((destination) =>
          typeof destination?.id === "string" && typeof destination.name === "string")
        : [];
      if (!isCurrentContact()) return;

      if (destinations.length) {
        const results = await Promise.all(destinations.map(async (destination) => {
          try {
            const response = await chrome.runtime.sendMessage({
              type: "REMOTE_USER_SEARCH_REQUEST",
              data: { destinationId: destination.id, digits }
            });
            if (!response?.ok) throw new Error(response?.error || "La búsqueda remota no se completó.");
            return { destination, result: response };
          } catch (error) {
            return { destination, error: error.message || "No se pudo consultar la PC." };
          }
        }));
        if (!isCurrentContact()) return;
        for (const { destination, result, error } of results) {
          await appendSearchResult(destination.name, result, error, destination.id);
        }
      } else {
        const response = await chrome.runtime.sendMessage({
          type: "USER_SEARCH_REQUEST",
          data: { digits }
        });
        if (!isCurrentContact()) return;
        if (!response?.ok) throw new Error(response?.error || "La búsqueda en esta PC no se completó.");
        dismissToast(`user-search:local:${digits}`);
        await appendSearchResult("Esta PC", response);
      }
    } catch (error) {
      if (!isCurrentContact()) return;
      console.error("[Ganamos balance extension] No se pudieron buscar usuarios por los últimos cuatro números.", error);
      showToast(host, "Búsqueda de usuarios", error.message || "No se pudo completar la búsqueda.", "error", `user-search:local:${digits}`);
      const failure = document.createElement("div");
      failure.className = "contact-user-search-error";
      failure.textContent = `No se pudo completar la búsqueda: ${error.message || "error desconocido."}`;
      resultsContainer.append(failure);
    }
    if (isCurrentContact()) section.hidden = resultsContainer.childElementCount === 0;
  }

  function updateContact() {
    const zoomViewOpen = [...document.querySelectorAll('button[aria-label="Acercar"]')]
      .some(isRenderedVisible);
    const messageActionMenuOpen = [...document.querySelectorAll(
      'button[role="menuitem"][aria-label="Responder"]'
    )].some(isRenderedVisible);
    const agentBalanceHost = document.getElementById(AGENT_BALANCE_HOST_ID);
    const activeBonusHost = document.getElementById(ACTIVE_BONUS_HOST_ID);
    if (agentBalanceHost) {
      const display = zoomViewOpen ? "none" : "";
      if (agentBalanceHost.style.display !== display) agentBalanceHost.style.display = display;
    }
    updateActiveBonusVisibility(zoomViewOpen);
    if (zoomViewOpen) {
      const host = document.getElementById(HOST_ID);
      if (host && host.style.display !== "none") host.style.display = "none";
      return;
    }

    const title = findContactTitle();
    const hasUnblockButton = Boolean(findUnblockButton());
    const isNormalChat = isNormalChatOpen(title);
    const contactTitle = title?.textContent || "";
    const usernames = isNormalChat ? findPlatformUsernames(contactTitle) : null;
    const phone = isNormalChat
      ? getPhoneFromWhatsAppChat(title) ||
        (!usernames?.ganamos && !usernames?.multipanel
          ? getUnscheduledContactDigits(contactTitle)
          : null)
      : null;
    const hasLegacyUsername = Boolean(
      usernames?.legacy?.ganamos || usernames?.legacy?.multipanel
    );
    if (!usernames?.ganamos && !usernames?.multipanel && !hasLegacyUsername && !phone) {
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
    host.style.display = messageActionMenuOpen ? "none" : "block";
    if (!selectingContactUserText) positionHost(host, title);
    const accountsKey = JSON.stringify({
      usernames: usernames && {
        ganamos: usernames.ganamos,
        multipanel: usernames.multipanel,
        firstPlatform: usernames.firstPlatform
      },
      phone
    });
    if (host.dataset.accounts === accountsKey && activeAccountsKey === accountsKey) {
      updateSportBetsIndicator(
        title,
        Object.values(host.sportBetsStates || {})
          .some((state) => state?.hasBets === true)
      );
      return;
    }
    updateSportBetsIndicator(title, false);
    if (host.dataset.accounts && host.dataset.accounts !== accountsKey) {
      host.shadowRoot.querySelector(".dialog-root").replaceChildren();
    }
    host.dataset.accounts = accountsKey;
    host.dataset.username = usernames?.ganamos || "";
    host.dataset.multipanelUsername = usernames?.multipanel || "";
    host.dataset.defaultPlatform = usernames?.firstPlatform || (usernames?.ganamos ? "ganamos" : "multipanel");
    host.dataset.contactPhone = phone || "";
    host.dataset.withdrawalLimit = "";
    host.dataset.relatedContacts = "";
    const userPreferenceId = getSportBetsPreferenceId(host);
    updateRelatedContactsIndicator(title);
    host.dataset.bonusDisabled = "false";
    host.dataset.accumulatesBonuses = "false";
    const bonusDisabledLabel = host.shadowRoot.querySelector(".bonus-disabled-label");
    if (bonusDisabledLabel) bonusDisabledLabel.hidden = true;
    const accumulatesBonusesLabel = host.shadowRoot.querySelector(".accumulates-bonuses-label");
    if (accumulatesBonusesLabel) accumulatesBonusesLabel.hidden = true;
    void readUserBonusDisabled(userPreferenceId)
      .then((disabled) => {
        if (host.dataset.accounts === accountsKey && activeAccountsKey === accountsKey) {
          updateUserBonusDisabledPresentation(host, disabled);
        }
      })
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudo cargar la configuración de bono por usuario.",
        error
      ));
    void readUserAccumulatesBonuses(userPreferenceId)
      .then((enabled) => {
        if (host.dataset.accounts === accountsKey && activeAccountsKey === accountsKey) {
          updateUserAccumulatesBonusesPresentation(host, enabled);
        }
      })
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudo cargar la configuración Acumula bonos.",
        error
      ));
    void readUserRelatedContacts(userPreferenceId)
      .then((relatedContacts) => {
        if (host.dataset.accounts === accountsKey && activeAccountsKey === accountsKey) {
          host.dataset.relatedContacts = relatedContacts;
          updateRelatedContactsIndicator(findContactTitle());
        }
      })
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudieron cargar los contactos relacionados.",
        error
      ));
    void readUserWithdrawalLimit(userPreferenceId)
      .then((limit) => {
        if (host.dataset.accounts === accountsKey && activeAccountsKey === accountsKey) {
          host.dataset.withdrawalLimit = String(limit);
          updateWithdrawalLimitIndicator(findContactTitle());
        }
      })
      .catch((error) => console.error(
        "[Ganamos balance extension] No se pudo cargar el monto máximo de retiro.",
        error
      ));
    const hasPlatformUsers = Boolean(usernames?.ganamos || usernames?.multipanel);
    host.passwordResetCandidates = [];
    updateDepositBonusBypassVisibility(
      Boolean(activeBonusHost?.dataset.bonusType && activeBonusHost.dataset.bonusType !== "none"),
      activeBonusHost?.dataset.invertDepositButtons === "true"
    );
    updateDepositAdvertisingVisibility(activeBonusHost?.dataset.advertisingReady === "true");
    const contactUserSearch = host.shadowRoot.querySelector(".contact-user-search");
    contactUserSearch.hidden = true;
    contactUserSearch.querySelector(".contact-user-search-results").replaceChildren();
    host.shadowRoot.querySelector(".user-information-button").hidden =
      !hasPlatformUsers && !hasUnblockButton;
    host.shadowRoot.querySelector(".reschedule-button").hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".exchange-button").hidden =
      !usernames?.ganamos || !usernames?.multipanel;
    updateWithdrawalLimitIndicator();
    const missingPlatform = usernames?.ganamos && !usernames?.multipanel
      ? "multipanel"
      : usernames?.multipanel && !usernames?.ganamos
        ? "ganamos"
        : null;
    host.shadowRoot.querySelector('[data-action="deposit"]').hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".deposit-action-group").hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".withdrawal-action-group").hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".password-reset-button").hidden = !hasPlatformUsers;
    host.shadowRoot.querySelector(".status").hidden = !hasPlatformUsers;
    const createUserButton = host.shadowRoot.querySelector(".create-user-button");
    const legacyMigrations = ["ganamos", "multipanel"]
      .filter((platform) => !usernames?.[platform] && usernames?.legacy?.[platform])
      .map((platform) => ({ platform, ...usernames.legacy[platform] }));
    host.legacyMigrations = legacyMigrations;
    const legacyMigrationButtons = host.shadowRoot.querySelector(".legacy-migration-buttons");
    const showStandaloneMigrations = !hasPlatformUsers && legacyMigrations.length > 0;
    legacyMigrationButtons.replaceChildren();
    legacyMigrationButtons.hidden = !showStandaloneMigrations;
    if (showStandaloneMigrations) {
      for (const migration of legacyMigrations) {
        const platformName = migration.platform === "ganamos" ? "Ganamos" : "MultiPanel";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "create-user-button";
        button.dataset.mode = "full";
        button.dataset.platform = migration.platform;
        button.textContent = `Migrar Usuario ${platformName}`;
        button.title = `Migrar ${migration.username} a ${platformName}`;
        button.setAttribute("aria-label", button.title);
        button.addEventListener("click", () =>
          openCreateUserDialog(host, migration.platform, migration));
        legacyMigrationButtons.append(button);
      }
      if (legacyMigrations.length === 1) {
        const migration = legacyMigrations[0];
        const platform = migration.platform === "ganamos" ? "multipanel" : "ganamos";
        const platformName = platform === "ganamos" ? "Ganamos" : "MultiPanel";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "create-user-button";
        button.dataset.mode = "full";
        button.dataset.platform = platform;
        button.textContent = `Nuevo Usuario ${platformName}`;
        button.title = `Crear un usuario ${platformName} para este contacto`;
        button.setAttribute("aria-label", button.title);
        button.addEventListener("click", () =>
          openCreateUserDialog(host, platform, null, migration.base));
        legacyMigrationButtons.append(button);
      }
    }
    createUserButton.hidden = showStandaloneMigrations ||
      (!missingPlatform && (!phone || hasPlatformUsers));
    const createFromScratch = !hasPlatformUsers && Boolean(phone);
    createUserButton.dataset.mode = createFromScratch ? "full" : "compact";
    createUserButton.dataset.platform = missingPlatform || "ganamos";
    const missingPlatformMigration = legacyMigrations.find(({ platform }) =>
      platform === missingPlatform);
    const createUserLabel = createFromScratch
      ? "Crear Usuario"
      : missingPlatform
      ? `${missingPlatformMigration ? "Migrar usuario" : "Crear"} ${missingPlatform === "ganamos" ? "Ganamos" : "MultiPanel"}`
      : "Crear usuario";
    createUserButton.textContent = createFromScratch ? "Crear Usuario" : "+";
    createUserButton.title = createUserLabel;
    createUserButton.setAttribute("aria-label", createUserLabel);
    host.dataset.createPlatform = missingPlatform || "";
    host.balanceStates = {};
    host.sportBetsStates = {};
    activeAccountsKey = accountsKey;
    agentBalanceContactKey = accountsKey;
    if (hasPlatformUsers) void updateWithdrawalButtonState(host, accountsKey);
    if (agentBalanceHost && isAgentMovementView(agentBalanceView)) {
      void renderAgentMovements(agentBalanceHost);
    }
    if (hasPlatformUsers) void refreshBalance(host);
    else if (phone) void searchExistingContactUsers(host, phone.slice(-4), accountsKey);
  }

  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      updateContact();
      scheduleContactTagScan();
      renderPendingWithdrawals();
    });
  }

  function protectExtensionTextSelection(event) {
    const path = event.composedPath();
    const startedOnBalanceText = path.some((target) =>
      target instanceof Element &&
      (target.classList.contains("agent-balance-label") ||
        target.classList.contains("agent-balance-amount"))
    ) && path.some((target) =>
      target instanceof Element && target.id === AGENT_BALANCE_HOST_ID
    );
    const startedOnContactUserText = path.some((target) =>
      target instanceof Element && target.classList.contains("contact-user-search")
    ) && path.some((target) =>
      target instanceof Element && target.id === HOST_ID
    );
    if (event.type === "mousedown" || event.type === "pointerdown") {
      if (startedOnBalanceText) selectingAgentBalanceText = true;
      if (startedOnContactUserText) selectingContactUserText = true;
    }
    if (!startedOnBalanceText && !selectingAgentBalanceText &&
      !startedOnContactUserText && !selectingContactUserText) return;
    event.stopImmediatePropagation();
    event.stopPropagation();
    if (event.type === "mouseup" || event.type === "pointerup" || event.type === "pointercancel") {
      window.setTimeout(() => {
        selectingAgentBalanceText = false;
        selectingContactUserText = false;
        scheduleUpdate();
      }, 0);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(({ target }) =>
      target.id === HOST_ID || target.id === AGENT_BALANCE_HOST_ID ||
      target.id === CONTACT_FLOW_COUNTER_HOST_ID ||
      target.id === PENDING_WITHDRAWALS_HOST_ID)) return;
    if (mutations.some(({ target, addedNodes, removedNodes }) =>
      nodeTouchesSidebar(target) ||
      [...addedNodes, ...removedNodes].some(nodeTouchesSidebar))) {
      scheduleContactTagScan();
    }
    scheduleUpdate();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-hidden", "aria-label", "aria-selected", "class", "data-id", "hidden", "style", "title"],
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
    window.addEventListener(eventName, protectExtensionTextSelection, true);
  }
  window.addEventListener("blur", () => {
    selectingAgentBalanceText = false;
    selectingContactUserText = false;
  });
  createActiveBonusHost();
  createContactFlowCounterPanel();
  createPendingWithdrawalsPanel();
  const agentBalanceHost = createAgentBalancePanel();
  void refreshAgentBalance(agentBalanceHost);
  void refreshMultiPanelAgentBalance(agentBalanceHost);
  void loadContactVisualTags();
  window.setInterval(() => {
    void refreshAgentBalance(agentBalanceHost);
    void refreshMultiPanelAgentBalance(agentBalanceHost);
    void refreshPendingWithdrawalBalances();
  }, 60_000);
  updateContact();
})();
