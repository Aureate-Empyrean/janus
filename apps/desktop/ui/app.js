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
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
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
    throw error;
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
const NOTES = { name: "notes", label: "Notes", multiline: true };
const TYPES = {
  login: {
    label: "Login",
    plural: "Logins",
    fields: [
      { name: "username", label: "Username", copy: true },
      { name: "password", label: "Password", secret: true, copy: true, generate: true },
      { name: "urls", label: "Website", copy: true, list: true, input: { type: "url", placeholder: "https://" } },
      NOTES,
    ],
  },
  payment_card: {
    label: "Payment card",
    plural: "Payment cards",
    fields: [
      { name: "cardholder", label: "Cardholder", copy: true },
      { name: "number", label: "Card number", secret: true, copy: true, input: { inputmode: "numeric" } },
      { name: "expiry", label: "Expires", copy: true, input: { placeholder: "MM/YY" } },
      { name: "security_code", label: "Security code", secret: true, copy: true, input: { inputmode: "numeric" } },
      { name: "pin", label: "PIN", secret: true, copy: true, input: { inputmode: "numeric" } },
      NOTES,
    ],
  },
  identity: {
    label: "Identity document",
    plural: "Identity documents",
    fields: [
      { name: "document_type", label: "Document", options: DOCUMENT_TYPES },
      { name: "full_name", label: "Full name", copy: true },
      { name: "document_number", label: "Number", secret: true, copy: true },
      { name: "issuing_authority", label: "Issued by" },
      { name: "country", label: "Country" },
      { name: "issued_on", label: "Issued", input: { type: "date" } },
      { name: "expires_on", label: "Expires", input: { type: "date" } },
      NOTES,
    ],
  },
  wifi: {
    label: "Wi-Fi",
    plural: "Wi-Fi",
    fields: [
      { name: "ssid", label: "Network name", copy: true },
      { name: "password", label: "Password", secret: true, copy: true, generate: true },
      { name: "security", label: "Security", options: WIFI_SECURITY },
      NOTES,
    ],
  },
  api_secret: {
    label: "API secret",
    plural: "API secrets",
    fields: [
      { name: "service", label: "Service" },
      { name: "key_id", label: "Key or client ID", copy: true },
      { name: "secret", label: "Secret", secret: true, copy: true },
      NOTES,
    ],
  },
  secure_note: {
    label: "Secure note",
    plural: "Secure notes",
    fields: [{ name: "content", label: "Note", multiline: true, secret: true, copy: true }],
  },
};

async function refresh() {
  state.items = await call("list");
  render();
}

function itemRows() {
  const visible = state.items.filter(
    (i) =>
      (state.filter === "all" || i.type === state.filter) &&
      (i.title + " " + i.subtitle).toLowerCase().includes(state.query.toLowerCase()),
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
        h("span", { class: "title", text: i.title || "Untitled" }),
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
  const count = (type) => state.items.filter((i) => type === "all" || i.type === type).length;
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
        Object.entries(TYPES).map(([key, type]) => nav(key, type.plural)),
        h("div", { class: "spacer" }),
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
    const shown = optionLabel(field, value);
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
            v.textContent = visible ? value : "••••••••••••";
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
  detail.replaceChildren(
    h(
      "div",
      { class: "detail-inner" },
      h(
        "header",
        { class: "detail-head" },
        h("span", { class: "glyph", text: glyphFor(item) }),
        h("h2", { text: item.title || "Untitled" }),
        h("button", { class: "btn", type: "button", text: "Edit", onclick: () => edit(item) }),
        h("button", { class: "btn ghost danger", type: "button", text: "Delete", onclick: () => remove(item) }),
      ),
      rows.length ? h("div", { class: "kv" }, rows) : h("p", { class: "empty", text: "No details yet." }),
      h("p", { class: "meta-line", text: `${type.label} · updated ${new Date(item.updated_at).toLocaleString()}` }),
    ),
  );
}

function input(field, value) {
  const common = { name: field.name, autocomplete: "off", spellcheck: "false" };
  if (field.multiline) return h("textarea", common, value);
  if (field.options)
    return h(
      "select",
      { ...common, class: "select" },
      field.options.map(([key, label]) => h("option", { value: key, selected: key === value, text: label })),
    );
  return h("input", {
    ...common,
    value,
    ...(field.secret ? { type: "password", class: "mono" } : {}),
    ...field.input,
  });
}

function edit(item, typeKey = item?.type) {
  state.mode = "edit";
  render();
  const type = TYPES[typeKey];
  const detail = document.getElementById("detail");
  const error = h("p", { class: "error", role: "alert" });
  const fields = [h("label", { class: "field" }, h("span", { text: "Title" }), input({ name: "title" }, item?.title ?? ""))];
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
      ),
      info,
    );
  }
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
        const id = await call("save", { id: item?.id ?? null, item: payload }, error);
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
