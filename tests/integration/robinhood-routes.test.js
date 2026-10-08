import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";
import { robinhoodHarness, sampleOrder } from "../helpers/robinhood-test-helpers.js";

test("broker endpoints require Discord admission and mutations require CSRF", async () => {
  const h = robinhoodHarness(), app = createTestApp({ robinhoodService: h.service });
  await request(app).get("/api/robinhood/state").expect(401).expect("Cache-Control", "no-store");
  const operator = await loginTestOperator(app);
  for (const endpoint of ["connect", "disconnect", "discover", "read", "actions", "pause", "actions/id/decision"]) await operator.post(`/api/robinhood/${endpoint}`).send({}).expect(403);
  assert.equal(h.invocations.length, 0);
});

test("OAuth callback validates one-time state and exposes no credentials in the workspace", async () => {
  const h = robinhoodHarness(), app = createTestApp({ robinhoodService: h.service });
  const operator = await loginTestOperator(app), csrf = await readCsrfToken(operator, "/brain");
  await operator.post("/api/robinhood/connect").set("X-CSRF-Token", csrf).send({ ownerId: "another-user" }).expect(200);
  await operator.get("/auth/robinhood/callback?state=wrong&code=fixture-code").expect(302).expect("Location", "/settings?section=connections&robinhood=invalid_state");
  await operator.get("/auth/robinhood/callback?state=fixture-state&code=fixture-code").expect(302).expect("Location", "/settings?section=connections&robinhood=connected");
  await operator.get("/auth/robinhood/callback?state=fixture-state&code=fixture-code").expect(302).expect("Location", "/settings?section=connections&robinhood=invalid_state");
  const state = await operator.get("/api/robinhood/state").expect(200);
  assert.equal(state.body.connected, true); assert.doesNotMatch(state.text, /fixture-token|fixture-refresh|sealed/);
  assert.equal((await h.service.state("another-user")).connected, false);
});

test("owner-scoped broker review is separate from research approval and cannot override the live lock", async () => {
  const h = robinhoodHarness(), app = createTestApp({ robinhoodService: h.service });
  const operator = await loginTestOperator(app); await h.connect("discord:operator");
  const csrf = await readCsrfToken(operator, "/brain");
  const preview = await operator.post("/api/robinhood/actions").set("X-CSRF-Token", csrf).send({ ...sampleOrder(), source: "brain", ownerId: "another-user", liveEnabled: true }).expect(201);
  assert.equal(preview.body.action.source, "operator");
  await operator.post(`/api/robinhood/actions/${preview.body.action.id}/decision`).set("X-CSRF-Token", csrf).send({ decision: "approve", version: 1, liveEnabled: true }).expect(423);
  await operator.post(`/api/robinhood/actions/${preview.body.action.id}/decision`).set("X-CSRF-Token", csrf).send({ decision: "reject", version: 1 }).expect(200);
  assert.equal(h.invocations.filter((item) => item.name.startsWith("place_")).length, 0);
  const page = await operator.get("/accounts").expect(200);
  assert.match(page.text, /Stocks &amp; ETFs|Stocks & ETFs/); assert.match(page.text, /Options/); assert.match(page.text, /Crypto/);
});
