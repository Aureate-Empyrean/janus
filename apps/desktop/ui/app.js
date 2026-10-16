// Janus desktop UI: a search-first ("spotlight") vault. All vault logic and every field
// rule live in the Rust core; this file only renders. Text is always inserted with
// textContent; the only markup strings are the static icons below.
"use strict";

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const AUTO_LOCK_MS = 5 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30 * 1000;
const MIN_PASSWORD = 12;
const MASK = "••••••••••••";

const state = { items: [], query: "", filter: "all", cursor: 0 };
const $app = document.getElementById("app");

/* ───────── Icons (static, trusted markup) ───────── */

const ICONS = {
  mark: '<circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="12.5" r="3" fill="currentColor"/><path d="M14.2 14h3.6l1.2 8h-6z" fill="currentColor"/>',
  search:
    '<circle cx="14" cy="14" r="8" stroke="currentColor" stroke-width="2.2"/><path d="m20 20 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  lock: '<rect x="7" y="14" width="18" height="13" rx="3" stroke="currentColor" stroke-width="2"/><path d="M11 14v-3a5 5 0 0 1 10 0v3" stroke="currentColor" stroke-width="2"/>',
  key: '<circle cx="11" cy="16" r="5" stroke="currentColor" stroke-width="2"/><path d="M16 16h11m-4 0v4m-3-4v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  swap: '<path d="M8 11h16l-4-4M24 21H8l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M16 8v16M8 16h16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  close: '<path d="m10 10 12 12M22 10 10 22" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  copy: '<rect x="11" y="11" width="13" height="13" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M8 20V9a1 1 0 0 1 1-1h11" stroke="currentColor" stroke-width="2"/>',
  star: '<path d="m16 6 3 6.3 6.9.9-5 4.8 1.2 6.8L16 21.6l-6.1 3.2 1.2-6.8-5-4.8 6.9-.9z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  starFull: '<path d="m16 6 3 6.3 6.9.9-5 4.8 1.2 6.8L16 21.6l-6.1 3.2 1.2-6.8-5-4.8 6.9-.9z" fill="currentColor"/>',
  login:
    '<circle cx="16" cy="12" r="5" stroke="currentColor" stroke-width="2"/><path d="M7 26c1.5-5 5-7 9-7s7.5 2 9 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  payment_card:
    '<rect x="5" y="8" width="22" height="16" rx="3" stroke="currentColor" stroke-width="2"/><path d="M5 13h22M9 19h5" stroke="currentColor" stroke-width="2"/>',
  identity:
    '<rect x="6" y="5" width="20" height="22" rx="3" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="13" r="3.5" stroke="currentColor" stroke-width="2"/><path d="M11 22c1-2.5 3-3.5 5-3.5s4 1 5 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  wifi: '<path d="M5 13a16 16 0 0 1 22 0M9 17.5a10 10 0 0 1 14 0M13 22a4 4 0 0 1 6 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="25.5" r="1.6" fill="currentColor"/>',
  api_secret:
    '<path d="m12 10-6 6 6 6M20 10l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  secure_note:
    '<path d="M9 5h10l6 6v16H9z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M19 5v6h6M13 17h8M13 21h6" stroke="currentColor" stroke-width="2"/>',
};
function icon(name, cls = "icon") {
  const span = h("span", { class: cls, "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 32 32" fill="none">${ICONS[name]}</svg>`;
  return span;
}

/* ───────── DOM helpers ───────── */

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on"))
      el.addEventListener(key.slice(2), (event) => {
        // Async handlers: errors from call() are already on screen; show anything else.
        const result = value(event);
        result?.catch?.((error) => error?.shown || toast(String(error?.message ?? error)));
      });
    else if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false)
      el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}
// replaceChildren that accepts nested arrays and skips null/false children.
function fill(el, ...children) {
  el?.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  el.classList.remove("show");
  void el.offsetWidth; // restart the entrance transition
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2800);
}
async function call(cmd, args, errorEl) {
  try {
    if (errorEl) errorEl.textContent = "";
    return await invoke(cmd, args);
  } catch (error) {
    const message = String(error);
    if (errorEl) errorEl.textContent = message;
    else toast(message);
    if (message.includes("locked")) await boot();
    throw Object.assign(new Error(message), { shown: true });
  }
}
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* ───────── Auto-lock and clipboard ───────── */

let idleTimer;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lockNow("Locked after 5 minutes of inactivity"), AUTO_LOCK_MS);
}
for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, touch);

async function lockNow(message) {
  clearTimeout(idleTimer);
  closeSheet(true);
  // Nothing from the unlocked session (items, search text, filters) survives a lock.
  Object.assign(state, { items: [], query: "", filter: "all", cursor: 0 });
  await invoke("lock").catch(() => {});
  await boot();
  if (message) toast(message);
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied · cleared in 30 s`);
    setTimeout(async () => {
      try {
        if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText("");
      } catch {
        /* Clearing is best effort; the platform may refuse clipboard reads. */
      }
    }, CLIPBOARD_CLEAR_MS);
  } catch {
    toast("The clipboard is not available");
  }
}

/* ───────── Gate: create or unlock ───────── */

