import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryWorkspaceRepository, createSqliteWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createPolymarketService } from "../../src/polymarket/polymarket-service.js";
import { simulateFill, analyzeMarket } from "../../src/polymarket/polymarket-analysis.js";
import { normalizeMarket, normalizeBook } from "../../src/polymarket/polymarket-client.js";
import { POLY_NOW, POLY_ADDRESS, rawPolyMarket, rawPolyBook, polyFixture, manualPolyTimers } from "../helpers/polymarket-test-helpers.js";

function fixture(options = {}) {
  const timers = manualPolyTimers(), repository = options.repository ?? createMemoryWorkspaceRepository();
  const upstream = polyFixture(options), service = createPolymarketService({ repository, client: upstream.client, now: () => POLY_NOW, ...timers, ...options });
  return { timers, repository, service, ...upstream };
}

test("research and memory are isolated from other owners and the original Brain", async () => {
  const { service, repository } = fixture();
  await repository.update("alice", state => { state.providers = { secret: { ciphertext: "private" } }; state.drafts.research = { fields: { objective: "Original brain" } }; });
  const note = await service.note("alice", { text: "Official event rules matter.", marketId: "123" });
  const report = await service.research("alice", { marketId: "123" });
  assert.equal(report.analysis.eligible, true); assert.equal(report.analysis.relatedNotes[0].id, note.id);
  assert.equal(report.sources.length, 4); assert.equal((await service.state("bob")).research.length, 0);
  assert.equal((await service.state("alice")).providers, undefined);
  assert.equal((await repository.read("alice")).drafts.research.fields.objective, "Original brain");
  await assert.rejects(service.remove("bob", "research", report.id), { code: "POLY_NOT_FOUND" });
});

test("SQLite retains Polymarket watchlists and research after reopening", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "synergy-poly-test-"));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "workspace.sqlite"), repository = createSqliteWorkspaceRepository(filename);
  const first = fixture({ repository });
  await first.service.watch("alice", { marketId: "123", watching: true }); await first.service.research("alice", { marketId: "123" });
  await first.service.close(); await repository.close();
  const reopened = createSqliteWorkspaceRepository(filename), second = fixture({ repository: reopened });
  assert.deepEqual((await second.service.state("alice")).watchlist, ["123"]);
  assert.equal((await second.service.state("alice")).research.length, 1);
  await second.service.close(); await reopened.close();
});

test("paper fills walk price levels, reserve fees, and reject stale or insufficient depth", () => {
  const book = normalizeBook(rawPolyBook("111", { asks: [{ price: "0.8", size: "10" }, { price: "0.805", size: "100" }] }), "111", POLY_NOW.toISOString());
  const fill = simulateFill({ book, side: "BUY", fee: { rate: 0.04, exponent: 1 }, budget: 20, slippageBps: 100, now: POLY_NOW });
  assert.ok(fill.shares > 10); assert.ok(fill.price > 0.8); assert.ok(fill.fee > 0); assert.ok(-fill.cashChange <= 20.00001);
  assert.throws(() => simulateFill({ book, side: "SELL", fee: { rate: 0, exponent: 1 }, shares: 2000, slippageBps: 100, now: POLY_NOW }), /Not enough bid depth/);
  assert.throws(() => simulateFill({ book: { ...book, timestamp: "2026-10-11T00:00:00Z" }, fee: { rate: 0, exponent: 1 }, side: "BUY", budget: 20, slippageBps: 100, now: POLY_NOW }), /Fresh depth/);
  assert.throws(() => simulateFill({ book, fee: null, side: "BUY", budget: 20, slippageBps: 100, now: POLY_NOW }), /verified fee/);
});

test("missing book, fees or activity cannot pass convergence screening", () => {
  const market = normalizeMarket(rawPolyMarket({ feesEnabled: true }), POLY_NOW.toISOString());
  const analysis = analyzeMarket(market, [null, null], null, [], POLY_NOW);
  assert.equal(analysis.eligible, false); assert.equal(analysis.spread, null); assert.equal(analysis.netFlowUsd, 0);
  assert.equal(analysis.gates.find(gate => gate.name === "Known fees").pass, false);
});

