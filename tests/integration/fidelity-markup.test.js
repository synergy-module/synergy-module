import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JSDOM } from "jsdom";
import { createTestApp, loginTestOperator } from "../helpers/auth-test-helpers.js";

test("the overview guides setup, research and account review while preserving the economic calendar", async () => {
  const agent = await loginTestOperator(createTestApp({
    sessionSecret: "test-secret",
    marketNewsService: {
      getCurrentWeek: async () => ({
        state: "live",
        events: [{
          id: "42",
          timestamp: "2026-09-03T12:30:00.000Z",
          market: "USD",
          country: "United States",
          title: "Non Farm Payrolls",
          importance: "high",
          actual: null,
          forecast: "75K",
          previous: "62K",
        }],
        updatedAt: "2026-09-02T12:00:00.000Z",
        range: { from: "2026-08-30", to: "2026-09-05" },
      }),
    },
  }));
  const home = await agent.get("/home").expect(200);
  const homeDom = new JSDOM(home.text);
  assert.equal(homeDom.window.document.querySelectorAll(".setup-steps > li").length, 3);
  assert.ok(homeDom.window.document.querySelector('[data-route-view] a[href="/brain"][data-nav-link]'));
  for (const route of ["/settings", "/research", "/accounts"]) {
    assert.ok(homeDom.window.document.querySelector(`.setup-steps a[href="${route}"][data-nav-link]`));
  }
  homeDom.window.close();
  const response = await agent.get("/market-news").expect(200);
  assert.match(response.text, /market-calendar/);
  assert.match(response.text, /calendar-toolbar/);
  assert.match(response.text, /calendar-event/);
  assert.match(response.text, /calendar-state/);
});

test("Brain stays a focused canvas while Research, Settings and Accounts contain their own controls", async () => {
  const app = createTestApp();
  const agent = await loginTestOperator(app);
  const brain = new JSDOM((await agent.get("/brain").expect(200)).text);
  assert.ok(brain.window.document.querySelector("[data-brain-network]"));
  assert.equal(brain.window.document.querySelectorAll("[data-route-view] form").length, 0);
  assert.equal(brain.window.document.querySelector("[data-brain-form]"), null);
  assert.equal(brain.window.document.querySelector("[data-robinhood]"), null);
  brain.window.close();
  const research = new JSDOM((await agent.get("/research").expect(200)).text);
  assert.ok(research.window.document.querySelector("[data-brain-form]"));
  assert.ok(research.window.document.querySelector('[data-brain-panel="knowledge"]'));
  assert.equal(research.window.document.querySelector('input[name="apiKey"]'), null);
  assert.equal(research.window.document.querySelector('select[name="provider"]'), null);
  research.window.close();
  const settings = new JSDOM((await agent.get("/settings").expect(200)).text);
  assert.equal(settings.window.document.querySelectorAll('[data-provider-form] input[type="password"]').length, 3);
  assert.ok(settings.window.document.querySelector("[data-connection-connect]"));
  assert.ok(settings.window.document.querySelector("[data-settings-defaults]"));
  settings.window.close();
  const accounts = await agent.get("/accounts").expect(200);
  assert.match(accounts.text, /data-rh-actions/);
});

test("Admin uses Cortex panels with dense action rows and mobile field labels", async () => {
  const app = createTestApp();
  const agent = await loginTestOperator(app);
  const [response, stylesheet] = await Promise.all([
    agent.get("/admin").expect(200),
    request(app).get("/css/synergy-module.css").expect(200),
  ]);
  const dom = new JSDOM(response.text);
  const style = dom.window.document.createElement("style");
  style.textContent = stylesheet.text;
  dom.window.document.head.append(style);

  const userRow = dom.window.document.querySelector("[data-admin-user-row]");
  const rail = dom.window.document.querySelector("[data-admin-users]");
  const actions = userRow.querySelector(".admin-actions");
  assert.equal(dom.window.getComputedStyle(userRow).display, "grid");
  assert.equal(dom.window.getComputedStyle(rail).borderTopWidth, "1px");
  assert.equal(dom.window.getComputedStyle(actions).display, "flex");
  assert.equal(userRow.closest(".panel"), null);
  assert.ok(userRow.closest(".cortex-panel"));
  assert.ok([...userRow.children].every((child) => child.hasAttribute("data-field")));
  dom.window.close();
});