function gate(title, lede, fields, button, onSubmit, note) {
  const error = h("p", { class: "error", role: "alert" });
  const submit = h("button", { class: "btn primary wide", type: "submit", text: button });
  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await onSubmit(error);
        } catch {
          /* message already shown */
        } finally {
          submit.disabled = false;
        }
      },
    },
    fields,
    error,
    submit,
    note ? h("p", { class: "hint note", text: note }) : null,
  );
  fill(
    $app,
    h(
      "main",
      { class: "gate" },
      h(
        "div",
        { class: "gate-box rise" },
        icon("mark", "gate-mark"),
        h("p", { class: "wordmark", text: "JANUS" }),
        h("p", { class: "house", text: "AUREATE EMPYREAN" }),
        h("h1", { text: title }),
        h("p", { class: "lede", text: lede }),
        form,
      ),
    ),
  );
  form.querySelector("input")?.focus();
}
function passwordField(label, id, autocomplete) {
  return h(
    "label",
    { class: "field" },
    h("span", { text: label }),
    h("input", { id, type: "password", autocomplete, required: true }),
  );
}

function createScreen() {
  gate(
    "Create your vault",
    "Choose a master password. It encrypts everything stored here, on this device.",
    [
      passwordField("Master password", "pw", "new-password"),
      passwordField("Repeat it", "pw2", "new-password"),
      h("p", { class: "hint", text: `At least ${MIN_PASSWORD} characters. A few unrelated words work well.` }),
    ],
    "Create vault",
    async (error) => {
      const pw = document.getElementById("pw").value;
      if (pw !== document.getElementById("pw2").value) {
        error.textContent = "The passwords do not match";
        throw Error();
      }
      await call("create", { password: pw }, error);
      await boot();
    },
    "There is no recovery. If you forget the master password, nobody can open this vault.",
  );
}

function unlockScreen() {
  gate(
    "Welcome back",
    "Enter your master password to unlock.",
    [passwordField("Master password", "pw", "current-password")],
    "Unlock",
    async (error) => {
      await call("unlock", { password: document.getElementById("pw").value }, error);
      await boot();
    },
  );
}

/* ───────── Item types: field schema ───────── */

const DOCUMENT_TYPES = [
  ["passport", "Passport"],
  ["national_id", "National ID"],
  ["driving_licence", "Driving licence"],
  ["other", "Other document"],
];
const WIFI_SECURITY = [
  ["WPA3", "WPA3"],
  ["WPA2", "WPA2"],
  ["WEP", "WEP"],
  ["open", "Open"],
  ["other", "Other"],
];
const NOTES = { name: "notes", label: "Notes", multiline: true, max: 10000 };
// `main`: the value a quick Copy takes from a result row.
const TYPES = {
  login: {
    label: "Login",
    plural: "Logins",
    main: ["password", "Password"],
    fields: [
      { name: "username", label: "Username", copy: true, max: 256 },
      { name: "password", label: "Password", secret: true, copy: true, generate: true, max: 1024 },
      {
        name: "urls",
        label: "Website",
        copy: true,
        list: true,
        max: 2048,
        input: { type: "url", placeholder: "https://" },
      },
      {
        name: "totp",
        label: "Authenticator key",
        secret: true,
        max: 2048,
        input: { placeholder: "Base32 key or otpauth:// link" },
      },
      NOTES,
    ],
  },
  payment_card: {
    label: "Payment card",
    plural: "Cards",
    main: ["number", "Card number"],
    fields: [
      { name: "cardholder", label: "Cardholder", copy: true, max: 100 },
      { name: "number", label: "Card number", secret: true, copy: true, format: "card", hint: "12 to 19 digits" },
      {
        name: "expiry",
        label: "Expires",
        copy: true,
        format: "expiry",
        hint: "MM/YY",
        input: { placeholder: "MM/YY" },
      },
      { name: "security_code", label: "Security code", secret: true, copy: true, digits: 4, hint: "3 or 4 digits" },
      { name: "pin", label: "PIN", secret: true, copy: true, digits: 12, hint: "4 to 12 digits" },
      NOTES,
    ],
  },
  identity: {
    label: "Identity document",
    plural: "Documents",
    main: ["document_number", "Document number"],
    fields: [
      { name: "document_type", label: "Document", options: DOCUMENT_TYPES },
      { name: "full_name", label: "Full name", copy: true, max: 200 },
      { name: "document_number", label: "Number", secret: true, copy: true, max: 40, format: "upper" },
      { name: "issuing_authority", label: "Issued by", max: 200 },
      { name: "country", label: "Country", max: 60 },
      { name: "issued_on", label: "Issued", input: { type: "date" } },
      { name: "expires_on", label: "Expires", input: { type: "date" } },
      NOTES,
    ],
  },
  wifi: {
    label: "Wi-Fi",
    plural: "Wi-Fi",
    main: ["password", "Wi-Fi password"],
    fields: [
      { name: "ssid", label: "Network name", copy: true, max: 32 },
      {
        name: "password",
        label: "Password",
        secret: true,
        copy: true,
        generate: true,
        max: 64,
        hint: "WPA: 8 to 63 characters. WEP: 5 or 13.",
      },
      { name: "security", label: "Security", options: WIFI_SECURITY },
      NOTES,
    ],
  },
  api_secret: {
    label: "API secret",
    plural: "API secrets",
    main: ["secret", "Secret"],
    fields: [
      { name: "service", label: "Service", max: 100 },
      { name: "key_id", label: "Key or client ID", copy: true, max: 200 },
      { name: "secret", label: "Secret", secret: true, copy: true, max: 8192 },
      NOTES,
    ],
  },
  secure_note: {
    label: "Secure note",
    plural: "Notes",
    main: ["content", "Note"],
    fields: [{ name: "content", label: "Note", multiline: true, secret: true, copy: true, max: 100000 }],
  },
};
function optionLabel(field, value) {
  return field.options?.find(([key]) => key === value)?.[1] ?? value;
}

