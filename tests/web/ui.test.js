// The page in Chrome against a fake API. Chrome loads web/ as it is; every
// request is answered from here: the page files, a stand-in for the Cognito
// library and an in-memory API that behaves like lambda/lambda_app.py.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { WEB, loadPage } = require("./load");

const ORIGIN = "https://wiki.test";
const ADMIN = { email: "admin@example.com", password: "admin123" };
const { WikiText } = loadPage({ lang: "en" });

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}

const CONFIG = "window.WIKI_CONFIG = " + JSON.stringify({
  region: "eu-central-1",
  userPoolId: "eu-central-1_test",
  clientId: "test",
  apiBase: "/api",
  demo: { email: ADMIN.email, password: ADMIN.password, reset: "rate(1 hour)" },
}) + ";";

// Enough of amazon-cognito-identity-js for the page: one user, the session kept in localStorage.
// "test-totp" in localStorage means the user has an authenticator app; its code is always 123456.
const TOTP_CODE = "123456";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const COGNITO = `(() => {
  const KEY = "test-session";
  const TOTP = "test-totp";
  const session = () => ({
    isValid: () => true,
    getRefreshToken: () => "refresh",
    getIdToken: () => ({ getJwtToken: () => "token", payload: { email: ${JSON.stringify(ADMIN.email)}, "cognito:groups": ["admins"] } }),
  });
  const user = () => ({
    getSession: (done) => done(null, session()),
    refreshSession: (token, done) => done(null, session()),
    signOut: () => localStorage.removeItem(KEY),
    getUserData: (done) => done(null, { UserMFASettingList: localStorage.getItem(TOTP) ? ["SOFTWARE_TOKEN_MFA"] : [] }),
    associateSoftwareToken: (callbacks) => callbacks.associateSecretCode(${JSON.stringify(TOTP_SECRET)}),
    verifySoftwareToken: (code, name, callbacks) => (code === ${JSON.stringify(TOTP_CODE)}
      ? callbacks.onSuccess({ Status: "SUCCESS" })
      : callbacks.onFailure({ code: "EnableSoftwareTokenMFAException", message: "Code mismatch" })),
    setUserMfaPreference: (sms, totp, done) => {
      if (totp.Enabled) localStorage.setItem(TOTP, "1");
      else localStorage.removeItem(TOTP);
      done(null, "SUCCESS");
    },
  });
  window.AmazonCognitoIdentity = {
    CognitoUserPool: function () { this.getCurrentUser = () => (localStorage.getItem(KEY) ? user() : null); },
    AuthenticationDetails: function (data) { this.data = data; },
    CognitoUser: function (data) {
      this.authenticateUser = (details, callbacks) => {
        if (details.data.Password === ${JSON.stringify(ADMIN.password)}) {
          if (localStorage.getItem(TOTP)) return callbacks.totpRequired("SOFTWARE_TOKEN_MFA", {});
          localStorage.setItem(KEY, "1");
          callbacks.onSuccess(session());
        } else {
          callbacks.onFailure({ code: "NotAuthorizedException", message: "Incorrect username or password." });
        }
      };
      this.sendMFACode = (code, callbacks, type) => {
        if (type !== "SOFTWARE_TOKEN_MFA" || code !== ${JSON.stringify(TOTP_CODE)}) {
          return callbacks.onFailure({ code: "CodeMismatchException", message: "Invalid code received for user" });
        }
        localStorage.setItem(KEY, "1");
        callbacks.onSuccess(session());
      };
    },
  };
})();`;

const QRCODE = fs.readFileSync(require.resolve("qrcode-generator/qrcode.js"));

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".html": "text/html" };

