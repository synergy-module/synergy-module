import test from "node:test";
import assert from "node:assert/strict";
import { createBrainService } from "../../src/agent-brain/brain-service.js";
import { createMemoryBrainRepository } from "../../src/agent-brain/brain-repository.js";
import { createBrainKnowledge } from "../../src/agent-brain/brain-knowledge.js";
import { createBrainTools } from "../../src/agent-brain/brain-tools.js";
import { createBrainModelGateway } from "../../src/agent-brain/brain-model-gateway.js";
import { evaluateTraderRisk } from "../../src/services/trader-service.js";

const TIME = new Date("2026-09-14T14:00:00Z");
const INPUT = {
  mode: "analysis", provider: "gemini", symbol: "ES", timeframe: "5m",
  context: "Manual snapshot observed at 14:00 UTC: daily trend is upward. Support 98, reclaim and entry 100, resistance and target 106. A break below 98 invalidates the setup.",
  objective: "Research this setup with cited manual evidence and risk checks.",
  accountSize: 50000, riskPercent: 0.5, pointValue: 50, minRewardRisk: 2,
};
const PLAN = { tasks: [
  { id: "research", label: "Gather observed evidence", role: "researcher", dependencies: [] },
  { id: "strategy", label: "Propose a supported thesis", role: "strategist", dependencies: ["research"] },
  { id: "critique", label: "Critique the risk and evidence", role: "critic", dependencies: ["strategy"] },
] };
const THESIS = {
  bias: "long", summary: "The manual reclaim and supplied trend support a research hypothesis.",
  evidence: ["The supplied snapshot states support at 98 and resistance at 106. [snapshot]"], missingData: [],
  entry: 100, stop: 98, target: 106, invalidation: "Loss of supplied support at 98 invalidates the hypothesis.",
};
const REVIEW = { verdict: "pass", reason: "The cited manual data supports this research proposal.", revisionInstruction: "" };
const action = (kind, changes = {}) => ({ kind, summary: "Choose a bounded next action.", tool: "", argumentsJson: "{}", handoffRole: "", thesis: null, ...changes });
const toolAction = (tool, args = {}) => action("tool", { tool, argumentsJson: JSON.stringify(args) });
const handoff = (handoffRole) => action("handoff", { handoffRole });
const finish = (thesis = THESIS) => action("finish", { thesis });

function harness({ queues = {}, generate, executeTool, realTools = false, paidCallsEnabled = true, repository: providedRepository, rates = { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.1, cacheCreationInputPerMillion: 1.25 }, usage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, totalTokens: 150 }, ...serviceOptions } = {}) {
  const repository = providedRepository ?? createMemoryBrainRepository({ now: () => TIME });
  const knowledge = createBrainKnowledge({ repository });
  const calls = [];
  const toolCalls = [];
  let calendarRequests = 0;
  let ids = 0;
  const actualTools = createBrainTools({ knowledge, journalRepository: { list: async () => [] }, canReadJournal: () => true,
    marketNewsService: { getCurrentWeek: async () => { calendarRequests += 1; return { state: "live", updatedAt: TIME.toISOString(), events: [] }; } }, now: () => TIME });
  const scripts = {
    planner: [PLAN], researcher: [toolAction("context.read"), toolAction("calendar.read"), handoff("strategist")],
    strategist: [finish()], critic: [REVIEW], ...queues,
  };
  const modelGateway = {
    getStatus: () => ({ defaultProvider: "gemini", paidCallsEnabled, providers: ["gemini", "openai", "claude"].map((id) => ({ id, label: id, model: `test-${id}`, configured: true })) }),
    getPricing: () => rates,
    async generate(owner, request) {
      calls.push({ owner, ...request });
      if (generate) return generate(owner, request);
      const role = request.system.match(/Current role: (\w+)/)?.[1];
      const value = scripts[role]?.shift();
      if (value instanceof Error) throw value;
      return { data: structuredClone(value), usage, latencyMs: 1, estimatedCostUsd: usage ? 0.0002 : null, cache: { status: "miss", key: "test-cache" } };
    },
  };
  const tools = { definitions: (role) => actualTools.definitions(role), async execute(request) {
    toolCalls.push(request);
    if (executeTool) {
      const customized = await executeTool(request);
      if (customized !== undefined) return customized;
    }
    if (realTools) return actualTools.execute(request);
    if (request.name === "context.read") return { ok: true, data: { context: request.input.context }, citations: [{ id: "snapshot", title: "Manual snapshot", excerpt: request.input.context }], truncated: false };
    if (request.name === "calendar.read") return { ok: true, data: { state: request.input.mode === "demo" ? "demo" : "fresh", events: [], truncated: false }, citations: [], truncated: false };
    if (request.name === "risk.check") return { ok: true, data: { risk: evaluateTraderRisk(request.input, request.arguments.thesis), verified: true }, citations: [], truncated: false };
    return { ok: true, data: { matches: [] }, citations: [], truncated: false };
  } };
  const service = createBrainService({ repository, knowledge, tools, modelGateway, now: () => TIME, idFactory: () => `test-${++ids}`, ...serviceOptions });
  return { service, repository, knowledge, tools, modelGateway, calls, toolCalls, get calendarRequests() { return calendarRequests; } };
}

