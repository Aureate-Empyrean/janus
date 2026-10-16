// Browser check of the desktop UI with the same CSP as tauri.conf.json and a mocked
// `invoke` (the Rust core has its own tests). Usage: node tests/ui_preview.cjs [outDir]
const { chromium, expect } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.resolve(__dirname, "../ui");
const conf = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src-tauri/tauri.conf.json")));
const csp = conf.app.security.csp;
const out = process.argv[2] || "artifacts";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

const server = http.createServer((req, res) => {
  const file = path.join(ui, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(ui) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Content-Security-Policy": csp });
  fs.createReadStream(file).pipe(res);
});

const mock = () => {
  const vault = { exists: false, unlocked: false, password: null, items: [] };
  let n = 0;
  const subtitle = (i) => {
    const digits = (i.number || "").replace(/\D/g, "");
    return { login: i.username, wifi: i.ssid, api_secret: i.service, payment_card: digits.length >= 8 ? "•••• " + digits.slice(-4) : "" }[i.type] ?? "";
  };
  const summary = (i) => ({ id: i.id, type: i.type, title: i.title, subtitle: subtitle(i), updated_at: i.updated_at });
  window.__calls = [];
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        window.__calls.push(cmd);
        const need = () => { if (!vault.unlocked) throw "The vault is locked"; };
        switch (cmd) {
          case "status": return { exists: vault.exists, unlocked: vault.unlocked };
          case "create": if (args.password.length < 12) throw "The master password must be at least 12 characters"; Object.assign(vault, { exists: true, unlocked: true, password: args.password }); return null;
          case "unlock": if (args.password !== vault.password) throw "Wrong master password, or the vault file was modified"; vault.unlocked = true; return null;
          case "lock": vault.unlocked = false; return null;
          case "list": need(); return vault.items.map(summary).sort((a, b) => a.title.localeCompare(b.title));
          case "get": need(); return { ...vault.items.find((i) => i.id === args.id) };
          case "save": need(); {
            const now = new Date().toISOString();
            if (args.id) { const i = vault.items.find((x) => x.id === args.id); Object.assign(i, args.item, { updated_at: now }); return i.id; }
            const id = "00000000-0000-4000-8000-00000000000" + ++n;
            vault.items.push({ id, created_at: now, updated_at: now, ...args.item }); return id;
          }
          case "delete": need(); vault.items = vault.items.filter((i) => i.id !== args.id); return null;
          case "generate": return { password: "Xq7#mK2!vR9@pL4$wT6^zH8&", bits: 147.3 };
          default: throw "unknown command " + cmd;
        }
      },
    },
  };
};

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1120, height: 760 }, reducedMotion: "reduce" })).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(mock);
    await page.goto(base);
    await expect(page.getByText("Development build.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create your vault" })).toBeVisible();
    await page.screenshot({ path: `${out}/janus-01-create.png` });
    await page.fill("#pw", "short");
    await page.fill("#pw2", "short");
    await page.click("text=Create vault");
    await expect(page.getByRole("alert")).toContainText("at least 12");
    await page.fill("#pw", "correct horse battery staple");
    await page.fill("#pw2", "correct horse battery staple");
    await page.click("text=Create vault");
    await expect(page.getByText("Your vault is empty.")).toBeVisible();

    await page.click("text=New");
    await expect(page.getByRole("heading", { name: "What do you want to add?" })).toBeVisible();
    await page.click(".type-card >> text=Login");
    await page.fill('input[name="title"]', "Example Mail");
    await page.fill('input[name="username"]', "adrian@example.org");
    await page.click("text=Generate");
    await page.fill('input[name="urls"]', "https://mail.example.org");
    await page.screenshot({ path: `${out}/janus-02-new-login.png` });
    await page.click("text=Add to vault");
    await expect(page.getByRole("heading", { name: "Example Mail" })).toBeVisible();
    await expect(page.locator(".kv")).not.toContainText("Xq7#mK2");
    await page.click("text=Reveal");
    await expect(page.locator(".kv")).toContainText("Xq7#mK2");
    await page.screenshot({ path: `${out}/janus-03-detail.png` });

    await page.click(".nav-item >> text=Secure notes");
    await page.click("text=New");
    await page.fill('input[name="title"]', "Recovery codes");
    await page.fill('textarea[name="content"]', "1111-2222\n3333-4444");
    await page.click("text=Add to vault");
    // A payment card: secrets masked, overview shows only the last four digits.
    await page.click(".nav-item >> text=Payment cards");
    await page.click("text=New");
    await page.fill('input[name="title"]', "Visa");
    await page.fill('input[name="number"]', "4111 1111 1111 1234");
    await page.fill('input[name="security_code"]', "987");
    await page.click("text=Add to vault");
    await expect(page.locator(".item-row .sub")).toHaveText("•••• 1234");
    await expect(page.locator(".kv")).not.toContainText("4111");
    await page.click('[aria-label="Reveal Card number"]');
    await expect(page.locator(".kv")).toContainText("4111 1111 1111 1234");
    await page.screenshot({ path: `${out}/janus-04b-card.png` });
    // An identity document uses its own fields, including a document-type select.
    await page.click(".nav-item >> text=Identity documents");
    await page.click("text=New");
    await page.fill('input[name="title"]', "Passport");
    await page.selectOption('select[name="document_type"]', "passport");
    await page.fill('input[name="document_number"]', "X1234567");
    await page.fill('input[name="expires_on"]', "2031-01-01");
    await page.click("text=Add to vault");
    await expect(page.locator(".kv")).toContainText("Passport");
    await page.click(".nav-item >> text=All items");
    await expect(page.locator(".item-row")).toHaveCount(4);
    const search = page.locator('input[type="search"]');
    await search.pressSequentially("mail");
    await expect(search).toHaveValue("mail");
    await expect(search).toBeFocused();
    await expect(page.locator(".item-row")).toHaveCount(1);
    await page.screenshot({ path: `${out}/janus-04-list.png` });

    // Searching or filtering while editing keeps the unsaved form.
    await page.click("text=New");
    await page.click(".type-card >> text=Wi-Fi");
    await page.fill('input[name="title"]', "Unsaved draft");
    await search.fill("");
    await search.pressSequentially("rec");
    await page.click(".nav-item >> text=Logins");
    await expect(page.locator('input[name="title"]')).toHaveValue("Unsaved draft");
    await page.click("text=Cancel");
    await search.fill("");
    await page.click(".nav-item >> text=All items");

    await page.click("text=Lock");
    await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
    await page.fill("#pw", "wrong password here");
    await page.click("button:has-text('Unlock')");
    await expect(page.getByRole("alert")).toContainText("Wrong master password");
    await page.screenshot({ path: `${out}/janus-05-unlock-error.png` });
    await page.fill("#pw", "correct horse battery staple");
    await page.click("button:has-text('Unlock')");
    await expect(page.locator(".item-row")).toHaveCount(4);

    const font = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('14px "Roboto"'); });
    if (!font) errors.push("Bundled Roboto did not load");
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    if (accent !== "#4fb8b0") errors.push("Teal accent missing: " + accent);
    if (errors.length) throw Error(errors.join(" | "));
    console.log("PASS: create (weak password refused), type chooser, login with generator, payment card (last four only in list), identity document, masked/revealed password, secure note, filter/search, lock, wrong password, unlock, Roboto, teal accent, CSP without violations");
  } catch (e) {
    console.error("FAIL:", e.message, errors);
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: `${out}/janus-failure.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
