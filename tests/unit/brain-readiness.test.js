import test from "node:test";
import assert from "node:assert/strict";
import { buildBrainReadiness, summarizeOfflineEvaluation } from "../../src/agent-brain/brain-readiness.js";
import { createMemoryBrainRepository, createSqliteBrainRepository } from "../../src/agent-brain/brain-repository.js";

const NOW = new Date("2026-09-14T20:00:00Z");
const BASE = { defaultProvider: "gemini", paidCallsEnabled: false, providers: [{ id: "gemini", label: "Gemini", configured: false }], runs: [] };
const byId = (report, id) => report.checks.find((check) => check.id === id);

test("readiness keeps a configured credential separate from activation and live verification", () => {
  for (const flag of [undefined, null, false, "true", 1]) {
    const report = buildBrainReadiness({ now: NOW, state: { ...BASE, paidCallsEnabled: flag,
      providers: [{ id: "gemini", label: "Gemini", configured: true, pricingConfigured: true }] } });
    assert.equal(report.paidCallsEnabled, false);
    assert.equal(byId(report, "paid_ai").status, "locked");
    assert.equal(byId(report, "credentials").status, "ready");
    assert.equal(byId(report, "live_validation").status, "pending");
    assert.equal(byId(report, "demo_workflow").status, "pending");
    assert.match(byId(report, "credentials").detail, /validity has not been checked/);
  }
});

test("offline fixture summaries require internally consistent pass counts", () => {
  const pass = { total: 2, passed: 2, failed: 0, cases: [{ passed: true }, { passed: true }] };
  const result = summarizeOfflineEvaluation(pass, NOW);
  assert.deepEqual(result, { total: 2, passed: 2, failed: 0, checkedAt: NOW.toISOString() });
  for (const invalid of [null, {}, { ...pass, passed: 1 }, { ...pass, total: 3 }, { ...pass, cases: [{ passed: "true" }, { passed: true }] }]) {
    assert.equal(summarizeOfflineEvaluation(invalid, NOW), null);
  }
  const failed = summarizeOfflineEvaluation({ total: 2, passed: 1, failed: 1, cases: [{ passed: true }, { passed: false }] }, NOW);
  assert.equal(byId(buildBrainReadiness({ state: BASE, lastEvaluation: failed }), "offline_evals").status, "pending");
  assert.equal(byId(buildBrainReadiness({ state: BASE, lastEvaluation: result }), "offline_evals").status, "ready");
});

test("readiness reflects account evidence while keeping live requirements pending", () => {
  const state = { ...BASE, storage: { kind: "sqlite", persistent: true },
    runs: [{ input: { mode: "demo" }, result: {}, status: "completed", metrics: { modelCalls: 0 } }] };
  const report = buildBrainReadiness({ state, now: NOW, documents: [{ kind: "memory" }, { kind: "knowledge" }] });
  for (const id of ["storage", "demo_workflow", "memory", "knowledge"]) assert.equal(byId(report, id).status, "ready", id);
  for (const id of ["live_validation", "market_data"]) assert.equal(byId(report, id).status, "pending", id);
  assert.equal(byId(report, "execution").status, "locked");
  assert.match(byId(report, "demo_workflow").detail, /illustrative/);
  const failedDemo = buildBrainReadiness({ state: { ...state, runs: [{ ...state.runs[0], status: "failed" }] } });
  assert.equal(byId(failedDemo, "demo_workflow").status, "pending");
});

test("temporary repositories cannot claim persistence", async (t) => {
  const memory = createMemoryBrainRepository();
  const sqlite = createSqliteBrainRepository({ filename: ":memory:" });
  t.after(async () => { await memory.close(); await sqlite.close(); });
  for (const repository of [memory, sqlite]) {
    assert.equal(repository.getStorageStatus().persistent, false);
    const report = buildBrainReadiness({ state: { ...BASE, storage: repository.getStorageStatus() } });
    assert.equal(byId(report, "storage").status, "pending");
  }
});
