import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSqliteBrokerRepository } from "../../src/brokers/broker-repository.js";
import { DEFAULT_POLICY, planTrades } from "../../src/robinhood-brain/risk-policy.js";
import { buildEquityOrder, pointer, validateBindings, verifyOrderPreview } from "../../src/robinhood-brain/broker-evidence.js";
import { rhBrainHarness, rhSnapshot, RH_BRAIN_NOW, RH_POLICY, RH_BINDINGS } from "../helpers/robinhood-brain-test-helpers.js";

test("the offline demo creates isolated research without provider/broker calls or validated days", async t => {
  const h = rhBrainHarness(); t.after(async () => { await h.service.close(); await h.broker.close(); });
  const run = await h.service.run("alice", { mode: "demo" });
  assert.equal(run.status, "completed", run.error); assert.equal(run.source, "demo"); assert.equal(run.modelCalls, 0);
  assert.equal(h.calls.length, 0); assert.equal(h.modelCalls.length, 0); assert.equal(run.executions[0].status, "simulated");
  assert.equal((await h.service.state("alice")).dryDays.length, 0); assert.equal((await h.service.state("bob")).runs.length, 0);
  assert.ok(!JSON.stringify(await h.service.state("alice")).includes("fixture-never-expose-token"));
});

test("broker paper cycles use selected research and critic providers, obey held-position limits, and persist lessons", async t => {
  const h = rhBrainHarness(); t.after(async () => { await h.service.close(); await h.broker.close(); }); await h.connect();
  await h.service.note("alice", { text: "Check the actual broker evidence before trusting a thesis." });
  const run = await h.service.run("alice", { mode: "cycle" }); assert.equal(run.status, "completed", run.error);
  assert.deepEqual(h.modelCalls, ["grok", "claude"]); assert.equal(run.executions[0].status, "filled");
  assert.equal(h.calls.filter(row => row.name === "place_equity_order").length, 0);
  const state = await h.service.state("alice"); assert.equal(state.paper.positions.length, 1); assert.equal(state.paper.cash, 9940);
  assert.equal(state.dryDays.length, 1); assert.equal(state.notes.length, 1); assert.equal(state.memories.length, 1);
  await h.service.run("alice", { mode: "cycle" }); assert.equal((await h.service.state("alice")).paper.positions.length, 1);
  assert.equal((await h.service.state("alice")).dryDays.length, 1);
});

test("cash and loss gates block entries while stop losses still precede buys", () => {
  const snapshot = rhSnapshot(), thesis = { symbol: "DEMO", direction: "long", conviction: "high", critic: "pass", riskFlags: [], thesisPrice: 50 };
  snapshot.account.dailyPnl = -600;
  snapshot.positions = [{ symbol: "DEMO", quantity: 10, averageCost: 60, value: 499.5, holdingId: "holding", openedAt: "2026-10-01T15:30:00Z" }];
  const plan = planTrades({ snapshot, theses: [thesis], policy: RH_POLICY, now: RH_BRAIN_NOW });
  assert.equal(plan.entriesHalted, true); assert.equal(plan.orders[0].side, "sell"); assert.equal(plan.orders[0].reason, "stop_loss");
  assert.ok(!plan.orders.some(row => row.side === "buy"));
  const cash = rhSnapshot(); cash.account.cash = 100;
  assert.equal(planTrades({ snapshot: cash, theses: [thesis], policy: RH_POLICY, now: RH_BRAIN_NOW }).orders.length, 0);
});

test("tiered profits cascade against the remaining quantity and do not refire for the same holding", () => {
  const snapshot = rhSnapshot(); snapshot.markets[0].bid = 80; snapshot.markets[0].ask = 80.1;
  snapshot.positions = [{ symbol: "DEMO", quantity: 100, averageCost: 50, value: 8000, holdingId: "holding", openedAt: "2026-10-01T15:30:00Z" }];
  const plan = planTrades({ snapshot, theses: [], policy: RH_POLICY, now: RH_BRAIN_NOW });
  assert.equal(plan.orders[0].quantity, 57.8125); assert.deepEqual(plan.orders[0].tiers, [0, 1, 2]);
  assert.equal(planTrades({ snapshot, theses: [], policy: RH_POLICY, now: RH_BRAIN_NOW,
    ledger: [{ symbol: "DEMO", holdingId: "holding", status: "filled", tiers: [0, 1, 2] }] }).orders.length, 0);
});

