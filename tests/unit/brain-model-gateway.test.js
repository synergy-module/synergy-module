import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBrainModelGateway } from "../../src/agent-brain/brain-model-gateway.js";
import { createSqliteBrainRepository } from "../../src/agent-brain/brain-repository.js";

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const REQUEST = { provider: "gemini", system: "Stable research instructions.", prompt: "User market observations to analyze.", schema: SCHEMA, maxOutputTokens: 512 };
const USAGE = { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, cacheCreationInputTokens: 100, totalTokens: 1200 };
const ZERO = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 };
const RATES = { inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2 };

function fixture({ provider = "gemini", generateDetailed, simple = false, repository: suppliedRepository, pricing = { gemini: RATES, openai: RATES, claude: RATES } } = {}) {
  const calls = [];
  const cacheCalls = [];
  const storage = new Map();
  let currentTime = new Date("2026-09-14T14:00:00Z");
  let model = `${provider}-fixture-1`;
  let configured = true;
  let paidCallsEnabled = true;
  const repository = suppliedRepository ?? {
    async getCache(owner, key) { cacheCalls.push(["get", owner, key]); return structuredClone(storage.get(JSON.stringify([owner, key])) ?? null); },
    async putCache(owner, key, value) { cacheCalls.push(["put", owner, key]); storage.set(JSON.stringify([owner, key]), structuredClone(value)); },
  };
  const aiProvider = {
    getStatus: () => ({ defaultProvider: provider, paidCallsEnabled, providers: [{ id: provider, label: provider, model, configured, apiKey: "private status field" }] }),
    async [simple ? "generate" : "generateDetailed"](request) {
      calls.push(request);
      if (generateDetailed) return generateDetailed(request);
      if (simple) return { answer: "Validated research response." };
      return { data: { answer: "Validated research response." }, usage: USAGE, provider, model, latencyMs: 123, apiKey: "never-store-this-field" };
    },
  };
  const options = { aiProvider, repository, now: () => currentTime, pricing };
  const gateway = createBrainModelGateway(options);
  return {
    gateway, repository, options, storage, calls, cacheCalls,
    setTime(ms) { currentTime = new Date(ms); },
    advance(ms) { currentTime = new Date(currentTime.valueOf() + ms); },
    setModel(value) { model = value; },
    setConfigured(value) { configured = value; },
    setPaidCallsEnabled(value) { paidCallsEnabled = value; },
  };
}

test("gateway fails closed before cache or provider access when activation is absent or not boolean true", async () => {
  for (const value of [undefined, null, false, "true", 1]) {
    const f = fixture();
    f.setPaidCallsEnabled(value);
    assert.equal(f.gateway.getStatus().paidCallsEnabled, false);
    assert.equal(f.gateway.getStatus().providers[0].configured, true);
    f.gateway.getStatus().paidCallsEnabled = true;
    await assert.rejects(f.gateway.generate("alice", { ...REQUEST, paidCallsEnabled: true }),
      { code: "TRADER_PAID_AI_LOCKED", status: 423 });
    assert.equal(f.calls.length, 0);
    assert.equal(f.cacheCalls.length, 0);
  }
  assert.equal(createBrainModelGateway().getStatus().paidCallsEnabled, false);
});

