// content.js
console.log("✅ ollama_spell_content.js loaded (idle-timer, seq-checked, rate-limited)");

/* =========================
   CONFIG
========================= */
let enabled = true;
let model = "llama3";
let IDLE_MS = 900;              // send only when user truly idle this long
const MIN_INTERVAL_MS = 2500;   // hard throttle per element
const MIN_LEN = 5;              // ignore very short strings to cut noise

/* =========================
   STATE
========================= */
let currentTarget = null;
let floatingWindow = null;
let miniWindow = null;
let popupEl = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

/* Per-element WeakMap state */
const idleTimer       = new WeakMap(); // el -> timeout id
const lastInputAt     = new WeakMap(); // el -> ts of last real input
const throttleNextAt  = new WeakMap(); // el -> ts when next send allowed
const suppressOnce    = new WeakMap(); // el -> bool (ignore next input we caused)
const composingIME    = new WeakMap(); // el -> bool (user composing)
const latestSeq       = new WeakMap(); // el -> last request seq id
const lastAppliedText = new WeakMap(); // el -> text the UI currently represents
const isVisibleMap    = new WeakMap(); // el -> isIntersecting

/* =========================
   INIT SETTINGS
========================= */
chrome.storage.local.get(["spellCheckEnabled", "model", "debounceMs"], (data) => {
  enabled = data.spellCheckEnabled ?? true;
  model = data.model || "llama3";
  // If user had a custom debounce, map it to idle ms gently
  if (typeof data.debounceMs === "number" && data.debounceMs >= 200) {
    IDLE_MS = data.debounceMs;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SPELL_CHECK_TOGGLE") enabled = !!msg.enabled;
  if (msg.type === "MODEL_SET") model = msg.model || "llama3";
  if (msg.type === "DEBOUNCE_SET") IDLE_MS = Math.max(200, msg.ms || 900);
  if (msg.type === "AUTOCORRECT_ACTIVE" && currentTarget) doAutoCorrectAll(currentTarget);
});

/* =========================
   DETECT EDITABLES
========================= */
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => isVisibleMap.set(e.target, e.isIntersecting)),
  { root: null, threshold: 0 }
);

const editableObserver = new MutationObserver(() => detectEditables());
editableObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener("load", () => detectEditables());

function detectEditables() {
  const nodes = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
  nodes.forEach((el) => {
    if (!el.__ollama_bound) {
      el.addEventListener("focusin", () => onFocus(el));
      el.addEventListener("input", () => onInput(el));
      el.addEventListener("compositionstart", () => composingIME.set(el, true));
      el.addEventListener("compositionend", () => { composingIME.set(el, false); scheduleIdle(el); });
      try { io.observe(el); } catch {}
      el.__ollama_bound = true;
    }
  });
}

/* =========================
   EVENT HANDLERS
========================= */
function onFocus(el) {
  if (!enabled) return;
  currentTarget = el;
  scheduleIdle(el);
}

function onInput(el) {
  if (!enabled || currentTarget !== el) return;
  // Skip programmatic writes we caused
  if (suppressOnce.get(el)) { suppressOnce.set(el, false); return; }
  // Update last real input time, then schedule idle check
  lastInputAt.set(el, Date.now());
  scheduleIdle(el);
}

/* =========================
   IDLE TIMER (trailing-only)
========================= */
function scheduleIdle(el) {
  if (!enabled) return;
  if (composingIME.get(el)) return;
  if (document.visibilityState !== "visible") return;
  if (isVisibleMap.has(el) && !isVisibleMap.get(el)) return;

  // Record last input time if not present (e.g., on focus)
  if (!lastInputAt.get(el)) lastInputAt.set(el, Date.now());

  // Clear any existing idle timer and set a new trailing one
  clearTimeout(idleTimer.get(el));
  const t = setTimeout(() => idleTick(el), IDLE_MS);
  idleTimer.set(el, t);
}

function idleTick(el) {
  // If new input happened within the idle window, push the timer forward
  const last = lastInputAt.get(el) || 0;
  const now = Date.now();
  const since = now - last;
  if (since < IDLE_MS) {
    clearTimeout(idleTimer.get(el));
    const t = setTimeout(() => idleTick(el), IDLE_MS - since);
    idleTimer.set(el, t);
    return;
  }
  // Truly idle → maybe send (with throttle)
  maybeSend(el);
}

