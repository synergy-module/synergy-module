import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createNavigationController } from "../../public/js/navigation-controller.js";
import { createTransitionController } from "../../public/js/transition-controller.js";

function fragment(body, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "X-Synergy-Module-Path": "/market-news",
      "X-Synergy-Module-Title": "MARKET NEWS",
      "X-Synergy-Module-Key": "market-news",
      ...headers,
    },
  });
}

function createHarness({ fetchImpl, html = "<main data-main><section data-route-view>HOME</section></main>" } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost/home" });
  const transitionCalls = [];
  const initialized = [];
  const toasts = [];
  const controller = createNavigationController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl,
    transition: {
      show: (title) => transitionCalls.push(["show", title]),
      hide: () => transitionCalls.push(["hide"]),
      fail: (message) => transitionCalls.push(["fail", message]),
    },
    initializePage: (root, details) => initialized.push({ root, details }),
    showToast: (message) => toasts.push(message),
  });
  return { dom, controller, transitionCalls, initialized, toasts };
}

test("navigate swaps the fragment and pushes clean history", async () => {
  const calls = [];
  const { dom, controller, initialized } = createHarness({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return fragment("<section data-route-view>MARKET NEWS</section>");
    },
  });

  await controller.navigate("/market-news");

  assert.equal(calls[0].headers["X-Synergy-Module-Fragment"], "1");
  assert.match(dom.window.document.querySelector("[data-main]").textContent, /MARKET NEWS/);
  assert.equal(dom.window.location.pathname, "/market-news");
  assert.equal(initialized[0].details.key, "market-news");
});

test("the routing overlay remains mounted through the fragment swap until its delayed hide", async () => {
  const dom = new JSDOM("<main data-main><section data-route-view>HOME</section></main>", { url: "http://localhost/home" });
  dom.window.matchMedia = () => ({ matches: true });
  const transition = createTransitionController({ documentRef: dom.window.document, reducedMotion: true });
  const controller = createNavigationController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async () => fragment("<section data-route-view>MARKET NEWS</section>"),
    transition,
    initializePage() {},
  });

  await controller.navigate("/market-news");

  assert.match(dom.window.document.querySelector("[data-main]").textContent, /MARKET NEWS/);
  assert.ok(dom.window.document.querySelector(".route-xn"));
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(dom.window.document.querySelector(".route-xn"), null);
});

test("fragment metadata replaces immediate routing feedback with exact nontrivial route titles", async () => {
  let resolveFragment;
  const dom = new JSDOM("<main data-main><section data-route-view>HOME</section></main>", { url: "http://localhost/home" });
  dom.window.matchMedia = () => ({ matches: true });
  const calls = [];
  const controller = createNavigationController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: () => new Promise((resolve) => { resolveFragment = resolve; }),
    transition: { show: (title) => calls.push(title), hide() {}, fail() {} },
    initializePage() {},
  });

  const navigation = controller.navigate("/alerts/support-resistance");
  assert.deepEqual(calls, ["ROUTING"]);
  resolveFragment(fragment("<section data-route-view>ALERTS</section>", {
    "X-Synergy-Module-Title": "ALERTS :: S&R",
    "X-Synergy-Module-Key": "alerts-sr",
  }));
  await navigation;

  assert.equal(calls.at(-1), "ALERTS :: S&R");
});

test("fragment metadata preserves exact titles for new and public journal routes", async () => {
  const titles = ["NEW JOURNAL ENTRY", "PUBLIC JOURNAL ENTRY"];
  let call = 0;
  const dom = new JSDOM("<main data-main><section data-route-view>HOME</section></main>", { url: "http://localhost/home" });
  dom.window.matchMedia = () => ({ matches: true });
  const shownTitles = [];
  const controller = createNavigationController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async () => fragment("<section data-route-view>JOURNAL</section>", {
      "X-Synergy-Module-Title": titles[call++],
    }),
    transition: { show: (title) => shownTitles.push(title), hide() {}, fail() {} },
    initializePage() {},
  });

  await controller.navigate("/journal/new");
  await controller.navigate("/journal/entry-1");

  assert.deepEqual(shownTitles.filter((title) => title !== "ROUTING"), titles);
});

