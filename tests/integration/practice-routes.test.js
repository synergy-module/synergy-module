import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

const spec = { name: "Manual practice", strategyId: "manual", feed: { source: "binance", instrument: "BINANCE:BTCUSDT" } };
test("new sign-ins complete setup before entering the workspace, with saved profile and preferences", async t => {
  const app = createTestApp(); t.after(() => app.locals.practiceService.close());
  const user = await loginTestOperator(app, { onboarding: false });
  await user.get("/home").expect(302).expect("Location", "/setup");
  await user.get("/practice").set("X-Synergy-Module-Fragment", "1").expect(302).expect("Location", "/setup");
  const csrf = await readCsrfToken(user, "/setup");
  await user.patch("/api/settings/profile").send({ displayName: "Riley" }).expect(403);
  await user.patch("/api/settings/profile").set("X-CSRF-Token", csrf).send({ displayName: "Riley" }).expect(200);
  await user.patch("/api/settings/preferences").set("X-CSRF-Token", csrf).send({ theme: "light", defaultLanding: "/practice" }).expect(200);
  await user.post("/api/settings/onboarding/complete").set("X-CSRF-Token", csrf).send({ acknowledgedPracticeIsolation: true }).expect(200);
  await user.get("/home").expect(302).expect("Location", "/practice");
  const page = await user.get("/practice").expect(200); assert.match(page.text, /data-theme-preference="light"/); assert.match(page.text, /Riley/);
});

test("forward paper orders require authorization and CSRF and never expose historical replay routes", async t => {
  const app = createTestApp({ practiceMarketData: { async quote() { return { instrument: "BINANCE:BTCUSDT", timestamp: new Date().toISOString(), price: 100, bid: 99, ask: 101, liquidity: 10000 }; } } });
  t.after(() => app.locals.practiceService.close());
  await request(app).get("/api/practice").expect(401);
  const alice = await loginTestOperator(app, { username: "Alice" }), bob = await loginTestOperator(app, { username: "Bob" });
  const csrf = await readCsrfToken(alice, "/practice");
  await alice.post("/api/practice/books").send(spec).expect(403);
  const { body: book } = await alice.post("/api/practice/books").set("X-CSRF-Token", csrf).send(spec).expect(201);
  await bob.get(`/api/practice/books/${book.id}`).expect(404);
  const bought = await alice.post(`/api/practice/books/${book.id}/orders`).set("X-CSRF-Token", csrf).send({ side: "BUY", budgetUsd: 20, requestId: "paper-buy-1" }).expect(200);
  assert.equal(bought.body.positions.length, 1); assert.equal(bought.body.mode, "PAPER"); assert.equal(bought.body.qa.eligibleForLive, false);
  await alice.post(`/api/practice/books/${book.id}/start`).set("X-CSRF-Token", csrf).send({ mode: "LIVE" }).expect(422);
  const catalog = await request(app).get("/api/v1/operations").expect(200); assert.ok(catalog.body.operations.some(o => o.path.includes("/practice/books/:id/orders"))); assert.ok(!catalog.body.operations.some(o => /backtests/.test(o.path)));
});

test("prediction research, paper testing and real accounts have separate rendered controls", async t => {
  const app = createTestApp(); t.after(() => app.locals.practiceService.close());
  const user = await loginTestOperator(app);
  const research = await user.get("/polymarket").expect(200); assert.doesNotMatch(research.text, /data-poly-us-form|data-poly-settings-form/);
  const paper = await user.get("/practice/polymarket").expect(200); assert.match(paper.text, /data-poly-settings-form/); assert.doesNotMatch(paper.text, /data-poly-us-form|data-poly-note-form/);
  const live = await user.get("/live/polymarket").expect(200); assert.match(live.text, /data-poly-us-form/); assert.doesNotMatch(live.text, /data-poly-settings-form|data-poly-tab="paper"/);
  await user.get("/polymarket?view=paper").expect(302).expect("Location", "/practice/polymarket");
  await user.get("/polymarket?view=account").expect(302).expect("Location", "/live/polymarket");
});