async function run(fixture, input = INPUT, owner = "alice") {
  const initial = await fixture.service.start(owner, input);
  return fixture.service.waitForRun(owner, initial.id);
}

async function until(predicate) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached.");
}

test("actual ReAct research tools, role handoff, deterministic risk and critique reach approval", async () => {
  const fixture = harness();
  const result = await run(fixture, { ...INPUT, routes: { planner: "openai", researcher: "gemini", strategist: "claude", critic: "openai" } });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.result.proposalStatus, "ready");
  assert.equal(result.result.risk.quantity, 2);
  assert.equal(result.result.risk.maxLoss, 200);
  assert.equal(result.result.tradeExecutionAuthorized, false);
  assert.deepEqual(fixture.toolCalls.map((call) => call.name), ["context.read", "calendar.read", "risk.check"]);
  assert.deepEqual(fixture.calls.map((call) => call.provider), ["openai", "gemini", "gemini", "gemini", "claude", "openai"]);
  assert.equal(result.metrics.modelCalls, 6);
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(result.metrics.tokensCharged, 900);
  assert.equal(result.plan.length, 3);
  assert.equal(result.graph.edges.length, 2);
  assert.ok(result.trace.some((item) => item.type === "handoff"));
  assert.equal(result.proposalHash.length, 64);
  assert.equal(result.proposalVersion, result.version);
  assert.match(fixture.calls[0].system, /untrusted DATA/);
  assert.ok(!JSON.stringify(result).includes("chainOfThought"));
});

test("scripted demo uses the actual tool registry and risk worker without model or external calendar calls", async () => {
  const fixture = harness({ realTools: true });
  const result = await run(fixture, { ...INPUT, symbol: "X", mode: "demo", context: "", objective: "Demonstrate the complete research workflow. ".repeat(20) });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.result.proposalStatus, "ready");
  assert.equal(result.result.risk.quantity, 2);
  assert.equal(result.metrics.steps, 10);
  assert.equal(result.metrics.toolCalls, 6);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.calendarRequests, 0);
  assert.match(result.result.thesis.summary, /ILLUSTRATIVE DEMO/);
  assert.deepEqual(fixture.toolCalls.map((call) => call.name), ["context.read", "calendar.read", "knowledge.search", "memory.search", "journal.search", "risk.check"]);
});

for (const paidCallsEnabled of [false, null, "true", 1]) {
  test(`paid brain runs require server activation before persistence or tools (${JSON.stringify(paidCallsEnabled)})`, async () => {
    const fixture = harness({ paidCallsEnabled, realTools: true });
    await assert.rejects(fixture.service.start("alice", { ...INPUT, paidCallsEnabled: true }), { code: "TRADER_PAID_AI_LOCKED", status: 423 });
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.toolCalls.length, 0);
    assert.equal(fixture.calendarRequests, 0);
    assert.deepEqual(await fixture.repository.listRuns("alice"), []);
    const result = await run(fixture, { ...INPUT, mode: "demo" });
    assert.equal(result.status, "awaiting_approval");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.calendarRequests, 0);
    await fixture.service.close();
    await fixture.repository.close();
  });
}

