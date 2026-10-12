import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import ejs from "ejs";
import { initializePolymarket } from "../../public/js/polymarket-controller.js";
import { createPolymarketService } from "../../src/polymarket/polymarket-service.js";
import { createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { POLY_NOW, polyFixture } from "../helpers/polymarket-test-helpers.js";

test("offline market failure leaves saved memory usable and disposes requests and listeners", async () => {
  const repository = createMemoryWorkspaceRepository(), service = createPolymarketService({ repository, client: polyFixture().client, now: () => POLY_NOW });
  await service.note("alice", { text: "Saved lesson survives an offline feed" });
  const state = await service.state("alice");
  const html = await ejs.renderFile("views/pages/polymarket.ejs", { page: { route: { key: "polymarket" } } });
  const dom = new JSDOM(`<meta name="csrf-token" content="test-token">${html}`, { url: "http://localhost/polymarket?view=brain" });
  const signals = [], requests = [];
  const controller = initializePolymarket(dom.window.document.querySelector("[data-polymarket]"), { fetchImpl: async (url, options) => {
    requests.push(url); signals.push(options.signal);
    return url.endsWith("/state") ? Response.json(state) : Response.json({ message: "Market feed unavailable" }, { status: 503 });
  } });
  await controller.ready;
  assert.match(dom.window.document.querySelector("[data-poly-notes]").textContent, /Saved lesson survives/);
  assert.equal(dom.window.document.querySelector('[data-poly-panel="brain"]').hidden, false);
  assert.equal(dom.window.document.querySelector("[data-poly-feedback]").dataset.error, "true");
  dom.window.document.querySelector('[data-poly-tab="brain"]').dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(dom.window.document.querySelector('[data-poly-tab="radar"]').getAttribute("aria-selected"), "true");
  assert.equal(dom.window.document.querySelector('[data-poly-tab="paper"]'), null);
  controller.dispose(); assert.ok(signals.every(signal => signal.aborted));
  const requestCount = requests.length;
  dom.window.document.querySelector('[data-poly-action="refresh"]').click(); assert.equal(requests.length, requestCount);
  dom.window.close(); await service.close();
});
