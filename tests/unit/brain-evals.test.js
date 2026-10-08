import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runBrainEvaluations } from "../../src/agent-brain/brain-evals.js";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

const execute = promisify(execFile);

test("offline evaluations exercise the real bounded workflow without network access and return a complete report", async (t) => {
  let networkAttempts = 0;
  t.mock.method(globalThis, "fetch", () => {
    networkAttempts += 1;
    throw new Error("Network use is forbidden in offline evaluations");
  });
  const report = await runBrainEvaluations();
  assert.equal(report.failed, 0, JSON.stringify(report.cases.filter((scenario) => !scenario.passed)));
  assert.equal(report.passed, report.total);
  assert.equal(report.total, report.cases.length);
  assert.ok(report.total >= 18);
  assert.ok(report.durationMs >= 0 && Number.isFinite(report.durationMs));
  assert.equal(new Set(report.cases.map((scenario) => scenario.id)).size, report.total);
  const required = ["demo_pipeline", "approval_scope", "approval_replay", "checkpoint_reload", "cancellation", "step_budget", "token_budget", "cost_budget", "model_call_budget", "tool_allowlist", "tool_schema", "risk_worker", "tenant_retrieval", "citation_grounding", "context_compaction", "tool_timeout", "tool_output_bound", "exact_cache"];
  for (const id of required) assert.ok(report.cases.some((scenario) => scenario.id === id && scenario.passed), id);
  for (const scenario of report.cases) {
    assert.equal(typeof scenario.name, "string");
    assert.ok(scenario.detail.length > 10);
    assert.equal(scenario.passed, true);
  }
  assert.equal(networkAttempts, 0);
});

test("the standalone evaluation command exits successfully with a readable summary", async () => {
  const project = fileURLToPath(new URL("../..", import.meta.url));
  const { stdout, stderr } = await execute(process.execPath, ["scripts/eval-brain.js"], { cwd: project, timeout: 15000 });
  assert.match(stdout, /Agent brain offline evaluations: \d+\/\d+ passed/);
  assert.match(stdout, /PASS demo_pipeline/);
  assert.match(stdout, /PASS exact_cache/);
  assert.doesNotMatch(stdout, /FAIL/);
  assert.doesNotMatch(stderr, /could not complete/);
});

test("the evaluation CLI ignores Node watch protocol messages from isolated risk workers", { timeout: 20000 }, async (t) => {
  const project = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawn(process.execPath, ["--watch", "--watch-preserve-output", "scripts/eval-brain.js"], { cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The watched offline evaluation did not complete.")), 15000);
    const accept = (chunk) => {
      output += chunk.toString();
      if (output.includes("Waiting for file changes")) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", accept);
    child.stderr.on("data", accept);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("The watch process ended before reporting completion.")); });
  });
  assert.match(output, /PASS risk_worker/);
  assert.match(output, /Agent brain offline evaluations: (\d+)\/\1 passed/);
  assert.doesNotMatch(output, /FAIL/);
});

test("repeated authenticated HTTP evaluations use isolated fixtures and complete every case", { timeout: 20000 }, async (t) => {
  let modelCalls = 0;
  const app = createTestApp({ traderAIProvider: {
    getStatus: () => ({ defaultProvider: "gemini", providers: [{ id: "gemini", label: "Gemini", model: "offline-test", configured: false }] }),
    async generate() { modelCalls += 1; throw new Error("A model cannot be called by this offline test."); },
  } });
  t.after(async () => { await app.locals.brainService.close?.(); await app.locals.brainRepository.close(); });
  const agent = await loginTestOperator(app);
  const token = await readCsrfToken(agent, "/brain");
  for (let index = 0; index < 3; index += 1) {
    const { body } = await agent.post("/api/brain/evals").set("X-CSRF-Token", token).send({}).expect(200);
    assert.equal(body.failed, 0, JSON.stringify(body.cases?.filter((scenario) => !scenario.passed)));
    assert.equal(body.passed, body.total);
    assert.ok(body.total >= 18);
    assert.equal(body.cases.find((scenario) => scenario.id === "risk_worker")?.passed, true);
  }
  assert.equal(modelCalls, 0);
});
