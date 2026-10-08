# Synergy Module Express MVC Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the static Synergy Module terminal as a progressively enhanced Express MVC application with clean URLs while preserving its visual design, cinematic login, matrix effect, and seamless glitch navigation.

**Architecture:** Express controllers render either complete EJS documents or page fragments from the same view models. A persistent browser shell intercepts internal links, plays the route transition, fetches the fragment, swaps the route region, and updates browser history. Demo authentication uses a replaceable server service and session; journal persistence remains behind a browser-side local-storage repository until the later PostgreSQL phase.

**Tech Stack:** Node.js 24, Express 5, EJS 3, express-session, native ES modules, Node test runner, Supertest, JSDOM, existing CSS and browser Canvas APIs.

**Spec:** `docs/superpowers/specs/2026-09-01-express-mvc-rebuild-design.md`

## Global Constraints

- Preserve all accepted copy, layout, palette, typography, CRT effects, ASCII sphere, motion timing, responsive behavior, and interaction behavior from the current app.
- Use clean server URLs; hash routes must not remain the primary router.
- Full requests and fragment requests must be rendered from the same controller view model.
- Keep demo authentication behind `AuthService` so Discord OAuth can replace it later.
- Keep `synergy-module.journal.v1` readable through a repository interface so a later HTTP/PostgreSQL adapter can replace it.
- Do not add Discord OAuth, PostgreSQL, real feeds, alert persistence, indicator provisioning, or webhook delivery.
- Respect `prefers-reduced-motion` and preserve keyboard access.
- The folder is not currently a Git repository. Run commit steps only if Git is initialized by the user before execution.

---

### Task 1: Scaffold the Express application and authentication boundary

**Files:**
- Create: `package.json`
- Create: `src/app.js`
- Create: `src/server.js`
- Create: `src/services/auth-service.js`
- Create: `src/controllers/auth-controller.js`
- Create: `src/middleware/require-auth.js`
- Create: `src/routes/auth-routes.js`
- Create: `views/layouts/login.ejs`
- Create: `tests/unit/auth-service.test.js`
- Create: `tests/integration/auth-routes.test.js`

**Interfaces:**
- Produces: `createAuthService().authenticate({ username, passkey }) -> Promise<{ id, username }>`.
- Produces: `requireAuth(req, res, next)` with redirect behavior for full requests and `401` JSON for fragment requests.
- Produces: `createApp({ sessionSecret, authService }) -> Express` for tests and `src/server.js`.
- Session shape: `req.session.operator = { id: string, username: string }`.

- [ ] **Step 1: Create package metadata and install dependencies**

Use this package shape, letting npm record resolved versions in `package-lock.json`:

```json
{
  "name": "synergy-module",
  "version": "0.1.2",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "test": "node --test",
    "test:watch": "node --test --watch"
  }
}
```

Run:

```powershell
npm install express@^5 ejs@^3 express-session@^1
npm install --save-dev supertest@^7 jsdom@^26
```

- [ ] **Step 2: Write failing authentication unit tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthService } from "../../src/services/auth-service.js";

test("demo auth rejects blank credentials", async () => {
  const auth = createAuthService();
  await assert.rejects(
    () => auth.authenticate({ username: " ", passkey: "" }),
    { code: "CREDENTIALS_REQUIRED" },
  );
});

