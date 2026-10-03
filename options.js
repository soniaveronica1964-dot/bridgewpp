const roleInput = document.querySelector("#role");
const ganamosUserIdInput = document.querySelector("#ganamosUserId");
const tokenInput = document.querySelector("#token");
const ganamosSuffixInput = document.querySelector("#ganamosSuffix");
const multiPanelSuffixInput = document.querySelector("#multiPanelSuffix");
const userCreationPasswordInput = document.querySelector("#userCreationPassword");
const hint = document.querySelector("#hint");
const status = document.querySelector("#status");

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
  if (role !== "standalone" && !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    status.textContent = "El código no tiene el formato esperado. Copialo de credentials.json.";
    return;
  }

  try {
    await chrome.storage.local.set({
      bridgeRole: role,
      bridgeToken: role === "standalone" ? "" : token,
      ganamosUserId,
      ganamosSuffix,
      multiPanelSuffix,
      userCreationPassword: userCreationPasswordInput.value
    });
    status.textContent = "Configuración guardada. Usá los mismos sufijos en el perfil principal y recargá WhatsApp Web.";
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
  "userCreationPassword"
])
  .then(({ bridgeRole, bridgeToken, ganamosUserId, ganamosSuffix, multiPanelSuffix, userCreationPassword }) => {
    roleInput.value = ["primary", "secondary"].includes(bridgeRole) ? bridgeRole : "standalone";
    ganamosUserIdInput.value = /^\d+$/.test(String(ganamosUserId ?? ""))
      ? String(ganamosUserId)
      : "38175478";
    tokenInput.value = typeof bridgeToken === "string" ? bridgeToken : "";
    ganamosSuffixInput.value = typeof ganamosSuffix === "string" ? ganamosSuffix : "f";
    multiPanelSuffixInput.value = typeof multiPanelSuffix === "string" ? multiPanelSuffix : "y";
    userCreationPasswordInput.value = typeof userCreationPassword === "string" ? userCreationPassword : "";
    updateHint();
  })
  .catch((error) => {
    status.textContent = `No se pudo cargar la configuración: ${error.message}`;
  });