test("a strategist can request more research through a bounded handoff loop", async () => {
  const fixture = harness({ queues: {
    researcher: [toolAction("context.read"), toolAction("calendar.read"), handoff("strategist"), toolAction("knowledge.search", { query: "ES support" }), handoff("strategist")],
    strategist: [handoff("researcher"), finish()],
  } });
  const result = await run(fixture);
  assert.equal(result.status, "awaiting_approval");
  assert.ok(result.trace.some((item) => item.type === "handoff" && item.details?.from === "strategist" && item.details?.to === "researcher"));
  assert.ok(fixture.toolCalls.some((call) => call.name === "knowledge.search"));
});

test("an observed tool failure can trigger a corrective next action", async () => {
  let failed = false;
  const fixture = harness({ queues: { researcher: [toolAction("context.read"), toolAction("context.read"), toolAction("calendar.read"), handoff("strategist")] },
    executeTool: (request) => {
      if (request.name === "context.read" && !failed) { failed = true; throw new Error("SECRET upstream failure"); }
    },
  });
  const result = await run(fixture);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.result.proposalStatus, "ready");
  assert.equal(fixture.toolCalls.filter((call) => call.name === "context.read").length, 2);
  assert.ok(result.trace.some((item) => item.type === "tool_result" && item.details.ok === false));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

for (const [name, nextAction, code] of [
  ["unknown action", action("execute_order"), "BRAIN_ACTION_INVALID"],
  ["unknown tool", toolAction("broker.order", { quantity: 2 }), "BRAIN_TOOL_REJECTED"],
  ["forbidden role tool", toolAction("risk.check", { thesis: THESIS }), "BRAIN_TOOL_REJECTED"],
  ["unknown tool arguments", toolAction("context.read", { url: "https://example.com" }), "BRAIN_TOOL_REJECTED"],
  ["non-object tool arguments", action("tool", { tool: "context.read", argumentsJson: "[]" }), "BRAIN_TOOL_REJECTED"],
  ["self handoff", handoff("researcher"), "BRAIN_HANDOFF_INVALID"],
  ["extra hidden model field", { ...toolAction("context.read"), reasoning: "Unrequested internal reasoning" }, "BRAIN_ACTION_INVALID"],
]) {
  test(`${name} fails closed before tool execution`, async () => {
    const fixture = harness({ queues: { researcher: [nextAction] } });
    const result = await run(fixture);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, code);
    assert.equal(fixture.toolCalls.length, 0);
  });
}

test("cyclic planner dependencies fail before any action or tool", async () => {
  const plan = structuredClone(PLAN);
  plan.tasks[0].dependencies = ["critique"];
  const fixture = harness({ queues: { planner: [plan] } });
  const result = await run(fixture);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "BRAIN_OUTPUT_INVALID");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.toolCalls.length, 0);
});

test("critic revision runs strategy and exact risk again, with only one revision allowed", async () => {
  const fixture = harness({ queues: {
    strategist: [finish(), finish({ ...THESIS, stop: 99, target: 103 })],
    critic: [{ verdict: "revise", reason: "Use the nearer supplied invalidation.", revisionInstruction: "Revise stop to 99 and target to 103 from the manual evidence." },
      { verdict: "revise", reason: "More changes would be needed.", revisionInstruction: "Try another change." }],
  } });
  const result = await run(fixture);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.result.thesis.stop, 99);
  assert.equal(result.result.risk.quantity, 5);
  assert.equal(result.result.review.verdict, "wait");
  assert.equal(result.result.proposalStatus, "wait");
  assert.equal(fixture.toolCalls.filter((call) => call.name === "risk.check").length, 2);
  assert.equal(result.trace.filter((item) => item.type === "revision").length, 1);
});

