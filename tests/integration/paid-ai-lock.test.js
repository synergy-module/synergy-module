import assert from "node:assert/strict";
import test from "node:test";
import { createTraderAIProvider } from "../../src/providers/trader-ai-provider.js";
import { readTraderConfig } from "../../src/config/trader-config.js";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

const INPUT = {
  provider: "gemini", mode: "analysis", symbol: "ES", timeframe: "5m",
  context: "Manual illustrative snapshot: support 98, entry 100, target 106. No live price source is connected.",
  objective: "Review the supplied research with verified risk calculations.",
  accountSize: 50000, riskPercent: 0.5, pointValue: 50, minRewardRisk: 2,
};

test("configured API keys cannot bypass the default paid lock through either HTTP workflow", async (t) => {
  let modelRequests = 0;
  let calendarRequests = 0;
  const keys = {
    GEMINI_API_KEY: "fixture-gemini-credential",
    OPENAI_API_KEY: "fixture-openai-credential",
    ANTHROPIC_API_KEY: "fixture-claude-credential",
  };
  const provider = createTraderAIProvider({
    config: readTraderConfig(keys),
    async fetchImpl() {
      modelRequests += 1;
      throw new Error("Paid provider transport must remain unused in this test.");
    },
  });
  const app = createTestApp({
    traderAIProvider: provider,
    marketNewsService: { async getCurrentWeek() {
      calendarRequests += 1;
      throw new Error("Calendar transport must remain unused while paid runs are locked.");
    } },
    logger: { error() {} },
  });
  t.after(async () => {
    await app.locals.brainService.close();
    await app.locals.brainRepository.close();
  });
  const client = await loginTestOperator(app);
  const csrf = await readCsrfToken(client, "/brain");

  for (const workflow of ["trader", "brain"]) {
    const state = await client.get(`/api/${workflow}/state`).expect(200).expect("Cache-Control", "no-store");
    assert.equal(state.body.paidCallsEnabled, false);
    assert.equal(state.body.providers.length, 3);
    assert.ok(state.body.providers.every((item) => item.configured));
    for (const key of Object.values(keys)) assert.ok(!JSON.stringify(state.body).includes(key));
    for (const selectedProvider of ["gemini", "openai", "claude"]) {
      const rejected = await client.post(`/api/${workflow}/runs?paidCallsEnabled=true`)
        .set("X-CSRF-Token", csrf)
        .send({ ...INPUT, provider: selectedProvider, paidCallsEnabled: true, TRADER_PAID_AI_ENABLED: "true" })
        .expect(423).expect("Cache-Control", "no-store");
      assert.equal(rejected.body.error, "TRADER_PAID_AI_LOCKED");
      for (const key of Object.values(keys)) assert.ok(!JSON.stringify(rejected.body).includes(key));
    }
    assert.deepEqual((await client.get(`/api/${workflow}/state`).expect(200)).body.runs, []);
  }
  assert.equal(modelRequests, 0);
  assert.equal(calendarRequests, 0);

  const traderDemo = await client.post("/api/trader/runs").set("X-CSRF-Token", csrf)
    .send({ ...INPUT, mode: "demo" }).expect(201);
  assert.equal(traderDemo.body.run.mode, "demo");
  const brainDemo = await client.post("/api/brain/runs").set("X-CSRF-Token", csrf)
    .send({ ...INPUT, mode: "demo" }).expect(202);
  const checkpoint = await app.locals.brainService.waitForRun("discord:operator", brainDemo.body.run.id);
  assert.equal(checkpoint.status, "awaiting_approval", JSON.stringify(checkpoint.error));
  assert.equal(checkpoint.metrics.modelCalls, 0);
  const evaluations = await client.post("/api/brain/evals").set("X-CSRF-Token", csrf).send({}).expect(200);
  assert.equal(evaluations.body.failed, 0, JSON.stringify(evaluations.body.cases));
  assert.ok(evaluations.body.total >= 20);
  assert.equal(modelRequests, 0);
  assert.equal(calendarRequests, 0);
});
