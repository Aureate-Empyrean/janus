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
  res.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Content-Security-Policy": csp,
  });
  fs.createReadStream(file).pipe(res);
});

const mock = () => {
  const vault = { exists: false, unlocked: false, password: null, items: [] };
  let n = 0;
  const subtitle = (i) => {
    const digits = (i.number || "").replace(/\D/g, "");
    return (
      {
        login: i.username,
        wifi: i.ssid,
        api_secret: i.service,
        payment_card: digits.length >= 8 ? "•••• " + digits.slice(-4) : "",
      }[i.type] ?? ""
    );
  };
  const summary = (i) => ({
    id: i.id,
    type: i.type,
    title: i.title,
    subtitle: subtitle(i),
    folder: i.folder,
    tags: i.tags,
    favorite: i.favorite,
    updated_at: i.updated_at,
  });
  const tidy = (m) => ({
    folder: m.folder.trim(),
    tags: m.tags.map((t) => t.trim()).filter(Boolean),
    favorite: m.favorite,
  });
  window.__calls = [];
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        window.__calls.push(cmd);
        const need = () => {
          if (!vault.unlocked) throw "The vault is locked";
        };
        switch (cmd) {
          case "status":
            return { exists: vault.exists, unlocked: vault.unlocked };
          case "create":
            if (args.password.length < 12) throw "The master password must be at least 12 characters";
            Object.assign(vault, { exists: true, unlocked: true, password: args.password });
            return null;
          case "unlock":
            if (args.password !== vault.password) throw "Wrong master password, or the vault file was modified";
            vault.unlocked = true;
            return null;
          case "lock":
            vault.unlocked = false;
            return null;
          case "list":
            need();
            return vault.items.map(summary).sort((a, b) => a.title.localeCompare(b.title));
          case "get":
            need();
            return { ...vault.items.find((i) => i.id === args.id) };
          case "save":
            need();
            {
              const now = new Date().toISOString();
              if (args.id) {
                const i = vault.items.find((x) => x.id === args.id);
                if (i.password && i.password !== args.item.password)
                  i.history.unshift({ field: "password", value: i.password, replaced_at: now });
                Object.assign(i, args.item, tidy(args.meta), { updated_at: now });
                return i.id;
              }
              const id = "00000000-0000-4000-8000-00000000000" + ++n;
              vault.items.push({ id, created_at: now, updated_at: now, history: [], ...args.item, ...tidy(args.meta) });
              return id;
            }
          case "set_meta":
            need();
            Object.assign(
              vault.items.find((i) => i.id === args.id),
              tidy(args.meta),
            );
            return null;
          case "export_vault":
            if (args.master !== vault.password) throw "Wrong master password, or the vault file was modified";
            if (!args.exportPassword || args.exportPassword.length < 12)
              throw "The master password must be at least 12 characters";
            return "C:\\Users\\you\\Downloads\\janus-1760000000.janus-export";
          case "preview_export":
          case "import_export": {
            if (args.password !== "export passphrase here")
              throw "Wrong master password, or the vault file was modified";
            if (!Array.isArray(args.bytes) || !args.bytes.length) throw "This is not a Janus export file";
            const incoming = [
              {
                id: vault.items[0].id,
                type: vault.items[0].type,
                title: vault.items[0].title,
                subtitle: "",
                folder: "",
                tags: [],
                favorite: false,
              },
              {
                id: "11111111-1111-4111-8111-111111111111",
                type: "wifi",
                title: "Cabin Wi-Fi",
                subtitle: "Cabin",
                folder: "",
                tags: [],
                favorite: false,
              },
            ];
            if (cmd === "preview_export") return incoming;
            vault.items.push({
              ...incoming[1],
              ssid: "Cabin",
              password: "p",
              security: "WPA2",
              notes: "",
              history: [],
              updated_at: new Date().toISOString(),
            });
            return { added: 1, skipped_existing: 1 };
          }
          case "preview_import":
          case "import_items": {
            if (args.format !== "browser_csv" || !args.bytes.length) throw "This is not a CSV file";
            const plan = {
              items: [
                { id: "x", type: "login", title: "GitHub", subtitle: "adrian", folder: "", tags: [], favorite: false },
              ],
              warnings: [],
              kept_in_notes: 2,
            };
            if (cmd === "preview_import") return plan;
            vault.items.push({
              id: "22222222-2222-4222-8222-222222222222",
              type: "login",
              title: "GitHub",
              username: "adrian",
              password: "p",
              urls: [],
              notes: "",
              totp: "",
              folder: "",
              tags: [],
              favorite: false,
              history: [],
              updated_at: new Date().toISOString(),
            });
            return { added: 1, skipped_existing: 0 };
          }
          case "check_item": {
            // A small subset of the core rules, enough to exercise the per-field display.
            const i = args.item,
              errors = [];
            if (!i.title.trim()) errors.push({ field: "title", message: "Give the item a title" });
            if (i.type === "payment_card") {
              const n = i.number.replace(/\D/g, "");
              if (n && (n.length < 12 || n.length > 19))
                errors.push({ field: "number", message: "Card numbers have 12 to 19 digits" });
              if (i.security_code && !/^\d{3,4}$/.test(i.security_code))
                errors.push({ field: "security_code", message: "3 or 4 digits" });
            }
            return errors;
          }
          case "wifi_qr":
            need();
            return "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=";
          case "delete":
            need();
            vault.items = vault.items.filter((i) => i.id !== args.id);
            return null;
          case "totp":
            need();
            return { code: "287082", remaining: 17, period: 30 };
          case "generate":
            return { password: "Xq7#mK2!vR9@pL4$wT6^zH8&", bits: 147.3 };
          default:
            throw "unknown command " + cmd;
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
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1180, height: 800 }, reducedMotion: "reduce" });
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(mock);
    await page.goto(base);
    const sheet = page.locator(".sheet");
    const closeSheet = async () => {
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    };

    // Create vault.
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
    await expect(page.getByRole("heading", { name: "Your vault is empty" })).toBeVisible();
    await expect(page.locator("#search")).toBeFocused();
    await page.screenshot({ path: `${out}/janus-02-empty.png` });

    // A login with generator, authenticator key, folder and tags, from the empty-state tiles.
    await page.click(".results .type-card >> text=Login");
    await expect(sheet.getByRole("heading", { name: "New login" })).toBeVisible();
    await page.fill('input[name="title"]', "Example Mail");
    await page.fill('input[name="username"]', "adrian@example.org");
    await page.click("text=Generate");
    await page.fill('input[name="urls"]', "https://mail.example.org");
    await page.fill('input[name="totp"]', "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    await page.fill('input[name="folder"]', "Work");
    await page.fill('input[name="tags"]', "email, 2fa");
    await page.screenshot({ path: `${out}/janus-03-new-login.png` });
    await page.click("text=Add to vault");
    await expect(sheet.getByRole("heading", { name: "Example Mail" })).toBeVisible();
    await expect(page.locator(".kv")).not.toContainText("Xq7#mK2");
    await expect(page.locator(".code")).toHaveText("287 082");
    await expect(page.locator(".kv")).not.toContainText("GEZDGNBV");
    await page.click('[aria-label="Reveal Password"]');
    await expect(page.locator(".kv")).toContainText("Xq7#mK2");
    await expect(page.locator(".sheet .tag")).toHaveText(["email", "2fa"]);
    await page.click('[aria-label="Add to favorites"]');
    await expect(page.locator('[aria-label="Remove from favorites"]')).toBeVisible();
    await page.screenshot({ path: `${out}/janus-04-detail.png` });

    // Password change kept in history.
    await page.click(".sheet >> text=Edit");
    await page.fill('input[name="password"]', "a-brand-new-password-value");
    await page.click(".sheet >> text=Save");
    await expect(page.locator(".history summary")).toHaveText("Previous values (1)");
    await page.click(".history summary");
    await page.click(".history >> text=Reveal");
    await expect(page.locator(".history")).toContainText("Xq7#mK2");
    await closeSheet();
    await expect(page.locator(".tile")).toHaveCount(1);
    await expect(page.locator("#search")).toBeFocused();

    // A payment card: typing aids, per-field rule errors, card visual.
    await page.click("text=New");
    await expect(sheet.getByRole("heading", { name: "Add to your vault" })).toBeVisible();
    await page.click(".sheet .type-card >> text=Payment card");
    await page.fill('input[name="title"]', "Visa");
    const number = page.locator('input[name="number"]');
    await number.pressSequentially("4111a111111111111111999");
    await expect(number).toHaveValue("4111 1111 1111 1111 111");
    await page.locator('input[name="expiry"]').pressSequentially("0829");
    await expect(page.locator('input[name="expiry"]')).toHaveValue("08/29");
    const cvc = page.locator('input[name="security_code"]');
    await cvc.pressSequentially("12345");
    await expect(cvc).toHaveValue("1234");
    await cvc.fill("12");
    await number.fill("4111 1111 1111 1111");
    await page.fill('input[name="cardholder"]', "Adrian K");
    await page.click("text=Add to vault");
    await expect(page.locator(".field:has([name=security_code]) .field-error")).toHaveText("3 or 4 digits");
    await page.screenshot({ path: `${out}/janus-05-card-errors.png` });
    await cvc.fill("987");
    await page.click("text=Add to vault");
    await expect(page.locator(".cc-brand")).toHaveText("VISA");
    await expect(page.locator(".cc-number")).toHaveText("•••• •••• •••• 1111");
    await page.click('[aria-label="Reveal card number"]');
    await expect(page.locator(".cc-number")).toHaveText("4111 1111 1111 1111");
    await page.screenshot({ path: `${out}/janus-06-card.png` });
    await closeSheet();

    // Identity document and Wi-Fi with a join code.
    await page.click("text=New");
    await page.click(".sheet .type-card >> text=Identity document");
    await page.fill('input[name="title"]', "Passport");
    await page.selectOption('select[name="document_type"]', "passport");
    await page.fill('input[name="document_number"]', "x1234567");
    await expect(page.locator('input[name="document_number"]')).toHaveValue("X1234567");
    await page.click("text=Add to vault");
    await expect(page.locator(".sheet .kv")).toContainText("Passport");
    await closeSheet();
    await page.click("text=New");
    await page.click(".sheet .type-card >> text=Wi-Fi");
    await page.fill('input[name="title"]', "Home Wi-Fi");
    await page.fill('input[name="ssid"]', "Exodus");
    await page.fill('input[name="password"]', "home-network-pass");
    await page.click("text=Add to vault");
    await page.click("text=Show join code");
    await expect(page.locator("img.qr")).toBeVisible();
    await closeSheet();

    // Spotlight search, keyboard selection, chips.
    await expect(page.locator(".tile")).toHaveCount(1);
    await page.screenshot({ path: `${out}/janus-07-home.png` });
    const search = page.locator("#search");
    await search.pressSequentially("ex");
    await expect(page.locator(".row")).toHaveCount(2);
    await expect(page.locator(".row.selected .row-title")).toContainText("Example Mail");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".row.selected .row-title")).toContainText("Home Wi-Fi");
    await page.screenshot({ path: `${out}/janus-08-search.png` });
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("heading", { name: "Home Wi-Fi" })).toBeVisible();
    await closeSheet();
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await page.click('.chip[data-filter="payment_card"]');
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator(".row .row-sub")).toHaveText("•••• 1111");
    await page.click('.chip[data-filter="folder:Work"]');
    await expect(page.locator(".row")).toHaveCount(1);
    await page.click('.chip[data-filter="all"]');
    await page.keyboard.press("Control+k");
    await expect(search).toBeFocused();

    // Export and imports, from the top bar.
    await page.click('[aria-label="Export & import"]');
    await page.fill("#exp-master", "correct horse battery staple");
    await page.fill("#exp1", "export passphrase here");
    await page.fill("#exp2", "export passphrase here");
    await page.click("text=Export to Downloads");
    await expect(page.getByText(/Saved to C:/)).toBeVisible();
    await page.setInputFiles("#imp-file", {
      name: "janus.janus-export",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
    await page.fill("#imp-pw", "wrong export password");
    await page.click("text=Preview import");
    await expect(page.locator("form:has(#imp-file) [role=alert]")).toContainText("Wrong");
    await page.fill("#imp-pw", "export passphrase here");
    await page.click("text=Preview import");
    await expect(page.getByText("2 items in this export, 1 new.")).toBeVisible();
    await page.click("text=Import 1 items");
    await expect(page.locator("#toast")).toContainText("Imported 1 items, 1 already present");
    await page.selectOption("#other-format", "browser_csv");
    await page.setInputFiles("#other-file", {
      name: "passwords.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("name,url,username,password\nGitHub,,adrian,p\n"),
    });
    await page.click("button:has-text('Preview') >> nth=-1");
    await expect(page.getByText("1 items will be added as new items.")).toBeVisible();
    await page.click("text=Import 1 items");
    await expect(page.getByText(/Now delete the file you imported/)).toBeVisible();
    await closeSheet();
    await expect(page.locator('.chip[data-filter="all"] .chip-count')).toHaveText("6");

    // Lock clears the session; wrong and right password.
    await search.fill("mail");
    await page.click('[aria-label="Lock"]');
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await page.fill("#pw", "wrong password here");
    await page.click("button:has-text('Unlock')");
    await expect(page.getByRole("alert")).toContainText("Wrong master password");
    await page.screenshot({ path: `${out}/janus-09-unlock-error.png` });
    await page.fill("#pw", "correct horse battery staple");
    await page.click("button:has-text('Unlock')");
    await expect(search).toHaveValue("");
    await expect(page.locator('.chip[data-filter="all"] .chip-count')).toHaveText("6");

    const font = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('14px "Roboto"');
    });
    if (!font) errors.push("Bundled Roboto did not load");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    );
    if (accent !== "#4fb8b0") errors.push("Teal accent missing: " + accent);
    if (errors.length) throw Error(errors.join(" | "));
    console.log(
      "PASS: create, empty state, login (generator, 2FA ring code, folder, tags, favorite, history), card (typing aids, rule errors, card visual), identity, Wi-Fi join code, spotlight search with keyboard, chips, export, imports, lock/unlock, Roboto, teal accent, CSP without violations",
    );
  } catch (e) {
    console.error("FAIL:", e.message, errors);
    await page?.screenshot({ path: `${out}/janus-failure.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