test("a successful fragment swap resets the main pane scroll position", async () => {
  const { dom, controller } = createHarness({
    fetchImpl: async () => fragment("<section data-route-view>MARKET NEWS</section>"),
  });
  const main = dom.window.document.querySelector("[data-main]");
  main.scrollTop = 180;

  await controller.navigate("/market-news");

  assert.equal(main.scrollTop, 0);
});

test("a 401 preserves a validated relative login URL without replacing the current route", async () => {
  const dom = new JSDOM("<main data-main><section data-route-view>HOME</section></main>", { url: "http://localhost/home" });
  const redirects = [];
  const windowRef = {
    ...dom.window,
    location: { href: dom.window.location.href, assign: (path) => redirects.push(path) },
    history: dom.window.history,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
  };
  const controller = createNavigationController({
    documentRef: dom.window.document,
    windowRef,
    fetchImpl: async () => Response.json({
      error: "AUTH_REQUIRED",
      loginUrl: "/login?error=access_revoked",
    }, { status: 401 }),
    transition: { show() {}, hide() {}, fail() {} },
    initializePage() {},
  });

  await controller.navigate("/market-news");

  assert.deepEqual(redirects, ["/login?error=access_revoked"]);
  assert.match(dom.window.document.querySelector("[data-main]").textContent, /HOME/);
});

test("a 401 rejects unsafe or unknown login URLs", async () => {
  for (const loginUrl of [
    "https://evil.example/login",
    "//evil.example/login",
    "/admin",
    "/login?error=arbitrary",
    "/login?error=access_revoked&next=https://evil.example",
  ]) {
    const dom = new JSDOM("<main data-main><section data-route-view>HOME</section></main>", { url: "http://localhost/home" });
    const redirects = [];
    const windowRef = {
      ...dom.window,
      location: { href: dom.window.location.href, assign: (path) => redirects.push(path) },
      history: dom.window.history,
      addEventListener: dom.window.addEventListener.bind(dom.window),
      removeEventListener: dom.window.removeEventListener.bind(dom.window),
    };
    const controller = createNavigationController({
      documentRef: dom.window.document,
      windowRef,
      fetchImpl: async () => Response.json({ error: "AUTH_REQUIRED", loginUrl }, { status: 401 }),
      transition: { show() {}, hide() {}, fail() {} },
      initializePage() {},
    });

    await controller.navigate("/market-news");

    assert.deepEqual(redirects, ["/login"]);
    controller.dispose();
    dom.window.close();
  }
});

test("a denied navigation holds the overlay, reports permission failure, and retains route history", async () => {
  const { dom, controller, transitionCalls, toasts } = createHarness({
    fetchImpl: async () => Response.json({
      error: "INSUFFICIENT_PERMISSIONS",
      message: "ACCESS FAILED :: INSUFFICIENT PERMISSIONS",
    }, { status: 403 }),
  });
  dom.window.matchMedia = () => ({ matches: true });
  const originalPath = dom.window.location.pathname;
  const originalTitle = dom.window.document.title;
  const startedAt = Date.now();

  await controller.navigate("/admin");

  assert.ok(Date.now() - startedAt >= 110, "reduced-motion denial must retain its loading state for about 120ms");
  assert.equal(dom.window.location.pathname, originalPath);
  assert.equal(dom.window.document.title, originalTitle);
  assert.match(dom.window.document.querySelector("[data-main]").textContent, /HOME/);
  assert.deepEqual(transitionCalls.at(-1), ["fail", "ACCESS FAILED :: INSUFFICIENT PERMISSIONS"]);
  assert.deepEqual(toasts, ["ACCESS FAILED :: INSUFFICIENT PERMISSIONS"]);
});

test("a 404 fragment retains current content and reports terminal route-not-found feedback", async () => {
  const { dom, controller, transitionCalls, toasts } = createHarness({
    fetchImpl: async () => new Response("missing", { status: 404 }),
  });

  await controller.navigate("/missing-terminal-route");

  assert.match(dom.window.document.querySelector("[data-main]").textContent, /HOME/);
  assert.deepEqual(transitionCalls.at(-1), ["fail", "ROUTE LOAD FAILED :: CURRENT BUFFER RETAINED"]);
  assert.deepEqual(toasts, ["ROUTE NOT FOUND :: CURRENT BUFFER RETAINED"]);
});

