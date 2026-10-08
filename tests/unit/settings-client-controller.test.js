import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { initializeSettings } from "../../public/js/settings-controller.js";

const filename = fileURLToPath(new URL("../../views/pages/settings.ejs", import.meta.url));
const template = readFileSync(filename, "utf8");
const preferences = { provider: "gemini", symbol: "SPY", timeframe: "15m", accountSize: 50000, riskPercent: .5, pointValue: 1, minRewardRisk: 2, routes: {}, limits: { maxSteps: 12, maxModelCalls: 10, maxTokens: 64000, maxDurationMs: 120000, maxCostUsd: null } };
const settings = { preferences, drafts: {}, storage: { kind: "sqlite", persistent: true }, credentialStorageAvailable: true, paidCallsEnabled: false, providers: ["gemini", "openai", "claude"].map((id) => ({ id, configured: false, source: null, model: `${id}-test` })) };
const broker = { configured: true, connected: false, missing: [] };
const readiness = { checkedAt: "2026-09-24T12:00:00Z", checks: [{ id: "credentials", label: "Provider credentials", detail: "Saved credentials have not been verified", status: "pending" }] };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, { fetch = () => undefined, search = "", windowRef } = {}) {
  const html = ejs.render(template, { page: { route: { key: "settings", title: "Settings", uri: "settings", description: "Connections and defaults" } } }, { filename });
  const dom = new JSDOM(`<meta name="csrf-token" content="test-csrf">${html}`, { url: `http://localhost/settings${search}` });
  const root = dom.window.document.querySelector("[data-route-view]"), calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return await fetch(url, options) ?? response(url === "/api/settings" ? settings : url === "/api/robinhood/state" ? broker : { readiness });
  };
  const instance = initializeSettings(root, { fetchImpl, ...(windowRef ? { windowRef } : {}) });
  t.after(() => { instance.dispose(); dom.window.close(); });
  return { root, dom, instance, calls, find: (name) => root.querySelector(`[data-${name}]`), provider: (name) => root.querySelector(`[data-provider-form="${name}"]`) };
}
const submit = (app, form) => form.dispatchEvent(new app.dom.window.Event("submit", { bubbles: true, cancelable: true }));

test("provider keys save only on explicit submit and never render a saved secret", async (t) => {
  const app = fixture(t, { fetch: (url, options) => url === "/api/settings/providers/gemini" ? response({ ...settings, providers: settings.providers.map((p) => p.id === "gemini" ? { ...p, configured: true, source: "account" } : p) }) : undefined }); await tick();
  const form = app.provider("gemini"); form.elements.apiKey.value = "fixture-key-no-provider-request";
  form.elements.apiKey.dispatchEvent(new app.dom.window.Event("input", { bubbles: true })); await tick();
  assert.equal(app.calls.length, 3, "typing does not submit or verify a credential");
  submit(app, form); await tick();
  const call = app.calls.at(-1);
  assert.equal(call.url, "/api/settings/providers/gemini"); assert.equal(call.options.method, "PUT");
  assert.deepEqual(JSON.parse(call.options.body), { apiKey: "fixture-key-no-provider-request" });
  assert.equal(call.options.headers["X-CSRF-Token"], "test-csrf");
  assert.equal(form.elements.apiKey.value, ""); assert.match(form.textContent, /Saved key/);
  assert.match(form.textContent, /No provider call was made/); assert.doesNotMatch(app.root.textContent, /fixture-key-no-provider-request/);
  assert.equal(app.dom.window.localStorage.length, 0);
  assert.equal(app.calls.filter((call) => call.options.method !== "GET").length, 1);
});

test("failed key replacement preserves the typed value and can be retried", async (t) => {
  const app = fixture(t, { fetch: (url) => url.includes("/providers/") ? response({ message: "Storage unavailable" }, 503) : undefined }); await tick();
  const form = app.provider("claude"); form.elements.apiKey.value = "keep-this-fixture-key"; submit(app, form); await tick();
  assert.equal(form.elements.apiKey.value, "keep-this-fixture-key"); assert.match(form.textContent, /Storage unavailable/);
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
});

test("repeated key submission sends one request while saving", async (t) => {
  let resolve;
  const app = fixture(t, { fetch: (url) => url.includes("/providers/") ? new Promise((complete) => { resolve = complete; }) : undefined }); await tick();
  const form = app.provider("openai"); form.elements.apiKey.value = "test-key";
  submit(app, form); submit(app, form);
  assert.equal(app.calls.filter((call) => call.url.includes("/providers/")).length, 1);
  resolve(response(settings)); await tick(); assert.equal(form.elements.apiKey.value, "");
});

test("saved defaults submit validated numeric values, routes and budget with CSRF", async (t) => {
  let payload;
  const app = fixture(t, { fetch: (url, options) => {
    if (url !== "/api/settings/preferences") return;
    payload = JSON.parse(options.body); return response({ ...settings, preferences: payload });
  } }); await tick();
  const form = app.find("settings-defaults");
  form.elements.provider.value = "claude"; form.elements.route_researcher.value = "gemini";
  form.elements.riskPercent.value = ".75"; form.elements.durationSeconds.value = "90"; form.elements.maxCostUsd.value = ".12";
  form.dispatchEvent(new app.dom.window.Event("input", { bubbles: true })); submit(app, form); await tick();
  assert.equal(payload.provider, "claude"); assert.equal(payload.routes.researcher, "gemini"); assert.equal(payload.riskPercent, .75);
  assert.equal(payload.limits.maxDurationMs, 90000); assert.equal(payload.limits.maxCostUsd, .12);
  assert.equal(app.calls.at(-1).options.method, "PATCH"); assert.match(app.find("defaults-feedback").textContent, /Defaults saved/);
});