test("demo auth returns the normalized operator identity", async () => {
  const auth = createAuthService();
  assert.deepEqual(
    await auth.authenticate({ username: " local_operator ", passkey: "preview" }),
    { id: "local_operator", username: "local_operator" },
  );
});
```

- [ ] **Step 3: Run the unit test and confirm the red state**

Run: `node --test tests/unit/auth-service.test.js`

Expected: FAIL because `src/services/auth-service.js` does not exist.

- [ ] **Step 4: Implement the minimal authentication service**

```js
export function createAuthService() {
  return {
    async authenticate({ username = "", passkey = "" }) {
      const normalized = username.trim();
      if (!normalized || !passkey.trim()) {
        const error = new Error("Credentials required");
        error.code = "CREDENTIALS_REQUIRED";
        throw error;
      }
      return { id: normalized, username: normalized };
    },
  };
}
```

- [ ] **Step 5: Run the authentication unit test and confirm green**

Run: `node --test tests/unit/auth-service.test.js`

Expected: 2 passing tests, 0 failures.

- [ ] **Step 6: Write failing authentication integration tests**

Test with one persistent Supertest agent:

```js
test("login establishes and logout removes the operator session", async () => {
  const agent = request.agent(createApp({ sessionSecret: "test-secret" }));
  await agent.get("/home").expect(302).expect("Location", "/login");
  await agent.post("/auth/login").send({ username: "operator", passkey: "preview" }).expect(200);
  await agent.get("/home").expect(200);
  await agent.post("/auth/logout").expect(200);
  await agent.get("/home").expect(302).expect("Location", "/login");
});

test("fragment requests receive 401 instead of a redirect", async () => {
  await request(createApp({ sessionSecret: "test-secret" }))
    .get("/home")
    .set("X-Synergy-Module-Fragment", "1")
    .expect(401)
    .expect({ error: "AUTH_REQUIRED", loginUrl: "/login" });
});
```

- [ ] **Step 7: Run the integration test and confirm the red state**

Run: `node --test tests/integration/auth-routes.test.js`

Expected: FAIL because the application factory, routes, controller, middleware, and login view are incomplete.

- [ ] **Step 8: Implement the application factory and authentication request flow**

Configure JSON and URL-encoded parsing, EJS, static assets, `express-session`, auth routes, and the temporary `/home` protected response. `POST /auth/login` maps `CREDENTIALS_REQUIRED` to status `400`; success regenerates the session, writes `operator`, and returns `{ ok: true, redirectTo: "/home" }`. `POST /auth/logout` destroys the session and returns `{ ok: true, redirectTo: "/login" }`.

Use secure cookie options in production and a local development secret only outside production:

```js
const secret = sessionSecret ?? process.env.SESSION_SECRET;
if (!secret && process.env.NODE_ENV === "production") {
  throw new Error("SESSION_SECRET is required in production");
}
```

- [ ] **Step 9: Run Task 1 tests**

Run: `node --test tests/unit/auth-service.test.js tests/integration/auth-routes.test.js`

Expected: 4 passing tests, 0 failures.

- [ ] **Step 10: Commit if a Git repository exists**

```powershell
git add package.json package-lock.json src views/layouts/login.ejs tests
git commit -m "feat: scaffold express mvc authentication"
```

---

### Task 2: Add route models, controllers, and dual full/fragment rendering

**Files:**
- Create: `src/models/navigation.js`
- Create: `src/models/view-models.js`
- Create: `src/middleware/fragment-request.js`
- Create: `src/controllers/page-controller.js`
- Create: `src/controllers/journal-controller.js`
- Create: `src/routes/page-routes.js`
- Create: `src/routes/journal-routes.js`
- Modify: `src/app.js`
- Create: `views/layouts/app.ejs`
- Create: `views/pages/home.ejs`
- Create: `views/pages/indicators.ejs`
- Create: `views/pages/market-news.ejs`
- Create: `views/pages/alerts-ict.ejs`
- Create: `views/pages/alerts-sr.ejs`
- Create: `views/pages/journal-index.ejs`
- Create: `views/pages/journal-new.ejs`
- Create: `views/pages/journal-public.ejs`
- Create: `tests/unit/navigation.test.js`
- Create: `tests/integration/page-routes.test.js`

**Interfaces:**
- Produces: `NAVIGATION`, `ROUTE_BY_KEY`, and `getRouteByPath(pathname)`.
- Produces: route records `{ key, title, path, uri, description, view }`.
- Produces: `fragmentRequest(req, res, next)` setting `req.isSynergyModuleFragment` from `X-Synergy-Module-Fragment: 1`.
- Produces: `renderPage(req, res, page)` returning either `layouts/app` or `pages/<view>`.

- [ ] **Step 1: Write failing navigation model tests**

```js
test("clean routes resolve to the expected view metadata", () => {
  assert.deepEqual(getRouteByPath("/alerts/support-resistance"), {
    key: "alerts-sr",
    title: "ALERTS :: S&R",
    path: "/alerts/support-resistance",
    uri: "alerts/support-resistance",
    description: "Support and resistance alerts presented with the same live terminal-style feedback.",
    view: "alerts-sr",
  });
});