for (const [name, thesis, calendar] of [
  ["unknown citation", { ...THESIS, evidence: ["Claim. [invented-source]"] }],
  ["uncited evidence", { ...THESIS, evidence: ["Unsupported claim."] }],
  ["wrong stop geometry", { ...THESIS, stop: 102 }],
  ["missing data", { ...THESIS, missingData: ["The higher-timeframe snapshot is missing."] }],
  ["stale calendar", THESIS, { state: "stale", truncated: false }],
  ["truncated calendar", THESIS, { state: "fresh", truncated: true }],
]) {
  test(`${name} cannot be made ready by a passing critic`, async () => {
    const fixture = harness({ queues: { strategist: [finish(thesis)] }, executeTool: (request) => {
      if (calendar && request.name === "calendar.read") return { ok: true, data: calendar, citations: [], truncated: calendar.truncated };
    } });
    const result = await run(fixture);
    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.result.review.verdict, "pass");
    assert.equal(result.result.proposalStatus, "wait");
    assert.equal(result.result.risk.passed, false);
    assert.equal(result.result.tradeExecutionAuthorized, false);
  });
}

test("a claimed snapshot citation is unavailable until context.read is observed", async () => {
  const fixture = harness({ queues: { researcher: [toolAction("calendar.read"), handoff("strategist")] } });
  const result = await run(fixture);
  assert.equal(result.result.proposalStatus, "wait");
  assert.match(result.result.thesis.missingData.join(" "), /context.read/);
});

test("a malformed critic response fails closed", async () => {
  const fixture = harness({ queues: { critic: [{ verdict: "pass" }] } });
  const result = await run(fixture);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "BRAIN_OUTPUT_INVALID");
  assert.equal(result.approval, null);
});

for (const [name, limits, code, maxCalls] of [
  ["steps", { maxSteps: 1 }, "BRAIN_STEP_LIMIT", 1],
  ["model calls", { maxModelCalls: 1 }, "BRAIN_MODEL_CALL_LIMIT", 1],
  ["tokens", { maxTokens: 1 }, "BRAIN_TOKEN_LIMIT", 0],
  ["money", { maxCostUsd: 0 }, "BRAIN_COST_LIMIT", 0],
]) {
  test(`${name} budget stops the workflow before an unauthorized next call`, async () => {
    const fixture = harness();
    const result = await run(fixture, { ...INPUT, limits });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, code);
    assert.equal(fixture.calls.length, maxCalls);
  });
}

test("a requested money cap requires configured pricing before any paid calls", async () => {
  const fixture = harness({ rates: null });
  await assert.rejects(fixture.service.start("alice", { ...INPUT, limits: { maxCostUsd: 1 } }), { code: "BRAIN_PRICING_REQUIRED" });
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.repository.listRuns("alice")).length, 0);
});

test("unknown usage consumes the conservative reservation and remains labeled unknown", async () => {
  const fixture = harness({ usage: null });
  const result = await run(fixture, { ...INPUT, limits: { maxModelCalls: 1 } });
  assert.equal(result.error.code, "BRAIN_MODEL_CALL_LIMIT");
  assert.equal(result.metrics.usageUnknownCalls, 1);
  assert.ok(result.metrics.tokensCharged > 1200);
  assert.equal(result.metrics.estimatedCostUsd, null);
});

test("total deadline aborts a model that ignores its signal", async () => {
  const fixture = harness({ generate: () => new Promise(() => {}) });
  const result = await run(fixture, { ...INPUT, limits: { maxDurationMs: 10 } });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "BRAIN_TIME_LIMIT");
  assert.equal(fixture.calls[0].signal.aborted, true);
});

test("start returns promptly and cancellation aborts the active call", async () => {
  const fixture = harness({ generate: () => new Promise(() => {}) });
  const initial = await fixture.service.start("alice", INPUT);
  assert.equal(initial.status, "running");
  await until(() => fixture.calls.length === 1);
  const cancelled = await fixture.service.cancel("alice", initial.id);
  assert.equal(cancelled.status, "cancelled");
  const final = await fixture.service.waitForRun("alice", initial.id);
  assert.equal(final.status, "cancelled");
  assert.equal(fixture.calls[0].signal.aborted, true);
  assert.ok(final.metrics.tokensCharged > 0);
  assert.equal(final.metrics.estimatedCostUsd, null);
});