test("failed defaults save retains edits and a provider refresh does not overwrite them", async (t) => {
  const app = fixture(t, { fetch: (url) => url === "/api/settings/preferences" ? response({ message: "Try again" }, 503) : url.includes("/providers/") ? response(settings) : undefined }); await tick();
  const defaults = app.find("settings-defaults"); defaults.elements.symbol.value = "BTC";
  defaults.dispatchEvent(new app.dom.window.Event("input", { bubbles: true })); submit(app, defaults); await tick();
  const provider = app.provider("gemini"); provider.elements.apiKey.value = "test-key"; submit(app, provider); await tick();
  assert.equal(defaults.elements.symbol.value, "BTC"); assert.match(app.find("defaults-feedback").textContent, /Try again/);
});

test("system checks run explicitly offline and render server strings as text", async (t) => {
  const hostile = '<img src=x onerror="alert(1)">'; let evaluated = false;
  const app = fixture(t, { search: "?section=system", fetch: (url) => {
    if (url === "/api/brain/evals") { evaluated = true; return response({ total: 2, failed: 1, cases: [{ name: hostile, passed: false }] }); }
    if (url === "/api/brain/state") return response({ readiness: { ...readiness, checks: [{ id: "test", label: hostile, detail: hostile, status: evaluated ? "ready" : "pending" }] } });
  } }); await tick();
  assert.equal(app.root.querySelector('[data-settings-panel="system"]').hidden, false);
  assert.equal(app.root.querySelector("img"), null); assert.match(app.find("brain-readiness-checks").textContent, /<img/);
  assert.equal(app.calls.some((call) => call.url.endsWith("/evals")), false);
  app.find("brain-evals").click(); await tick();
  assert.match(app.find("brain-eval-results").textContent, /1 \/ 2 passed/); assert.equal(app.root.querySelector("img"), null);
  assert.equal(app.find("brain-readiness-checks").firstElementChild.dataset.status, "ready");
  assert.equal(app.calls.find((call) => call.url.endsWith("/evals")).options.method, "POST");
  assert.equal(app.find("brain-evals").disabled, false);
});

test("Settings tabs support keyboard navigation without additional requests", async (t) => {
  const app = fixture(t); await tick();
  const connections = app.root.querySelector('[data-settings-tab="connections"]');
  connections.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  const defaults = app.root.querySelector('[data-settings-tab="defaults"]');
  assert.equal(defaults.getAttribute("aria-selected"), "true"); assert.equal(app.dom.window.document.activeElement, defaults);
  assert.equal(app.root.querySelector('[data-settings-panel="connections"]').hidden, true);
  assert.equal(app.calls.length, 3);
});

test("Robinhood connection rejects an unexpected OAuth destination", async (t) => {
  const redirects = [];
  const app = fixture(t, { windowRef: { location: { search: "", assign: (url) => redirects.push(url) } }, fetch: (url) => url === "/api/robinhood/connect" ? response({ authorizationUrl: "https://unexpected.example/oauth" }) : undefined }); await tick();
  app.find("connection-connect").click(); await tick();
  assert.deepEqual(redirects, []); assert.match(app.find("connection-feedback").textContent, /Unexpected Robinhood/);
});

test("late settings responses leave a disposed page unchanged", async (t) => {
  let resolve;
  const app = fixture(t, { fetch: (url) => url === "/api/settings" ? new Promise((complete) => { resolve = complete; }) : undefined });
  await tick(); app.instance.dispose(); const before = app.root.outerHTML;
  resolve(response(settings)); await tick(); assert.equal(app.root.outerHTML, before);
});

test("editing defaults while a save is pending preserves the newer unsaved values", async (t) => {
  let resolve, submitted;
  const app = fixture(t, { fetch: (url, options) => {
    if (url !== "/api/settings/preferences") return;
    submitted = JSON.parse(options.body); return new Promise((complete) => { resolve = complete; });
  } }); await tick();
  const form = app.find("settings-defaults"); form.elements.symbol.value = "BTC";
  form.dispatchEvent(new app.dom.window.Event("input", { bubbles: true })); submit(app, form);
  form.elements.symbol.value = "ETH"; form.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  resolve(response({ ...settings, preferences: submitted })); await tick();
  assert.equal(form.elements.symbol.value, "ETH");
  assert.match(app.find("defaults-feedback").textContent, /Unsaved|newer|new changes/i);
});

test("a key typed during an earlier save remains available for the next replacement", async (t) => {
  let resolve;
  const app = fixture(t, { fetch: (url) => url.includes("/providers/") ? new Promise((complete) => { resolve = complete; }) : undefined }); await tick();
  const form = app.provider("gemini"); form.elements.apiKey.value = "first-fixture-key"; submit(app, form);
  form.elements.apiKey.value = "newer-fixture-key"; form.elements.apiKey.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  resolve(response({ ...settings, providers: settings.providers.map((p) => p.id === "gemini" ? { ...p, source: "account", configured: true } : p) })); await tick();
  assert.equal(form.elements.apiKey.value, "newer-fixture-key");
  assert.match(form.querySelector("[data-provider-feedback]").textContent, /unsaved|newer|new key/i);
});
