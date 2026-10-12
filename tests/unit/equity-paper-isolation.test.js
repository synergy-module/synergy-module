import test from "node:test";
import assert from "node:assert/strict";
import { createEquityPaperBroker } from "../../src/practice/equity-paper-broker.js";
import { createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createRobinhoodBrainService } from "../../src/robinhood-brain/brain-service.js";
import { rhBrainHarness, RH_BRAIN_NOW, RH_POLICY, RH_BINDINGS } from "../helpers/robinhood-brain-test-helpers.js";

test("equity forward paper cycles persist separate virtual balances with no brokerage write authority", async t => {
  const h = rhBrainHarness(); await h.connect();
  const adapter = createEquityPaperBroker({ broker: h.broker, repository: createMemoryWorkspaceRepository() });
  const service = createRobinhoodBrainService({ broker: adapter, ai: h.ai, environment: "paper", now: () => RH_BRAIN_NOW });
  t.after(async () => { await service.close(); await h.service.close(); await h.broker.close(); });
  const original = await h.broker.readBrainWorkspace("alice");
  await service.configure("alice", { version: 1, policy: RH_POLICY, bindings: RH_BINDINGS }); await service.verify("alice");
  const result = await service.run("alice", { mode: "cycle" }); assert.equal(result.status, "completed", result.error);
  const state = await service.state("alice");
  assert.equal(state.environment, "PAPER"); assert.equal(state.paper.positions.length, 1); assert.equal(state.paper.cash, 9940);
  assert.deepEqual(await h.broker.readBrainWorkspace("alice"), original);
  assert.equal((await h.broker.state("alice")).actions.length, 0);
  assert.equal(h.calls.some(c => c.name === "place_equity_order" || c.name === "review_equity_order"), false);
  assert.equal((await service.state("bob")).paper.positions.length, 0);
  assert.throws(() => adapter.propose("alice", {}), { status: 423 }); assert.throws(() => adapter.submitAgentic("alice", "x"), { status: 423 });
  await assert.rejects(service.start("alice", { mode: "autonomous", version: 2 }), { status: 423 });
});

test("live readiness uses only matching independent paper policy and never imports paper orders", async t => {
  const h = rhBrainHarness(); await h.connect();
  const adapter = createEquityPaperBroker({ broker: h.broker, repository: createMemoryWorkspaceRepository() });
  await adapter.updateBrainWorkspace("alice", s => { s.agentic = { policy: RH_POLICY, bindings: RH_BINDINGS, dryDays: ["2026-10-01"] }; });
  const live = createRobinhoodBrainService({ broker: h.broker, ai: h.ai, environment: "live", paperQualification: owner => adapter.readBrainWorkspace(owner), now: () => RH_BRAIN_NOW });
  t.after(async () => { await live.close(); await h.service.close(); await h.broker.close(); });
  let state = await live.state("alice"); assert.deepEqual(state.dryDays, ["2026-10-01"]); assert.equal(state.ledger.length, 0);
  await adapter.updateBrainWorkspace("alice", s => { s.agentic.policy.orderBudgetUsd += 1; });
  state = await live.state("alice"); assert.deepEqual(state.dryDays, []);
  await assert.rejects(live.start("alice", { mode: "paper", version: 2 }), { status: 423 });
  await assert.rejects(live.run("alice", { mode: "demo" }), { status: 423 });
});

test("paper research and verification expose only virtual balances and holdings in structured data and citations", async t => {
  const prompts = [], h = rhBrainHarness({ beforeModel: request => { prompts.push(JSON.parse(request.prompt)); } }); await h.connect();
  h.snapshot.account.cash = 987654.321; h.snapshot.account.equity = 999999.123;
  h.snapshot.account.ordersClear = false;
  h.snapshot.positions = [{ symbol: "LIVE", quantity: 900, averageCost: 500, value: 450000, holdingId: "LIVE_HOLDING_PRIVATE", openedAt: "2026-10-01T00:00:00Z" }];
  h.snapshot.orders = [{ requestId: "LIVE_ORDER_PRIVATE", status: "filled", filledQuantity: 900, averagePrice: 500, symbol: "LIVE", side: "buy", number: RH_POLICY.accountNumber }];
  const adapter = createEquityPaperBroker({ broker: h.broker, repository: createMemoryWorkspaceRepository() });
  const service = createRobinhoodBrainService({ broker: adapter, ai: h.ai, environment: "paper", now: () => RH_BRAIN_NOW });
  t.after(async () => { await service.close(); await h.service.close(); await h.broker.close(); });
  await service.configure("alice", { version: 1, policy: RH_POLICY, bindings: RH_BINDINGS });
  await adapter.updateBrainWorkspace("alice", workspace => { workspace.agentic.paper = { ...workspace.agentic.paper, initialized: true, cash: 4321,
    positions: [{ symbol: "DEMO", quantity: 2, averageCost: 49, value: 100, markPrice: 50, holdingId: "PAPER_HOLDING", openedAt: "2026-10-01T00:00:00Z" }] }; });
  const verified = await service.verify("alice");
  assert.equal(verified.snapshot.account.cash, 4321); assert.equal(verified.snapshot.positions[0].holdingId, "PAPER_HOLDING"); assert.deepEqual(verified.snapshot.orders, []); assert.equal(verified.snapshot.account.ordersClear, true);
  const run = await service.run("alice", { mode: "cycle" }); assert.equal(run.status, "completed", run.error); assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].holdings.map(position => position.symbol), ["DEMO"]);
  for (const prompt of prompts) {
    assert.doesNotMatch(JSON.stringify(prompt), /987654\.321|999999\.123|LIVE_HOLDING_PRIVATE|LIVE_ORDER_PRIVATE/);
    for (const source of prompt.observations.filter(source => source.kind !== "markets")) assert.match(source.tool, /^virtual\.paper\./);
    assert.equal(JSON.parse(prompt.observations.find(source => source.kind === "account").excerpt)[0].cash, 4321);
    assert.equal(JSON.parse(prompt.observations.find(source => source.kind === "positions").excerpt)[0].holdingId, "PAPER_HOLDING");
  }
  const state = await service.state("alice");
  await assert.rejects(service.configure("alice", { version: state.version, policy: { ...RH_POLICY, symbols: ["SPY"] }, bindings: RH_BINDINGS }), { code: "RH_BRAIN_CONFLICT" });
  assert.deepEqual((await service.state("alice")).policy.symbols, ["DEMO"]);
});
