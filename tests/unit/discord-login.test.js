import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { initializeDiscordLogin } from "../../public/js/discord-login.js";

function fixture({ response = { status: "pending" }, blocked = false, fetchImpl } = {}) {
  const dom = new JSDOM(`<div data-discord-entry>
    <a href="/auth/discord" data-discord-login>SIGN IN</a>
    <div data-discord-status></div><div data-login-error hidden></div>
    <button data-discord-cancel hidden>CANCEL</button><a data-discord-fallback hidden href="/auth/discord">SAME TAB</a>
  </div>`, { url: "http://localhost/login" });
  const windowRef = dom.window;
  const timers = new Map();
  let nextTimer = 0;
  windowRef.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  windowRef.clearTimeout = (id) => timers.delete(id);
  let popupUrl;
  let closed = 0;
  let opens = 0;
  let completions = 0;
  const requests = [];
  const popup = { opener: windowRef, close() { closed++; }, focus() {}, location: { replace(url) { popupUrl = url; } } };
  windowRef.open = (url) => { opens++; popupUrl = url; return blocked ? null : popup; };
  const controller = initializeDiscordLogin({
    documentRef: windowRef.document, windowRef,
    fetchImpl: fetchImpl ?? (async (url, options) => { requests.push({ url, options }); return Response.json(response); }),
    onComplete: () => { completions++; },
  });
  const select = (selector) => windowRef.document.querySelector(selector);
  return {
    dom, popup, requests, select, timers,
    get popupUrl() { return popupUrl; }, get closed() { return closed; },
    get opens() { return opens; }, get completions() { return completions; },
    click() { select("[data-discord-login]").click(); },
    async tick() {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === 800) ?? [];
      assert.ok(timer, "expected a scheduled status poll");
      timers.delete(id);
      await timer.callback();
    },
    dispose() { controller.dispose(); dom.window.close(); },
  };
}

test("Discord opens once in an isolated popup while the terminal remains in place", async () => {
  const f = fixture();
  try {
    f.click(); f.click();
    assert.equal(f.opens, 1);
    assert.equal(f.popup.opener, null);
    assert.match(f.popupUrl, /^\/auth\/discord\?popup=[\w-]+$/);
    assert.equal(f.dom.window.location.pathname, "/login");
    assert.equal(f.select("[data-discord-cancel]").hidden, false);
    await f.tick();
    assert.equal(f.requests[0].url, `/auth/discord/status?attempt=${f.popupUrl.split("popup=")[1]}`);
    assert.equal(f.requests[0].options.cache, "no-store");
    assert.equal(f.completions, 0);
  } finally { f.dispose(); }
});

test("popup success closes the window and starts the original terminal animation once", async () => {
  const f = fixture({ response: { status: "complete", redirectTo: "https://untrusted.example" } });
  try {
    f.click(); await f.tick();
    assert.equal(f.closed, 1);
    assert.equal(f.completions, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.dom.window.location.pathname, "/login");
  } finally { f.dispose(); }
});

test("blocked popups keep the terminal visible and offer explicit same-tab fallback", () => {
  const f = fixture({ blocked: true });
  try {
    f.click();
    assert.equal(f.dom.window.location.pathname, "/login");
    assert.equal(f.select("[data-discord-fallback]").hidden, false);
    assert.match(f.select("[data-discord-status]").textContent, /POPUP UNAVAILABLE/);
    assert.equal(f.timers.size, 0);
  } finally { f.dispose(); }
});

test("provider errors show fixed terminal messages and allow another attempt", async () => {
  const f = fixture({ response: { status: "error", error: "account_banned", message: "<script>private()</script>" } });
  try {
    f.click(); await f.tick();
    assert.equal(f.select("[data-login-error]").textContent, "ACCESS FAILED :: ACCOUNT BANNED");
    assert.equal(f.completions, 0);
    assert.equal(f.select("[data-discord-login]").getAttribute("aria-disabled"), null);
    f.click(); assert.equal(f.opens, 2);
  } finally { f.dispose(); }
});

test("cancellation ignores an in-flight result and cleans up polling", async () => {
  let release;
  const f = fixture({ fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  try {
    f.click();
    const polling = f.tick();
    f.select("[data-discord-cancel]").click();
    release(Response.json({ status: "complete" }));
    await polling;
    assert.equal(f.completions, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.closed, 1);
  } finally { f.dispose(); }
});

test("transient status failure retries without losing the popup", async () => {
  const f = fixture({ fetchImpl: async () => { throw new Error("offline"); } });
  try {
    f.click(); await f.tick();
    assert.match(f.select("[data-discord-status]").textContent, /RECONNECTING/);
    assert.equal(f.closed, 0);
    assert.equal(f.completions, 0);
    assert.equal(f.timers.size, 1);
  } finally { f.dispose(); }
});

test("an abandoned popup times out and allows a new attempt", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  try {
    f.click();
    now += 300_001;
    await f.tick();
    assert.match(f.select("[data-discord-status]").textContent, /TIMED OUT/);
    assert.equal(f.closed, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
    f.click(); assert.equal(f.opens, 2);
  } finally { f.dispose(); }
});