test("missing account, tax-history, earnings or quote evidence never becomes permission to buy", () => {
  const thesis = { symbol: "DEMO", direction: "long", conviction: "high", critic: "pass", riskFlags: [], thesisPrice: 50 };
  for (const key of ["lossHistoryComplete", "earningsKnown", "quoteAt", "isLeveraged", "tradable"]) {
    const snapshot = rhSnapshot(); delete snapshot.markets[0][key];
    assert.equal(planTrades({ snapshot, theses: [thesis], policy: RH_POLICY, now: RH_BRAIN_NOW }).orders.length, 0, key);
  }
  const snapshot = rhSnapshot(); snapshot.account.number = "another-account";
  assert.ok(planTrades({ snapshot, theses: [thesis], policy: RH_POLICY, now: RH_BRAIN_NOW }).blocked.length);
});

test("broker mappings reject write tools, unsafe pointers and unsupported order schemas", () => {
  assert.throws(() => validateBindings([{ kind: "account", tool: "place_equity_order", root: "", fields: {}, arguments: {} }]), { code: "RH_BRAIN_ADAPTER" });
  assert.equal(pointer({ value: 4 }, "/__proto__/constructor"), undefined);
  assert.throws(() => buildEquityOrder({ name: "place_equity_order", inputSchema: { properties: { symbol: {} } } }, {}, "account", "id"), { code: "RH_BRAIN_ADAPTER" });
});

test("unknown preview approval, warnings and excessive costs cannot authorize autonomous orders", () => {
  const binding = RH_BINDINGS.find(row => row.kind === "preview"), order = { side: "buy", notional: 60 }, account = rhSnapshot().account;
  for (const preview of [{ valid: true }, { valid: true, warnings: ["Broker warning"], cost: 60 }, { valid: true, warnings: [], cost: 101 }]) {
    assert.throws(() => verifyOrderPreview({ structuredContent: preview }, binding, order, account, RH_POLICY), { code: "RH_BRAIN_RISK" });
  }
});

test("malformed financial facts are blocked instead of coerced into an entry", () => {
  const thesis = { symbol: "DEMO", direction: "long", conviction: "high", critic: "pass", riskFlags: [], thesisPrice: 50 };
  for (const key of ["earningsDays", "lossSaleDays"]) {
    const snapshot = rhSnapshot(); snapshot.markets[0][key] = "unknown";
    assert.equal(planTrades({ snapshot, theses: [thesis], policy: RH_POLICY, now: RH_BRAIN_NOW }).orders.length, 0);
  }
  const snapshot = rhSnapshot(); snapshot.account.cash = true;
  assert.ok(planTrades({ snapshot, theses: [], policy: RH_POLICY, now: RH_BRAIN_NOW }).blocked.length);
});

test("pausing during model research blocks previews and orders, and policy changes revoke consent", async t => {
  let entered, release; const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = rhBrainHarness({ beforeModel: async () => { entered(); await gate; } });
  t.after(async () => { await h.service.close(); await h.broker.close(); }); await h.connect();
  const pending = h.service.run("alice", { mode: "cycle" }); await reached; await h.service.pause("alice"); release();
  assert.equal((await pending).status, "cancelled"); assert.equal(h.calls.filter(row => /review_|place_/.test(row.name)).length, 0);
  const state = await h.service.state("alice"); await h.service.configure("alice", { version: state.version, policy: { ...RH_POLICY, provider: "openai" }, bindings: RH_BINDINGS });
  assert.equal((await h.service.state("alice")).consent, null); assert.equal((await h.service.state("alice")).verifiedAt, null);
});

test("reviewed execution creates a real broker preview and reserves it without submitting", async t => {
  const h = rhBrainHarness(); t.after(async () => { await h.service.close(); await h.broker.close(); }); await h.connect();
  await h.service.start("alice", { version: 2, mode: "review" }); await h.tick();
  const state = await h.service.state("alice"); assert.equal(state.ledger[0].status, "awaiting_approval");
  assert.equal(h.calls.filter(row => row.name === "review_equity_order").length, 1);
  assert.equal(h.calls.filter(row => row.name === "place_equity_order").length, 0);
  await h.service.pause("alice"); await assert.rejects(h.service.run("alice", { mode: "cycle" }), { code: "RH_BRAIN_RECONCILE" });
});

