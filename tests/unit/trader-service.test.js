import test from "node:test";
import assert from "node:assert/strict";
import { createTraderService } from "../../src/services/trader-service.js";

const TIME = new Date("2026-09-14T14:00:00.000Z");
const INPUT = {
  provider: "gemini", mode: "analysis", symbol: "ES", timeframe: "5m",
  context: "Manual snapshot at 14:00 UTC: daily trend up; support 98, current price 100, resistance 106. A reclaim of 100 suggests a long with invalidation below 98.",
  accountSize: 50000, riskPercent: 0.5, pointValue: 50, minRewardRisk: 2,
};
const THESIS = {
  bias: "long", summary: "The supplied uptrend and reclaim support a long hypothesis.",
  evidence: ["The manual snapshot states an uptrend and support at 98."],
  missingData: [], entry: 100, stop: 98, target: 106, invalidation: "A loss of supplied support at 98 invalidates the thesis.",
};
const CALENDAR = {
  state: "live", updatedAt: TIME.toISOString(),
  events: [{ timestamp: "2026-09-14T15:00:00.000Z", title: "Economic release", market: "USD", importance: "high" }],
};

function harness({ thesis = THESIS, review = { verdict: "pass", reason: "The manual evidence supports this research plan." }, calendar = CALENDAR, generate, paidCallsEnabled = true, now = () => TIME, ...options } = {}) {
  const calls = [];
  let calendarCalls = 0;
  let ids = 0;
  const service = createTraderService({
    aiProvider: {
      getStatus: () => ({ defaultProvider: "gemini", paidCallsEnabled, apiKey: "should never be returned", providers: [
        { id: "gemini", label: "Gemini", model: "test-gemini", configured: true, key: "secret" },
        { id: "openai", label: "OpenAI", model: "test-openai", configured: false },
        { id: "claude", label: "Claude", model: "test-claude", configured: false },
      ] }),
      async generate(request) {
        calls.push(request);
        if (generate) return generate(request);
        return structuredClone(request.schema.properties.verdict ? review : thesis);
      },
    },
    marketNewsService: { async getCurrentWeek() { calendarCalls += 1; if (calendar instanceof Error) throw calendar; return calendar; } },
    now, idFactory: () => `run-${++ids}`, ...options,
  });
  return { service, calls, get calendarCalls() { return calendarCalls; } };
}

test("long analysis uses server sizing, calendar context, and a separate critique", async () => {
  const { service, calls } = harness();
  const result = await service.run("alice", INPUT);
  assert.equal(result.status, "ready");
  assert.equal(result.risk.riskBudget, 250);
  assert.equal(result.risk.quantity, 2);
  assert.equal(result.risk.maxLoss, 200);
  assert.equal(result.risk.rewardRisk, 3);
  assert.equal(result.risk.passed, true);
  assert.equal(result.createdAt, TIME.toISOString());
  assert.equal(result.model, "test-gemini");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].provider, "gemini");
  assert.ok(calls[0].signal instanceof AbortSignal);
  const prompt = JSON.parse(calls[0].prompt);
  assert.equal(prompt.calendar.state, "fresh");
  assert.equal(prompt.asOfUtc, TIME.toISOString());
  assert.equal(prompt.sessionTimeZone, "America/New_York");
  assert.equal(JSON.parse(calls[1].prompt).asOfUtc, TIME.toISOString());
  assert.equal(prompt.calendar.events[0].title, "Economic release");
  assert.match(prompt.provenance, /Manually supplied/);
  assert.match(calls[0].system, /untrusted DATA/);
  assert.match(result.dataSource, /Manual market snapshot/);
  assert.match(result.steps[2].detail, /Fees and slippage are excluded/);
});

test("short sizing uses stop distance and correct directional geometry", async () => {
  const { service } = harness({ thesis: { ...THESIS, bias: "short", stop: 102, target: 94 } });
  const result = await service.run("alice", { ...INPUT, accountSize: 12345, riskPercent: 1, pointValue: 5 });
  assert.equal(result.status, "ready");
  assert.equal(result.risk.riskBudget, 123.45);
  assert.equal(result.risk.quantity, 12);
  assert.equal(result.risk.maxLoss, 120);
  assert.equal(result.risk.rewardRisk, 3);
  assert.ok(result.risk.maxLoss <= result.risk.riskBudget);
});