test("one run per user and four global workers are enforced", async () => {
  const fixture = harness({ generate: () => new Promise(() => {}) });
  const first = await fixture.service.start("alice", INPUT);
  await assert.rejects(fixture.service.start("alice", INPUT), { code: "BRAIN_RUN_IN_PROGRESS" });
  const rest = await Promise.all(["bob", "charlie", "dana"].map((owner) => fixture.service.start(owner, INPUT)));
  await assert.rejects(fixture.service.start("erin", INPUT), { code: "BRAIN_BUSY" });
  await Promise.all([["alice", first], ...rest.map((value, index) => [["bob", "charlie", "dana"][index], value])].map(([owner, value]) => fixture.service.cancel(owner, value.id)));
  await fixture.service.close();
});

test("durable approval survives a service restart and writes one tenant-scoped memory", async () => {
  const fixture = harness();
  const pending = await run(fixture, { ...INPUT, mode: "demo", context: "" });
  const restarted = createBrainService({ repository: fixture.repository, knowledge: fixture.knowledge, tools: fixture.tools, modelGateway: fixture.modelGateway, now: () => TIME });
  const state = await restarted.getState("alice");
  assert.equal(state.runs[0].status, "awaiting_approval");
  const completed = await restarted.decide("alice", pending.id, { version: pending.version, decision: "approve", note: "Save this research only." });
  assert.equal(completed.status, "completed");
  assert.equal(completed.approval.scope, "research_and_memory");
  assert.equal(completed.approval.tradeExecutionAuthorized, false);
  const replay = await restarted.decide("alice", pending.id, { version: pending.version, decision: "approve" });
  assert.equal(replay.version, completed.version);
  const documents = await fixture.repository.listDocuments("alice");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, `run:${pending.id}`);
  assert.match(documents[0].text, /Trade execution authorized: false/);
  assert.equal((await fixture.repository.listDocuments("bob")).length, 0);
  assert.equal((await restarted.getState("bob")).runs.length, 0);
  await assert.rejects(restarted.getRun("bob", pending.id), { code: "BRAIN_NOT_FOUND" });
  assert.equal(fixture.calls.length, 0);
});

test("stale approval versions and modified proposal hashes are rejected", async () => {
  const fixture = harness();
  const pending = await run(fixture, { ...INPUT, mode: "demo", context: "" });
  await assert.rejects(fixture.service.decide("alice", pending.id, { version: pending.version - 1, decision: "approve" }), { code: "BRAIN_CONFLICT" });
  const tampered = structuredClone(pending);
  tampered.result.thesis.target = 999;
  tampered.proposalVersion = pending.version + 1;
  const saved = await fixture.repository.saveRun("alice", tampered, { expectedVersion: pending.version });
  await assert.rejects(fixture.service.decide("alice", pending.id, { version: saved.version, decision: "approve" }), { code: "BRAIN_CONFLICT" });
  assert.equal((await fixture.repository.listDocuments("alice")).length, 0);
});