/* ───────── Home: search-first vault ───────── */

function inFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "favorites") return item.favorite;
  if (filter.startsWith("folder:")) return item.folder === filter.slice(7);
  return item.type === filter;
}
function folders() {
  return [...new Set(state.items.map((i) => i.folder).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}
// Ranks title matches above other matches; every word of the query must match somewhere.
function results() {
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const item of state.items) {
    if (!inFilter(item, state.filter)) continue;
    const title = item.title.toLowerCase();
    const haystack = [title, item.subtitle, item.folder, ...item.tags].join(" ").toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    const score = words.length ? (title.startsWith(words[0]) ? 0 : title.includes(words[0]) ? 1 : 2) : 0;
    scored.push([score, item]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title)).map(([, item]) => item);
}
function browsing() {
  return !state.query && state.filter === "all";
}

async function refresh() {
  state.items = await call("list");
  renderHome();
}

function renderHome() {
  const search = h("input", {
    id: "search",
    class: "spotlight-input",
    type: "search",
    placeholder: "Search your vault",
    "aria-label": "Search your vault",
    autocomplete: "off",
    spellcheck: "false",
    value: state.query,
    oninput: (event) => {
      state.query = event.target.value;
      state.cursor = 0;
      renderResults();
    },
    onkeydown: onSearchKey,
  });
  fill(
    $app,
    h(
      "div",
      { class: "home" },
      h(
        "header",
        { class: "topbar" },
        h("div", { class: "brand" }, icon("mark", "brand-mark"), h("b", { text: "JANUS" })),
        h(
          "nav",
          { class: "top-actions", "aria-label": "Vault" },
          h(
            "button",
            {
              class: "icon-btn",
              type: "button",
              title: "Export & import",
              "aria-label": "Export & import",
              onclick: transfer,
            },
            icon("swap"),
          ),
          h(
            "button",
            {
              class: "icon-btn",
              type: "button",
              title: "Master password",
              "aria-label": "Master password",
              onclick: passwordChange,
            },
            icon("key"),
          ),
          h(
            "button",
            { class: "icon-btn", type: "button", title: "Lock", "aria-label": "Lock", onclick: () => lockNow() },
            icon("lock"),
          ),
        ),
      ),
      h(
        "section",
        { class: "hero" },
        h(
          "div",
          { class: "spotlight" },
          icon("search", "spotlight-icon"),
          search,
          h("kbd", { class: "spotlight-kbd", text: "Ctrl K" }),
          h(
            "button",
            {
              class: "btn primary new-btn",
              type: "button",
              onclick: () => (TYPES[state.filter] ? edit(null, state.filter) : chooseType()),
            },
            icon("plus"),
            "New",
          ),
        ),
        h("div", { class: "chips", role: "toolbar", "aria-label": "Filter" }),
      ),
      h("main", { class: "results", id: "results", "aria-live": "polite" }),
    ),
  );
  renderResults();
  search.focus();
}

function renderChips() {
  const chip = (key, label, count) =>
    h(
      "button",
      {
        class: "chip" + (state.filter === key ? " on" : ""),
        type: "button",
        "data-filter": key,
        "aria-pressed": String(state.filter === key),
        onclick: () => {
          state.filter = state.filter === key && key !== "all" ? "all" : key;
          state.cursor = 0;
          renderResults();
        },
      },
      label,
      count !== undefined ? h("span", { class: "chip-count", text: String(count) }) : null,
    );
  const count = (filter) => state.items.filter((i) => inFilter(i, filter)).length;
  const typeChips = Object.entries(TYPES)
    .filter(([key]) => count(key))
    .map(([key, t]) => chip(key, t.plural, count(key)));
  fill(
    document.querySelector(".chips"),
    ...[
      chip("all", "All", state.items.length),
      count("favorites") ? chip("favorites", "★ Favorites", count("favorites")) : null,
      typeChips,
      folders().length ? h("span", { class: "chip-sep", "aria-hidden": "true" }) : null,
      folders().map((name) => chip("folder:" + name, name, count("folder:" + name))),
    ]
      .flat()
      .filter(Boolean),
  );
}

function renderResults() {
  renderChips();
  const host = document.getElementById("results");
  if (!host) return;
  if (!state.items.length) {
    fill(
      host,
      h(
        "div",
        { class: "empty-hero rise" },
        h("h2", { text: "Your vault is empty" }),
        h("p", { text: "Add a login, a card, your Wi-Fi or a document. Everything is encrypted on this device." }),
        h(
          "div",
          { class: "type-grid" },
          Object.entries(TYPES).map(([key, type]) => typeCard(key, type)),
        ),
      ),
    );
    return;
  }
  if (browsing()) {
    const favorites = state.items.filter((i) => i.favorite);
    const recent = [...state.items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6);
    fill(
      host,
      favorites.length
        ? h(
            "section",
            { class: "block" },
            h("h3", { class: "block-title", text: "Favorites" }),
            h("div", { class: "tiles" }, favorites.map(tile)),
          )
        : null,
      h(
        "section",
        { class: "block" },
        h("h3", { class: "block-title", text: "Recently changed" }),
        h(
          "div",
          { class: "rows", role: "list" },
          recent.map((item, i) => row(item, i)),
        ),
      ),
      h("p", { class: "browse-hint", text: `${state.items.length} items · type to search, or pick a filter above` }),
    );
  } else {
    const list = results();
    state.cursor = Math.min(state.cursor, Math.max(0, list.length - 1));
    fill(
      host,
      list.length
        ? h(
            "div",
            { class: "rows", role: "listbox", "aria-label": "Results" },
            list.map((item, i) => row(item, i)),
          )
        : h("p", { class: "empty", text: "Nothing matches." }),
    );
  }
  stagger(host);
}

function stagger(host) {
  if (reduceMotion()) return;
  host.querySelectorAll(".tile, .row").forEach((el, i) => {
    el.style.setProperty("--delay", `${Math.min(i, 12) * 22}ms`);
    el.classList.add("enter");
  });
}

function glyph(item, cls = "glyph") {
  return h("span", { class: `${cls} t-${item.type}` }, icon(item.type));
}

function tile(item) {
  return h(
    "button",
    { class: "tile", type: "button", onclick: () => showItem(item.id) },
    glyph(item),
    h("span", { class: "tile-title", text: item.title || "Untitled" }),
    h("span", { class: "tile-sub", text: item.subtitle || TYPES[item.type]?.label || "" }),
  );
}

function row(item, index) {
  const selected = !browsing() && index === state.cursor;
  const main = TYPES[item.type]?.main;
  return h(
    "div",
    {
      class: "row" + (selected ? " selected" : ""),
      role: browsing() ? "listitem" : "option",
      "aria-selected": String(selected),
      "data-index": String(index),
    },
    h(
      "button",
      { class: "row-open", type: "button", onclick: () => showItem(item.id) },
      glyph(item),
      h(
        "span",
        { class: "row-text" },
        h("span", { class: "row-title" }, item.favorite ? icon("starFull", "fav") : null, item.title || "Untitled"),
        h("span", { class: "row-sub", text: item.subtitle || TYPES[item.type]?.label || "" }),
      ),
      item.folder ? h("span", { class: "folder-pill", text: item.folder }) : null,
    ),
    main
      ? h(
          "button",
          {
            class: "icon-btn row-copy",
            type: "button",
            title: `Copy ${main[1].toLowerCase()}`,
            "aria-label": `Copy ${main[1].toLowerCase()} of ${item.title}`,
            onclick: () => quickCopy(item),
          },
          icon("copy"),
        )
      : null,
  );
}

async function quickCopy(item) {
  const full = await call("get", { id: item.id });
  const [name, label] = TYPES[item.type].main;
  const value = full[name];
  if (!value) return toast(`No ${label.toLowerCase()} saved`);
  await copy(value, label);
}

function onSearchKey(event) {
  const list = browsing() ? [] : results();
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!list.length) return;
    event.preventDefault();
    state.cursor = (state.cursor + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    renderResults();
    document.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && list[state.cursor]) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) quickCopy(list[state.cursor]);
    else showItem(list[state.cursor].id);
  } else if (event.key === "Escape" && (state.query || state.filter !== "all")) {
    event.preventDefault();
    state.query = "";
    state.filter = "all";
    event.target.value = "";
    renderResults();
  }
}