test("a 5xx fragment retains current content and reports retryable system feedback", async () => {
  const { dom, controller, toasts } = createHarness({
    fetchImpl: async () => new Response("server error", { status: 500 }),
  });

  await controller.navigate("/market-news");

  assert.match(dom.window.document.querySelector("[data-main]").textContent, /HOME/);
  assert.deepEqual(toasts, ["SYSTEM ERROR :: RETRY ROUTE"]);
});

test("network and malformed-success failures retain content and report retryable system feedback", async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError("network offline"); },
    async () => fragment("<div>not a route fragment</div>"),
  ]) {
    const { dom, controller, toasts } = createHarness({ fetchImpl });
    await controller.navigate("/market-news");
    assert.match(dom.window.document.querySelector("[data-main]").textContent, /HOME/);
    assert.deepEqual(toasts, ["SYSTEM ERROR :: RETRY ROUTE"]);
  }
});

test("real transition controller receives metadata through setTitle without creating markup", async () => {
  const dom = new JSDOM("<main data-main><section data-route-view>HOME</section></main>", { url: "http://localhost/home" });
  dom.window.matchMedia = () => ({ matches: true });
  const transition = createTransitionController({ documentRef: dom.window.document, reducedMotion: true });
  const controller = createNavigationController({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async () => fragment("<section data-route-view>NEWS</section>", {
      "X-Synergy-Module-Title": "MARKET <img src=x onerror=alert(1)>",
    }),
    transition,
    initializePage() {},
    showToast() {},
  });

  await controller.navigate("/market-news");

  const overlay = dom.window.document.querySelector(".route-xn");
  assert.equal(overlay.querySelector("img"), null);
  assert.match(overlay.querySelector(".route-xn-title").textContent, /MARKET <img src=x onerror=alert\(1\)>/);
});

test("popstate loads the fragment without pushing another history entry", async () => {
  const { dom, controller } = createHarness({
    fetchImpl: async () => fragment("<section data-route-view>MARKET NEWS</section>"),
  });
  let pushes = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (...args) => {
    pushes += 1;
    return originalPush(...args);
  };

  dom.window.history.pushState({}, "", "/market-news");
  pushes = 0;
  dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(pushes, 0);
  assert.match(dom.window.document.querySelector("[data-main]").textContent, /MARKET NEWS/);
  controller.dispose();
});

test("a newer navigation aborts the stale request and only mounts the latest fragment", async () => {
  let resolveFirst;
  const requests = [];
  const { dom, controller } = createHarness({
    fetchImpl: (url, options) => {
      requests.push({ url: String(url), signal: options.signal });
      if (requests.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve(fragment("<section data-route-view>JOURNAL</section>", {
        "X-Synergy-Module-Path": "/journal",
        "X-Synergy-Module-Title": "JOURNAL",
        "X-Synergy-Module-Key": "journal",
      }));
    },
  });

  const first = controller.navigate("/market-news");
  const second = controller.navigate("/journal");
  resolveFirst(fragment("<section data-route-view>STALE</section>"));
  await Promise.all([first, second]);

  assert.equal(requests[0].signal.aborted, true);
  assert.match(dom.window.document.querySelector("[data-main]").textContent, /JOURNAL/);
  assert.doesNotMatch(dom.window.document.querySelector("[data-main]").textContent, /STALE/);
});

test("click delegation ignores modified, external, hash, download, and targeted links", () => {
  const calls = [];
  const { dom, controller } = createHarness({
    html: `<main data-main><section data-route-view>HOME</section><a id="local" href="/market-news" data-nav-link>local</a><a id="hash" href="#x" data-nav-link>hash</a><a id="download" href="/market-news" data-nav-link download>download</a><a id="target" href="/market-news" data-nav-link target="_blank">target</a><a id="external" href="https://example.com" data-nav-link>external</a></main>`,
    fetchImpl: async (url) => { calls.push(String(url)); return fragment("<section data-route-view>MARKET NEWS</section>"); },
  });
  dom.window.document.addEventListener("click", (event) => event.preventDefault());

  for (const id of ["hash", "download", "target", "external"]) {
    dom.window.document.querySelector(`#${id}`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  dom.window.document.querySelector("#local").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  dom.window.document.querySelector("#local").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

  assert.deepEqual(calls, ["/market-news"]);
  controller.dispose();
});
