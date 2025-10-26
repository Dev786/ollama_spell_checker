// popup.js
const toggleBtn = document.getElementById("toggle");
const healthEl = document.getElementById("health");
const modelSel = document.getElementById("model");
const debounceInput = document.getElementById("debounce");
let autoCorrectActive = false;
const autoBtn = document.getElementById("autocorrect");

async function checkHealth() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "HEALTH" }, (res) => {
      resolve(!!(res && res.ok));
    });
  });
}
async function loadModels() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_MODELS" }, (res) => {
      resolve((res && res.models) || []);
    });
  });
}

function setEnabledUI(enabled) {
  toggleBtn.textContent = enabled ? "Disable" : "Enable";
}

document.addEventListener("DOMContentLoaded", async () => {
  // load state
  chrome.storage.local.get(["spellCheckEnabled", "model", "debounceMs"], async (data) => {
    const enabled = data.spellCheckEnabled ?? true;
    setEnabledUI(enabled);

    const ok = await checkHealth();
    healthEl.textContent = ok ? "🟢 Ollama connected" : "🔴 Ollama not reachable";

    const models = await loadModels();
    modelSel.innerHTML = "";
    (models.length ? models : ["llama3"]).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      modelSel.appendChild(opt);
    });
    const currentModel = data.model || (models[0] || "llama3");
    modelSel.value = currentModel;

    debounceInput.value = data.debounceMs || 800;
  });
});

toggleBtn.addEventListener("click", () => {
  chrome.storage.local.get("spellCheckEnabled", (data) => {
    const current = data.spellCheckEnabled ?? true;
    const next = !current;
    chrome.storage.local.set({ spellCheckEnabled: next }, () => {
      setEnabledUI(next);
      chrome.runtime.sendMessage({ type: "SPELL_CHECK_TOGGLE", enabled: next });
    });
  });
});

modelSel.addEventListener("change", () => {
  const val = modelSel.value;
  chrome.storage.local.set({ model: val }, () => {
    chrome.runtime.sendMessage({ type: "MODEL_SET", model: val });
  });
});

debounceInput.addEventListener("change", () => {
  const ms = Math.max(200, parseInt(debounceInput.value || "800", 10));
  chrome.storage.local.set({ debounceMs: ms }, () => {
    chrome.runtime.sendMessage({ type: "DEBOUNCE_SET", ms });
  });
});

autoBtn.addEventListener("click", () => {
  // set the text that auto correct is active on
  autoCorrectActive = !autoCorrectActive;
  autoBtn.textContent = autoCorrectActive ? "Stop Auto-correct" : "Start Auto-correct";
  chrome.runtime.sendMessage({ type: "AUTOCORRECT_ACTIVE" });
});
