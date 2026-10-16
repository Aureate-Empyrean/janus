// Janus desktop UI. All vault logic lives in the Rust core; this file only renders.
// Text is always inserted with textContent, never as HTML.
"use strict";

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const AUTO_LOCK_MS = 5 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30 * 1000;
const MIN_PASSWORD = 12;

const state = { filter: "all", query: "", items: [], selected: null, mode: "view" };
const $app = document.getElementById("app");

const MARK =
  '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="12.5" r="3" fill="currentColor"/><path d="M14.2 14h3.6l1.2 8h-6z" fill="currentColor"/></svg>';

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
function mark(cls) {
  const span = h("span", { class: cls });
  span.innerHTML = MARK; // static, trusted markup
  return span;
}
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
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

/* ───────── Auto-lock and clipboard ───────── */

let idleTimer;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lockNow("Locked after 5 minutes of inactivity"), AUTO_LOCK_MS);
}
for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, touch);

async function lockNow(message) {
  clearTimeout(idleTimer);
  // Nothing from the unlocked session (items, selection, search text) survives a lock.
  Object.assign(state, { items: [], selected: null, query: "", filter: "all", mode: "view" });
  await invoke("lock").catch(() => {});
  await boot();
  if (message) toast(message);
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied. The clipboard is cleared in 30 seconds.`);
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
  const submit = h("button", { class: "btn primary", type: "submit", text: button });
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
  $app.replaceChildren(
    h(
      "main",
      { class: "gate" },
      h(
        "div",
        { class: "gate-box" },
        mark("gate-mark"),
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
    "Unlock your vault",
    "Enter your master password.",
    [passwordField("Master password", "pw", "current-password")],
    "Unlock",
    async (error) => {
      await call("unlock", { password: document.getElementById("pw").value }, error);
      await boot();
    },
  );
}

/* ───────── Vault ───────── */

// Field schema per item type. `secret` values are masked until revealed; `copy` adds Copy.
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
const TYPES = {
  login: {
    label: "Login",
    plural: "Logins",
    fields: [
      { name: "username", label: "Username", copy: true, max: 256 },
      { name: "password", label: "Password", secret: true, copy: true, generate: true, max: 1024 },
      { name: "urls", label: "Website", copy: true, list: true, max: 2048, input: { type: "url", placeholder: "https://" } },
      { name: "totp", label: "Authenticator key", secret: true, max: 2048, input: { placeholder: "Base32 key or otpauth:// link" } },
      NOTES,
    ],
  },
  payment_card: {
    label: "Payment card",
    plural: "Payment cards",
    fields: [
      { name: "cardholder", label: "Cardholder", copy: true, max: 100 },
      { name: "number", label: "Card number", secret: true, copy: true, format: "card", hint: "12 to 19 digits" },
      { name: "expiry", label: "Expires", copy: true, format: "expiry", hint: "MM/YY", input: { placeholder: "MM/YY" } },
      { name: "security_code", label: "Security code", secret: true, copy: true, digits: 4, hint: "3 or 4 digits" },
      { name: "pin", label: "PIN", secret: true, copy: true, digits: 12, hint: "4 to 12 digits" },
      NOTES,
    ],
  },
  identity: {
    label: "Identity document",
    plural: "Identity documents",
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
    fields: [
      { name: "ssid", label: "Network name", copy: true, max: 32 },
      { name: "password", label: "Password", secret: true, copy: true, generate: true, max: 64, hint: "WPA: 8 to 63 characters. WEP: 5 or 13." },
      { name: "security", label: "Security", options: WIFI_SECURITY },
      NOTES,
    ],
  },
  api_secret: {
    label: "API secret",
    plural: "API secrets",
    fields: [
      { name: "service", label: "Service", max: 100 },
      { name: "key_id", label: "Key or client ID", copy: true, max: 200 },
      { name: "secret", label: "Secret", secret: true, copy: true, max: 8192 },
      NOTES,
    ],
  },
  secure_note: {
    label: "Secure note",
    plural: "Secure notes",
    fields: [{ name: "content", label: "Note", multiline: true, secret: true, copy: true, max: 100000 }],
  },
};

async function refresh() {
  state.items = await call("list");
  render();
}

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

function itemRows() {
  const query = state.query.toLowerCase();
  const visible = state.items.filter(
    (i) =>
      inFilter(i, state.filter) &&
      [i.title, i.subtitle, i.folder, ...i.tags].join(" ").toLowerCase().includes(query),
  );
  if (!visible.length)
    return [h("p", { class: "empty", text: state.items.length ? "Nothing matches." : "Your vault is empty." })];
  return visible.map((i) =>
    h(
      "button",
      {
        class: "item-row" + (state.selected === i.id ? " active" : ""),
        type: "button",
        onclick: () => select(i.id),
      },
      h("span", { class: "glyph", text: glyphFor(i) }),
      h(
        "span",
        {},
        h("span", { class: "title" }, i.favorite ? h("span", { class: "star", "aria-label": "Favorite", text: "★" }) : null, i.title || "Untitled"),
        h("span", { class: "sub", text: i.subtitle || TYPES[i.type]?.label || "" }),
      ),
    ),
  );
}

// Searching and filtering only touch the list and sidebar, so typing keeps focus and an
// open edit form keeps its unsaved input.
function renderList() {
  document.querySelector(".items")?.replaceChildren(...itemRows());
  for (const el of document.querySelectorAll(".sidebar [data-filter]"))
    el.classList.toggle("active", el.dataset.filter === state.filter);
}

function render() {
  const count = (filter) => state.items.filter((i) => inFilter(i, filter)).length;
  const nav = (key, label) =>
    h(
      "button",
      {
        class: "nav-item" + (state.filter === key ? " active" : ""),
        type: "button",
        "data-filter": key,
        onclick: () => {
          state.filter = key;
          renderList();
        },
      },
      h("span", { class: "label", text: label }),
      h("span", { class: "count", text: String(count(key)) }),
    );
  const search = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search",
    "aria-label": "Search items",
    value: state.query,
    oninput: (event) => {
      state.query = event.target.value;
      renderList();
    },
  });
  const detail = h("section", { class: "detail", id: "detail" });
  $app.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "nav",
        { class: "sidebar", "aria-label": "Janus" },
        h("div", { class: "brand" }, mark(""), h("b", { text: "JANUS" })),
        nav("all", "All items"),
        nav("favorites", "Favorites"),
        h("p", { class: "nav-heading", text: "Types" }),
        Object.entries(TYPES).map(([key, type]) => nav(key, type.plural)),
        folders().length ? h("p", { class: "nav-heading", text: "Folders" }) : null,
        folders().map((name) => nav("folder:" + name, name)),
        h("div", { class: "spacer" }),
        h("button", { class: "nav-item", type: "button", onclick: transfer }, h("span", { class: "label", text: "Export & import" })),
        h("button", { class: "nav-item", type: "button", onclick: passwordChange }, h("span", { class: "label", text: "Master password" })),
        h("button", { class: "nav-item", type: "button", onclick: () => lockNow() }, h("span", { class: "label", text: "Lock" })),
      ),
      h(
        "section",
        { class: "list-pane" },
        h(
          "div",
          { class: "list-head" },
          search,
          h("button", {
            class: "btn primary",
            type: "button",
            text: "New",
            onclick: () => (TYPES[state.filter] ? edit(null, state.filter) : chooseType()),
          }),
        ),
        h("div", { class: "items", role: "list" }, itemRows()),
      ),
      detail,
    ),
  );
  if (state.mode === "edit") return;
  if (state.selected) showItem(state.selected);
  else detail.append(h("p", { class: "empty", text: "Select an item, or create one with New." }));
}

function chooseType() {
  state.mode = "edit";
  render();
  document.getElementById("detail").replaceChildren(
    h(
      "div",
      { class: "detail-inner" },
      h("header", { class: "detail-head" }, h("h2", { text: "What do you want to add?" })),
      h(
        "div",
        { class: "type-grid" },
        Object.entries(TYPES).map(([key, type]) =>
          h("button", { class: "type-card", type: "button", text: type.label, onclick: () => edit(null, key) }),
        ),
      ),
    ),
  );
  document.querySelector(".type-card")?.focus();
}

function glyphFor(item) {
  return (item.title || "?").trim().charAt(0).toUpperCase() || "?";
}

async function select(id) {
  state.selected = id;
  state.mode = "view";
  render();
}

function optionLabel(field, value) {
  return field.options?.find(([key]) => key === value)?.[1] ?? value;
}

async function showItem(id) {
  const item = await call("get", { id });
  const detail = document.getElementById("detail");
  if (!detail || state.selected !== id) return;
  const type = TYPES[item.type];
  const rows = [];
  const row = (field, value) => {
    if (!value) return;
    const shown = field.format === "card" ? groupCard(value) : optionLabel(field, value);
    const v = h("span", { class: "v" + (field.secret ? " mono" : ""), text: field.secret ? "••••••••••••" : shown });
    const actions = h("span", { class: "actions" });
    if (field.secret) {
      let visible = false;
      actions.append(
        h("button", {
          class: "btn ghost small",
          type: "button",
          text: "Reveal",
          "aria-label": `Reveal ${field.label}`,
          onclick: (event) => {
            visible = !visible;
            v.textContent = visible ? shown : "••••••••••••";
            event.target.textContent = visible ? "Hide" : "Reveal";
          },
        }),
      );
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
    if (field.list) for (const value of item[field.name] ?? []) row(field, value);
    else row(field, item[field.name]);
  }
  if (item.type === "login" && item.totp) rows.splice(2, 0, codeRow(item.id));
  detail.replaceChildren(
    h(
      "div",
      { class: "detail-inner" },
      h(
        "header",
        { class: "detail-head" },
        h("span", { class: "glyph", text: glyphFor(item) }),
        h("h2", { text: item.title || "Untitled" }),
        h("button", {
          class: "btn ghost star-toggle" + (item.favorite ? " on" : ""),
          type: "button",
          "aria-pressed": String(item.favorite),
          "aria-label": item.favorite ? "Remove from favorites" : "Add to favorites",
          text: item.favorite ? "★" : "☆",
          onclick: async () => {
            await call("set_meta", { id: item.id, meta: { folder: item.folder, tags: item.tags, favorite: !item.favorite } });
            await refresh();
          },
        }),
        h("button", { class: "btn", type: "button", text: "Edit", onclick: () => edit(item) }),
        h("button", { class: "btn ghost danger", type: "button", text: "Delete", onclick: () => remove(item) }),
      ),
      item.tags.length ? h("div", { class: "tags" }, item.tags.map((tag) => h("span", { class: "tag", text: tag }))) : null,
      rows.length ? h("div", { class: "kv" }, rows) : h("p", { class: "empty", text: "No details yet." }),
      historySection(item),
      h("p", {
        class: "meta-line",
        text: [type.label, item.folder && `in ${item.folder}`, `updated ${new Date(item.updated_at).toLocaleString()}`].filter(Boolean).join(" · "),
      }),
    ),
  );
}

// Live one-time code. The code is computed by the core; the timer stops when the
// row leaves the page (another item, edit mode or lock).
let codeTimer;
function codeRow(id) {
  clearInterval(codeTimer);
  const code = h("span", { class: "v mono code", text: "······" });
  const left = h("span", { class: "code-left" });
  const copyButton = h("button", { class: "btn ghost small", type: "button", text: "Copy", "aria-label": "Copy one-time code" });
  let current = "";
  copyButton.addEventListener("click", () => current && copy(current, "One-time code"));
  let timer; // this row's own timer: a stale row must never stop a newer row's timer
  const tick = async () => {
    if (timer && !code.isConnected) return clearInterval(timer);
    try {
      const next = await invoke("totp", { id });
      current = next.code;
      code.textContent = next.code.replace(/(\d{3})(?=\d)/, "$1 ");
      left.textContent = `${next.remaining}s`;
      left.classList.toggle("soon", next.remaining <= 5);
    } catch (error) {
      clearInterval(timer);
      code.textContent = String(error);
    }
  };
  tick();
  timer = codeTimer = setInterval(tick, 1000);
  return h("div", { class: "kv-row" }, h("span", { class: "k", text: "One-time code" }), h("span", { class: "code-cell" }, code, left), h("span", { class: "actions" }, copyButton));
}

// Replaced secrets stay recoverable; values are masked like every other secret.
function historySection(item) {
  if (!item.history?.length) return null;
  const rows = item.history.map((change) => {
    const v = h("span", { class: "v mono", text: "••••••••••••" });
    let shown = false;
    return h(
      "div",
      { class: "kv-row" },
      h("span", { class: "k", text: new Date(change.replaced_at).toLocaleDateString() }),
      v,
      h(
        "span",
        { class: "actions" },
        h("button", {
          class: "btn ghost small",
          type: "button",
          text: "Reveal",
          onclick: (event) => {
            shown = !shown;
            v.textContent = shown ? change.value : "••••••••••••";
            event.target.textContent = shown ? "Hide" : "Reveal";
          },
        }),
        h("button", { class: "btn ghost small", type: "button", text: "Copy", onclick: () => copy(change.value, "Previous " + change.field) }),
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

function groupCard(value) {
  return value.replace(/\D/g, "").replace(/(\d{4})(?=\d)/g, "$1 ");
}

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
  state.mode = "edit";
  render();
  const type = TYPES[typeKey];
  const detail = document.getElementById("detail");
  const error = h("p", { class: "error", role: "alert" });
  const presetFolder = state.filter.startsWith("folder:") ? state.filter.slice(7) : "";
  const errorFor = {};
  const note = (name, hint) => {
    errorFor[name] = h("span", { class: "field-error", role: "alert" });
    return [hint ? h("span", { class: "field-hint", text: hint }) : null, errorFor[name]];
  };
  const fields = [h("label", { class: "field" }, h("span", { text: "Title" }), input({ name: "title", max: 200 }, item?.title ?? ""), note("title"))];
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
        h("input", { name: "folder", value: item?.folder ?? presetFolder, list: "folder-list", autocomplete: "off", placeholder: "None" }),
        h("datalist", { id: "folder-list" }, folders().map((name) => h("option", { value: name }))),
      ),
      h(
        "label",
        { class: "field" },
        h("span", { text: "Tags" }),
        h("input", { name: "tags", value: (item?.tags ?? []).join(", "), autocomplete: "off", placeholder: "Comma separated" }),
      ),
    ),
  );
  const form = h(
    "form",
    {
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
        state.selected = id;
        state.mode = "view";
        await refresh();
      },
    },
    fields,
    error,
    h(
      "div",
      { class: "form-actions" },
      h("button", { class: "btn primary", type: "submit", text: item ? "Save" : "Add to vault" }),
      h("button", {
        class: "btn ghost",
        type: "button",
        text: "Cancel",
        onclick: () => {
          state.mode = "view";
          render();
        },
      }),
    ),
  );
  detail.replaceChildren(
    h(
      "div",
      { class: "detail-inner" },
      h("header", { class: "detail-head" }, h("h2", { text: item ? `Edit ${type.label.toLowerCase()}` : `New ${type.label.toLowerCase()}` })),
      form,
    ),
  );
  form.querySelector("input")?.focus();
}

async function remove(item) {
  const detail = document.getElementById("detail");
  const confirmBox = h(
    "div",
    { class: "kv confirm" },
    h("p", { text: `Delete “${item.title || "Untitled"}” permanently? This cannot be undone.`, }),
    h(
      "div",
      { class: "form-actions" },
      h("button", {
        class: "btn danger",
        type: "button",
        text: "Delete permanently",
        onclick: async () => {
          await call("delete", { id: item.id });
          state.selected = null;
          await refresh();
          toast("Item deleted");
        },
      }),
      h("button", { class: "btn ghost", type: "button", text: "Keep it", onclick: () => confirmBox.remove() }),
    ),
  );
  detail.querySelector(".detail-inner")?.append(confirmBox);
}

// Encrypted export to Downloads and import of Janus exports, with a preview first.
function transfer() {
  state.mode = "edit";
  render();
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
        const path = await call("export_vault", { master: document.getElementById("exp-master").value, exportPassword: next }, exportError);
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
    h("p", { class: "hint", text: "The export is encrypted with this password, not your master password. Without it the file cannot be opened. Janus never writes a plaintext export." }),
    exportError,
    saved,
    h("div", { class: "form-actions" }, h("button", { class: "btn primary", type: "submit", text: "Export to Downloads" })),
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
        preview.replaceChildren(
          h("p", { text: `${items.length} items in this export, ${fresh.length} new. Items already in this vault are left unchanged.` }),
          h("div", { class: "kv" }, items.slice(0, 50).map((i) => h("div", { class: "kv-row" }, h("span", { class: "k", text: TYPES[i.type]?.label ?? i.type }), h("span", { class: "v", text: i.title || "Untitled" }), h("span", { class: "actions", text: known.has(i.id) ? "already here" : "" })))),
          items.length > 50 ? h("p", { class: "hint", text: `and ${items.length - 50} more` }) : null,
          h(
            "div",
            { class: "form-actions" },
            h("button", {
              class: "btn primary",
              type: "button",
              text: `Import ${fresh.length} items`,
              disabled: !fresh.length,
              onclick: async () => {
                const report = await call("import_export", pending, importError);
                pending = null;
                preview.replaceChildren();
                importForm.reset();
                toast(`Imported ${report.added} items${report.skipped_existing ? `, ${report.skipped_existing} already present` : ""}`);
                state.items = await call("list");
                renderList();
              },
            }),
          ),
        );
      },
    },
    h("label", { class: "field" }, h("span", { text: "Janus export file" }), h("input", { id: "imp-file", type: "file", accept: ".janus-export" })),
    passwordField("Export password", "imp-pw", "off"),
    importError,
    h("div", { class: "form-actions" }, h("button", { class: "btn", type: "submit", text: "Preview import" })),
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
        otherPreview.replaceChildren(
          h("p", { text: `${plan.items.length} items will be added as new items.` }),
          plan.kept_in_notes ? h("p", { class: "hint", text: `${plan.kept_in_notes} fields without a Janus counterpart are kept in the items' notes.` }) : null,
          plan.warnings.map((w) => h("p", { class: "hint warn", text: w })),
          h("div", { class: "kv" }, plan.items.slice(0, 50).map((i) => h("div", { class: "kv-row" }, h("span", { class: "k", text: TYPES[i.type]?.label ?? i.type }), h("span", { class: "v", text: i.title || "Untitled" }), h("span", { class: "actions", text: i.folder })))),
          plan.items.length > 50 ? h("p", { class: "hint", text: `and ${plan.items.length - 50} more` }) : null,
          h(
            "div",
            { class: "form-actions" },
            h("button", {
              class: "btn primary",
              type: "button",
              text: `Import ${plan.items.length} items`,
              disabled: !plan.items.length,
              onclick: async () => {
                const report = await call("import_items", { format, bytes }, otherError);
                otherPreview.replaceChildren(h("p", { class: "hint warn", text: `Imported ${report.added} items. Now delete the file you imported: it contains your passwords unencrypted.` }));
                otherForm.reset();
                state.items = await call("list");
                renderList();
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
    h("label", { class: "field" }, h("span", { text: "Export file" }), h("input", { id: "other-file", type: "file", accept: ".json,.csv" })),
    h("p", { class: "hint warn", text: "These files contain your passwords unencrypted. Janus reads them only in memory, but cannot protect or erase the file itself: delete it after importing." }),
    otherError,
    h("div", { class: "form-actions" }, h("button", { class: "btn", type: "submit", text: "Preview" })),
  );

  document.getElementById("detail").replaceChildren(
    h(
      "div",
      { class: "detail-inner" },
      h("header", { class: "detail-head" }, h("h2", { text: "Export & import" })),
      h("h3", { class: "section-title", text: "Encrypted export" }),
      exportForm,
      h("h3", { class: "section-title", text: "Import a Janus export" }),
      importForm,
      preview,
      h("h3", { class: "section-title", text: "Import from another password manager" }),
      otherForm,
      otherPreview,
    ),
  );
}

function passwordChange() {
  state.mode = "edit";
  render();
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
        state.mode = "view";
        render();
        toast("Master password changed");
      },
    },
    passwordField("Current master password", "cur", "current-password"),
    passwordField("New master password", "new1", "new-password"),
    passwordField("Repeat new password", "new2", "new-password"),
    error,
    h("div", { class: "form-actions" }, h("button", { class: "btn primary", type: "submit", text: "Change password" })),
  );
  document.getElementById("detail").replaceChildren(h("div", { class: "detail-inner" }, h("header", { class: "detail-head" }, h("h2", { text: "Master password" })), form));
}

/* ───────── Boot ───────── */

async function boot() {
  let status;
  try {
    status = await invoke("status");
  } catch (error) {
    $app.replaceChildren(h("main", { class: "gate" }, h("p", { class: "error", text: String(error) })));
    return;
  }
  state.mode = "view";
  if (!status.exists) return createScreen();
  if (!status.unlocked) return unlockScreen();
  touch();
  await refresh();
}
boot();