/* =========================
   TEXT HELPERS (preserve spacing)
========================= */
function getTextFromElement(el) {
  if (!el) return "";
  if (el.isContentEditable) {
    // Keep exact spacing; normalize NBSP from rich editors for stable indices
    return (el.textContent || "").replace(/\u00A0/g, " ");
  }
  return el.value || "";
}

function setTextToElement(el, val, { programmatic = false } = {}) {
  if (!el) return;
  if (programmatic) suppressOnce.set(el, true);
  if (el.isContentEditable) el.textContent = val;
  else el.value = val;
}

/* =========================
   RATE-LIMITED SENDER
========================= */
function maybeSend(el) {
  const text = getTextFromElement(el);
  if (!text || text.trim().length === 0) {
    removeUI();
    lastAppliedText.set(el, "");
    return;
  }
  if (text.length < MIN_LEN) return; // too short to bother

  // Avoid redraw spam: if UI already represents this text, skip
  if ((lastAppliedText.get(el) || "") === text) return;

  // Hard throttle
  const nextOk = throttleNextAt.get(el) || 0;
  const now = Date.now();
  if (now < nextOk) {
    // Defer exactly until throttle window ends
    clearTimeout(idleTimer.get(el));
    const t = setTimeout(() => maybeSend(el), nextOk - now + 5);
    idleTimer.set(el, t);
    return;
  }

  // Lock next allowed window *before* sending
  throttleNextAt.set(el, now + MIN_INTERVAL_MS);
  runSpellCheck(el, text);
}

/* =========================
   SEQ HELPERS
========================= */
function nextSeq(el) {
  const n = (latestSeq.get(el) || 0) + 1;
  latestSeq.set(el, n);
  return n;
}
function isLatest(el, seq) {
  return latestSeq.get(el) === seq;
}

/* =========================
   SPELLCHECK CORE (seq-checked)
========================= */
function runSpellCheck(el, textSnapshot) {
  const seq = nextSeq(el);
  chrome.runtime.sendMessage({ type: "SPELLCHECK", text: textSnapshot, model, seq }, (res) => {
    if (!res || res.error) {
      console.error("❌ Spellcheck error:", res?.error);
      return;
    }
    // Accept only if: (1) still latest response, (2) editor text unchanged
    if (!isLatest(el, seq)) return;
    if (getTextFromElement(el) !== textSnapshot) return;

    const html = buildHighlightedHTMLStrict(textSnapshot, Array.isArray(res.corrections) ? res.corrections : []);
    if (!html) {
      removeUI();
      lastAppliedText.set(el, textSnapshot);
      return;
    }
    showFloatingWindow(html);
    lastAppliedText.set(el, textSnapshot);
  });
}

/* =========================
   UI: Floating window (right, centered, draggable, minimizable)
========================= */
function showFloatingWindow(html) {
  if (miniWindow) { miniWindow.remove(); miniWindow = null; }

  if (!floatingWindow) {
    floatingWindow = document.createElement("div");
    floatingWindow.className = "ollama-floating-window";
    Object.assign(floatingWindow.style, {
      position: "fixed",
      top: "50%",
      right: "20px",
      transform: "translateY(-50%)",
      width: "420px",
      height: "75vh",
      background: "#fff",
      border: "1px solid #ccc",
      borderRadius: "12px",
      boxShadow: "0 8px 20px rgba(0,0,0,0.25)",
      overflow: "hidden",
      zIndex: "999999",
      fontFamily: "system-ui, sans-serif",
      color: "#222",
      userSelect: "none",
    });
    document.body.appendChild(floatingWindow);
  }

  // Single-line concatenation avoids stray whitespace with pre-wrap
  floatingWindow.innerHTML =
    '<div class="overlay-header" style="display:flex;justify-content:space-between;align-items:center;background:#f7f7f7;padding:10px 14px;border-bottom:1px solid #e0e0e0;font-weight:700;font-size:1em;color:#111;cursor:move;">' +
      '<span>🧠 Ollama Spell Check</span>' +
      '<span class="overlay-minimize" style="cursor:pointer;font-size:1.3em;color:#555;">−</span>' +
    '</div>' +
    '<div class="spell-overlay" style="padding:14px;height:calc(100% - 48px);overflow-y:auto;white-space:pre-wrap;word-wrap:break-word;line-height:1.5;font-size:0.95em;color:#222;user-select:text;">' +
      html +
    '</div>';

  const header = floatingWindow.querySelector(".overlay-header");
  header.addEventListener("mousedown", startDrag);
  document.addEventListener("mouseup", stopDrag);
  document.addEventListener("mousemove", drag);
  floatingWindow.querySelector(".overlay-minimize").addEventListener("click", minimizeToMiniWindow);

  // Bind suggestion popups
  floatingWindow.querySelectorAll(".misspelled-word").forEach((el) => {
    el.addEventListener("click", (e) => {
      const suggs = tryParseSuggestions(el.getAttribute("data-suggs"));
      showSuggestionPopup(el, suggs);
      e.stopPropagation();
    });
  });
}