document.addEventListener("keydown", (event) => {
  const search = document.getElementById("search");
  if (!search) return;
  if (event.key === "Escape" && document.querySelector(".sheet")) {
    event.preventDefault();
    closeSheet();
  } else if (
    (event.key === "k" && (event.ctrlKey || event.metaKey)) ||
    (event.key === "/" && !event.target.closest("input, textarea, select"))
  ) {
    event.preventDefault();
    closeSheet();
    search.focus();
    search.select();
  }
});

/* ───────── Sheet: item details, editing and settings slide over the page ───────── */

let sheetReturn = null;
function openSheet(title, ...content) {
  // Return focus to what opened the first sheet; sheets replacing sheets keep that target.
  const opener = document.activeElement;
  if (!document.querySelector(".sheet") || !opener?.closest?.(".sheet")) sheetReturn = opener;
  closeSheet(true);
  const body = h("div", { class: "sheet-body" }, content);
  const sheet = h(
    "aside",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h(
      "header",
      { class: "sheet-head" },
      h("h2", { class: "sheet-title", text: title }),
      h(
        "button",
        { class: "icon-btn", type: "button", "aria-label": "Close", onclick: () => closeSheet() },
        icon("close"),
      ),
    ),
    body,
  );
  const backdrop = h("div", { class: "sheet-backdrop", onclick: () => closeSheet() });
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    sheet.classList.add("open");
  });
  (
    sheet.querySelector("input, textarea, select, .sheet-body button") ?? sheet.querySelector(".sheet-head button")
  )?.focus();
  return body;
}
function closeSheet(instant = false) {
  clearInterval(codeTimer);
  const sheet = document.querySelector(".sheet");
  const backdrop = document.querySelector(".sheet-backdrop");
  if (!sheet) return;
  sheet.classList.add("leaving");
  sheet.classList.remove("open");
  backdrop?.classList.remove("open");
  const done = () => {
    sheet.remove();
    backdrop?.remove();
  };
  if (instant || reduceMotion()) done();
  else setTimeout(done, 220);
  const target =
    sheetReturn?.isConnected && sheetReturn !== document.body ? sheetReturn : document.getElementById("search");
  if (!instant) target?.focus();
}

function typeCard(key, type) {
  return h(
    "button",
    { class: "type-card", type: "button", onclick: () => edit(null, key) },
    h("span", { class: `glyph t-${key}` }, icon(key)),
    h("span", { text: type.label }),
  );
}
function chooseType() {
  openSheet(
    "Add to your vault",
    h(
      "div",
      { class: "type-grid" },
      Object.entries(TYPES).map(([key, type]) => typeCard(key, type)),
    ),
  );
}

/* ───────── Item details ───────── */