test("approval CAS permits only one concurrent decision and never creates duplicate memory", async () => {
  const fixture = harness();
  const pending = await run(fixture, { ...INPUT, mode: "demo", context: "" });
  const outcomes = await Promise.allSettled([
    fixture.service.decide("alice", pending.id, { version: pending.version, decision: "approve" }),
    fixture.service.decide("alice", pending.id, { version: pending.version, decision: "reject" }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal((await fixture.repository.listDocuments("alice")).length, 1);
});

test("an approving checkpoint resumes only on explicit approval and upserts the same document", async () => {
  const fixture = harness();
  const pending = await run(fixture, { ...INPUT, mode: "demo", context: "" });
  const originalSave = fixture.repository.saveRun;
  let failCompletion = true;
  fixture.repository.saveRun = async (...args) => {
    if (args[1].status === "completed" && failCompletion) { failCompletion = false; throw new Error("Simulated persistence interruption"); }
    return originalSave(...args);
  };
  await assert.rejects(fixture.service.decide("alice", pending.id, { version: pending.version, decision: "approve" }), { code: "BRAIN_APPROVAL_RETRY" });
  const checkpoint = await fixture.service.getRun("alice", pending.id);
  assert.equal(checkpoint.status, "approving");
  assert.equal((await fixture.repository.listDocuments("alice")).length, 1);
  const restarted = createBrainService({ repository: fixture.repository, tools: fixture.tools, modelGateway: fixture.modelGateway, now: () => TIME });
  assert.equal((await restarted.getState("alice")).runs[0].status, "approving");
  await assert.rejects(restarted.decide("alice", pending.id, { version: checkpoint.version, decision: "reject" }), { code: "BRAIN_CONFLICT" });
  const completed = await restarted.decide("alice", pending.id, { version: checkpoint.version, decision: "approve" });
  assert.equal(completed.status, "completed");
  assert.equal((await fixture.repository.listDocuments("alice")).length, 1);
});

test("rejection stores no memory and releases the user's checkpoint", async () => {
  const fixture = harness();
  const pending = await run(fixture, { ...INPUT, mode: "demo", context: "" });
  const rejected = await fixture.service.decide("alice", pending.id, { version: pending.version, decision: "reject" });
  assert.equal(rejected.status, "rejected");
  assert.equal((await fixture.repository.listDocuments("alice")).length, 0);
  const next = await run(fixture, { ...INPUT, mode: "demo", context: "" });
  assert.equal(next.status, "awaiting_approval");
});

test("a persisted orphan running state is interrupted without repeating paid work", async () => {
  const fixture = harness();
  await fixture.repository.saveRun("alice", { id: "orphan", status: "running", createdAt: TIME.toISOString(), updatedAt: TIME.toISOString(), trace: [], metrics: {} });
  const state = await fixture.service.getState("alice");
  assert.equal(state.runs[0].status, "failed");
  assert.equal(state.runs[0].error.code, "BRAIN_INTERRUPTED");
  assert.equal(fixture.calls.length, 0);
  const next = await run(fixture, { ...INPUT, mode: "demo", context: "" });
  assert.equal(next.status, "awaiting_approval");
});

test("shutdown aborts and awaits active workers and rejects new starts", async () => {
  const fixture = harness({ generate: () => new Promise(() => {}) });
  const initial = await fixture.service.start("alice", INPUT);
  await until(() => fixture.calls.length > 0);
  await fixture.service.close();
  const result = await fixture.service.getRun("alice", initial.id);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "BRAIN_INTERRUPTED");
  assert.equal(fixture.calls[0].signal.aborted, true);
  await assert.rejects(fixture.service.start("bob", INPUT), { code: "BRAIN_CLOSED" });
});

test("another service instance preserves a foreign workflow with an unexpired execution lease", async () => {
  const first = harness({ generate: () => new Promise(() => {}) });
  const initial = await first.service.start("alice", INPUT);
  await until(() => first.calls.length > 0);
  const second = harness({ repository: first.repository });
  const state = await second.service.getState("alice");
  assert.equal(state.runs[0].status, "running");
  assert.equal(state.runs[0].error, null);
  assert.ok(state.runs[0].execution.ownerId);
  assert.equal(Date.parse(state.runs[0].execution.deadlineAt), TIME.valueOf() + 121000);
  assert.equal((await first.repository.getRun("alice", initial.id)).status, "running");
  await first.service.cancel("alice", initial.id);
  await first.service.close();
});

test("expired foreign leases recover without repeating a paid call", async () => {
  const fixture = harness();
  await fixture.repository.saveRun("alice", { id: "expired", status: "running", createdAt: TIME.toISOString(), updatedAt: TIME.toISOString(), trace: [], metrics: {},
    execution: { ownerId: "other-process", deadlineAt: new Date(TIME.valueOf() - 1).toISOString() } });
  const state = await fixture.service.getState("alice");
  assert.equal(state.runs[0].status, "failed");
  assert.equal(state.runs[0].error.code, "BRAIN_INTERRUPTED");
  assert.equal(fixture.calls.length, 0);
});

test("concurrent service instances admit only one durable active run per owner", async () => {
  const first = harness({ generate: () => new Promise(() => {}) });
  let otherIds = 0;
  const second = harness({ repository: first.repository, idFactory: () => `other-${++otherIds}`, generate: () => new Promise(() => {}) });
  const results = await Promise.allSettled([first.service.start("alice", INPUT), second.service.start("alice", INPUT)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "BRAIN_RUN_IN_PROGRESS");
  await until(() => first.calls.length + second.calls.length === 1);
  assert.equal((await first.repository.listRuns("alice")).length, 1);
  await Promise.all([first.service.close(), second.service.close()]);
});

test("a foreign cancellation prevents further actions and discards an already-sent model response", async () => {
  let resolveCall;
  const first = harness({ generate: () => new Promise((resolve) => { resolveCall = resolve; }) });
  const initial = await first.service.start("alice", INPUT);
  await until(() => first.calls.length > 0);
  const second = harness({ repository: first.repository });
  const cancelled = await second.service.cancel("alice", initial.id);
  assert.equal(cancelled.status, "cancelled");
  resolveCall({ data: PLAN, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, totalTokens: 150 }, estimatedCostUsd: 0.0002, cache: { status: "miss" } });
  const result = await first.service.waitForRun("alice", initial.id);
  assert.equal(result.status, "cancelled");
  assert.equal(first.calls.length, 1);
  assert.equal(first.toolCalls.length, 0);
  assert.equal(first.calls[0].signal.aborted, true);
  assert.equal(result.result, null);
});

test("repeated missions reuse the durable planner cache while market roles receive fresh clocks", async () => {
  let clock = TIME;
  const repository = createMemoryBrainRepository({ now: () => clock });
  const fixture = harness({ repository });
  const backendCalls = [];
  const requests = [];
  let researchActions = 0;
  const aiProvider = {
    getStatus: () => fixture.modelGateway.getStatus(),
    async generateDetailed(request) {
      const role = request.system.match(/Current role: (\w+)/)?.[1];
      backendCalls.push({ role, ...request });
      const researchScript = [toolAction("context.read"), toolAction("calendar.read"), handoff("strategist")];
      const data = role === "planner" ? PLAN : role === "researcher" ? researchScript[researchActions++ % researchScript.length] : role === "strategist" ? finish() : REVIEW;
      return { data: structuredClone(data), provider: request.provider, model: `test-${request.provider}`,
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 150 }, latencyMs: 1 };
    },
  };
  const createService = () => {
    const gateway = createBrainModelGateway({ aiProvider, repository, now: () => clock,
      pricing: { gemini: { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.1 } } });
    const modelGateway = { ...gateway, async generate(owner, request) { requests.push(structuredClone({ ...request, signal: undefined })); return gateway.generate(owner, request); } };
    return createBrainService({ repository, tools: fixture.tools, modelGateway, now: () => clock });
  };
  const firstService = createService();
  const firstStart = await firstService.start("alice", INPUT);
  const first = await firstService.waitForRun("alice", firstStart.id);
  assert.equal(first.status, "awaiting_approval", JSON.stringify(first.error));
  await firstService.decide("alice", first.id, { version: first.version, decision: "reject" });
  await firstService.close();
  clock = new Date(TIME.valueOf() + 10000);
  const secondService = createService();
  const secondStart = await secondService.start("alice", INPUT);
  const second = await secondService.waitForRun("alice", secondStart.id);
  assert.equal(second.status, "awaiting_approval");
  assert.equal(second.metrics.cacheHits, 1);
  assert.equal(backendCalls.filter((call) => call.role === "planner").length, 1);
  const planners = requests.filter((request) => request.system.includes("Current role: planner."));
  assert.equal(planners.length, 2);
  assert.equal(planners[0].prompt, planners[1].prompt);
  assert.equal(Object.hasOwn(JSON.parse(planners[0].prompt), "asOfUtc"), false);
  for (const role of ["researcher", "strategist", "critic"]) {
    const times = new Set(requests.filter((request) => request.system.includes(`Current role: ${role}.`)).map((request) => JSON.parse(request.prompt).asOfUtc));
    assert.deepEqual([...times], [TIME.toISOString(), clock.toISOString()]);
  }
  assert.ok(requests.every((request) => request.cacheTtlMs === 60000));
  await secondService.close();
});