test("unknown paths return undefined", () => {
  assert.equal(getRouteByPath("/missing"), undefined);
});
```

- [ ] **Step 2: Run the navigation test and confirm the red state**

Run: `node --test tests/unit/navigation.test.js`

Expected: FAIL because the navigation model does not exist.

- [ ] **Step 3: Implement the route metadata and view-model builder**

Define exact entries for `home`, `indicators`, `market-news`, `alerts-ict`, `alerts-sr`, `journal`, and `journal-new`. Handle `/journal/:id` in the journal controller. `buildPageViewModel(route, extras)` must return:

```js
{
  route,
  navigation: NAVIGATION,
  operator: extras.operator,
  stats: extras.stats ?? null,
  data: extras.data ?? {},
}
```

- [ ] **Step 4: Run the navigation test and confirm green**

Run: `node --test tests/unit/navigation.test.js`

Expected: 2 passing tests, 0 failures.

- [ ] **Step 5: Write failing full/fragment route tests**

For each clean route, log in once and assert that a full request contains `data-app-shell` plus the route URI, while a fragment request contains `data-route-view` and omits `data-app-shell`:

```js
const cases = [
  ["/home", "synergy-module://home"],
  ["/indicators", "synergy-module://indicators"],
  ["/market-news", "synergy-module://market-news"],
  ["/alerts/ict", "synergy-module://alerts/ict"],
  ["/alerts/support-resistance", "synergy-module://alerts/support-resistance"],
  ["/journal", "synergy-module://journal"],
  ["/journal/new", "synergy-module://journal/new"],
];

for (const [path, identity] of cases) {
  await agent.get(path).expect(200).expect(/data-app-shell/).expect(new RegExp(identity));
  await agent.get(path).set("X-Synergy-Module-Fragment", "1").expect(200)
    .expect(/data-route-view/).expect((response) => {
      assert.doesNotMatch(response.text, /data-app-shell/);
      assert.equal(response.headers["x-synergy-module-path"], path);
    });
}
```

- [ ] **Step 6: Run route tests and confirm the red state**

Run: `node --test tests/integration/page-routes.test.js`

Expected: FAIL because the page routes and views are not implemented.

- [ ] **Step 7: Implement dual rendering and route registration**

`renderPage` must set `X-Synergy-Module-Path`, `X-Synergy-Module-Title`, and `X-Synergy-Module-Key`. Fragment requests render `pages/${page.route.view}`. Full requests render `layouts/app` with `pageView` and the same `page` object. Register specific `/journal/new` before `/journal/:id`.

- [ ] **Step 8: Implement semantic page EJS templates using the existing copy**

Each page root uses:

```ejs
<section class="route" data-route-view data-route-key="<%= page.route.key %>">
  <%- include("../partials/route-head", { page }) %>
