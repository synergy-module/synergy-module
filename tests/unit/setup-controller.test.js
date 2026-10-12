import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { initializeSetup } from "../../public/js/setup-controller.js";
import { createWorkspaceSettingsService } from "../../src/settings/workspace-settings-service.js";
const filename = fileURLToPath(new URL("../../views/pages/setup.ejs", import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function fixture(t, { step = "welcome", intercept = () => undefined, encryptionSecret = "a-stable-test-encryption-secret" } = {}) {
  const service = createWorkspaceSettingsService({ encryptionSecret });
  await service.saveOnboarding("alice", { step });
  const html = ejs.render(readFileSync(filename, "utf8"), { page: { operator: { displayName: "Alice" } } }, { filename });
  const dom = new JSDOM(`<meta name="csrf-token" content="test-csrf">${html}`, { url: "https://synergy.test/setup" });
  const root = dom.window.document.querySelector("[data-route-view]"), calls = [], navigations = [];
  const instance = initializeSetup(root, { navigate: (path) => navigations.push(path), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const custom = await intercept(url, options); if (custom) return custom;
    const body = options.body ? JSON.parse(options.body) : {};
    try {
      if (url === "/api/settings") return response(await service.getState("alice"));
      if (url === "/api/settings/profile") return response(await service.saveProfile("alice", body));
      if (url === "/api/settings/preferences") return response(await service.savePreferences("alice", body));
      if (url === "/api/settings/onboarding") return response(await service.saveOnboarding("alice", body));
      if (url === "/api/settings/onboarding/complete") return response(await service.completeOnboarding("alice", body));
      if (url.includes("/providers/")) return response(await service.saveProvider("alice", url.split("/").at(-1), body));
      return response({ configured: false, connected: false });
    } catch (error) { return response({ message: error.message }, error.status || 500); }
  } });
  t.after(() => { instance.dispose(); dom.window.close(); });
  await tick();
  return { root, dom, instance, calls, navigations, service, find: (name) => root.querySelector(`[data-setup-${name}]`), submit: (form) => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) };
}

test("first-run setup persists each step, allows optional connections and completes only after acknowledgment", async (t) => {
  const app = await fixture(t);
  app.submit(app.find("welcome")); await tick();
  assert.equal(app.root.querySelector('[data-setup-step="connections"]').hidden, false);
  assert.equal((await app.service.getExperience("alice")).profile.displayName, "Alice");
  app.root.querySelector('[data-setup-next="preferences"]').click(); await tick();
  const form = app.find("preferences"); form.elements.theme.value = "light"; form.elements.defaultLanding.value = "/practice";
  app.submit(form); await tick();
  assert.equal(app.find("review").hidden, false);
  app.submit(app.find("review")); await tick();
  assert.deepEqual(app.navigations, []);
  app.find("review").elements.acknowledgedPracticeIsolation.checked = true;
  app.submit(app.find("review")); await tick();
  assert.deepEqual(app.navigations, ["/practice"]);
  assert.equal((await app.service.getExperience("alice")).preferences.theme, "light");
  assert.ok((await app.service.getExperience("alice")).onboarding.completedAt);
  for (const call of app.calls.filter((item) => item.options.method !== "GET")) assert.equal(call.options.headers["X-CSRF-Token"], "test-csrf");
});

test("saved setup resumes and secrets are cleared after save and disposal", async (t) => {
  const app = await fixture(t, { step: "connections" });
  assert.equal(app.root.querySelector('[data-setup-step="connections"]').hidden, false);
  const form = app.find("ai"); form.elements.apiKey.value = "test-provider-secret";
  app.submit(form); await tick();
  assert.equal(form.elements.apiKey.value, "");
  assert.doesNotMatch(app.root.textContent, /test-provider-secret/);
  assert.equal(app.dom.window.localStorage.length, 0);
  form.elements.apiKey.value = "second-secret";
  app.find("poly").elements.secretKey.value = "poly-secret";
  app.instance.dispose();
  assert.equal(form.elements.apiKey.value, "");
  assert.equal(app.find("poly").elements.secretKey.value, "");
});

