const roleInput = document.querySelector("#role");
const ganamosUserIdInput = document.querySelector("#ganamosUserId");
const tokenInput = document.querySelector("#token");
const ganamosSuffixInput = document.querySelector("#ganamosSuffix");
const multiPanelSuffixInput = document.querySelector("#multiPanelSuffix");
const userCreationPasswordInput = document.querySelector("#userCreationPassword");
const hint = document.querySelector("#hint");
const status = document.querySelector("#status");
const remoteDestinationFields = [1, 2, 3].map((index) => ({
  id: `remote-${index}`,
  name: document.querySelector(`#remoteName${index}`),
  url: document.querySelector(`#remoteUrl${index}`),
  token: document.querySelector(`#remoteToken${index}`),
  ganamosSuffix: document.querySelector(`#remoteGanamosSuffix${index}`),
  multiPanelSuffix: document.querySelector(`#remoteMultiPanelSuffix${index}`)
}));

function normalizeRemoteOrigin(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("La dirección remota no es válida.");
  }
  if (url.protocol !== "http:" || url.port !== "32146" || url.pathname !== "/" ||
    url.search || url.hash || url.username || url.password) {
    throw new Error("Usá una dirección http:// de la PC destino, puerto 32146 y sin rutas adicionales.");
  }

  const host = url.hostname.toLowerCase();
  const ipv4Parts = host.split(".");
  const isIPv4 = ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const isPrivateIPv4 = isIPv4 && (
    Number(ipv4Parts[0]) === 10 ||
    Number(ipv4Parts[0]) === 172 && Number(ipv4Parts[1]) >= 16 && Number(ipv4Parts[1]) <= 31 ||
    Number(ipv4Parts[0]) === 192 && Number(ipv4Parts[1]) === 168 ||
    Number(ipv4Parts[0]) === 100 && Number(ipv4Parts[1]) >= 64 && Number(ipv4Parts[1]) <= 127 ||
    Number(ipv4Parts[0]) === 169 && Number(ipv4Parts[1]) === 254 ||
    Number(ipv4Parts[0]) === 127
  );
  const ipv6Host = host.startsWith("[") ? host.slice(1, -1) : "";
  const isPrivateIPv6 = ipv6Host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ipv6Host) ||
    /^fe[89ab][0-9a-f]:/i.test(ipv6Host);
  const isPrivateHostname = /^[a-z0-9.-]+$/.test(host) &&
    /\.(local|lan|internal)$/.test(host);
  if (!isPrivateIPv4 && !isPrivateIPv6 && !isPrivateHostname) {
    throw new Error("La dirección debe ser una IP o un nombre de host de red privada.");
  }
  return url.origin;
}

function getRemotePermissionPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

function readRemoteDestinations() {
  const destinations = [];
  const usedNames = new Set();
  const usedOrigins = new Set();
  for (const fields of remoteDestinationFields) {
    const name = fields.name.value.trim();
    const urlValue = fields.url.value.trim();
    const token = fields.token.value.trim();
    const ganamosSuffix = fields.ganamosSuffix.value.trim().toLowerCase();
    const multiPanelSuffix = fields.multiPanelSuffix.value.trim().toLowerCase();
    if (!name && !urlValue && !token) continue;
    if (!name || !urlValue || !token) {
      throw new Error(`Completá nombre, dirección y código del destino ${fields.id.slice(-1)}.`);
    }
    if (name.length > 40) throw new Error("El nombre visible de cada PC admite hasta 40 caracteres.");
    const normalizedName = name.toLocaleLowerCase();
    if (usedNames.has(normalizedName)) throw new Error("Los nombres visibles de los destinos deben ser distintos.");
    usedNames.add(normalizedName);
    const origin = normalizeRemoteOrigin(urlValue);
    if (usedOrigins.has(origin)) throw new Error("Cada destino debe usar una dirección distinta.");
    usedOrigins.add(origin);
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      throw new Error(`El código remoto de ${name} no tiene el formato esperado.`);
    }
    if (!/^[a-z]$/.test(ganamosSuffix) || !/^[a-z]$/.test(multiPanelSuffix) ||
      ganamosSuffix === multiPanelSuffix) {
      throw new Error(`Configurá dos sufijos distintos de una sola letra para ${name}.`);
    }
    destinations.push({
      id: fields.id,
      name,
      url: origin,
      token,
      ganamosSuffix,
      multiPanelSuffix
    });
  }
  return destinations;
}

function populateRemoteDestinations(destinations) {
  for (const fields of remoteDestinationFields) {
    const destination = destinations.find((item) => item.id === fields.id);
    fields.name.value = destination?.name || "";
    fields.url.value = destination?.url || "";
    fields.token.value = destination?.token || "";
    fields.ganamosSuffix.value = destination?.ganamosSuffix || "";
    fields.multiPanelSuffix.value = destination?.multiPanelSuffix || "";
  }
}