</section>
```

Write every page body explicitly from the existing `app.js`; do not invent copy or seeded data. The required body inventory is:

- `home`: four stat panels, recent-activity empty state, and five quick-access links.
- `indicators`: provisioning empty state plus the four-step TradingView instructions and disabled copy control.
- `market-news`: `ALL`, `RED`, and `ORANGE` filter chips plus the empty calendar state.
- `alerts-ict`: `+ NEW RULE`, ICT rules empty state, and trigger-log empty state.
- `alerts-sr`: `+ NEW LEVEL` plus the support/resistance empty state.
- `journal-index`: `+ NEW JOURNAL ENTRY`, a hydrated list mount, and the no-entries state.
- `journal-new`: direction selector, three trade fields, eight confluence controls, screenshot input, notes, draft, and submit controls.
- `journal-public`: webhook embed, public-link/copy row, record mount, and back-to-journal control.

- [ ] **Step 9: Run Task 2 tests**

Run: `node --test tests/unit/navigation.test.js tests/integration/page-routes.test.js tests/integration/auth-routes.test.js`

Expected: all tests pass with 0 failures.

- [ ] **Step 10: Commit if a Git repository exists**

```powershell
git add src views/pages views/layouts/app.ejs tests
git commit -m "feat: add clean mvc page routes"
```

---

### Task 3: Recreate the persistent terminal shell and accepted visual system

**Files:**
- Create: `views/partials/statusbar.ejs`
- Create: `views/partials/sidebar.ejs`
- Create: `views/partials/route-head.ejs`
- Create: `views/partials/empty-state.ejs`
- Create: `public/css/synergy-module.css`
- Create: `public/favicon.ico`
- Modify: `views/layouts/app.ejs`
- Modify: `views/layouts/login.ejs`
- Modify: `src/app.js`
- Modify: `tests/integration/page-routes.test.js`

**Interfaces:**
- Consumes: `page.route`, `page.navigation`, and `page.operator` from Task 2.
- Produces: one persistent `[data-app-shell]`, `[data-main]`, `[data-sidebar]`, `[data-statusbar]`, and `[data-toast]` contract for browser controllers.
- Produces: login hooks `[data-login-root]`, `[data-login-form]`, `[data-login-user]`, `[data-login-passkey]`, and `[data-login-submit]`.

- [ ] **Step 1: Extend integration tests with shell structure assertions**

```js
const response = await agent.get("/home").expect(200);
assert.match(response.text, /data-statusbar/);
assert.match(response.text, /data-sidebar/);
assert.match(response.text, /data-main/);
assert.match(response.text, /Synergy Module/);
assert.match(response.text, /root@synergy-module:~\$/);
assert.match(response.text, /SESSION 01 \/ AUTHORIZED/);
```

- [ ] **Step 2: Run the shell assertions and confirm the red state**

Run: `node --test tests/integration/page-routes.test.js`

Expected: FAIL on missing shell hooks and partial markup.

- [ ] **Step 3: Translate the shared HTML into layouts and partials**

Move document metadata, font links, scan line, vignette, and `noscript` content from `index.html` into both layouts. Translate `buildShell`, status ticker, navigation items, sidebar footer, route header, panels, and empty-state markup from `app.js` into EJS. Use real anchor elements with the clean paths from `page.navigation`.

- [ ] **Step 4: Copy the accepted CSS and favicon into public assets**

Copy `styles.css` byte-for-byte to `public/css/synergy-module.css` first. Copy `favicon.ico` to `public/favicon.ico`. Change selectors only where required to replace generated wrapper assumptions with EJS data hooks. Preserve all values in `:root`, breakpoints, and keyframes.

- [ ] **Step 5: Wire public assets and module entry points**

The layouts load:

```html
<link rel="stylesheet" href="/css/synergy-module.css">
<script type="module" src="/js/app-shell.js"></script>
```

The login layout loads `/js/login-controller.js` instead of the app shell.

- [ ] **Step 6: Run Task 3 integration tests**

Run: `node --test tests/integration/page-routes.test.js tests/integration/auth-routes.test.js`

Expected: all tests pass with 0 failures.

- [ ] **Step 7: Commit if a Git repository exists**

```powershell
git add views public src/app.js tests/integration
git commit -m "feat: restore terminal shell and visual system"
```

---

### Task 4: Implement seamless fragment navigation and glitch transitions

**Files:**
- Create: `public/js/transition-controller.js`
- Create: `public/js/navigation-controller.js`
- Create: `public/js/app-shell.js`
- Create: `public/js/sphere-renderer.js`
- Create: `public/js/ui-utils.js`
- Create: `tests/unit/transition-controller.test.js`
- Create: `tests/unit/navigation-controller.test.js`

**Interfaces:**
- Produces: `createTransitionController({ documentRef, reducedMotion }) -> { show(title), hide(), fail(message) }`.
- Produces: `createNavigationController({ documentRef, windowRef, fetchImpl, transition, initializePage }) -> { navigate(url, options), dispose() }`.
- Fragment request header: `X-Synergy-Module-Fragment: 1`.
- Fragment response headers: `X-Synergy-Module-Path`, `X-Synergy-Module-Title`, `X-Synergy-Module-Key`.

- [ ] **Step 1: Write failing transition tests with JSDOM**

```js
test("show and hide control the routing overlay", async () => {
  const dom = new JSDOM('<main data-main></main>');
  const transition = createTransitionController({ documentRef: dom.window.document, reducedMotion: true });
  transition.show("MARKET NEWS");
  assert.match(dom.window.document.body.textContent, /ROUTING::MARKET NEWS/);
  transition.hide();
  assert.equal(dom.window.document.querySelector(".route-xn"), null);
});
```

- [ ] **Step 2: Run the transition test and confirm the red state**

Run: `node --test tests/unit/transition-controller.test.js`

Expected: FAIL because the transition controller does not exist.

- [ ] **Step 3: Port the existing route transition into the controller**

Reuse `.route-xn`, `.route-xn-glitch`, `.route-xn-title`, `.route-xn-buffer`, and `.route-xn-bar` markup and timings. `show(title)` replaces an existing overlay rather than stacking another. `hide()` is idempotent.

- [ ] **Step 4: Run the transition test and confirm green**

Run: `node --test tests/unit/transition-controller.test.js`

Expected: 1 passing test, 0 failures.

- [ ] **Step 5: Write failing navigation tests**

```js
test("navigate swaps the fragment and pushes clean history", async () => {
  const dom = new JSDOM('<main data-main><section data-route-view>HOME</section></main>', { url: "http://localhost/home" });
  const calls = [];
  const controller = createNavigationController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return new Response('<section data-route-view>MARKET NEWS</section>', {
        status: 200,
        headers: { "X-Synergy-Module-Path": "/market-news", "X-Synergy-Module-Title": "MARKET NEWS", "X-Synergy-Module-Key": "market-news" },
      });
    },
    transition: { show() {}, hide() {}, fail() {} },
    initializePage() {},
  });
  await controller.navigate("/market-news");
  assert.equal(calls[0].headers["X-Synergy-Module-Fragment"], "1");
  assert.match(dom.window.document.querySelector("[data-main]").textContent, /MARKET NEWS/);
  assert.equal(dom.window.location.pathname, "/market-news");
});
```

Add tests for `401` redirect, non-OK failure preserving current content, `popstate` without `pushState`, and stale-request cancellation.

- [ ] **Step 6: Run navigation tests and confirm the red state**

Run: `node --test tests/unit/navigation-controller.test.js`

Expected: FAIL because the controller does not exist.

- [ ] **Step 7: Implement navigation, shell initialization, spheres, clock, and drawer delegation**

Intercept unmodified left clicks on same-origin anchors carrying `data-nav-link`. Ignore downloads, external links, hashes, modifier clicks, and targets. Keep the old route mounted until a successful response passes the `[data-route-view]` check. Use an `AbortController` per navigation. On failure, call `transition.fail("ROUTE LOAD FAILED :: CURRENT BUFFER RETAINED")`.

Port `buildSphereFrame`, clock/uptime updates, nav active state, drawer toggle, scrim close, and event delegation into focused modules. `app-shell.js` composes them once per document.

- [ ] **Step 8: Run Task 4 unit and integration tests**

Run: `node --test tests/unit/transition-controller.test.js tests/unit/navigation-controller.test.js tests/integration/page-routes.test.js`

Expected: all tests pass with 0 failures.

- [ ] **Step 9: Commit if a Git repository exists**

```powershell
git add public/js tests/unit
git commit -m "feat: add seamless glitch navigation"
```

---

### Task 5: Implement the cinematic login and logout flow

**Files:**
- Create: `public/js/login-sequence.js`
- Create: `public/js/matrix-renderer.js`
- Create: `public/js/login-controller.js`
- Modify: `public/js/app-shell.js`
- Modify: `views/layouts/login.ejs`
- Modify: `views/partials/sidebar.ejs`
- Create: `tests/unit/login-sequence.test.js`

**Interfaces:**
- Produces: `AUTH_LINES` with the six existing handshake messages.
- Produces: `runLoginSequence({ reducedMotion, delay, onLine, onGrant, onComplete }) -> Promise<void>`.
- Produces: `startMatrix(canvas) -> () => void` cleanup function.
- Consumes: `POST /auth/login` and `POST /auth/logout` from Task 1.

- [ ] **Step 1: Write failing login-sequence tests**

```js
test("login sequence emits every handshake line before grant and completion", async () => {
  const events = [];
  await runLoginSequence({
    reducedMotion: true,
    delay: async () => {},
    onLine: (line) => events.push(line),
    onGrant: () => events.push("ACCESS GRANTED"),
    onComplete: () => events.push("COMPLETE"),
  });
  assert.deepEqual(events, [...AUTH_LINES, "ACCESS GRANTED", "COMPLETE"]);
});
```

- [ ] **Step 2: Run the sequence test and confirm the red state**

Run: `node --test tests/unit/login-sequence.test.js`

Expected: FAIL because the sequence module does not exist.

- [ ] **Step 3: Implement the sequence and matrix renderer**

Preserve the existing six lines and normal timings: `230ms` per line, `360ms` before grant, and `1700ms` matrix/grant display. Preserve reduced-motion timings: `80ms`, `140ms`, and `650ms`. Port the current matrix character set, color choices, drop behavior, and resize handling. The cleanup function cancels animation and removes its resize listener.

- [ ] **Step 4: Run the sequence test and confirm green**

Run: `node --test tests/unit/login-sequence.test.js`

Expected: 1 passing test, 0 failures.

- [ ] **Step 5: Implement the login controller**

On submit, POST JSON credentials. For `400`, render `> ERR :: CREDENTIALS REQUIRED — USER AND PASSKEY` and apply the existing shake class. For success, replace the form with the auth stream, call `runLoginSequence`, render `ACCESS GRANTED` over the matrix canvas, then set `window.location.href` to `redirectTo`.

- [ ] **Step 6: Implement logout without visual dead time**

The sidebar logout button POSTs `/auth/logout`; on success, navigate to `/login`. Disable repeat submissions while the request is active and surface a terminal toast on network failure.

- [ ] **Step 7: Run authentication and login unit tests**

Run: `node --test tests/unit/login-sequence.test.js tests/unit/auth-service.test.js tests/integration/auth-routes.test.js`

Expected: all tests pass with 0 failures.

- [ ] **Step 8: Commit if a Git repository exists**

```powershell
git add public/js views tests/unit/login-sequence.test.js
git commit -m "feat: preserve cinematic login flow"
```

---

### Task 6: Extract the journal domain, local repository, and page controller

**Files:**
- Create: `public/js/journal/journal-entry.js`
- Create: `public/js/journal/local-storage-journal-repository.js`
- Create: `public/js/journal/journal-service.js`
- Create: `public/js/journal/journal-page-controller.js`
- Modify: `public/js/app-shell.js`
- Modify: `views/pages/journal-index.ejs`
- Modify: `views/pages/journal-new.ejs`
- Modify: `views/pages/journal-public.ejs`
- Create: `tests/unit/journal-entry.test.js`
- Create: `tests/unit/journal-repository.test.js`

**Interfaces:**
- Produces: `calculateProfitLoss({ direction, entryPrice, exitPrice }) -> string`.
- Produces: `createJournalEntry(input, { id, createdAt }) -> JournalEntry`.
- Produces: `LocalStorageJournalRepository(storage, key = "synergy-module.journal.v1")` with `list()`, `find(id)`, `create(entry)`, and `clear()`.
- Produces: `createJournalService(repository, clock, idFactory)` with `list()`, `find(id)`, and `create(input)`.
- Produces: `initializeJournalPage(root, service)` called after full or fragment render.

- [ ] **Step 1: Write failing journal domain tests**

```js
test("P&L follows direction and formats two decimals", () => {
  assert.equal(calculateProfitLoss({ direction: "long", entryPrice: "100", exitPrice: "103.5" }), "+3.50");
  assert.equal(calculateProfitLoss({ direction: "short", entryPrice: "100", exitPrice: "103.5" }), "-3.50");
});

