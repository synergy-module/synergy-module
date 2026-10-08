import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { initializeRobinhood } from "../../public/js/brain/robinhood-controller.js";
import { orderInput } from "../helpers/robinhood-test-helpers.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const html = readFileSync(new URL("../../views/partials/robinhood-workspace.ejs", import.meta.url), "utf8");
function fixture(t, overrides = {}) {
  const dom = new JSDOM(html, { url: "https://synergy-module.test/brain" }), root = dom.window.document.querySelector("[data-robinhood]"), calls = [];
  const state = { configured: true, connected: true, paused: true, liveEnabled: false, missing: [], snapshots: [], actions: [], events: [],
    tools: ["Equities", "Options", "Crypto"].map((group, i) => ({ name: ["place_equity_order", "place_option_order", "place_crypto_order"][i], group: "Actions", kind: "order", inputSchema: orderInput })), ...overrides };
  const request = async (url, body) => {
    calls.push({ url, body });
    if (url.endsWith("/state")) return structuredClone(state);
    if (url.endsWith("/actions")) { state.actions = [{ ...body, id: "action-1", version: 1, status: "awaiting_approval", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60000, source: "operator", preview: { structuredContent: { warning: "Review this fixture" } } }]; return { action: state.actions[0] }; }
    return {};
  };
  const instance = initializeRobinhood(root, { request, windowRef: dom.window, onEvidence() {} });
  t.after(() => { instance.dispose(); dom.window.close(); });
  return { dom, root, calls, state, instance, find: (name) => root.querySelector(`[data-rh-${name}]`) };
}
test("disconnected UI gives equal market entry points and blocks calls until connection is ready", async (t) => {
  const f = fixture(t, { configured: false, connected: false, missing: ["ROBINHOOD_TOKEN_ENCRYPTION_KEY"], tools: [] }); await f.instance.open();
  assert.equal(f.root.querySelectorAll("[data-rh-market]").length, 3);
  assert.equal(f.find("connect").disabled, true); assert.equal(f.find("submit").disabled, true);
  assert.match(f.find("config").textContent, /ROBINHOOD_TOKEN_ENCRYPTION_KEY/);
  assert.equal(f.calls.length, 1);
});
test("all market cards expose their discovered order forms, and preparing never submits", async (t) => {
  const f = fixture(t); await f.instance.open();
  for (const name of ["Equities", "Options", "Crypto"]) {
    f.root.querySelector(`[data-rh-market="${name}"]`).click();
    assert.equal(f.find("group").value, name); assert.equal(f.find("fields").querySelectorAll("[data-parameter]").length, 4);
  }
  for (const field of f.find("fields").querySelectorAll("[data-parameter]")) field.value = { account_id: "fixture-agentic", symbol: "EXAMPLE", quantity: "1", limit_price: "10" }[field.dataset.parameter];
  f.find("form").elements.namedItem("reason").value = "Synthetic interface verification";
  f.find("form").dispatchEvent(new f.dom.window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.equal(f.calls.filter((call) => call.url.endsWith("/actions")).length, 1);
  assert.equal(f.calls.some((call) => call.url.endsWith("/decision")), false);
  assert.equal(f.root.querySelector('[data-rh-decision="approve"]').disabled, true);
  assert.match(f.find("actions").textContent, /Review this fixture/);
});
test("broker content is rendered as text rather than executable markup", async (t) => {
  const f = fixture(t, { actions: [{ id: "test", tool: "place_equity_order", status: "unknown", arguments: { symbol: '<img src=x onerror="alert(1)">' }, reason: "<script>bad()</script>", createdAt: new Date().toISOString() }] });
  await f.instance.open();
  assert.equal(f.find("actions").querySelector("script,img"), null);
  assert.match(f.find("actions").textContent, /<script>/);
});