// The API, kept in memory. `calls` records every request for the checks.
function fakeApi(tiddlers) {
  const store = new Map();
  const calls = [];
  const state = { story: null, drafts: new Map(), guestMfa: true };
  let clock = Date.parse("2026-09-01T10:00:00Z");
  const stamp = () => new Date((clock += 60000)).toISOString();
  const etag = () => Math.random().toString(16).slice(2);
  const meta = (item) => {
    const { text, ...rest } = item;
    return Object.assign(rest, { links: [...WikiText.links(text, item.type)].sort(), size: Buffer.byteLength(text) });
  };
  const full = (title) => Object.assign(meta(store.get(title)), { text: store.get(title).text });
  const put = (title, text, extra) => {
    const old = store.get(title);
    const now = stamp();
    const item = Object.assign({ title, text, tags: [], type: "text/vnd.tiddlywiki", created: old ? old.created : now, creator: ADMIN.email }, extra, { modified: now, modifier: ADMIN.email, etag: etag() });
    store.set(title, item);
    return item;
  };
  tiddlers.forEach((item) => put(item.title, item.text, item));

  function handle(method, url, body) {
    const route = method + " " + url.pathname.replace(/^\/api/, "");
    calls.push({ route, query: Object.fromEntries(url.searchParams), body });
    const q = (name) => url.searchParams.get(name);
    switch (route) {
      case "GET /tiddlers": {
        // Two per page, so the page has to follow the cursor.
        const all = [...store.values()];
        const from = Number(q("cursor") || 0);
        const next = from + 2 < all.length ? String(from + 2) : null;
        return [200, { items: all.slice(from, from + 2).map(meta), next_cursor: next }];
      }
      case "POST /tiddlers/get":
        if (body.titles.length > 100) return [400, { error: "Too many titles" }];
        return [200, { items: body.titles.filter((title) => store.has(title)).map(full) }];
      case "GET /search": {
        const words = q("q").toLowerCase();
        return [200, { items: [...store.values()].filter((item) => (item.title + "\n" + item.text).toLowerCase().includes(words)).map((item) => item.title) }];
      }
      case "GET /tasks":
        return [200, {
          items: [...store.values()]
            .filter((item) => !q("tag") || item.tags.includes(q("tag")))
            .map((item) => ({ title: item.title, type: item.type, tasks: [...WikiText.tasks(item.text, item.type)].filter((task) => !task.done).map((task) => ({ ...task })) }))
            .filter((group) => group.tasks.length),
        }];
      case "PUT /tiddler": {
        const source = body.from_title || body.title;
        const old = store.get(source);
        if ((old && old.etag !== body.etag) || (!old && body.etag)) return [409, { error: "Someone else changed this tiddler" }];
        if (body.from_title && body.from_title !== body.title) store.delete(body.from_title);
        put(body.title, body.text, { tags: body.tags || [], type: body.type });
        return [200, full(body.title)];
      }
      case "DELETE /tiddler":
        store.delete(q("title"));
        return [200, {}];
      case "GET /revisions":
        return [200, { items: [] }];
      case "GET /state":
        return [200, { story: state.story, drafts: [...state.drafts.values()] }];
      case "PUT /state/story":
        state.story = body.titles;
        return [200, { updated: stamp() }];
      case "PUT /state/draft": {
        const updated = stamp();
        state.drafts.set(body.key, Object.assign({}, body, { updated }));
        return [200, { updated }];
      }
      case "DELETE /state/draft":
        state.drafts.delete(q("key"));
        return [200, {}];
      case "GET /admin/users":
        return [200, { items: [
          { email: ADMIN.email, status: "CONFIRMED", enabled: true, admin: true, mfa: false, self: true },
          { email: "guest@example.com", status: "CONFIRMED", enabled: true, admin: false, mfa: state.guestMfa, self: false },
        ] }];
      case "PUT /admin/users":
        if (body.reset_mfa) state.guestMfa = false;
        return [200, { email: body.email }];
      default:
        return [404, { error: "Not found" }];
    }
  }

  return { store, calls, state, handle, routes: (route) => calls.filter((call) => call.route === route) };
}

const SAMPLE = [
  { title: "Home", text: "! Welcome\nSee [[Recipes]] and [[Nowhere]].\n\n{{Motto}}" },
  { title: "Motto", text: "''Keep it simple''" },
  { title: "Recipes", text: "Soup needs a [[Pot]].\n\n* [ ] buy carrots\n* [x] buy salt", tags: ["Food"] },
  { title: "Pot", text: "A big one." },
  { title: "Far away", text: "The word zucchini appears only here." },
  { title: "$:/DefaultTiddlers", text: "[[Home]]" },
];

const executablePath = chromePath();
let browser;

test.before(async () => {
  if (executablePath) browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});

test.after(async () => {
  if (browser) await browser.close();
});