test("entry creation normalizes defaults and preserves confluences", () => {
  const entry = createJournalEntry(
    { direction: "long", entryTime: "", entryPrice: "100", exitPrice: "101", notes: " test ", confluences: ["FVG"], screenshotCount: 2 },
    { id: "entry-1", createdAt: "2026-09-01T00:00:00.000Z" },
  );
  assert.deepEqual(entry, {
    id: "entry-1", direction: "long", entryTime: "--", entryPrice: "100", exitPrice: "101",
    pl: "+1.00", notes: " test ", confluences: ["FVG"], screenshotCount: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
});
```

- [ ] **Step 2: Run journal domain tests and confirm the red state**

Run: `node --test tests/unit/journal-entry.test.js`

Expected: FAIL because the journal domain module does not exist.

- [ ] **Step 3: Implement the journal domain and confirm green**

Port the current long/short calculation, default strings, confluence copy, screenshot count, and created timestamp exactly. Run `node --test tests/unit/journal-entry.test.js`; expected 2 passing tests.

- [ ] **Step 4: Write failing repository tests**

Use a fake storage object. Assert newest-first insertion, lookup by string ID, preservation of the existing storage key, and malformed JSON fallback to `[]`.

```js
test("malformed persisted data falls back to an empty journal", () => {
  const storage = fakeStorage({ "synergy-module.journal.v1": "{" });
  const repository = new LocalStorageJournalRepository(storage);
  assert.deepEqual(repository.list(), []);
});
```

- [ ] **Step 5: Run repository tests and confirm the red state**

Run: `node --test tests/unit/journal-repository.test.js`

Expected: FAIL because the repository does not exist.

- [ ] **Step 6: Implement repository, service, and journal page hydration**

Use data hooks rather than route-specific global listeners. The page controller must support direction toggles, confluence add/remove, screenshot count, draft toast, submit, list rendering, and public entry rendering. On submit, save through the service and call the shared navigator with `/journal/${entry.id}` so the glitch transition still plays.

- [ ] **Step 7: Run all journal tests**

Run: `node --test tests/unit/journal-entry.test.js tests/unit/journal-repository.test.js`

Expected: all tests pass with 0 failures.

- [ ] **Step 8: Commit if a Git repository exists**

```powershell
git add public/js/journal public/js/app-shell.js views/pages tests/unit/journal-*.test.js
git commit -m "feat: extract journal model and repository"
```

---

### Task 7: Complete remaining interactions, error paths, documentation, and verification

**Files:**
- Create: `public/js/page-interactions.js`
- Create: `views/pages/error.ejs`
- Modify: `public/js/app-shell.js`
- Modify: `src/app.js`
- Modify: `README.md`
- Create: `reference/static-original/index.html`
- Create: `reference/static-original/app.js`
- Create: `reference/static-original/styles.css`
- Create: `reference/static-original/favicon.ico`
- Create: `tests/integration/error-routes.test.js`
- Create: `tests/unit/page-interactions.test.js`

**Interfaces:**
- Produces: `initializePageInteractions(root, { showToast })` for news filters, alert standby buttons, copy actions, and page-local controls.
- Produces: production-safe full-page and fragment error responses.
- Consumes: shared navigator and toast utility from Task 4.

- [ ] **Step 1: Write failing interaction and error tests**

Use JSDOM to click `ALL`, `RED`, and `ORANGE` chips and assert one active state at a time. Assert alert buttons produce the exact current messages. Integration tests assert unknown full requests return the terminal error page with status `404`, unknown fragment requests return status `404` without the full shell, and thrown server errors omit stack traces when `NODE_ENV=production`.

- [ ] **Step 2: Run interaction and error tests and confirm the red state**

Run: `node --test tests/unit/page-interactions.test.js tests/integration/error-routes.test.js`

Expected: FAIL because the interaction module and error views are not implemented.

- [ ] **Step 3: Implement page interactions and safe error rendering**

Port current market-news chip behavior, alert standby toasts, copy toast, nav drawer behavior, and route-specific initialization. Use event delegation so fragment swaps do not accumulate handlers. Error middleware logs server details locally but renders only terminal-safe copy.

- [ ] **Step 4: Archive the static reference without losing it**

Create `reference/static-original/` and copy the original `index.html`, `app.js`, `styles.css`, and `favicon.ico` there. Keep those files unchanged as the accepted reference until the MVC app completes visual verification. After verification, remove the root static entry files so `npm start` is the canonical application entry point; retain the archived copies.

- [ ] **Step 5: Rewrite the README for MVC operation**

Document:

```text
npm install
npm run dev
npm test
npm start
```

List the clean routes, current demo authentication, later Discord boundary, current local journal repository, later PostgreSQL boundary, and the full/fragment navigation architecture.

- [ ] **Step 6: Run the complete automated test suite**

Run: `npm test`

Expected: exit code `0`, 0 failed tests.

- [ ] **Step 7: Start the MVC app and verify HTTP behavior**

Stop the old static server only after its files are archived. Start the MVC app on the requested local host and port:

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4173"
npm start
```

Verify `/login`, authenticate, then verify all clean routes return `200`. Confirm asset requests return `200` and server output contains no unhandled exceptions.

- [ ] **Step 8: Perform Browser/IAB rendered QA**

The flow under test is: `/login` -> enter demo credentials -> handshake and matrix -> `/home` -> navigate through every sidebar route -> create a journal entry -> public entry -> browser back/forward -> logout.

Required evidence:

- Page URL/title and meaningful DOM for login and dashboard.
- Empty login rejection.
- Visible handshake lines, `ACCESS GRANTED`, and matrix frame.
- Route overlay observed during at least one navigation and correct destination afterward.
- Direct refresh of `/market-news` and `/journal`.
- Journal P&L and persistence after refresh.
- News filter selected-state change and alert toast.
- Desktop viewport, current viewport, and mobile viewport under `880px`.
- No framework overlay and no relevant console warnings/errors.
- Screenshots of login, dashboard, route transition/destination, journal public record, and mobile drawer.

- [ ] **Step 9: Compare the MVC render with the archived static reference**

Serve `reference/static-original/` on a separate local port and capture matching screenshots. Inspect both reference and MVC screenshots with `view_image`. Record a fidelity ledger with at least these comparison points: copy, shell geometry, typography, palette/CRT overlays, spacing/panels, ASCII sphere, transition timing, login matrix, and responsive sidebar. Fix all material drift and rerun the affected tests and browser flow.

- [ ] **Step 10: Run final verification after all fixes**

Run fresh:

```powershell
npm test
npm start
```

Confirm the server listens on `http://127.0.0.1:4173`, then rerun the login, route-transition, journal, history, console, and responsive browser checks. Do not claim completion from an earlier run.

- [ ] **Step 11: Commit if a Git repository exists**

```powershell
git add .
git commit -m "feat: complete synergy-module express mvc rebuild"
```