test("locking a configured gateway prevents reuse of a cached model response as well as new calls", async () => {
  const f = fixture();
  assert.equal(f.gateway.getStatus().paidCallsEnabled, true);
  await f.gateway.generate("alice", REQUEST);
  assert.equal(f.storage.size, 1);
  f.cacheCalls.length = 0;
  f.setPaidCallsEnabled(false);
  await assert.rejects(f.gateway.generate("alice", REQUEST), { code: "TRADER_PAID_AI_LOCKED" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.cacheCalls.length, 0);
});

test("activation is rechecked after an asynchronous cache miss before any provider invocation", async () => {
  let release;
  const f = fixture({ repository: {
    getCache: () => new Promise((resolve) => { release = resolve; }),
    putCache: async () => assert.fail("Locked generation cannot write cache"),
  } });
  const pending = f.gateway.generate("alice", REQUEST);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  f.setPaidCallsEnabled(false);
  release(null);
  await assert.rejects(pending, { code: "TRADER_PAID_AI_LOCKED", status: 423 });
  assert.equal(f.calls.length, 0);
});

test("exact response cache survives gateway recreation and reports zero new usage separately from original usage", async () => {
  const f = fixture();
  const first = await f.gateway.generate("alice", REQUEST);
  assert.equal(first.cache.status, "miss");
  assert.deepEqual(first.usage, USAGE);
  assert.match(first.cache.key, /^[a-f0-9]{64}$/);
  const reopened = createBrainModelGateway(f.options);
  const hit = await reopened.generate("alice", REQUEST);
  assert.equal(hit.cache.status, "hit");
  assert.deepEqual(hit.data, first.data);
  assert.deepEqual(hit.usage, ZERO);
  assert.deepEqual(hit.sourceUsage, USAGE);
  assert.equal(hit.estimatedCostUsd, 0);
  assert.ok(hit.latencyMs >= 0 && hit.latencyMs < 123);
  assert.equal(f.calls.length, 1);
  hit.data.answer = "Modified by caller";
  assert.equal((await reopened.generate("alice", REQUEST)).data.answer, first.data.answer);
  const stored = JSON.stringify([...f.storage.values()]);
  assert.ok(!stored.includes(REQUEST.system));
  assert.ok(!stored.includes(REQUEST.prompt));
  assert.doesNotMatch(stored, /apiKey|never-store-this-field|private status field/);
  assert.doesNotMatch(JSON.stringify(reopened.getStatus()), /apiKey|private status field/);
});

test("exact model cache survives closing and reopening the durable SQLite repository", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "synergy-module-brain-gateway-"));
  const f = fixture();
  let repository;
  try {
    const filename = path.join(directory, "cache.sqlite");
    repository = createSqliteBrainRepository({ filename, now: f.options.now });
    const first = createBrainModelGateway({ ...f.options, repository });
    assert.equal((await first.generate("alice", REQUEST)).cache.status, "miss");
    await repository.close();
    repository = createSqliteBrainRepository({ filename, now: f.options.now });
    const reopened = createBrainModelGateway({ ...f.options, repository });
    assert.equal((await reopened.generate("alice", REQUEST)).cache.status, "hit");
    assert.equal(f.calls.length, 1);
    assert.equal((await reopened.generate("bob", REQUEST)).cache.status, "miss");
    f.advance(60000);
    assert.equal((await reopened.generate("alice", REQUEST)).cache.status, "miss");
  } finally {
    await repository?.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith("synergy-module-brain-gateway-"));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("cache is isolated by owner and changing every generation input produces a miss", async () => {
  const f = fixture();
  const original = await f.gateway.generate("alice", REQUEST);
  const other = await f.gateway.generate("bob", REQUEST);
  assert.equal(other.cache.status, "miss");
  assert.notEqual(other.cache.key, original.cache.key);
  for (const changed of [
    { system: REQUEST.system + " Revised." }, { prompt: REQUEST.prompt + " New observation." },
    { schema: { ...SCHEMA, description: "Different output schema." } }, { maxOutputTokens: 256 },
    { cacheKey: "another-workflow" },
  ]) {
    const result = await f.gateway.generate("alice", { ...REQUEST, ...changed });
    assert.equal(result.cache.status, "miss");
    assert.notEqual(result.cache.key, original.cache.key);
  }
  f.setModel("gemini-fixture-2");
  const newModel = await f.gateway.generate("alice", REQUEST);
  assert.equal(newModel.cache.status, "miss");
  assert.notEqual(newModel.cache.key, original.cache.key);
});

test("exact cache key includes provider even when two providers have an identical configured model name", async () => {
  const f = fixture();
  const aiProvider = {
    getStatus: () => ({ defaultProvider: "gemini", paidCallsEnabled: true, providers: ["gemini", "openai"].map((id) => ({ id, label: id, model: "same-fixture", configured: true })) }),
    generate: async () => ({ answer: "Shared fixture result." }),
  };
  const gateway = createBrainModelGateway({ ...f.options, aiProvider });
  const gemini = await gateway.generate("alice", REQUEST);
  const openai = await gateway.generate("alice", { ...REQUEST, provider: "openai" });
  assert.equal(openai.cache.status, "miss");
  assert.notEqual(gemini.cache.key, openai.cache.key);
});

