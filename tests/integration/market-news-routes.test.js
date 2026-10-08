import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JSDOM } from "jsdom";
import { createTestApp, loginTestOperator } from "../helpers/auth-test-helpers.js";

const liveCalendar = {
  state: "live",
  events: [{
    id: "42",
    timestamp: "2026-09-03T12:30:00.000Z",
    market: "USD",
    country: "United States",
    title: "Non Farm Payrolls",
    importance: "high",
    source: "ECONOMICIUM / OFFICIAL SCHEDULES",
  }],
  updatedAt: "2026-09-02T12:00:00.000Z",
  range: { from: "2026-08-30", to: "2026-09-05" },
};

async function authenticatedAgent(marketNewsService) {
  const agent = await loginTestOperator(createTestApp({
    sessionSecret: "test-secret", marketNewsService, logger: { error() {} },
  }));
  return agent;
}

test("market news renders provider data in full and fragment responses", async () => {
  const service = { getCurrentWeek: async () => liveCalendar };
  const agent = await authenticatedAgent(service);

  const response = await agent.get("/market-news").expect(200);
  assert.match(response.text, /data-app-shell/);
  assert.match(response.text, /data-market-news/);
  assert.match(response.text, /data-calendar-impact="high"/);
  assert.match(response.text, /data-calendar-market="usd"/);
  assert.match(response.text, /data-calendar-refresh/);
  assert.match(response.text, /data-calendar-link-status/);
  assert.match(response.text, /data-event-id="42"/);
  assert.match(response.text, /data-impact="high"/);
  assert.match(response.text, /TIMES UTC/);
  assert.match(response.text, /data-calendar-timezone[^>]*>TIMES UTC</);
  assert.doesNotMatch(response.text, /TIMES LOCAL/);
  assert.match(response.text, />HIGH</);
  assert.match(response.text, />Non Farm Payrolls</);
  assert.match(response.text, /SOURCE :: ECONOMICIUM \/ OFFICIAL SCHEDULES/);
  assert.match(response.text, /href="https:\/\/www\.economicium\.com\/economic-calendar\/"/);
  assert.doesNotMatch(response.text, /ACTUAL ::|FORECAST ::|PREVIOUS ::/);
  assert.doesNotMatch(response.text, /iframe|financialjuice|twitter-timeline|x\\.com/i);
  await agent.get("/market-news").set("X-Synergy-Module-Fragment", "1").expect(200)
    .expect(/data-market-news/).expect((response) => assert.doesNotMatch(response.text, /data-app-shell/));
});

test("initial calendar status renders live and stale states with consistent terminal copy", async () => {
  for (const [state, expected] of [["live", "LINK :: LIVE"], ["stale", "LINK :: STALE DATA"]]) {
    const agent = await authenticatedAgent({
      getCurrentWeek: async () => ({ ...liveCalendar, state }),
    });
    const response = await agent.get("/market-news").expect(200);
    const dom = new JSDOM(response.text);

    assert.equal(dom.window.document.querySelector("[data-calendar-link-status]").textContent.trim(), expected);
    dom.window.close();
  }
});

test("server-rendered rows expose explicit field labels and semantic day-ready values", async () => {
  const agent = await authenticatedAgent({ getCurrentWeek: async () => liveCalendar });
  const response = await agent.get("/market-news").expect(200);
  const dom = new JSDOM(response.text);
  const row = dom.window.document.querySelector('[data-event-id="42"]');

  assert.deepEqual([...row.querySelectorAll(".calendar-field-label")].map((label) => label.textContent), [
    "TIME :: ", "IMPACT :: ", "MARKET :: ", "EVENT :: ",
  ]);
  assert.equal(row.querySelector("[data-event-time]").dataset.field, "TIME");
  assert.equal(row.querySelector("[data-event-time-value]").textContent, "12:30Z");
  dom.window.close();
});

test("server rendering escapes markup-like provider identifiers and titles", async () => {
  const event = {
    ...liveCalendar.events[0],
    id: 'event\"><img data-provider-injected="id">',
    title: '<img data-provider-injected="title" src=x>',
  };
  const agent = await authenticatedAgent({
    getCurrentWeek: async () => ({ ...liveCalendar, events: [event] }),
  });
  const response = await agent.get("/market-news").expect(200);
  const dom = new JSDOM(response.text);
  const documentRef = dom.window.document;
  const row = documentRef.querySelector("[data-calendar-event]");

  assert.equal(documentRef.querySelector("[data-provider-injected]"), null);
  assert.equal(row.dataset.eventId, event.id);
  assert.equal(row.querySelector(".calendar-event-title [data-event-field-value]").textContent, event.title);
  assert.equal(row.querySelector(".calendar-value"), null);
  dom.window.close();
});

test("refresh endpoint returns normalized data and honors a forced refresh", async () => {
  const calls = [];
  const service = { getCurrentWeek: async (options) => { calls.push(options); return liveCalendar; } };
  const agent = await authenticatedAgent(service);

  const response = await agent.get("/api/market-news/events?refresh=1").expect(200);

  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.calendar, liveCalendar);
  assert.deepEqual(calls, [{ force: true }]);
});

test("page preserves the terminal shell while a first load failure makes the API unavailable", async () => {
  const service = { getCurrentWeek: async () => { throw new Error("provider secret body"); } };
  const agent = await authenticatedAgent(service);

  await agent.get("/market-news").expect(200).expect(/Calendar source unavailable/).expect(/data-market-news/);
  const response = await agent.get("/api/market-news/events").expect(503);
  assert.deepEqual(response.body, {
    ok: false,
    calendar: { state: "offline", events: [], updatedAt: null, range: null },
  });
  assert.doesNotMatch(JSON.stringify(response.body), /provider secret body/);
});

test("market news API requires an authenticated operator", async () => {
  await request(createTestApp({ logger: { error() {} } }))
    .get("/api/market-news/events")
    .expect(401);
});
