import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";
import { polyFixture } from "../helpers/polymarket-test-helpers.js";

test("Polymarket pages and APIs require admission, and every write requires CSRF", async t => {
  const { client } = polyFixture(), app = createTestApp({ polymarketClient: client }); t.after(() => app.locals.polymarketService.close());
  await request(app).get("/polymarket").expect(302);
  await request(app).get("/api/polymarket/markets").expect(401);
  await request(app).post("/api/polymarket/paper/start").send({}).expect(401);
  const agent = await loginTestOperator(app);
  await agent.get("/polymarket").expect(200).expect("Cache-Control", "no-store").expect(/Second Brain/);
  await agent.get("/polymarket?view=brain").set("X-Synergy-Module-Fragment", "1").expect(200).expect("X-Synergy-Module-Path", "/polymarket?view=brain");
  for (const [method, path, body] of [["post", "notes", { text: "Test lesson" }], ["post", "research", { marketId: "123" }],
    ["put", "watchlist", { marketId: "123", watching: true }], ["put", "radar", {}], ["put", "paper/settings", {}],
    ["post", "paper/start", {}], ["post", "paper/pause", {}], ["post", "paper/positions/x/close", {}], ["delete", "notes/x", {}], ["delete", "research/x", {}]]) {
    await agent[method](`/api/polymarket/${path}`).send(body).expect(403);
  }
});

test("research is stored only for its operator, and routes reject invalid input and malformed JSON", async t => {
  const { client, calls } = polyFixture(), app = createTestApp({ polymarketClient: client }); t.after(() => app.locals.polymarketService.close());
  const alice = await loginTestOperator(app, { username: "poly-alice" }), bob = await loginTestOperator(app, { username: "poly-bob" });
  const csrf = await readCsrfToken(alice, "/polymarket");
  await alice.post("/api/polymarket/notes").set("X-CSRF-Token", csrf).send({ text: "Market event lesson", marketId: "123" }).expect(200);
  const research = await alice.post("/api/polymarket/research").set("X-CSRF-Token", csrf).send({ marketId: "123" }).expect(200);
  const own = await alice.get("/api/polymarket/state").expect(200).expect("Cache-Control", "no-store");
  assert.equal(own.body.research.length, 1); assert.equal(own.body.notes.length, 1);
  assert.equal((await bob.get("/api/polymarket/state").expect(200)).body.research.length, 0);
  const bobCsrf = await readCsrfToken(bob, "/polymarket");
  await bob.delete(`/api/polymarket/research/${research.body.report.id}`).set("X-CSRF-Token", bobCsrf).expect(404);
  await alice.post("/api/polymarket/paper/start").set("X-CSRF-Token", csrf).send({ mode: "LIVE" }).expect(422);
  await alice.post("/api/polymarket/research").set("X-CSRF-Token", csrf).send({ marketId: "http://localhost/secret" }).expect(422);
  await alice.post("/api/polymarket/notes").set("X-CSRF-Token", csrf).set("Content-Type", "application/json").send("{").expect(400);
  assert.ok(calls.every(call => call.options.method === undefined));
});