test("cache TTL caps at 60 seconds, does not slide on reads, and respects a shorter requested freshness window", async () => {
  const f = fixture();
  await f.gateway.generate("alice", { ...REQUEST, cacheTtlMs: 999999 });
  f.advance(1001);
  assert.equal((await f.gateway.generate("alice", { ...REQUEST, cacheTtlMs: 1000 })).cache.status, "miss");
  f.advance(1001);
  assert.equal((await f.gateway.generate("alice", { ...REQUEST, cacheTtlMs: 999999 })).cache.status, "miss");
  f.advance(59999);
  assert.equal((await f.gateway.generate("alice", REQUEST)).cache.status, "hit");
  f.advance(1);
  assert.equal((await f.gateway.generate("alice", REQUEST)).cache.status, "miss");
});

test("zero TTL disables only exact caching while provider prefix caching retains a stable owner-scoped hint", async () => {
  const f = fixture();
  for (const prompt of [REQUEST.prompt, REQUEST.prompt + " Additional snapshot."]) {
    const result = await f.gateway.generate("alice", { ...REQUEST, prompt, cacheTtlMs: 0 });
    assert.equal(result.cache.status, "disabled");
  }
  assert.equal(f.cacheCalls.length, 0);
  assert.equal(f.calls[0].cacheKey, f.calls[1].cacheKey);
  assert.match(f.calls[0].cacheKey, /^[a-f0-9]{64}$/);
  assert.equal(f.calls[0].maxOutputTokens, 512);
  await f.gateway.generate("bob", { ...REQUEST, cacheTtlMs: 0 });
  assert.notEqual(f.calls[0].cacheKey, f.calls[2].cacheKey);
});

test("provider prefix cache reads and cache writes use distinct prices without double-counting input tokens", async () => {
  const f = fixture({ provider: "claude" });
  const result = await f.gateway.generate("alice", { ...REQUEST, provider: "claude" });
  assert.equal(result.cache.status, "miss");
  assert.equal(result.estimatedCostUsd, (500 * 2 + 400 * 0.2 + 100 * 2.5 + 200 * 10) / 1e6);
  assert.deepEqual(f.gateway.getPricing("claude"), { ...RATES, cacheCreationInputPerMillion: 2.5 });
  const rates = f.gateway.getPricing("claude");
  rates.inputPerMillion = 999;
  assert.equal(f.gateway.getPricing("claude").inputPerMillion, 2);
});

test("unconfigured pricing or unknown cache-read prices return null costs, not invented zero-dollar estimates", async () => {
  for (const pricing of [{}, { gemini: { inputPerMillion: 2 } }, { gemini: { inputPerMillion: 2, outputPerMillion: 10 } }, { gemini: { inputPerMillion: -1, outputPerMillion: 10 } }]) {
    const f = fixture({ pricing });
    const result = await f.gateway.generate("alice", REQUEST);
    assert.equal(result.estimatedCostUsd, null);
  }
  assert.equal(fixture({ pricing: {} }).gateway.getPricing("gemini"), null);
  assert.equal(fixture().gateway.getPricing("__proto__"), null);
});

test("simple provider compatibility reports unknown usage and cost while exact-cache reuse has no new usage", async () => {
  const f = fixture({ simple: true });
  const result = await f.gateway.generate("alice", REQUEST);
  assert.deepEqual(result.data, { answer: "Validated research response." });
  assert.equal(result.usage, null);
  assert.equal(result.estimatedCostUsd, null);
  const hit = await f.gateway.generate("alice", REQUEST);
  assert.deepEqual(hit.usage, ZERO);
  assert.equal(hit.sourceUsage, null);
  assert.equal(hit.estimatedCostUsd, 0);
});

test("failed, malformed, secret-bearing or mismatched-provider results are never cached", async () => {
  for (const generateDetailed of [
    async () => { throw new Error("PRIVATE_PROVIDER_PAYLOAD"); },
    async () => ({ data: {}, usage: USAGE, provider: "gemini", model: "gemini-fixture-1" }),
    async () => ({ data: { answer: "valid" }, usage: USAGE, provider: "openai", model: "gemini-fixture-1" }),
    async () => ({ data: { answer: "sk-ant-" + "a".repeat(40) }, usage: USAGE, provider: "gemini", model: "gemini-fixture-1" }),
  ]) {
    const f = fixture({ generateDetailed });
    await assert.rejects(f.gateway.generate("alice", REQUEST), (error) => {
      assert.equal(error.code, "TRADER_PROVIDER_ERROR");
      assert.doesNotMatch(error.message, /PRIVATE|sk-ant/);
      return true;
    });
    assert.equal(f.storage.size, 0);
    assert.ok(!f.cacheCalls.some(([operation]) => operation === "put"));
  }
});

