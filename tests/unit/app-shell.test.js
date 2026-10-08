import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { initializeAppShell } from "../../public/js/app-shell.js";

const homeFragment = `
  <section data-route-view data-route-key="home">
    <div class="stat-value muted" data-journal-count>0</div>
  </section>`;

const marketNewsFragment = `
  <section data-route-view data-route-key="market-news" data-market-news data-calendar-state="live">
    <span data-calendar-timezone>TIMES UTC</span>
    <button data-calendar-refresh></button>
    <span data-calendar-count>0</span>
    <span data-calendar-status></span>
    <time data-calendar-updated></time>
    <div data-calendar-events></div>
    <div data-calendar-empty hidden></div>
    <div data-calendar-filter-empty hidden></div>
    <div data-calendar-offline hidden></div>
  </section>`;

const indicatorFragment = `
  <section data-route-view data-route-key="indicators" data-indicator-access-root data-request-status="NOT_REQUESTED">
    <output data-indicator-request-status>NOT REQUESTED</output>
    <form data-indicator-request-form>
      <input name="_csrf" value="csrf-token">
      <input name="tradingViewUsername" value="synergy_module_tv">
      <input name="consent" type="checkbox" value="true" checked>
      <button type="submit" data-indicator-submit>REQUEST</button>
    </form>
    <output data-indicator-request-feedback></output>
  </section>`;

const adminFragment = `
  <section data-route-view data-route-key="admin" data-admin-root data-current-user-id="7" aria-busy="false">
    <ol data-admin-users>
      <li data-admin-user-row data-user-id="42" data-user-banned="false" data-active-sessions="1">
        <output data-admin-ban-state>ALLOWED</output><strong data-admin-session-count>1</strong>
        <form><input name="_csrf" value="csrf-token"><button type="submit" data-admin-action="sign-out"
          data-admin-action-endpoint="/api/admin/users/42/sign-out" data-admin-confirm="SIGN OUT?">SIGN OUT</button></form>
      </li>
    </ol>
    <output data-admin-feedback></output>
  </section>`;

test("home journal count hydrates from the shared journal service after full and fragment renders", async () => {
  const dom = new JSDOM(`<div data-app-shell data-shell-body><main data-main>${homeFragment}</main></div>`, {
    url: "http://localhost/home",
  });
  dom.window.matchMedia = () => ({ matches: true });
  let entries = [{ id: "shared-1", direction: "long" }];
  const instance = initializeAppShell({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async () => new Response(homeFragment, {
      status: 200,
      headers: {
        "X-Synergy-Module-Path": "/home",
        "X-Synergy-Module-Title": "DASHBOARD",
        "X-Synergy-Module-Key": "home",
      },
    }),
    journalService: { list: () => entries },
  });

  const initialCount = dom.window.document.querySelector("[data-journal-count]");
  assert.equal(initialCount.textContent, "1");
  assert.equal(initialCount.classList.contains("muted"), false);

  entries = [{ id: "shared-1", direction: "long" }, { id: "shared-2", direction: "short" }];
  await instance.navigator.navigate("/home");

  const fragmentCount = dom.window.document.querySelector("[data-journal-count]");
  assert.equal(fragmentCount.textContent, "2");
  assert.equal(fragmentCount.classList.contains("muted"), false);
  instance.dispose();
  dom.window.close();
});

test("home journal count retains accepted muted styling at zero", () => {
  const dom = new JSDOM(`<div data-app-shell data-shell-body><main data-main>${homeFragment}</main></div>`, { url: "http://localhost/home" });
  dom.window.matchMedia = () => ({ matches: true });
  const instance = initializeAppShell({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async () => new Response(),
    journalService: { list: () => [] },
  });

  const count = dom.window.document.querySelector("[data-journal-count]");
  assert.equal(count.textContent, "0");
  assert.equal(count.classList.contains("muted"), true);
  instance.dispose();
  dom.window.close();
});

test("navigating away from Market News clears its scheduled refresh", async (t) => {
  const dom = new JSDOM(`<div data-app-shell data-shell-body><main data-main>${marketNewsFragment}</main></div>`, {
    url: "http://localhost/market-news",
  });
  dom.window.matchMedia = () => ({ matches: true });
  const intervals = [];
  const cleared = [];
  const setInterval = dom.window.setInterval.bind(dom.window);
  const clearInterval = dom.window.clearInterval.bind(dom.window);
  dom.window.setInterval = (callback, delay) => {
    const id = setInterval(callback, delay);
    intervals.push({ id, delay });
    return id;
  };
  dom.window.clearInterval = (id) => {
    cleared.push(id);
    clearInterval(id);
  };
  const instance = initializeAppShell({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async () => new Response(homeFragment, {
      status: 200,
      headers: {
        "X-Synergy-Module-Path": "/home",
        "X-Synergy-Module-Title": "DASHBOARD",
        "X-Synergy-Module-Key": "home",
      },
    }),
  });
  t.after(() => {
    instance.dispose();
    dom.window.close();
  });
  const refreshInterval = intervals.find(({ delay }) => delay === 60_000);

  await instance.navigator.navigate("/home");

  assert.ok(refreshInterval);
  assert.equal(cleared.includes(refreshInterval.id), true);
});

test("logout sends the authenticated page CSRF token", async (t) => {
  const dom = new JSDOM(`
    <meta name="csrf-token" content="csrf-from-session">
    <div data-app-shell data-shell-body><button data-logout></button><main data-main>${homeFragment}</main></div>
  `, { url: "http://localhost/home" });
  dom.window.matchMedia = () => ({ matches: true });
  let requestOptions;
  const instance = initializeAppShell({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response(JSON.stringify({ ok: false }), { status: 403, headers: { "Content-Type": "application/json" } });
    },
  });
  t.after(() => {
    instance.dispose();
    dom.window.close();
  });

  dom.window.document.querySelector("[data-logout]").click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(requestOptions.headers["X-CSRF-Token"], "csrf-from-session");
});

test("retired indicator markup cannot issue new requests through the app shell", async (t) => {
  const dom = new JSDOM(`<div data-app-shell data-shell-body><main data-main>${indicatorFragment}</main></div>`, {
    url: "http://localhost/indicators",
  });
  dom.window.matchMedia = () => ({ matches: true });
  let requestOptions;
  const instance = initializeAppShell({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response(JSON.stringify({ ok: true, request: { status: "PENDING" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  t.after(() => {
    instance.dispose();
    dom.window.close();
  });

  dom.window.document.querySelector("[data-indicator-request-form]").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(requestOptions, undefined);
  assert.equal(dom.window.document.querySelector("[data-indicator-request-status]").textContent, "NOT REQUESTED");
});

test("Admin routes are progressively enhanced by the app shell", async (t) => {
  const dom = new JSDOM(`<div data-app-shell data-shell-body><main data-main>${adminFragment}</main></div>`, {
    url: "http://localhost/admin",
  });
  dom.window.matchMedia = () => ({ matches: true });
  dom.window.confirm = () => true;
  let requestOptions;
  const instance = initializeAppShell({
    documentRef: dom.window.document,
    windowRef: dom.window,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response(JSON.stringify({
        ok: true, user: { id: "42", banned: false, activeSessions: 0 }, selfSignedOut: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  t.after(() => {
    instance.dispose();
    dom.window.close();
  });

  dom.window.document.querySelector('[data-admin-action="sign-out"]').click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(requestOptions.method, "POST");
  assert.equal(dom.window.document.querySelector("[data-admin-session-count]").textContent, "0");
});