const BRANDS = [
  [/^4/, "VISA"],
  [/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, "MASTERCARD"],
  [/^3[47]/, "AMEX"],
  [/^6(011|5)/, "DISCOVER"],
];
function cardBrand(number) {
  return BRANDS.find(([re]) => re.test(number))?.[1] ?? "CARD";
}
function groupCard(value) {
  return value.replace(/\D/g, "").replace(/(\d{4})(?=\d)/g, "$1 ");
}

function revealer(value, display = value) {
  const v = h("span", { class: "v mono", text: MASK });
  let shown = false;
  const button = h("button", {
    class: "btn ghost small",
    type: "button",
    text: "Reveal",
    onclick: () => {
      shown = !shown;
      v.textContent = shown ? display : MASK;
      button.textContent = shown ? "Hide" : "Reveal";
    },
  });
  return { v, button };
}

function cardVisual(item) {
  const number = item.number || "";
  const last4 = number.slice(-4);
  const digits = h("span", { class: "cc-number mono", text: number ? `•••• •••• •••• ${last4}` : "No number saved" });
  let shown = false;
  return h(
    "div",
    { class: `cc cc-${cardBrand(number).toLowerCase()}` },
    h(
      "div",
      { class: "cc-top" },
      h("span", { class: "cc-chip", "aria-hidden": "true" }),
      h("span", { class: "cc-brand", text: cardBrand(number) }),
    ),
    h(
      "button",
      {
        class: "cc-reveal",
        type: "button",
        "aria-label": "Reveal card number",
        disabled: !number,
        onclick: () => {
          shown = !shown;
          digits.textContent = shown ? groupCard(number) : `•••• •••• •••• ${last4}`;
        },
      },
      digits,
    ),
    h(
      "div",
      { class: "cc-bottom" },
      h("span", {}, h("small", { text: "CARDHOLDER" }), item.cardholder || "—"),
      h("span", {}, h("small", { text: "EXPIRES" }), item.expiry || "—"),
    ),
  );
}

async function showItem(id) {
  const item = await call("get", { id });
  const type = TYPES[item.type];
  const rows = [];
  const fieldRow = (field, value) => {
    if (!value) return;
    const shown = field.format === "card" ? groupCard(value) : optionLabel(field, value);
    const actions = h("span", { class: "actions" });
    let v;
    if (field.secret) {
      const r = revealer(value, shown);
      v = r.v;
      r.button.setAttribute("aria-label", `Reveal ${field.label}`);
      actions.append(r.button);
    } else {
      v = h("span", { class: "v", text: shown });
    }
    if (field.copy)
      actions.append(
        h("button", {
          class: "btn ghost small",
          type: "button",
          text: "Copy",
          "aria-label": `Copy ${field.label}`,
          onclick: () => copy(value, field.label),
        }),
      );
    rows.push(h("div", { class: "kv-row" }, h("span", { class: "k", text: field.label }), v, actions));
  };
  for (const field of type.fields) {
    if (item.type === "payment_card" && (field.name === "cardholder" || field.name === "expiry")) continue;
    if (field.list) for (const value of item[field.name] ?? []) fieldRow(field, value);
    else fieldRow(field, item[field.name]);
  }
  if (item.type === "login" && item.totp) rows.splice(2, 0, codeRow(item.id));
  const favorite = h(
    "button",
    {
      class: "icon-btn star-toggle" + (item.favorite ? " on" : ""),
      type: "button",
      "aria-pressed": String(item.favorite),
      "aria-label": item.favorite ? "Remove from favorites" : "Add to favorites",
      onclick: async () => {
        await call("set_meta", {
          id: item.id,
          meta: { folder: item.folder, tags: item.tags, favorite: !item.favorite },
        });
        state.items = await call("list");
        renderResults();
        await showItem(item.id);
      },
    },
    icon(item.favorite ? "starFull" : "star"),
  );
  const body = openSheet(
    item.title || "Untitled",
    h(
      "div",
      { class: "detail-hero" },
      glyph(item, "glyph big"),
      h(
        "div",
        { class: "detail-meta" },
        h("span", { class: "detail-type", text: type.label }),
        item.folder ? h("span", { class: "folder-pill", text: item.folder }) : null,
      ),
      favorite,
    ),
    item.tags.length
      ? h(
          "div",
          { class: "tags" },
          item.tags.map((tag) => h("span", { class: "tag", text: tag })),
        )
      : null,
    item.type === "payment_card" ? cardVisual(item) : null,
    rows.length ? h("div", { class: "kv" }, rows) : h("p", { class: "empty", text: "No details yet." }),
    item.type === "wifi" ? wifiJoin(item) : null,
    historySection(item),
    h("p", { class: "meta-line", text: `Updated ${new Date(item.updated_at).toLocaleString()}` }),
    h(
      "div",
      { class: "sheet-actions" },
      h("button", { class: "btn primary", type: "button", text: "Edit", onclick: () => edit(item) }),
      h("button", {
        class: "btn ghost danger",
        type: "button",
        text: "Delete",
        onclick: (event) => remove(item, event.target),
      }),
    ),
  );
  body.closest(".sheet").classList.add(`sheet-${item.type}`);
}

function wifiJoin(item) {
  const holder = h("div", { class: "wifi-join" });
  const button = h("button", {
    class: "btn",
    type: "button",
    text: "Show join code",
    onclick: async () => {
      const src = await call("wifi_qr", { id: item.id });
      fill(
        holder,
        h("img", { class: "qr", src, alt: `QR code to join ${item.ssid}` }),
        h("p", { class: "hint", text: "Scan with a phone camera to join. It contains the password." }),
      );
    },
  });
  holder.append(button);
  return holder;
}