test("autonomous activation is blocked without switches, consent and ten distinct verified days", async t => {
  const h = rhBrainHarness(); t.after(async () => { await h.service.close(); await h.broker.close(); }); await h.connect();
  await assert.rejects(h.service.start("alice", { version: 2, mode: "autonomous", authorizeAutonomous: true }), { code: "RH_BRAIN_AUTHORITY" });
  assert.equal(h.calls.filter(row => row.name === "place_equity_order").length, 0);
});

test("policy-authorized submission dispatches once, stays reserved until a verified broker fill, then reconciles", async t => {
  const h = rhBrainHarness({ liveEnabled: true, autonomousEnabled: true }); t.after(async () => { await h.service.close(); await h.broker.close(); }); await h.connect();
  await h.broker.pause("alice", false);
  await h.broker.updateBrainWorkspace("alice", workspace => { workspace.agentic.dryDays = Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`); });
  await h.service.start("alice", { version: 2, mode: "autonomous", authorizeAutonomous: true }); await h.tick();
  let state = await h.service.state("alice"); assert.equal(state.runs[0].status, "completed", state.runs[0].error);
  assert.equal(h.calls.filter(row => row.name === "place_equity_order").length, 1); assert.equal(state.ledger[0].status, "submitted");
  assert.equal((await h.broker.state("alice")).unattendedTrading, true);
  const entry = state.ledger[0]; assert.equal((await h.broker.state("alice")).actions[0].authority, "operator_policy");
  h.snapshot.orders.push({ requestId: entry.requestId, number: RH_POLICY.accountNumber, status: "filled", filledQuantity: entry.quantity, averagePrice: 50, symbol: "DEMO", side: "buy" });
  await h.service.reconcile("alice"); state = await h.service.state("alice"); assert.equal(state.ledger[0].status, "filled");
  assert.equal((await h.broker.state("alice")).actions[0].status, "reconciled");
});

test("broker dispatch timeouts produce unknown outcomes and are never replayed", async t => {
  const h = rhBrainHarness({ liveEnabled: true, autonomousEnabled: true, beforeOrder: async () => { throw new Error("Uncertain fixture transport"); } });
  t.after(async () => { await h.service.close(); await h.broker.close(); }); await h.connect(); await h.broker.pause("alice", false);
  await h.broker.updateBrainWorkspace("alice", workspace => { workspace.agentic.dryDays = Array.from({ length: 10 }, (_, i) => String(i)); });
  await h.service.start("alice", { version: 2, mode: "autonomous", authorizeAutonomous: true }); await h.tick();
  const state = await h.service.state("alice"); assert.equal(state.ledger[0].status, "unknown"); assert.equal(state.worker.running, false);
  assert.equal(h.calls.filter(row => row.name === "place_equity_order").length, 1);
  await assert.rejects(h.service.run("alice", { mode: "cycle" })); assert.equal(h.calls.filter(row => row.name === "place_equity_order").length, 1);
});

test("independent reviewer wait prevents entries", async t => {
  const h = rhBrainHarness({ critic: "wait" }); t.after(async () => { await h.service.close(); await h.broker.close(); }); await h.connect();
  const run = await h.service.run("alice", { mode: "cycle" }); assert.equal(run.status, "completed"); assert.equal(run.executions.length, 0);
});

test("broker brain metadata persists in SQLite independently from connection secrets and other owners", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "synergy-rh-brain-test-")); assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const filename = path.join(directory, "broker.sqlite"), first = rhBrainHarness({ repository: createSqliteBrokerRepository(filename) });
  await first.service.note("alice", { text: "Durable Robinhood lesson" }); await first.service.run("alice", { mode: "demo" }); await first.service.close(); await first.broker.close();
  const second = rhBrainHarness({ repository: createSqliteBrokerRepository(filename) });
  assert.equal((await second.service.state("alice")).notes[0].text, "Durable Robinhood lesson");
  assert.equal((await second.service.state("bob")).runs.length, 0); await second.service.close(); await second.broker.close();
});