for (const [name, prices, pointValue, expectedQuantity] of [
  ["long decimal", { bias: "long", entry: 1.1, stop: 1, target: 1.3 }, 1, 1000],
  ["short decimal", { bias: "short", entry: 1.1, stop: 1.2, target: 0.9 }, 1, 1000],
  ["long forex", { bias: "long", entry: 1.1000, stop: 1.0990, target: 1.1020 }, 100000, 1],
  ["short forex", { bias: "short", entry: 1.1000, stop: 1.1010, target: 1.0980 }, 100000, 1],
  ["scientific notation", { bias: "long", entry: 1.1e-7, stop: 1e-7, target: 1.3e-7 }, 100000, 100000],
]) {
  test(`${name} honors exact decimal budget and reward/risk boundaries`, async () => {
    const { service } = harness({ thesis: { ...THESIS, ...prices } });
    const result = await service.run("alice", { ...INPUT, accountSize: 10000, riskPercent: 1, pointValue, minRewardRisk: 2 });
    assert.equal(result.status, "ready");
    assert.equal(result.risk.rewardRisk, 2);
    assert.equal(result.risk.quantity, expectedQuantity);
    assert.equal(result.risk.riskBudget, 100);
    assert.equal(result.risk.maxLoss, 100);
  });
}

for (const [name, prices] of [
  ["long", { bias: "long", entry: 1.1, stop: 0.9999999999999999, target: 1.3000000000000003 }],
  ["short", { bias: "short", entry: 1.1, stop: 1.2000000000000002, target: 0.8999999999999996 }],
]) {
  test(`${name} never rounds an actually over-budget unit into the position`, async () => {
    const { service } = harness({ thesis: { ...THESIS, ...prices } });
    const result = await service.run("alice", { ...INPUT, accountSize: 10000, riskPercent: 1, pointValue: 1 });
    assert.equal(result.status, "ready");
    assert.equal(result.risk.quantity, 999);
    assert.ok(result.risk.maxLoss < result.risk.riskBudget);
  });
}

for (const [name, prices] of [
  ["long", { bias: "long", entry: 1.1, stop: 1, target: 1.2999999999999998 }],
  ["short", { bias: "short", entry: 1.1, stop: 1.2, target: 0.9000000000000001 }],
]) {
  test(`${name} reward/risk below the decimal minimum cannot pass through an epsilon`, async () => {
    const { service, calls } = harness({ thesis: { ...THESIS, ...prices } });
    const result = await service.run("alice", { ...INPUT, accountSize: 10000, riskPercent: 1, pointValue: 1, minRewardRisk: 2 });
    assert.equal(result.status, "wait");
    assert.equal(result.risk.quantity, 1000);
    assert.match(result.risk.reasons.join(" "), /required minimum/);
    assert.equal(calls.length, 1);
  });
}

for (const [name, thesis, expected] of [
  ["long stop above entry", { ...THESIS, stop: 102 }, /correct sides/],
  ["long target below entry", { ...THESIS, target: 96 }, /correct sides/],
  ["short stop below entry", { ...THESIS, bias: "short", target: 94 }, /correct sides/],
  ["short target above entry", { ...THESIS, bias: "short", stop: 102 }, /correct sides/],
  ["zero distance", { ...THESIS, stop: 100 }, /correct sides/],
  ["nonpositive price", { ...THESIS, stop: -1 }, /positive finite/],
  ["missing price", { ...THESIS, entry: null }, /positive finite/],
  ["low reward/risk", { ...THESIS, target: 102 }, /required minimum/],
  ["neutral bias", { ...THESIS, bias: "neutral" }, /no directional/],
  ["missing evidence", { ...THESIS, evidence: [] }, /supporting evidence/],
  ["missing market information", { ...THESIS, missingData: ["Higher-timeframe context is missing."] }, /missing market/],
  ["missing invalidation", { ...THESIS, invalidation: "" }, /invalidation/],
]) {
  test(`${name} forces wait and cannot be overridden by a model`, async () => {
    const { service, calls } = harness({ thesis });
    const result = await service.run("alice", INPUT);
    assert.equal(result.status, "wait");
    assert.equal(result.risk.passed, false);
    assert.match(result.risk.reasons.join(" "), expected);
    assert.equal(result.review.verdict, "wait");
    assert.equal(calls.length, 1);
  });
}

