// background.js
const API_BASE = "http://localhost:8000";
const SESSION_CACHE_TTL = 60000; // 60s
const sessionCache = new Map(); // key -> {ts, value}

function cacheKeySpell(text, model) {
  return `SC|${model}|${text}`;
}
function cacheKeyAuto(text, model) {
  return `AC|${model}|${text}`;
}
function cacheGet(key) {
  const row = sessionCache.get(key);
  if (!row) return null;
  if (Date.now() - row.ts > SESSION_CACHE_TTL) {
    sessionCache.delete(key);
    return null;
  }
  return row.value;
}
function cacheSet(key, value) {
  sessionCache.set(key, { ts: Date.now(), value });
}

async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "HEALTH") {
        const data = await apiGet("/health");
        return sendResponse({ ok: data.ok === true });
      }
      if (msg.type === "GET_MODELS") {
        const data = await apiGet("/models");
        return sendResponse({ models: data.models || [] });
      }
      if (msg.type === "SPELLCHECK") {
        const { text, model } = msg;
        const key = cacheKeySpell(text, model);
        const cached = cacheGet(key);
        if (cached) return sendResponse({ corrections: cached, cached: true });

        const data = await apiPost("/spellcheck", { text, model });
        cacheSet(key, data.corrections || []);
        return sendResponse({ corrections: data.corrections || [] });
      }
      if (msg.type === "AUTOCORRECT_ALL") {
        const { text, model } = msg;
        const key = cacheKeyAuto(text, model);
        const cached = cacheGet(key);
        if (cached) return sendResponse({ text: cached, cached: true });

        const data = await apiPost("/correct", { text, model });
        cacheSet(key, data.text || "");
        return sendResponse({ text: data.text || "" });
      }
    } catch (e) {
      return sendResponse({ error: e.message || String(e) });
    }
  })();
  return true; // keep port open
});