// Live one-time code with a countdown ring. The core computes the code; the timer
// belongs to its row, so a stale row can never stop a newer one.
let codeTimer;
function codeRow(id) {
  clearInterval(codeTimer);
  const code = h("span", { class: "v mono code", text: "··· ···" });
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("viewBox", "0 0 36 36");
  ring.setAttribute("class", "ring");
  ring.innerHTML =
    '<circle cx="18" cy="18" r="15" class="ring-track"/><circle cx="18" cy="18" r="15" class="ring-fill"/>';
  const left = h("span", { class: "code-left" });
  const copyButton = h("button", {
    class: "btn ghost small",
    type: "button",
    text: "Copy",
    "aria-label": "Copy one-time code",
  });
  let current = "";
  copyButton.addEventListener("click", () => current && copy(current, "One-time code"));
  let timer;
  const tick = async () => {
    if (timer && !code.isConnected) return clearInterval(timer);
    try {
      const next = await invoke("totp", { id });
      current = next.code;
      code.textContent = next.code.replace(/(\d{3})(?=\d)/, "$1 ");
      left.textContent = `${next.remaining}s`;
      ring.querySelector(".ring-fill").style.strokeDashoffset = String(94.25 * (1 - next.remaining / next.period));
      ring.classList.toggle("soon", next.remaining <= 5);
    } catch (error) {
      clearInterval(timer);
      code.textContent = String(error);
    }
  };
  tick();
  timer = codeTimer = setInterval(tick, 1000);
  return h(
    "div",
    { class: "kv-row code-row" },
    h("span", { class: "k", text: "One-time code" }),
    h("span", { class: "code-cell" }, ring, code, left),
    h("span", { class: "actions" }, copyButton),
  );
}

// Replaced secrets stay recoverable; values are masked like every other secret.
function historySection(item) {
  if (!item.history?.length) return null;
  const rows = item.history.map((change) => {
    const r = revealer(change.value);
    return h(
      "div",
      { class: "kv-row" },
      h("span", { class: "k", text: new Date(change.replaced_at).toLocaleDateString() }),
      r.v,
      h(
        "span",
        { class: "actions" },
        r.button,
        h("button", {
          class: "btn ghost small",
          type: "button",
          text: "Copy",
          onclick: () => copy(change.value, "Previous " + change.field),
        }),
      ),
    );
  });
  return h(
    "details",
    { class: "history" },
    h("summary", { text: `Previous values (${item.history.length})` }),
    h("div", { class: "kv" }, rows),
  );
}

async function remove(item, button) {
  const box = h(
    "div",
    { class: "confirm" },
    h("p", { text: `Delete “${item.title || "Untitled"}” permanently? This cannot be undone.` }),
    h(
      "div",
      { class: "sheet-actions" },
      h("button", {
        class: "btn danger-solid",
        type: "button",
        text: "Delete permanently",
        onclick: async () => {
          await call("delete", { id: item.id });
          closeSheet();
          await refreshResults();
          toast("Item deleted");
        },
      }),
      h("button", { class: "btn ghost", type: "button", text: "Keep it", onclick: () => box.remove() }),
    ),
  );
  button.closest(".sheet-body").append(box);
  box.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
}

async function refreshResults() {
  state.items = await call("list");
  renderResults();
}

/* ───────── Editing ───────── */

// Typing aids only; the core's rules decide what is valid (see check_item).
function constrain(field, el) {
  const digits = (v, max) => v.replace(/\D/g, "").slice(0, max);
  const fix = {
    card: (v) => groupCard(digits(v, 19)),
    expiry: (v) => {
      const d = digits(v, 4);
      return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    },
    upper: (v) => v.toUpperCase(),
  }[field.format];
  const apply = fix ?? (field.digits ? (v) => digits(v, field.digits) : null);
  if (!apply) return;
  el.addEventListener("input", () => {
    const next = apply(el.value);
    if (next !== el.value) el.value = next;
  });
}

function input(field, value) {
  const limits = {
    ...(field.max ? { maxlength: field.max } : {}),
    ...(field.format === "card" ? { maxlength: 23, inputmode: "numeric" } : {}),
    ...(field.format === "expiry" ? { maxlength: 5, inputmode: "numeric" } : {}),
    ...(field.digits ? { maxlength: field.digits, inputmode: "numeric" } : {}),
  };
  const common = { name: field.name, autocomplete: "off", spellcheck: "false", ...limits };
  if (field.multiline) return h("textarea", common, value);
  if (field.options)
    return h(
      "select",
      { ...common, class: "select" },
      field.options.map(([key, label]) => h("option", { value: key, selected: key === value, text: label })),
    );
  const el = h("input", {
    ...common,
    value: field.format === "card" ? groupCard(value) : value,
    ...(field.secret ? { type: "password", class: "mono" } : {}),
    ...field.input,
  });
  constrain(field, el);
  return el;
}