test("less than one whole unit is a wait, not a fractional futures position", async () => {
  const { service } = harness();
  const result = await service.run("alice", { ...INPUT, accountSize: 100 });
  assert.equal(result.status, "wait");
  assert.equal(result.risk.quantity, 0);
  assert.equal(result.risk.maxLoss, 0);
  assert.match(result.risk.reasons.join(" "), /one whole unit/);
});

test("unrepresentable risk calculations fail closed without non-finite output", async () => {
  const { service } = harness({ thesis: { ...THESIS, entry: 1e308, stop: 1, target: 1.7e308 } });
  const result = await service.run("alice", INPUT);
  assert.equal(result.status, "wait");
  assert.equal(result.risk.rewardRisk, null);
  assert.equal(result.risk.quantity, 0);
  assert.match(result.risk.reasons.join(" "), /finite risk/);
});

test("unsafe integer quantities fail closed", async () => {
  const { service } = harness();
  const result = await service.run("alice", { ...INPUT, pointValue: 1e-30 });
  assert.equal(result.status, "wait");
  assert.equal(result.risk.quantity, 0);
  assert.match(result.risk.reasons.join(" "), /supported calculation range/);
});

for (const [name, thesis] of [
  ["string prices", { ...THESIS, entry: "100" }],
  ["infinity", { ...THESIS, stop: Infinity }],
  ["missing fields", { summary: "Incomplete." }],
  ["bad bias", { ...THESIS, bias: "buy" }],
  ["oversized evidence", { ...THESIS, evidence: ["x".repeat(601)] }],
  ["too many evidence items", { ...THESIS, evidence: Array(21).fill("Evidence.") }],
  ["extra model controls", { ...THESIS, riskPassed: true }],
]) {
  test(`malformed output (${name}) is rejected and not saved`, async () => {
    const { service } = harness({ thesis });
    await assert.rejects(service.run("alice", INPUT), { code: "TRADER_OUTPUT_INVALID", status: 502 });
    assert.equal(service.getState("alice").runs.length, 0);
  });
}

test("review can veto a plan that passes arithmetic checks", async () => {
  const { service, calls } = harness({ review: { verdict: "wait", reason: "The manual context does not sufficiently establish the higher-timeframe thesis." } });
  const result = await service.run("alice", INPUT);
  assert.equal(calls.length, 2);
  assert.equal(result.risk.passed, true);
  assert.equal(result.status, "wait");
  assert.match(result.review.reason, /higher-timeframe/);
});

for (const review of [null, { verdict: "pass" }, { verdict: "pass", reason: "" }, { verdict: "ready", reason: "Go" }]) {
  test(`invalid review fails closed (${JSON.stringify(review)})`, async () => {
    const { service } = harness({ review });
    const result = await service.run("alice", INPUT);
    assert.equal(result.status, "wait");
    assert.equal(result.review.verdict, "wait");
    assert.match(result.review.reason, /could not be completed or validated/);
  });
}

