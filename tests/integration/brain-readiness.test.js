import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

test("readiness uses completed server evals and resets evidence after server recreation", async (t) => {
  const report = { passed: 1, failed: 0, total: 1, cases: [{ id: "fixture", passed: true }], durationMs: 1 };
  let attempts = 0;
  const options = { brainEvaluator: async () => {
    attempts += 1;
    if (attempts > 1) throw new Error("Injected fixture failure");
    return report;
  }, logger: { error() {} } };
  const first = createTestApp(options), second = createTestApp(options);
  t.after(async () => {
    for (const app of [first, second]) { await app.locals.brainService.close(); await app.locals.brainRepository.close(); }
  });
  const client = await loginTestOperator(first);
  const csrf = await readCsrfToken(client, "/brain");
  const status = async (agent) => (await agent.get("/api/brain/state").expect(200).expect("Cache-Control", "no-store"))
    .body.readiness.checks.find((check) => check.id === "offline_evals");
  assert.equal((await status(client)).status, "pending");
  await client.post("/api/brain/evals").set("X-CSRF-Token", csrf).send({ passed: 999, failed: 0 }).expect(200);
  const checked = await status(client);
  assert.equal(checked.status, "ready");
  assert.match(checked.detail, /1\/1 deterministic scenarios passed/);
  assert.equal((await status(await loginTestOperator(second))).status, "pending");
  await client.post("/api/brain/evals").set("X-CSRF-Token", csrf).send({}).expect(500);
  assert.equal((await status(client)).status, "pending");
});
