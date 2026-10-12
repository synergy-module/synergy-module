import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

test("third brain routes are authenticated, CSRF protected, fragment ready, and scoped to the operator", async t => {
  const app = createTestApp({ logger: { error() {} } }); t.after(() => app.locals.robinhoodBrainService.close());
  await request(app).get("/robinhood-brain").expect(302);
  await request(app).get("/api/robinhood-brain/state").expect(401);
  const alice = await loginTestOperator(app, { username: "rh-alice" }), bob = await loginTestOperator(app, { username: "rh-bob" });
  await alice.get("/robinhood-brain?view=policy").set("X-Synergy-Module-Fragment", "1").expect(200).expect("X-Synergy-Module-Path", "/robinhood-brain?view=policy");
  for (const path of ["cycles", "verify", "start", "pause", "reconcile", "notes", "catalog/sync"]) await alice.post(`/api/robinhood-brain/${path}`).send({}).expect(403);
  await alice.put("/api/robinhood-brain/policy").send({}).expect(403);
  await alice.delete("/api/robinhood-brain/notes/x").expect(403);
  const csrf = await readCsrfToken(alice, "/robinhood-brain");
  await alice.post("/api/robinhood-brain/notes").set("X-CSRF-Token", csrf).send({ text: "Alice's third brain lesson" }).expect(200);
  assert.equal((await bob.get("/api/robinhood-brain/state").expect(200)).body.notes.length, 0);
  const started = await alice.post("/api/robinhood-brain/cycles").set("X-CSRF-Token", csrf).send({ mode: "demo" }).expect(202);
  assert.equal(started.body.status, "running");
  await app.locals.robinhoodBrainService.close();
  const own = await alice.get("/api/robinhood-brain/state").expect(200).expect("Cache-Control", "no-store");
  assert.equal(own.body.runs.length, 1); assert.equal(own.body.dryDays.length, 0); assert.equal(own.body.proofs, undefined);
  assert.deepEqual(own.body.providers.map(row => row.id), ["gemini", "openai", "claude", "grok"]);
  await alice.post("/api/robinhood-brain/cycles").set("X-CSRF-Token", csrf).send({ mode: "demo", owner: "rh-bob" }).expect(422);
});