test("review provider failure saves a wait result without leaking upstream errors", async () => {
  const { service } = harness({ generate: (request) => {
    if (request.schema.properties.verdict) throw new Error("SECRET upstream payload");
    return structuredClone(THESIS);
  } });
  const result = await service.run("alice", INPUT);
  assert.equal(result.status, "wait");
  assert.equal(service.getState("alice").runs.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("provider failures return only safe local errors and release the user lock", async () => {
  const { service } = harness({ generate: () => { throw Object.assign(new Error("SECRET upstream payload"), { status: 418 }); } });
  await assert.rejects(service.run("alice", INPUT), (error) => {
    assert.equal(error.code, "TRADER_PROVIDER_ERROR");
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  const result = await service.run("alice", { ...INPUT, mode: "demo" });
  assert.equal(result.mode, "demo");
});

test("an unconfigured provider rejects analysis before calendar or model calls", async () => {
  const fixture = harness();
  await assert.rejects(fixture.service.run("alice", { ...INPUT, provider: "claude" }), { code: "TRADER_PROVIDER_NOT_CONFIGURED", status: 503 });
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.calendarCalls, 0);
});

for (const paidCallsEnabled of [false, null, "true", 1]) {
  test(`paid analysis requires an explicit server boolean before any work (${JSON.stringify(paidCallsEnabled)})`, async () => {
    const fixture = harness({ paidCallsEnabled });
    await assert.rejects(fixture.service.run("alice", { ...INPUT, paidCallsEnabled: true }), { code: "TRADER_PAID_AI_LOCKED", status: 423 });
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.calendarCalls, 0);
    assert.equal(fixture.service.getState("alice").paidCallsEnabled, false);
    assert.deepEqual(fixture.service.getState("alice").runs, []);
    const result = await fixture.service.run("alice", { ...INPUT, mode: "demo" });
    assert.equal(result.mode, "demo");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.calendarCalls, 0);
  });
}

test("explicit demo is labeled, ignores market text, and makes no provider calls", async () => {
  const fixture = harness();
  const result = await fixture.service.run("alice", { ...INPUT, mode: "demo", provider: "claude", context: "" });
  assert.equal(result.mode, "demo");
  assert.equal(result.status, "ready");
  assert.equal(result.plan.entry, 100);
  assert.equal(result.plan.stop, 98);
  assert.equal(result.plan.target, 106);
  assert.equal(result.risk.quantity, 2);
  assert.equal(result.risk.maxLoss, 200);
  assert.match(result.dataSource, /ILLUSTRATIVE DEMO/);
  assert.match(result.summary, /not market data/);
  assert.match(result.review.reason, /No AI review/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.calendarCalls, 0);
});

test("service can demonstrate the workflow without any provider dependency", async () => {
  const service = createTraderService();
  const result = await service.run("alice", { ...INPUT, mode: "demo", context: "" });
  assert.equal(result.mode, "demo");
  await assert.rejects(service.run("alice", INPUT), { code: "TRADER_PAID_AI_LOCKED" });
});

for (const [name, calendar, state] of [
  ["missing service", undefined, "unavailable"],
  ["network failure", new Error("SECRET calendar payload"), "unavailable"],
  ["stale fallback", { ...CALENDAR, state: "stale" }, "stale"],
  ["old cache", { ...CALENDAR, updatedAt: "2026-09-12T14:00:00Z" }, "stale"],
  ["invalid timestamp", { ...CALENDAR, updatedAt: "unknown" }, "stale"],
]) {
  test(`calendar ${name} is accurately labeled and cannot become ready`, async () => {
    const { service, calls } = harness({ calendar, ...(name === "missing service" ? { marketNewsService: undefined } : {}) });
    const result = await service.run("alice", INPUT);
    assert.equal(result.status, "wait");
    assert.match(result.dataSource, new RegExp(`calendar ${state}`));
    assert.equal(result.steps[0].status, "warning");
    assert.equal(result.missingData.length, 1);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  });
}

test("calendar timeout fails gracefully instead of blocking analysis indefinitely", async () => {
  const { service, calls } = harness({ calendarTimeoutMs: 5, marketNewsService: { getCurrentWeek: () => new Promise(() => {}) } });
  const result = await service.run("alice", INPUT);
  assert.equal(result.status, "wait");
  assert.match(result.dataSource, /calendar unavailable/);
  assert.equal(calls.length, 1);
});

test("calendar preserves a just-released event for both thesis and critique", async () => {
  const released = { ...CALENDAR.events[0], title: "CPI just released", timestamp: new Date(TIME.valueOf() - 1000).toISOString() };
  const { service, calls } = harness({ calendar: { ...CALENDAR, events: [released] } });
  const result = await service.run("alice", INPUT);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const calendar = JSON.parse(call.prompt).calendar;
    assert.equal(calendar.state, "fresh");
    assert.equal(calendar.events.length, 1);
    assert.equal(calendar.events[0].title, "CPI just released");
    assert.equal(calendar.truncated, false);
    assert.equal(calendar.omittedCount, 0);
    assert.equal(calendar.recentWindowHours, 24);
  }
  assert.match(result.steps[0].detail, /recent and upcoming/);
});

test("calendar includes the 24-hour recent boundary and declares its scope", async () => {
  const boundary = { ...CALENDAR.events[0], title: "Recent boundary", timestamp: new Date(TIME.valueOf() - 24 * 60 * 60 * 1000).toISOString() };
  const old = { ...boundary, title: "Outside recent scope", timestamp: new Date(new Date(boundary.timestamp).valueOf() - 1).toISOString() };
  const { service, calls } = harness({ calendar: { ...CALENDAR, events: [old, boundary] } });
  await service.run("alice", INPUT);
  const calendar = JSON.parse(calls[0].prompt).calendar;
  assert.deepEqual(calendar.events.map((event) => event.title), ["Recent boundary"]);
  assert.equal(calendar.recentWindowHours, 24);
  assert.equal(calendar.truncated, false);
});

test("calendar prioritizes a high-impact 31st event and discloses the incomplete selection", async () => {
  const mediumEvents = Array.from({ length: 30 }, (_, index) => ({
    ...CALENDAR.events[0], title: `Medium release ${index}`, importance: "medium",
    timestamp: new Date(TIME.valueOf() + (index + 1) * 60000).toISOString(),
  }));
  const cpi = { ...CALENDAR.events[0], title: "CPI high impact", timestamp: new Date(TIME.valueOf() + 31 * 60000).toISOString() };
  const { service, calls } = harness({ calendar: { ...CALENDAR, events: [...mediumEvents, cpi] } });
  const result = await service.run("alice", INPUT);
  const calendar = JSON.parse(calls[0].prompt).calendar;
  assert.equal(calendar.events.length, 30);
  assert.ok(calendar.events.some((event) => event.title === cpi.title));
  assert.equal(calendar.truncated, true);
  assert.equal(calendar.omittedCount, 1);
  assert.equal(result.status, "wait");
  assert.equal(result.risk.passed, false);
  assert.equal(result.steps[0].status, "warning");
  assert.match(result.dataSource, /1 events omitted or invalid/);
  assert.match(result.missingData.join(" "), /calendar context is incomplete/);
  assert.equal(calls.length, 1);
});

test("calendar omission of a later high-impact event forces wait despite a positive thesis", async () => {
  const events = Array.from({ length: 31 }, (_, index) => ({
    ...CALENDAR.events[0], title: `High-impact release ${index}`,
    timestamp: new Date(TIME.valueOf() + (index + 1) * 60000).toISOString(),
  }));
  const { service, calls } = harness({ calendar: { ...CALENDAR, events } });
  const result = await service.run("alice", INPUT);
  const calendar = JSON.parse(calls[0].prompt).calendar;
  assert.equal(calendar.events.length, 30);
  assert.equal(calendar.truncated, true);
  assert.equal(calendar.omittedCount, 1);
  assert.equal(result.status, "wait");
  assert.equal(result.review.verdict, "wait");
  assert.equal(calls.length, 1);
});

test("invalid calendar rows are disclosed instead of silently implying complete context", async () => {
  const { service, calls } = harness({ calendar: { ...CALENDAR, events: [{ title: "CPI", timestamp: "unknown" }] } });
  const result = await service.run("alice", INPUT);
  const calendar = JSON.parse(calls[0].prompt).calendar;
  assert.equal(calendar.events.length, 0);
  assert.equal(calendar.truncated, true);
  assert.equal(calendar.omittedCount, 1);
  assert.equal(result.status, "wait");
});

test("generation timeout aborts the provider and releases concurrency", async () => {
  let signal;
  const { service } = harness({ generationTimeoutMs: 5, generate: (request) => {
    signal = request.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(service.run("alice", INPUT), { code: "TRADER_PROVIDER_TIMEOUT", status: 504 });
  assert.equal(signal.aborted, true);
  const result = await service.run("alice", { ...INPUT, mode: "demo" });
  assert.equal(result.mode, "demo");
});

test("history is per operator, bounded to ten, and cloned on reads and writes", async () => {
  const { service } = harness();
  for (let index = 0; index < 12; index += 1) await service.run("alice", { ...INPUT, mode: "demo" });
  const bobResult = await service.run("bob", { ...INPUT, mode: "demo", symbol: "NQ" });
  bobResult.plan.entry = 999;
  const alice = service.getState("alice");
  assert.equal(alice.runs.length, 10);
  assert.equal(alice.runs[0].id, "run-12");
  assert.equal(alice.runs[9].id, "run-3");
  alice.runs[0].evidence.push("Tampered");
  assert.equal(service.getState("alice").runs[0].evidence.length, 2);
  assert.equal(service.getState("bob").runs[0].symbol, "NQ");
  assert.equal(service.getState("bob").runs[0].plan.entry, 100);
  assert.equal(service.getState("charlie").runs.length, 0);
  assert.doesNotMatch(JSON.stringify(alice), /secret|should never/);
});

test("history evicts inactive operators and expires after 24 hours", async () => {
  let currentTime = TIME;
  const { service } = harness({ now: () => currentTime });
  for (let index = 0; index < 101; index += 1) await service.run(`operator-${index}`, { ...INPUT, mode: "demo" });
  assert.equal(service.getState("operator-0").runs.length, 0);
  assert.equal(service.getState("operator-100").runs.length, 1);
  currentTime = new Date(TIME.valueOf() + 24 * 60 * 60 * 1000 + 1);
  assert.equal(service.getState("operator-100").runs.length, 0);
});

test("same-user concurrent runs are rejected while other users remain independent", async () => {
  let resolveThesis;
  const pendingThesis = new Promise((resolve) => { resolveThesis = resolve; });
  const { service } = harness({ generate: (request) => request.schema.properties.verdict ? { verdict: "pass", reason: "Supported." } : pendingThesis });
  const first = service.run("alice", INPUT);
  await assert.rejects(service.run("alice", INPUT), { code: "TRADER_RUN_IN_PROGRESS", status: 409 });
  const bob = await service.run("bob", { ...INPUT, mode: "demo" });
  assert.equal(bob.mode, "demo");
  resolveThesis(structuredClone(THESIS));
  await first;
  assert.equal(service.getState("alice").runs.length, 1);
});

test("paid analyses have a short cooldown while demos remain immediately available", async () => {
  let currentTime = TIME;
  const { service } = harness({ now: () => currentTime });
  await service.run("alice", INPUT);
  await assert.rejects(service.run("alice", INPUT), { code: "TRADER_RATE_LIMITED", status: 429 });
  await service.run("alice", { ...INPUT, mode: "demo" });
  currentTime = new Date(TIME.valueOf() + 5000);
  const result = await service.run("alice", INPUT);
  assert.equal(result.status, "ready");
});

test("global analysis concurrency is bounded without preventing demo use", async () => {
  let resolveThesis;
  const pendingThesis = new Promise((resolve) => { resolveThesis = resolve; });
  const { service } = harness({ generate: (request) => request.schema.properties.verdict ? { verdict: "pass", reason: "Supported." } : pendingThesis });
  const pending = Array.from({ length: 8 }, (_, index) => service.run(`operator-${index}`, INPUT));
  await assert.rejects(service.run("ninth", INPUT), { code: "TRADER_BUSY", status: 503 });
  await service.run("ninth", { ...INPUT, mode: "demo" });
  resolveThesis(structuredClone(THESIS));
  await Promise.all(pending);
});

for (const invalid of [
  { provider: "unknown" }, { mode: "automatic" }, { symbol: "<script>" }, { timeframe: "2m" },
  { context: "too short" }, { context: "x".repeat(12001) }, { accountSize: 0 }, { accountSize: "50000" },
  { riskPercent: 10 }, { riskPercent: NaN }, { pointValue: 0 }, { pointValue: Infinity }, { minRewardRisk: 0.5 },
]) {
  test(`invalid input ${Object.keys(invalid)[0]} is rejected before any upstream calls`, async () => {
    const fixture = harness();
    await assert.rejects(fixture.service.run("alice", { ...INPUT, ...invalid }), { code: "TRADER_INPUT_INVALID", status: 422 });
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.calendarCalls, 0);
  });
}