test("the paper worker records fills, respects duplicate markets and closes at current bids", async t => {
  const { service, timers } = fixture(); t.after(() => service.close());
  await service.start("alice", {}); await timers.tick();
  let state = await service.state("alice"); assert.equal(state.paper.positions.length, 1); assert.equal(state.paper.trades[0].side, "BUY");
  assert.ok(state.paper.cash < 10000); assert.equal(state.liveEnabled, false); assert.equal(state.mode, "PAPER");
  await timers.tick(); assert.equal((await service.state("alice")).paper.positions.length, 1);
  await assert.rejects(service.settings("alice", { positionUsd: 100 }), { code: "POLY_CONFLICT" });
  await service.pause("alice"); const id = (await service.state("alice")).paper.positions[0].id;
  state = await service.closePosition("alice", id); assert.equal(state.paper.positions.length, 0); assert.equal(state.paper.trades[0].side, "SELL");
  assert.ok(state.paper.realizedPnl < 0); await assert.rejects(service.closePosition("alice", id), { code: "POLY_NOT_FOUND" });
});

test("pausing while a scan is in flight prevents a later buy", async t => {
  let release, entered; const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { service, timers } = fixture({ beforeFetch: async url => { if (url.pathname === "/markets/123") { entered(); await gate; } } });
  t.after(() => service.close()); await service.start("alice", {}); const cycle = timers.tick(); await reached;
  await service.pause("alice"); release(); await cycle;
  assert.equal((await service.state("alice")).paper.trades.length, 0); assert.equal((await service.state("alice")).paper.bot.running, false);
});

test("exposure and equity loss limits block new entries, and two workers cannot start the same owner", async t => {
  const one = fixture(), two = fixture({ repository: one.repository }); t.after(() => one.service.close()); t.after(() => two.service.close());
  await one.service.settings("alice", { maxExposureUsd: 10, positionUsd: 10 });
  await one.service.start("alice", {}); await assert.rejects(two.service.start("alice", {}), { code: "POLY_CONFLICT" });
  await one.timers.tick(); assert.equal((await one.service.state("alice")).paper.positions.length, 1);
  await one.timers.tick(); assert.equal((await one.service.state("alice")).paper.trades.length, 1);
  await one.service.pause("alice");
  await one.repository.update("alice", state => { state.polymarket.paper.cash -= 400; });
  await assert.rejects(one.service.start("alice", {}), { code: "POLY_RISK" });
});

test("access removal pauses a running worker, and submitted state cannot enable live orders", async t => {
  let allowed = true; const { service, timers } = fixture({ canOperate: async () => allowed }); t.after(() => service.close());
  await assert.rejects(service.start("alice", { mode: "LIVE" }), { code: "POLY_INPUT" });
  await assert.rejects(service.settings("alice", { slippageBps: NaN }), { code: "POLY_INPUT" });
  await service.start("alice", {}); allowed = false; await timers.tick();
  assert.equal((await service.state("alice")).paper.bot.running, false); assert.equal((await service.state("alice")).paper.trades.length, 0);
  await service.address("alice", { address: POLY_ADDRESS, following: true }); assert.equal((await service.radar("alice")).activity.length, 1);
});

test("access revoked during market retrieval prevents a later fill", async t => {
  let allowed = true, release, entered;
  const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { service, timers } = fixture({ canOperate: async () => allowed,
    beforeFetch: async url => { if (url.pathname === "/markets/123") { entered(); await gate; } } });
  t.after(() => service.close()); await service.start("alice", {}); const work = timers.tick(); await reached;
  allowed = false; release(); await work;
  assert.equal((await service.state("alice")).paper.trades.length, 0);
  assert.equal((await service.state("alice")).paper.bot.running, false);
});

test("watchlist markets outside the discovery page are still inspected by the worker", async t => {
  const base = polyFixture().client;
  const inspected = [];
  const client = { ...base, markets: async () => ({ markets: [] }), market: async id => { inspected.push(id); return base.market(id); } };
  const { service, timers } = fixture({ client }); t.after(() => service.close());
  await service.watch("alice", { marketId: "123", watching: true }); await service.start("alice", {}); await timers.tick();
  assert.deepEqual(inspected, ["123"]); assert.equal((await service.state("alice")).paper.positions.length, 1);
});

test("missing order book data blocks fills and preserves cash", async t => {
  const base = polyFixture().client, client = { ...base, book: async () => { throw new Error("Unavailable book"); } };
  const { service, timers } = fixture({ client }); t.after(() => service.close());
  await service.start("alice", {}); await timers.tick(); const state = await service.state("alice");
  assert.equal(state.paper.trades.length, 0); assert.equal(state.paper.cash, 10000);
});
