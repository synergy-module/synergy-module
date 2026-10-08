import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

const noKeys = {
  getStatus: () => ({ defaultProvider: "gemini", paidCallsEnabled: true, providers: [
    { id: "gemini", label: "Gemini", model: "test-model", configured: false },
    { id: "openai", label: "OpenAI", model: "test-model", configured: false },
    { id: "claude", label: "Claude", model: "test-model", configured: false },
  ] }),
  generate: () => { throw new Error("An unconfigured provider must not be invoked"); },
};
const demo = {
  provider: "gemini", mode: "demo", symbol: "ES", timeframe: "5m", context: "",
  accountSize: 50000, riskPercent: 0.5, pointValue: 50, minRewardRisk: 2,
};
const makeApp = (options = {}) => createTestApp({ traderAIProvider: noKeys, ...options });

test("trader page and API require authentication", async () => {
  const app = makeApp();
  await request(app).get("/trader").expect(302).expect("Location", "/login");
  await request(app).get("/api/trader/state").expect(401);
  await request(app).post("/api/trader/runs").send(demo).expect(401);
});

test("the former trader page redirects to the unified Research workspace and its API retains all providers", async () => {
  const client = await loginTestOperator(makeApp({ roles: ["OS"] }));
  await client.get("/trader").expect(302).expect("Location", "/research");
  const full = await client.get("/research").expect(200);
  assert.match(full.text, /data-app-shell/);
  assert.match(full.text, /data-brain-form/);
  assert.match(full.text, /\/css\/trader.css/);
  await client.get("/trader").set("X-Synergy-Module-Fragment", "1").expect(302).expect("Location", "/research");
  const fragment = await client.get("/research").set("X-Synergy-Module-Fragment", "1")
    .expect(200).expect("X-Synergy-Module-Key", "research").expect("X-Synergy-Module-Path", "/research");
  assert.doesNotMatch(fragment.text, /data-app-shell/);
  const state = await client.get("/api/trader/state").expect(200).expect("Cache-Control", "no-store");
  assert.equal(state.body.defaultProvider, "gemini");
  assert.deepEqual(state.body.providers.map((p) => p.id), ["gemini", "openai", "claude"]);
  assert.deepEqual(state.body.runs, []);
});

test("demo analysis is CSRF protected, recorded, and isolated between operators", async () => {
  const app = makeApp();
  const first = await loginTestOperator(app, { username: "first-trader" });
  const second = await loginTestOperator(app, { username: "second-trader" });
  await first.post("/api/trader/runs").send(demo).expect(403);
  const csrf = await readCsrfToken(first, "/research");
  const result = await first.post("/api/trader/runs").set("X-CSRF-Token", csrf)
    .send(demo).expect(201).expect("Cache-Control", "no-store");
  assert.equal(result.body.run.mode, "demo");
  assert.match(result.body.run.dataSource, /demo|illustrative/i);
  assert.ok(result.body.run.steps.length >= 3);
  assert.equal(result.body.run.risk.quantity, 2);
  assert.equal(result.body.run.risk.maxLoss, 200);
  const own = await first.get("/api/trader/state").expect(200);
  const other = await second.get("/api/trader/state").expect(200);
  assert.equal(own.body.runs.length, 1);
  assert.deepEqual(other.body.runs, []);
});

test("invalid risk and unconfigured analysis fail with structured errors", async () => {
  const client = await loginTestOperator(makeApp());
  const csrf = await readCsrfToken(client, "/research");
  const invalid = await client.post("/api/trader/runs").set("X-CSRF-Token", csrf)
    .send({ ...demo, riskPercent: -1 }).expect(422);
  assert.equal(invalid.body.error, "TRADER_INPUT_INVALID");
  const missing = await client.post("/api/trader/runs").set("X-CSRF-Token", csrf)
    .send({ ...demo, mode: "analysis", context: "Supplied market context with a mapped point of interest and no verified price feed." })
    .expect(503);
  assert.equal(missing.body.error, "TRADER_PROVIDER_NOT_CONFIGURED");
});

test("unexpected errors and provider payloads never reach the client or logs", async () => {
  const logs = [];
  const service = {
    getState: () => noKeys.getStatus(),
    run: async () => { throw new Error("Bearer private-credential upstream-body"); },
  };
  const client = await loginTestOperator(makeApp({ traderService: service, logger: { error: (text) => logs.push(text) } }));
  const csrf = await readCsrfToken(client, "/research");
  const response = await client.post("/api/trader/runs").set("X-CSRF-Token", csrf).send(demo).expect(500);
  assert.deepEqual(response.body, { error: "TRADER_UNAVAILABLE", message: "Analysis is unavailable. Try again." });
  assert.doesNotMatch(JSON.stringify(logs), /private-credential|upstream-body/);
});