function edit(item, typeKey = item?.type) {
  const type = TYPES[typeKey];
  const error = h("p", { class: "error", role: "alert" });
  const errorFor = {};
  const note = (name, hint) => {
    errorFor[name] = h("span", { class: "field-error", role: "alert" });
    return [hint ? h("span", { class: "field-hint", text: hint }) : null, errorFor[name]];
  };
  const presetFolder = state.filter.startsWith("folder:") ? state.filter.slice(7) : "";
  const fields = [
    h(
      "label",
      { class: "field" },
      h("span", { text: "Title" }),
      input({ name: "title", max: 200 }, item?.title ?? ""),
      note("title"),
    ),
  ];
  for (const field of type.fields) {
    const value = field.list ? (item?.[field.name]?.[0] ?? "") : (item?.[field.name] ?? "");
    const control = input(field, value);
    const extras = [];
    let info = null;
    if (field.secret && !field.multiline)
      extras.push(
        h("button", {
          class: "btn small",
          type: "button",
          text: "Show",
          onclick: (event) => {
            control.type = control.type === "password" ? "text" : "password";
            event.target.textContent = control.type === "password" ? "Show" : "Hide";
          },
        }),
      );
    if (field.generate) {
      info = h("p", { class: "gen-info" });
      extras.push(
        h("button", {
          class: "btn small",
          type: "button",
          text: "Generate",
          onclick: async () => {
            const generated = await call("generate", { length: 24, symbols: true });
            control.value = generated.password;
            control.type = "text";
            info.textContent = `Generated: 24 characters, about ${Math.round(generated.bits)} bits of entropy.`;
          },
        }),
      );
    }
    fields.push(
      h(
        "label",
        { class: "field" },
        h("span", { text: field.label }),
        extras.length ? h("span", { class: "input-row" }, control, extras) : control,
        note(field.name, field.hint),
      ),
      info,
    );
  }
  fields.push(
    h(
      "div",
      { class: "field-pair" },
      h(
        "label",
        { class: "field" },
        h("span", { text: "Folder" }),
        h("input", {
          name: "folder",
          value: item?.folder ?? presetFolder,
          list: "folder-list",
          autocomplete: "off",
          placeholder: "None",
          maxlength: 60,
        }),
        h(
          "datalist",
          { id: "folder-list" },
          folders().map((name) => h("option", { value: name })),
        ),
      ),
      h(
        "label",
        { class: "field" },
        h("span", { text: "Tags" }),
        h("input", {
          name: "tags",
          value: (item?.tags ?? []).join(", "),
          autocomplete: "off",
          placeholder: "Comma separated",
        }),
      ),
    ),
  );
  const form = h(
    "form",
    {
      class: "edit-form",
      onsubmit: async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const payload = { type: typeKey, title: String(data.get("title") ?? "") };
        for (const field of type.fields) {
          const value = String(data.get(field.name) ?? "");
          payload[field.name] = field.list ? (value ? [value] : []) : value;
        }
        const meta = {
          folder: String(data.get("folder") ?? ""),
          tags: String(data.get("tags") ?? "").split(","),
          favorite: item?.favorite ?? state.filter === "favorites",
        };
        for (const el of Object.values(errorFor)) el.textContent = "";
        const problems = await call("check_item", { item: payload }, error);
        if (problems.length) {
          for (const p of problems) if (errorFor[p.field]) errorFor[p.field].textContent = p.message;
          error.textContent = "Check the marked fields.";
          form.querySelector(`[name="${problems[0].field}"]`)?.focus();
          return;
        }
        const id = await call("save", { id: item?.id ?? null, item: payload, meta }, error);
        state.items = await call("list");
        renderResults();
        await showItem(id);
        toast(item ? "Saved" : "Added to your vault");
      },
    },
    fields,
    error,
    h(
      "div",
      { class: "sheet-actions sticky" },
      h("button", { class: "btn primary", type: "submit", text: item ? "Save" : "Add to vault" }),
      h("button", {
        class: "btn ghost",
        type: "button",
        text: "Cancel",
        onclick: () => (item ? showItem(item.id) : closeSheet()),
      }),
    ),
  );
  openSheet(item ? `Edit ${type.label.toLowerCase()}` : `New ${type.label.toLowerCase()}`, form);
}

/* ───────── Export, import and master password ───────── */