// A fresh browser profile and a fresh API for each test.
async function openWiki(t, { signedIn = true, lang = "en", api = fakeApi(SAMPLE) } = {}) {
  if (!executablePath) {
    if (process.env.CI) throw new Error("Chrome not found; set CHROME_PATH");
    t.skip("Chrome not found; set CHROME_PATH to run the interface tests");
    return null;
  }
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());
    const reply = (status, contentType, body) => request.respond({ status, contentType, body });
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("amazon-cognito-identity")) return reply(200, "text/javascript", COGNITO);
    // The real file from npm, so the page's integrity hash is checked too.
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/qrcode-generator@")) {
      return request.respond({ status: 200, contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" }, body: QRCODE });
    }
    if (url.origin !== ORIGIN) return request.abort();
    if (url.pathname.startsWith("/api/")) {
      const body = request.postData() ? JSON.parse(request.postData()) : null;
      const [status, data] = api.handle(request.method(), url, body);
      return reply(status, "application/json", JSON.stringify(data));
    }
    if (url.pathname === "/config.js") return reply(200, "text/javascript", CONFIG);
    const file = path.join(WEB, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(WEB) || !fs.existsSync(file)) return reply(404, "text/plain", "not found");
    return reply(200, TYPES[path.extname(file)] || "application/octet-stream", fs.readFileSync(file));
  });
  await page.evaluateOnNewDocument((lang, signedIn) => {
    if (sessionStorage.getItem("test-ready")) return;
    sessionStorage.setItem("test-ready", "1");
    if (lang) localStorage.setItem("wiki-lang", lang);
    if (signedIn) localStorage.setItem("test-session", "1");
  }, lang, signedIn);
  await page.goto(ORIGIN + "/");
  t.after(() => assert.deepEqual(errors, [], "errors on the page"));
  return { page, api };
}

const card = (title) => `[data-card=${JSON.stringify(title)}]`;
const text = (page, selector) => page.$eval(selector, (node) => node.textContent);
const titles = (page, selector) => page.$$eval(selector, (nodes) => nodes.map((node) => node.dataset.card || node.dataset.title || node.textContent));

// Clicks the first element matching the selector whose text is exactly `label`.
async function clickText(page, selector, label) {
  await page.waitForFunction((selector, label) => [...document.querySelectorAll(selector)].some((node) => node.textContent === label), {}, selector, label);
  await page.evaluate((selector, label) => [...document.querySelectorAll(selector)].find((node) => node.textContent === label).click(), selector, label);
}

async function openSettings(page, tab) {
  await page.waitForSelector(card("Home"));
  await clickText(page, "button", "Settings");
  await clickText(page, ".dialog [role=tab]", tab);
}

async function until(check, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("timed out: " + message);
}

test("sign in with the demo account", async (t) => {
  const wiki = await openWiki(t, { signedIn: false });
  if (!wiki) return;
  const { page, api } = wiki;
  await page.waitForSelector(".login form");
  assert.equal(await page.$eval('input[type="email"]', (node) => node.value), ADMIN.email);
  assert.match(await text(page, ".demo-note"), /admin@example\.com \/ admin123/);

  await page.$eval('input[type="password"]', (node) => { node.value = "wrong"; });
  await page.click(".login button.primary");
  await until(async () => (await text(page, ".login .error")) === "Wrong email or password", "wrong password message");

  await page.$eval('input[type="password"]', (node, password) => { node.value = password; }, ADMIN.password);
  await page.click(".login button.primary");
  await page.waitForSelector(card("Home") + " .body h2");
  assert.equal(await text(page, card("Home") + " .body h2"), "Welcome");
  assert.equal(api.routes("GET /tiddlers").length, 3, "three pages of two");
});

test("only the texts on screen are loaded", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page, api } = wiki;
  await page.waitForSelector(card("Home") + " .transclusion strong");
  assert.equal(await text(page, card("Home") + " .transclusion strong"), "Keep it simple");
  const loaded = () => api.routes("POST /tiddlers/get").flatMap((call) => call.body.titles);
  assert.ok(!loaded().includes("Recipes"), "a linked tiddler is not loaded before it is opened");
  assert.ok(!loaded().includes("Far away"));
  assert.ok(await page.$(card("Home") + ' a.missing[data-title="Nowhere"]'), "a missing link is known without texts");

  await page.click(card("Home") + ' a[data-title="Recipes"]');
  await page.waitForSelector(card("Recipes") + " .body");
  await until(async () => /Soup needs a Pot/.test(await text(page, card("Recipes") + " .body")), "text of the opened tiddler");
  assert.ok(loaded().includes("Recipes"));
  assert.ok(!loaded().includes("Pot"));
  assert.match(await text(page, card("Recipes") + " .card-foot"), /Home/, "backlinks come from the stored links");
});