function minimizeToMiniWindow() {
  if (!floatingWindow) return;
  floatingWindow.style.display = "none";

  miniWindow = document.createElement("div");
  miniWindow.innerHTML =
    '<div style="font-weight:600;font-size:14px;">🧠 Ollama Spell Checker</div>' +
    '<div style="font-size:12px;color:#555;margin-top:4px;">Click to reopen</div>';

  Object.assign(miniWindow.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    width: "250px",
    height: "100px",
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "10px",
    boxShadow: "0 4px 10px rgba(0,0,0,0.2)",
    zIndex: "999999",
    fontFamily: "system-ui, sans-serif",
    color: "#111",
    padding: "10px",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    cursor: "pointer",
  });

  miniWindow.addEventListener("click", () => {
    floatingWindow.style.display = "block";
    miniWindow.remove();
    miniWindow = null;
  });
  document.body.appendChild(miniWindow);
}

/* =========================
   DRAGGING
========================= */
function startDrag(e) {
  isDragging = true;
  dragOffset.x = e.clientX - floatingWindow.offsetLeft;
  dragOffset.y = e.clientY - floatingWindow.offsetTop;
  floatingWindow.style.boxShadow = "0 10px 24px rgba(0,0,0,0.35)";
}
function stopDrag() {
  isDragging = false;
  if (floatingWindow) floatingWindow.style.boxShadow = "0 8px 20px rgba(0,0,0,0.25)";
}
function drag(e) {
  if (!isDragging || !floatingWindow) return;
  e.preventDefault();
  floatingWindow.style.left = (e.clientX - dragOffset.x) + "px";
  floatingWindow.style.top  = (e.clientY - dragOffset.y) + "px";
  floatingWindow.style.right = "auto";
  floatingWindow.style.transform = "translate(0,0)";
}

/* =========================
   CLEANUP
========================= */
function removeUI() {
  [floatingWindow, miniWindow, popupEl].forEach((el) => el && el.remove());
  floatingWindow = null;
  miniWindow = null;
  popupEl = null;
}

/* =========================
   STRICT HIGHLIGHTING (no false positives)
========================= */
function buildHighlightedHTMLStrict(text, corrections) {
  if (!text) return "";

  const raw = [];
  for (const c of corrections || []) {
    const suggs = Array.isArray(c.suggestions)
      ? c.suggestions
      : (typeof c.suggestions === "string" && c.suggestions.trim() ? [c.suggestions.trim()] : []);
    for (const pos of c.positions || []) {
      const s = pos[0], e = pos[1];
      if (Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s && e <= text.length) {
        raw.push({ start: s, end: e, word: c.word, suggestions: suggs });
      }
    }
  }

  raw.sort((a, b) => a.start - b.start);
  const accepted = [];
  let lastEnd = -1;

  for (const r of raw) {
    if (r.start < lastEnd) continue; // no overlaps
    const part = text.slice(r.start, r.end);
    if (!/[A-Za-z]/.test(part)) continue;

    const left  = r.start > 0 ? text[r.start - 1] : "";
    const right = r.end < text.length ? text[r.end] : "";
    if (/[A-Za-z0-9_]/.test(left) || /[A-Za-z0-9_]/.test(right)) continue; // word boundary

    if (!hasMeaningfulDiff(part, r.suggestions)) continue;

    accepted.push(r);
    lastEnd = r.end;
  }

  if (!accepted.length) return "";

  let out = [];
  let cursor = 0;
  for (const r of accepted) {
    out.push(escapeHtml(text.slice(cursor, r.start)));
    out.push(
      '<span class="misspelled-word" style="text-decoration:underline wavy red;cursor:pointer;color:#c62828;font-weight:500;"' +
      ' data-start="' + r.start + '"' +
      ' data-end="' + r.end + '"' +
      ' data-word="' + encodeURIComponent(r.word || "") + '"' +
      ' data-suggs="' + encodeURIComponent(JSON.stringify(r.suggestions || [])) + '">' +
      escapeHtml(text.slice(r.start, r.end)) +
      '</span>'
    );
    cursor = r.end;
  }
  out.push(escapeHtml(text.slice(cursor)));
  return out.join("");
}