function transfer() {
  const exportError = h("p", { class: "error", role: "alert" });
  const saved = h("p", { class: "hint" });
  const exportForm = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const next = document.getElementById("exp1").value;
        if (next !== document.getElementById("exp2").value) {
          exportError.textContent = "The export passwords do not match";
          return;
        }
        const path = await call(
          "export_vault",
          { master: document.getElementById("exp-master").value, exportPassword: next },
          exportError,
        );
        saved.textContent = `Saved to ${path}`;
        exportForm.reset();
      },
    },
    passwordField("Master password", "exp-master", "current-password"),
    h(
      "div",
      { class: "field-pair" },
      passwordField("Export password", "exp1", "new-password"),
      passwordField("Repeat export password", "exp2", "new-password"),
    ),
    h("p", {
      class: "hint",
      text: "The export is encrypted with this password, not your master password. Without it the file cannot be opened. Janus never writes a plaintext export.",
    }),
    exportError,
    saved,
    h(
      "div",
      { class: "sheet-actions" },
      h("button", { class: "btn primary", type: "submit", text: "Export to Downloads" }),
    ),
  );

  const importError = h("p", { class: "error", role: "alert" });
  const preview = h("div", { class: "import-preview" });
  let pending = null;
  const importForm = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const file = document.getElementById("imp-file").files[0];
        if (!file) {
          importError.textContent = "Choose an export file first";
          return;
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const password = document.getElementById("imp-pw").value;
        const items = await call("preview_export", { bytes, password }, importError);
        pending = { bytes, password };
        const known = new Set(state.items.map((i) => i.id));
        const fresh = items.filter((i) => !known.has(i.id));
        fill(
          preview,
          h("p", {
            text: `${items.length} items in this export, ${fresh.length} new. Items already in this vault are left unchanged.`,
          }),
          h(
            "div",
            { class: "kv" },
            items
              .slice(0, 50)
              .map((i) =>
                h(
                  "div",
                  { class: "kv-row" },
                  h("span", { class: "k", text: TYPES[i.type]?.label ?? i.type }),
                  h("span", { class: "v", text: i.title || "Untitled" }),
                  h("span", { class: "actions", text: known.has(i.id) ? "already here" : "" }),
                ),
              ),
          ),
          items.length > 50 ? h("p", { class: "hint", text: `and ${items.length - 50} more` }) : null,
          h(
            "div",
            { class: "sheet-actions" },
            h("button", {
              class: "btn primary",
              type: "button",
              text: `Import ${fresh.length} items`,
              disabled: !fresh.length,
              onclick: async () => {
                const report = await call("import_export", pending, importError);
                pending = null;
                fill(preview);
                importForm.reset();
                toast(
                  `Imported ${report.added} items${report.skipped_existing ? `, ${report.skipped_existing} already present` : ""}`,
                );
                await refreshResults();
              },
            }),
          ),
        );
      },
    },
    h(
      "label",
      { class: "field" },
      h("span", { text: "Janus export file" }),
      h("input", { id: "imp-file", type: "file", accept: ".janus-export" }),
    ),
    passwordField("Export password", "imp-pw", "off"),
    importError,
    h("div", { class: "sheet-actions" }, h("button", { class: "btn", type: "submit", text: "Preview import" })),
  );

  const otherError = h("p", { class: "error", role: "alert" });
  const otherPreview = h("div", { class: "import-preview" });
  const otherForm = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const file = document.getElementById("other-file").files[0];
        if (!file) {
          otherError.textContent = "Choose an export file first";
          return;
        }
        const format = document.getElementById("other-format").value;
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const plan = await call("preview_import", { format, bytes }, otherError);
        fill(
          otherPreview,
          h("p", { text: `${plan.items.length} items will be added as new items.` }),
          plan.kept_in_notes
            ? h("p", {
                class: "hint",
                text: `${plan.kept_in_notes} fields without a Janus counterpart are kept in the items' notes.`,
              })
            : null,
          plan.warnings.map((w) => h("p", { class: "hint warn", text: w })),
          h(
            "div",
            { class: "kv" },
            plan.items
              .slice(0, 50)
              .map((i) =>
                h(
                  "div",
                  { class: "kv-row" },
                  h("span", { class: "k", text: TYPES[i.type]?.label ?? i.type }),
                  h("span", { class: "v", text: i.title || "Untitled" }),
                  h("span", { class: "actions", text: i.folder }),
                ),
              ),
          ),
          plan.items.length > 50 ? h("p", { class: "hint", text: `and ${plan.items.length - 50} more` }) : null,
          h(
            "div",
            { class: "sheet-actions" },
            h("button", {
              class: "btn primary",
              type: "button",
              text: `Import ${plan.items.length} items`,
              disabled: !plan.items.length,
              onclick: async () => {
                const report = await call("import_items", { format, bytes }, otherError);
                fill(
                  otherPreview,
                  h("p", {
                    class: "hint warn",
                    text: `Imported ${report.added} items. Now delete the file you imported: it contains your passwords unencrypted.`,
                  }),
                );
                otherForm.reset();
                await refreshResults();
              },
            }),
          ),
        );
      },
    },
    h(
      "label",
      { class: "field" },
      h("span", { text: "Format" }),
      h(
        "select",
        { id: "other-format", class: "select" },
        h("option", { value: "bitwarden_json", text: "Bitwarden (unencrypted JSON)" }),
        h("option", { value: "browser_csv", text: "Browser passwords CSV (Chrome, Edge, Firefox)" }),
      ),
    ),
    h(
      "label",
      { class: "field" },
      h("span", { text: "Export file" }),
      h("input", { id: "other-file", type: "file", accept: ".json,.csv" }),
    ),
    h("p", {
      class: "hint warn",
      text: "These files contain your passwords unencrypted. Janus reads them only in memory, but cannot protect or erase the file itself: delete it after importing.",
    }),
    otherError,
    h("div", { class: "sheet-actions" }, h("button", { class: "btn", type: "submit", text: "Preview" })),
  );

  openSheet(
    "Export & import",
    h("h3", { class: "section-title", text: "Encrypted export" }),
    exportForm,
    h("h3", { class: "section-title", text: "Import a Janus export" }),
    importForm,
    preview,
    h("h3", { class: "section-title", text: "Import from another password manager" }),
    otherForm,
    otherPreview,
  );
}

function passwordChange() {
  const error = h("p", { class: "error", role: "alert" });
  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const next = document.getElementById("new1").value;
        if (next !== document.getElementById("new2").value) {
          error.textContent = "The new passwords do not match";
          return;
        }
        await call("change_password", { current: document.getElementById("cur").value, new: next }, error);
        closeSheet();
        toast("Master password changed");
      },
    },
    passwordField("Current master password", "cur", "current-password"),
    passwordField("New master password", "new1", "new-password"),
    passwordField("Repeat new password", "new2", "new-password"),
    error,
    h(
      "div",
      { class: "sheet-actions" },
      h("button", { class: "btn primary", type: "submit", text: "Change password" }),
    ),
  );
  openSheet("Master password", form);
}

/* ───────── Boot ───────── */

async function boot() {
  let status;
  try {
    status = await invoke("status");
  } catch (error) {
    fill($app, h("main", { class: "gate" }, h("p", { class: "error", text: String(error) })));
    return;
  }
  if (!status.exists) return createScreen();
  if (!status.unlocked) return unlockScreen();
  touch();
  await refresh();
}
boot();