function updateHint() {
  if (roleInput.value === "primary") {
    hint.textContent = "Pegá primaryToken del archivo local credentials.json. El puente debe estar ejecutándose en esta computadora.";
    tokenInput.autocomplete = "off";
  } else if (roleInput.value === "secondary") {
    hint.textContent = "Pegá clientToken del mismo archivo credentials.json usado por el perfil principal.";
    tokenInput.autocomplete = "off";
  } else {
    hint.textContent = "El modo independiente no necesita código.";
    tokenInput.value = "";
  }
  tokenInput.disabled = roleInput.value === "standalone";
  tokenInput.required = roleInput.value !== "standalone";
}

roleInput.addEventListener("change", updateHint);
document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const role = roleInput.value;
  const ganamosUserId = ganamosUserIdInput.value.trim();
  const token = tokenInput.value.trim();
  const ganamosSuffix = ganamosSuffixInput.value.trim().toLowerCase();
  const multiPanelSuffix = multiPanelSuffixInput.value.trim().toLowerCase();
  if (!["standalone", "primary", "secondary"].includes(role)) {
    status.textContent = "Elegí un modo válido.";
    return;
  }
  if (!/^\d+$/.test(ganamosUserId)) {
    status.textContent = "Ingresá un ID de agente Ganamos válido, usando solo números.";
    return;
  }
  if (!/^[a-z]$/.test(ganamosSuffix) || !/^[a-z]$/.test(multiPanelSuffix) ||
    ganamosSuffix === multiPanelSuffix) {
    status.textContent = "Ingresá una sola letra para cada plataforma y asegurate de que sean distintas.";
    return;
  }
  let remoteDestinations;
  try {
    remoteDestinations = readRemoteDestinations();
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  if (role !== "standalone" && !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    status.textContent = "El código no tiene el formato esperado. Copialo de credentials.json.";
    return;
  }

  try {
    const origins = remoteDestinations.map(({ url }) => getRemotePermissionPattern(url));
    if (origins.length && !await chrome.permissions.request({ origins })) {
      status.textContent = "No se concedió permiso de conexión a uno o más destinos.";
      return;
    }
    const previous = await chrome.storage.local.get("remoteCreateDestinations");
    const previousOrigins = (Array.isArray(previous.remoteCreateDestinations)
      ? previous.remoteCreateDestinations
      : [])
      .filter((destination) => typeof destination?.url === "string")
      .map((destination) => getRemotePermissionPattern(destination.url));
    await chrome.storage.local.set({
      bridgeRole: role,
      bridgeToken: role === "standalone" ? "" : token,
      ganamosUserId,
      ganamosSuffix,
      multiPanelSuffix,
      userCreationPassword: userCreationPasswordInput.value,
      remoteCreateDestinations: remoteDestinations
    });
    const removedOrigins = previousOrigins.filter((origin) => !origins.includes(origin));
    if (removedOrigins.length) await chrome.permissions.remove({ origins: removedOrigins });
    status.textContent = "Configuración guardada. Recargá WhatsApp Web para aplicar los cambios.";
  } catch (error) {
    status.textContent = `No se pudo guardar la configuración: ${error.message}`;
  }
});

chrome.storage.local.get([
  "bridgeRole",
  "bridgeToken",
  "ganamosUserId",
  "ganamosSuffix",
  "multiPanelSuffix",
  "userCreationPassword",
  "remoteCreateDestinations"
])
  .then(({ bridgeRole, bridgeToken, ganamosUserId, ganamosSuffix, multiPanelSuffix, userCreationPassword, remoteCreateDestinations }) => {
    roleInput.value = ["primary", "secondary"].includes(bridgeRole) ? bridgeRole : "standalone";
    ganamosUserIdInput.value = /^\d+$/.test(String(ganamosUserId ?? ""))
      ? String(ganamosUserId)
      : "38175478";
    tokenInput.value = typeof bridgeToken === "string" ? bridgeToken : "";
    ganamosSuffixInput.value = typeof ganamosSuffix === "string" ? ganamosSuffix : "f";
    multiPanelSuffixInput.value = typeof multiPanelSuffix === "string" ? multiPanelSuffix : "y";
    userCreationPasswordInput.value = typeof userCreationPassword === "string" ? userCreationPassword : "";
    populateRemoteDestinations(Array.isArray(remoteCreateDestinations) ? remoteCreateDestinations : []);
    updateHint();
  })
  .catch((error) => {
    status.textContent = `No se pudo cargar la configuración: ${error.message}`;
  });
