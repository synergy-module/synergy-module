import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { initializeBrainCanvas } from "../../public/js/brain/brain-canvas-controller.js";

const filename = fileURLToPath(new URL("../../views/pages/brain.ejs", import.meta.url));
const template = readFileSync(filename, "utf8");
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, fetchImpl, extra = {}) {
  const html = ejs.render(template, { page: { route: { key: "brain", title: "Brain" } } }, { filename });
  const dom = new JSDOM(`<meta name="csrf-token" content="test-csrf">${html}`, { url: "http://localhost/brain" });
  const root = dom.window.document.querySelector("[data-route-view]"), navigations = [];
  const instance = initializeBrainCanvas(root, { fetchImpl, navigate: (url) => navigations.push(url), ...extra });
  t.after(() => { instance.dispose(); dom.window.close(); });
  return { dom, root, instance, navigations };
}

test("Brain is only a network canvas and each section opens its dedicated destination", async (t) => {
  const calls = [];
  const app = fixture(t, async (url, options) => { calls.push({ url, options }); return response({ runs: [], documents: [], robinhoodState: { connected: true } }); }); await tick();
  assert.equal(app.root.querySelector("form"), null);
  assert.equal(app.root.querySelector("[data-brain-form]"), null);
  assert.equal(app.root.querySelector(".brain-network-inspector").hidden, true);
  for (const [node, destination] of [["agent:planner", "/research"], ["module:memory", "/research?view=knowledge"], ["module:risk", "/settings?section=system"], ["module:robinhood", "/accounts"]]) {
    app.root.querySelector(`[data-lobe-node="${node}"]`).click();
    app.root.querySelector("[data-network-navigate]").click();
    assert.equal(app.navigations.at(-1), destination);
  }
  assert.match(app.root.querySelector(".brain-network-inspector").textContent, /connection is saved/);
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [["/api/brain/state", "GET"]]);
});

test("a failed state request keeps the explorable canvas available and reports the unavailable activity", async (t) => {
  const app = fixture(t, async () => response({ message: "Unavailable" }, 503)); await tick();
  assert.equal(app.root.querySelectorAll("[data-lobe-node]").length, 8);
  const feedback = app.root.querySelector("[data-canvas-feedback]");
  assert.equal(feedback.hidden, false); assert.match(feedback.textContent, /Saved activity could not be loaded/);
  app.root.querySelector('[data-lobe-node="agent:planner"]').click();
  assert.equal(app.root.querySelector(".brain-network-inspector").hidden, false);
});

test("active research polling stops when complete and never starts model or broker actions", async (t) => {
  const timers = [], cleared = [], calls = [];
  const app = fixture(t, async (url, options) => {
    calls.push({ url, options }); return response({ runs: [{ id: "r", status: calls.length === 1 ? "running" : "completed" }] });
  }, { windowRef: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout(id) { cleared.push(id); } } }); await tick();
  assert.equal(timers.length, 1); await timers[0]();
  assert.equal(timers.length, 1); assert.equal(calls.length, 2); assert.ok(calls.every((call) => call.options.method === "GET"));
  app.instance.dispose(); assert.ok(cleared.includes(1));
});

test("late network state cannot modify a disposed page", async (t) => {
  let resolve;
  const app = fixture(t, () => new Promise((complete) => { resolve = complete; }));
  app.instance.dispose(); const before = app.root.outerHTML;
  resolve(response({ runs: [{ id: "r", status: "running" }] })); await tick();
  assert.equal(app.root.outerHTML, before);
});