test("create, edit and a conflicting save", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page, api } = wiki;
  await page.waitForSelector(card("Home"));
  await page.click(".actions .primary");
  await page.waitForSelector(".tiddler.editing textarea");
  await page.$eval(".tiddler.editing .title-input", (node) => { node.value = "Plans"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.$eval(".tiddler.editing textarea", (node) => { node.value = "Go to [[Pot]] ''today''"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click('.tiddler.editing button[title="Save"]');
  await page.waitForSelector(card("Plans") + ":not(.editing) .body strong");
  assert.equal(api.store.get("Plans").text, "Go to [[Pot]] ''today''");
  assert.equal(api.state.drafts.size, 0, "the draft is gone after saving");

  await page.click(card("Plans") + ' button[title="Edit"]');
  await page.waitForSelector(card("Plans") + ".editing textarea");
  await page.$eval(card("Plans") + " textarea", (node) => { node.value = "Changed"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await until(() => api.state.drafts.has("Plans"), "autosaved draft");
  api.store.get("Plans").etag = "changed-elsewhere";
  await page.click(card("Plans") + ' button[title="Save"]');
  await until(async () => /Someone else changed/.test(await page.evaluate(() => document.body.textContent)), "conflict message");
  assert.ok(await page.$(card("Plans") + ".editing"), "the editor stays open with the text");
  assert.equal(await page.$eval(card("Plans") + " textarea", (node) => node.value), "Changed");
  assert.notEqual(api.store.get("Plans").text, "Changed");
});

test("ticking a task saves the tiddler", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page, api } = wiki;
  await page.waitForSelector(card("Home"));
  await page.evaluate(() => { location.hash = encodeURIComponent("Recipes"); });
  await page.waitForSelector(card("Recipes") + " input.task-box");
  await page.click(card("Recipes") + ' input.task-box[data-task="0"]');
  await until(() => api.store.get("Recipes").text.includes("* [x] buy carrots"), "saved tick");
  assert.match(api.store.get("Recipes").text, /\* \[x\] buy salt/);
});

test("todo summary comes from the server", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page, api } = wiki;
  await page.waitForSelector(card("Home"));
  await page.click(".actions .primary");
  await page.waitForSelector(".tiddler.editing textarea");
  await page.$eval(".tiddler.editing .title-input", (node) => { node.value = "Todo"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.$eval(".tiddler.editing textarea", (node) => { node.value = "<<todo>>"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click('.tiddler.editing button[title="Save"]');
  await page.waitForSelector(card("Todo") + " .todo li.task");
  assert.deepEqual(await page.$$eval(card("Todo") + " .todo li.task", (nodes) => nodes.map((node) => node.textContent)), ["buy carrots"]);
  assert.equal(api.routes("GET /tasks").length >= 1, true);
  await page.click(card("Todo") + " .todo input.task-box");
  await until(() => api.store.get("Recipes").text.includes("* [x] buy carrots"), "tick from the summary");
});

test("search finds titles at once and text on the server", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page, api } = wiki;
  await page.waitForSelector(".search");
  await page.type(".search", "recip");
  assert.ok((await titles(page, "#side-list a[data-title]")).includes("Recipes"));
  await page.$eval(".search", (node) => { node.value = ""; });
  await page.type(".search", "zucchini");
  await until(async () => (await titles(page, "#side-list a[data-title]")).includes("Far away"), "text match from the server");
  assert.equal(api.routes("GET /search").at(-1).query.q, "zucchini");
});

test("open tiddlers come back after a reload", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page, api } = wiki;
  await page.waitForSelector(card("Home"));
  await page.evaluate(() => { location.hash = encodeURIComponent("Pot"); });
  await page.waitForSelector(card("Pot"));
  await until(() => (api.state.story || []).includes("Pot"), "story saved to the server");
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => localStorage.setItem("test-session", "1"));
  await page.goto(ORIGIN + "/");
  await page.waitForSelector(card("Pot") + " .body");
  assert.deepEqual((await titles(page, "#story [data-card], .story [data-card]")).sort(), [...api.state.story].sort());
});

