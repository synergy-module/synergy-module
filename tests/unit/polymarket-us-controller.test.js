import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import ejs from "ejs";
import { initializePolymarketUs } from "../../public/js/polymarket-us-controller.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function page() {
  return new JSDOM(`<meta name="csrf-token" content="csrf-fixture">${await ejs.renderFile("views/pages/polymarket-account.ejs", {})}`, { url: "http://localhost/live/polymarket" });
}
const account = connected => ({ configured: true, connected, needsReplacement: false, connectedAt: connected ? "2026-10-12T15:30:00Z" : null,
  snapshot: connected ? { syncedAt: "2026-10-12T15:30:00Z", balances: { items: [{ currency: "USD", currentBalance: 125, buyingPower: 100, assetNotional: 25 }], observedAt: "2026-10-12T15:30:00Z" },
    positions: { items: [{ title: '<script>alert("x")</script>', netPosition: 2.5, cost: { value: 1.25, currency: "USD" } }], partial: true, observedAt: "2026-10-12T15:30:00Z" }, orders: { items: [], observedAt: "2026-10-12T15:30:00Z" }, warnings: [] } : null });

test("US connection sends CSRF, clears secret fields, renders account values as text, and disconnects", async t => {
  const dom = await page(), root = dom.window.document.querySelector("[data-poly-us]"), calls = [];
  const controller = initializePolymarketUs(root, { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json(account(url.endsWith("connect") && !url.endsWith("disconnect")));
  } });
  t.after(() => { controller.dispose(); dom.window.close(); });
  await controller.load();
  const form = root.querySelector("form"); assert.equal(form.elements.secretKey.disabled, false);
  form.elements.keyId.value = "fixture-key"; form.elements.secretKey.value = "fixture-secret";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(form.elements.secretKey.value, ""); await tick();
  assert.equal(calls[1].options.headers["X-CSRF-Token"], "csrf-fixture");
  assert.equal(JSON.parse(calls[1].options.body).secretKey, "fixture-secret");
  assert.match(root.querySelector("[data-poly-us-balances]").textContent, /\$125\.00/);
  assert.equal(root.querySelector("[data-poly-us-positions] script"), null);
  assert.match(root.querySelector("[data-poly-us-warnings]").textContent, /first 100/);
  root.querySelector("[data-poly-us-disconnect]").click(); await tick();
  assert.equal(root.querySelector("[data-poly-us-snapshot]").hidden, true);
  assert.match(root.querySelector("[data-poly-us-status]").textContent, /NOT CONNECTED/);
  controller.dispose(); assert.ok(calls.every(call => call.options.signal.aborted));
});

test("US connection errors leave credentials blank and are scoped to the account panel", async t => {
  const dom = await page(), root = dom.window.document.querySelector("[data-poly-us]");
  const controller = initializePolymarketUs(root, { fetchImpl: async url => url.endsWith("state") ? Response.json(account(false)) : Response.json({ message: "API access unavailable" }, { status: 401 }) });
  t.after(() => { controller.dispose(); dom.window.close(); });
  await controller.load(); const form = root.querySelector("form"); form.elements.secretKey.value = "fixture-secret";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.equal(form.elements.secretKey.value, "");
  assert.match(root.querySelector("[data-poly-us-feedback]").textContent, /API access unavailable/);
  assert.equal(root.querySelector("[data-poly-us-sync]").disabled, true);
});

test("US account opens independently and does not request international data", async t => {
  const dom = await page(), calls = [];
  const controller = initializePolymarketUs(dom.window.document.querySelector("[data-poly-us]"), { fetchImpl: async url => {
    calls.push(url);
    return Response.json({ ...account(false), configured: false });
  } });
  t.after(() => { controller.dispose(); dom.window.close(); });
  await controller.load();
  assert.deepEqual(calls, ["/api/polymarket/us/state"]);
  assert.equal(dom.window.document.querySelector("[data-poly-us-submit]").disabled, true);
  assert.equal(dom.window.document.querySelector('[data-poly-action="start"]'), null);
});