test("a failed setup save stays on the current step and preserves the entered name", async (t) => {
  const app = await fixture(t, { intercept: (url) => url === "/api/settings/profile" ? response({ message: "Storage unavailable" }, 503) : undefined });
  app.find("welcome").elements.displayName.value = "New display name";
  app.submit(app.find("welcome")); await tick();
  assert.equal(app.find("welcome").hidden, false);
  assert.equal(app.find("welcome").elements.displayName.value, "New display name");
  assert.match(app.find("feedback").textContent, /Storage unavailable/);
  assert.equal(app.find("welcome").querySelector('[type="submit"]').disabled, false);
});

test("setup completes without AI, broker, agent token or encryption configuration", async (t) => {
  const app = await fixture(t, { encryptionSecret: null });
  app.submit(app.find("welcome")); await tick();
  assert.equal(app.find("ai-options").open, false, "provider key fields are collapsed by default");
  assert.equal(app.find("ai").checkValidity(), false, "the unused optional provider form may be empty");
  assert.equal(app.find("ai").querySelector('[type="submit"]').disabled, true);
  assert.equal(app.find("robinhood-connect").disabled, true);
  assert.match(app.root.textContent, /without an AI key, connected brokerage, or external-assistant token/);
  app.find("skip").click(); await tick();
  assert.equal(app.find("preferences").hidden, false);
  app.submit(app.find("preferences")); await tick();
  app.find("review").elements.acknowledgedPracticeIsolation.checked = true;
  app.submit(app.find("review")); await tick();
  assert.ok((await app.service.getExperience("alice")).onboarding.completedAt);
  assert.deepEqual(app.navigations, ["/home"]);
  assert.equal(app.calls.some(call => /providers\/|\/connect$|\/tokens/.test(call.url)), false);
});

test("invalid unsubmitted connection credentials never block the Continue setup action", async (t) => {
  const app = await fixture(t);
  app.submit(app.find("welcome")); await tick();
  app.find("ai-options").open = true;
  app.find("ai").elements.apiKey.value = "unsubmitted-key";
  app.find("ai").elements.apiKey.setCustomValidity("Invalid unsaved credential");
  app.find("poly").elements.keyId.value = "partial-entry";
  app.root.querySelector('[data-setup-next="preferences"]').click(); await tick();
  assert.equal(app.find("preferences").hidden, false);
  app.submit(app.find("preferences")); await tick();
  app.find("review").elements.acknowledgedPracticeIsolation.checked = true;
  app.submit(app.find("review")); await tick();
  assert.ok((await app.service.getExperience("alice")).onboarding.completedAt);
  assert.equal(app.calls.some(call => /providers\/|\/connect$|\/tokens/.test(call.url)), false);
});

test("Robinhood setup blockers are readable and safe while optional setup remains usable", async (t) => {
  const hostile = '<img src=x onerror="alert(1)">';
  const app = await fixture(t, { intercept: url => url === "/api/robinhood/state" ? response({ configured: false, connected: false, setup: { ready: false, checks: [{ id: "callback", label: "Return address", ready: false, message: hostile }], redirectUri: "https://synergy.test/auth/robinhood/callback", supportUrl: "javascript:alert(1)" } }) : undefined });
  assert.equal(app.find("robinhood-status").textContent, "Connection unavailable");
  assert.equal(app.root.querySelector("[data-broker-setup-help]").hidden, false);
  assert.match(app.root.querySelector("[data-broker-setup-content]").textContent, /Return address/);
  assert.equal(app.root.querySelector("[data-broker-setup-content] img"), null);
  assert.equal(app.root.querySelector("[data-broker-setup-content] a"), null);
  assert.equal(app.find("skip").disabled, false);
  const portal = app.find("poly").querySelector('a[href="https://polymarket.us/developer"]');
  assert.ok(portal); assert.match(app.find("poly").textContent, /Public prediction-market browsing and paper trading need no/);
  assert.equal(app.find("poly").querySelector('input[name="password"]'), null);
});