function normalizeForCompare(s) {
  return (s || "").toLowerCase().replace(/^[^a-z0-9]+/gi, "").replace(/[^a-z0-9]+$/gi, "");
}
function hasMeaningfulDiff(original, suggestions) {
  const base = normalizeForCompare(original);
  if (!base) return false;
  for (const sug of suggestions || []) {
    const norm = normalizeForCompare(sug);
    if (norm && norm !== base) return true;
  }
  return false;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function tryParseSuggestions(val) {
  if (!val) return [];
  try { return JSON.parse(decodeURIComponent(val)); } catch { return []; }
}

/* =========================
   SUGGESTION POPUP (topmost)
========================= */
function showSuggestionPopup(span, suggestions) {
  if (popupEl) popupEl.remove();
  popupEl = document.createElement("div");
  popupEl.className = "ollama-suggestion-popup";

  const list = Array.isArray(suggestions) ? suggestions : [suggestions].filter(Boolean);
  list.forEach((s) => {
    const item = document.createElement("div");
    item.textContent = s;
    Object.assign(item.style, {
      padding: "6px 10px",
      cursor: "pointer",
      color: "#111",
      fontSize: "0.9em",
      whiteSpace: "nowrap",
      borderRadius: "4px",
    });
    item.addEventListener("mouseenter", () => (item.style.background = "#f2f2f2"));
    item.addEventListener("mouseleave", () => (item.style.background = "transparent"));
    item.addEventListener("click", () => {
      applyReplacementByIndex(span, s);
      popupEl.remove();
      popupEl = null;
    });
    popupEl.appendChild(item);
  });

  document.body.appendChild(popupEl);
  const rect = span.getBoundingClientRect();
  Object.assign(popupEl.style, {
    position: "fixed",
    top: rect.bottom + 6 + "px",
    left: rect.left + "px",
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    zIndex: "2147483647",
    padding: "4px",
    minWidth: "140px",
  });

  const p = popupEl.getBoundingClientRect();
  if (p.right > window.innerWidth - 10) popupEl.style.left = (window.innerWidth - p.width - 10) + "px";
  if (p.bottom > window.innerHeight - 10) popupEl.style.top = (rect.top - p.height - 6) + "px";
}

/* =========================
   REPLACEMENT (no re-check loop; shift indices)
========================= */
function applyReplacementByIndex(span, replacement) {
  if (!currentTarget) return;

  const oldText = span.textContent;
  const start = parseInt(span.getAttribute("data-start"), 10);
  const end = parseInt(span.getAttribute("data-end"), 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

  // Update the editor, suppressing the 'input' event we cause
  const base = getTextFromElement(currentTarget);
  const newText = base.slice(0, start) + replacement + base.slice(end);
  setTextToElement(currentTarget, newText, { programmatic: true });

  // Update the span visually and mark as resolved
  span.textContent = replacement;
  span.style.textDecoration = "none";
  span.style.color = "#111";
  span.style.fontWeight = "normal";
  span.classList.remove("misspelled-word");

  // Shift later spans' indices so clicks remain accurate
  const delta = replacement.length - oldText.length;
  if (delta !== 0 && floatingWindow) {
    const spans = floatingWindow.querySelectorAll(".misspelled-word");
    spans.forEach((s) => {
      const sStart = parseInt(s.getAttribute("data-start"), 10);
      const sEnd = parseInt(s.getAttribute("data-end"), 10);
      if (!Number.isFinite(sStart) || !Number.isFinite(sEnd)) return;
      if (sStart >= end) {
        s.setAttribute("data-start", String(sStart + delta));
        s.setAttribute("data-end", String(sEnd + delta));
      }
    });
  }

  // Invalidate UI snapshot so next *real* input will refresh cleanly
  lastAppliedText.delete(currentTarget);
}

/* =========================
   AUTOCORRECT ALL (manual trigger)
========================= */
function doAutoCorrectAll(el) {
  const text = getTextFromElement(el);
  if (!text.trim()) return;
  chrome.runtime.sendMessage({ type: "AUTOCORRECT_ALL", text, model }, (res) => {
    if (!res || res.error) return;
    setTextToElement(el, res.text || text, { programmatic: true });
    removeUI();
    lastAppliedText.delete(el);
  });
}