test("cancellation before a cache lookup and during an uncooperative generation prevents cache writes", async () => {
  let complete;
  const f = fixture({ generateDetailed: () => new Promise((resolve) => { complete = resolve; }) });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(f.gateway.generate("alice", { ...REQUEST, signal: alreadyAborted.signal }), { code: "TRADER_PROVIDER_ERROR" });
  assert.equal(f.cacheCalls.length, 0);
  const controller = new AbortController();
  const pending = f.gateway.generate("alice", { ...REQUEST, signal: controller.signal });
  while (!complete) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: "TRADER_PROVIDER_ERROR" });
  complete({ data: { answer: "Late result" }, usage: USAGE, provider: "gemini", model: "gemini-fixture-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.storage.size, 0);
});

test("cancellation during a stalled cache read never invokes a model", async () => {
  let getStarted;
  const readStarted = new Promise((resolve) => { getStarted = resolve; });
  const f = fixture({ repository: { getCache: () => { getStarted(); return new Promise(() => {}); }, putCache: async () => {} } });
  const controller = new AbortController();
  const pending = f.gateway.generate("alice", { ...REQUEST, signal: controller.signal });
  await readStarted;
  controller.abort();
  await assert.rejects(pending, { code: "TRADER_PROVIDER_ERROR" });
  assert.equal(f.calls.length, 0);
});

test("cache backend failures do not discard a successful model response or expose storage details", async () => {
  for (const repository of [
    { getCache: async () => { throw new Error("PRIVATE_STORAGE_FAILURE"); }, putCache: async () => {} },
    { getCache: async () => null, putCache: async () => { throw new Error("PRIVATE_STORAGE_FAILURE"); } },
  ]) {
    const f = fixture({ repository });
    const result = await f.gateway.generate("alice", REQUEST);
    assert.equal(result.cache.status, "disabled");
    assert.equal(result.data.answer, "Validated research response.");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STORAGE/);
  }
});

test("invalid options and disabled credentials fail before cache lookup or generation", async () => {
  const f = fixture();
  for (const invalid of [{ provider: "__proto__" }, { maxOutputTokens: 127 }, { maxOutputTokens: 8193 }, { cacheTtlMs: NaN }, { cacheKey: "" }, { schema: { ...SCHEMA, additionalProperties: true } }]) {
    await assert.rejects(f.gateway.generate("alice", { ...REQUEST, ...invalid }), { code: "TRADER_INPUT_INVALID" });
  }
  await assert.rejects(f.gateway.generate("", REQUEST), { code: "TRADER_INPUT_INVALID" });
  f.setConfigured(false);
  await assert.rejects(f.gateway.generate("alice", REQUEST), { code: "TRADER_PROVIDER_NOT_CONFIGURED" });
  assert.equal(f.cacheCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

test("pricing can be supplied through server environment with explicit zero supported and missing rates unavailable", () => {
  const changes = {
    BRAIN_GEMINI_INPUT_USD_PER_MILLION: "1.5", BRAIN_GEMINI_OUTPUT_USD_PER_MILLION: "8",
    BRAIN_GEMINI_CACHED_INPUT_USD_PER_MILLION: "0", BRAIN_GEMINI_CACHE_CREATION_INPUT_USD_PER_MILLION: "",
    BRAIN_OPENAI_INPUT_USD_PER_MILLION: "", BRAIN_OPENAI_OUTPUT_USD_PER_MILLION: "8",
  };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, changes);
    const gateway = createBrainModelGateway();
    assert.deepEqual(gateway.getPricing("gemini"), { inputPerMillion: 1.5, outputPerMillion: 8, cachedInputPerMillion: 0, cacheCreationInputPerMillion: 0 });
    assert.equal(gateway.getPricing("openai"), null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