test("the interface follows the chosen language", async (t) => {
  const wiki = await openWiki(t, { signedIn: false, lang: "fr" });
  if (!wiki) return;
  const { page } = wiki;
  await page.waitForSelector(".login button.primary");
  assert.equal(await text(page, ".login button.primary"), "Se connecter");
  assert.equal(await page.evaluate(() => document.documentElement.lang), "fr");
  await page.select(".lang-select", "it");
  await page.waitForFunction(() => document.documentElement.lang === "it" && document.querySelector(".login button.primary"));
  assert.equal(await text(page, ".login button.primary"), "Accedi");
});

test("sign in asks for the authenticator code", async (t) => {
  const wiki = await openWiki(t, { signedIn: false });
  if (!wiki) return;
  const { page } = wiki;
  await page.waitForSelector(".login form");
  await page.evaluate(() => localStorage.setItem("test-totp", "1"));
  await page.$eval('input[type="password"]', (node, password) => { node.value = password; }, ADMIN.password);
  await page.click(".login button.primary");
  await page.waitForSelector('.login input[autocomplete="one-time-code"]');
  assert.equal(await text(page, ".login h1"), "Code from the app");

  await page.type('.login input[autocomplete="one-time-code"]', "000000");
  await page.click(".login button.primary");
  await until(async () => (await text(page, ".login .error")) === "Wrong code", "wrong code message");

  await page.type('.login input[autocomplete="one-time-code"]', TOTP_CODE);
  await page.click(".login button.primary");
  await page.waitForSelector(card("Home") + " .body h2");
});

test("two-step sign-in is turned on and off in the settings", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page } = wiki;
  await openSettings(page, "Two-step sign-in");
  await page.waitForSelector(".totp-status");
  assert.match(await text(page, ".totp-status"), /^Off\./);

  await clickText(page, ".settings-body button", "Enable");
  await page.waitForSelector(".settings-body svg.qr path");
  assert.ok((await page.$eval(".settings-body svg.qr path", (node) => node.getAttribute("d").length)) > 1000, "the QR code has modules");
  assert.equal(await text(page, ".totp-secret"), "JBSW Y3DP EHPK 3PXP");

  await page.type('.settings-body input[autocomplete="one-time-code"]', "000000");
  await clickText(page, ".settings-body button", "Confirm");
  await until(async () => (await text(page, ".settings-body .error")) === "Wrong code", "wrong code message");
  await page.type('.settings-body input[autocomplete="one-time-code"]', TOTP_CODE);
  await clickText(page, ".settings-body button", "Confirm");
  await until(async () => /^On\./.test(await text(page, ".totp-status")), "status after turning on");
  assert.equal(await page.evaluate(() => localStorage.getItem("test-totp")), "1");

  await clickText(page, ".settings-body button", "Turn off");
  await until(async () => /^Off\./.test(await text(page, ".totp-status")), "status after turning off");
  assert.equal(await page.evaluate(() => localStorage.getItem("test-totp")), null);
});

test("the users list shows two-step sign-in and resets it", async (t) => {
  const wiki = await openWiki(t);
  if (!wiki) return;
  const { page, api } = wiki;
  await openSettings(page, "Users");
  await page.waitForSelector("table.users tbody tr");
  const rows = () => page.$$eval("table.users tbody tr", (nodes) => nodes.map((node) => [...node.children].map((cell) => cell.textContent)));
  assert.deepEqual((await rows()).map((cells) => cells[2]), ["2FA: off", "2FA: on"]);
  await clickText(page, "table.users button", "Reset 2FA");
  await until(async () => (await rows())[1][2] === "2FA: off", "2FA reset");
  assert.deepEqual(api.routes("PUT /admin/users").map((call) => call.body), [{ email: "guest@example.com", reset_mfa: true }]);
  assert.equal(await page.$$eval("table.users button", (nodes) => nodes.filter((node) => node.textContent === "Reset 2FA").length), 0);
});
