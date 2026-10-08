import test from "node:test";
import assert from "node:assert/strict";
import { readTraderConfig } from "../../src/config/trader-config.js";
import { createTraderAIProvider, TraderProviderError } from "../../src/providers/trader-ai-provider.js";

const KEYS = { GEMINI_API_KEY: "gemini-private-test-key", OPENAI_API_KEY: "openai-private-test-key", ANTHROPIC_API_KEY: "claude-private-test-key" };
const ENABLED_ENV = { ...KEYS, TRADER_PAID_AI_ENABLED: "true" };
const schema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["wait", "review"] },
    notes: { type: "array", items: { type: "string" } },
    entry: { type: ["number", "null"] },
  },
  required: ["decision", "notes", "entry"],
  additionalProperties: false,
};
const analysis = { decision: "wait", notes: ["Market evidence is incomplete."], entry: null };
const request = { system: "You are a cautious research assistant.", prompt: "Review this supplied market snapshot.", schema };

function envelope(provider, output = JSON.stringify(analysis)) {
  if (provider === "gemini") return { candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "Internal thought" }, { text: output }] } }] };
  if (provider === "openai") return { status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", status: "completed", content: [{ type: "output_text", text: output }] }] };
  return { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "Internal thought" }, { type: "text", text: output }] };
}

function response(value, options) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" }, ...options });
}

function errorIsSafe(error, code = "TRADER_PROVIDER_ERROR", status = 502) {
  assert.ok(error instanceof TraderProviderError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  const serialized = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
  for (const key of Object.values(KEYS)) assert.ok(!serialized.includes(key));
  assert.doesNotMatch(serialized, /upstream-private-detail|api\.example\.invalid/);
  assert.equal(error.cause, undefined);
  return true;
}

test("trader configuration defaults to Gemini and reads optional provider credentials only from server environment", () => {
  const blank = readTraderConfig({});
  assert.equal(blank.defaultProvider, "gemini");
  assert.equal(blank.paidCallsEnabled, false);
  assert.deepEqual(Object.keys(blank.providers), ["gemini", "openai", "claude"]);
  assert.equal(blank.providers.gemini.model, "gemini-3.8-flash");
  assert.equal(blank.providers.openai.model, "gpt-5.4-mini");
  assert.equal(blank.providers.claude.model, "claude-sonnet-5");
  assert.ok(Object.values(blank.providers).every((provider) => provider.apiKey === ""));
  const configured = readTraderConfig({ ...KEYS, TRADER_AI_PROVIDER: " claude ", GEMINI_MODEL: " gemini-3.5-flash ", OPENAI_MODEL: "gpt-5.4", ANTHROPIC_MODEL: "claude-sonnet-4-6" });
  assert.equal(configured.defaultProvider, "claude");
  assert.equal(configured.paidCallsEnabled, false);
  assert.equal(configured.providers.gemini.model, "gemini-3.5-flash");
  assert.equal(configured.providers.claude.model, "claude-sonnet-4-6");
  assert.equal(configured.providers.openai.apiKey, KEYS.OPENAI_API_KEY);
});

test("paid AI activation requires the exact true server setting", () => {
  for (const value of [undefined, null, false, true, 1, "", "false", "TRUE", "True", "1", "yes", "on"]) {
    assert.equal(readTraderConfig({ ...KEYS, TRADER_PAID_AI_ENABLED: value }).paidCallsEnabled, false);
  }
  for (const value of ["true", " true "]) {
    assert.equal(readTraderConfig({ ...KEYS, TRADER_PAID_AI_ENABLED: value }).paidCallsEnabled, true);
  }
});

test("keys alone cannot trigger paid requests through either provider generation method", async () => {
  let calls = 0;
  const config = readTraderConfig(KEYS);
  const provider = createTraderAIProvider({ config, fetchImpl() { calls += 1; assert.fail("Locked calls must never reach a provider"); } });
  assert.equal(provider.getStatus().paidCallsEnabled, false);
  assert.ok(provider.getStatus().providers.every((item) => item.configured));
  for (const selected of ["gemini", "openai", "claude"]) {
    for (const method of ["generate", "generateDetailed"]) {
      await assert.rejects(provider[method]({ ...request, provider: selected, paidCallsEnabled: true }),
        (error) => errorIsSafe(error, "TRADER_PAID_AI_LOCKED", 423));
    }
  }
  // Public status, request payloads, and later config mutation cannot activate a
  // provider that was created in offline mode.
  provider.getStatus().paidCallsEnabled = true;
  config.paidCallsEnabled = true;
  await assert.rejects(provider.generateDetailed(request), { code: "TRADER_PAID_AI_LOCKED" });
  assert.equal(calls, 0);
});

test("injected provider config also fails closed unless activation is boolean true", async () => {
  for (const value of [undefined, null, false, "true", 1]) {
    const config = { ...readTraderConfig(ENABLED_ENV), paidCallsEnabled: value };
    const provider = createTraderAIProvider({ config, fetchImpl() { assert.fail("Non-boolean activation must not permit a request"); } });
    assert.equal(provider.getStatus().paidCallsEnabled, false);
    await assert.rejects(provider.generateDetailed(request), { code: "TRADER_PAID_AI_LOCKED", status: 423 });
  }
});

test("invalid providers, model paths, and API-key header injection fail without exposing their values", () => {
  for (const env of [
    { TRADER_AI_PROVIDER: "__proto__" },
    { TRADER_AI_PROVIDER: KEYS.GEMINI_API_KEY },
    { GEMINI_MODEL: "gemini-3.8-flash?key=private" },
    { OPENAI_MODEL: "https://api.example.invalid/model" },
    { ANTHROPIC_MODEL: "sk-ant-private-test-key" },
    { GEMINI_API_KEY: "private\r\nX-Header: bad" },
  ]) {
    assert.throws(() => readTraderConfig(env), (error) => {
      assert.ok(!Object.values(env).some((value) => error.message.includes(value)));
      return true;
    });
  }
});

test("provider status lists all options and configuration state without exposing keys or performing a request", () => {
  const provider = createTraderAIProvider({
    config: readTraderConfig({ GEMINI_API_KEY: KEYS.GEMINI_API_KEY }),
    fetchImpl() { assert.fail("status must not contact a provider"); },
  });
  const status = provider.getStatus();
  assert.equal(status.defaultProvider, "gemini");
  assert.equal(status.paidCallsEnabled, false);
  assert.deepEqual(status.providers.map((item) => [item.id, item.configured]), [["gemini", true], ["openai", false], ["claude", false]]);
  assert.ok(!JSON.stringify(status).includes(KEYS.GEMINI_API_KEY));
  for (const item of status.providers) assert.deepEqual(Object.keys(item), ["id", "label", "model", "configured"]);
  status.providers[0].model = "mutated";
  assert.equal(provider.getStatus().providers[0].model, "gemini-3.8-flash");
});

for (const selected of ["gemini", "openai", "claude"]) {
  test(`${selected} sends credentials in headers to its fixed endpoint and returns only validated analysis`, async () => {
    const calls = [];
    const provider = createTraderAIProvider({
      config: readTraderConfig(ENABLED_ENV),
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), ...options, body: JSON.parse(options.body) });
        return response(envelope(selected));
      },
    });
    assert.equal(provider.getStatus().paidCallsEnabled, true);
    assert.deepEqual(await provider.generate({ ...request, provider: selected }), analysis);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "error");
    assert.equal(call.url.search, "");
    for (const key of Object.values(KEYS)) {
      assert.ok(!call.url.href.includes(key));
      assert.ok(!JSON.stringify(call.body).includes(key));
    }
    if (selected === "gemini") {
      assert.equal(call.url.href, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
      assert.equal(call.headers["x-goog-api-key"], KEYS.GEMINI_API_KEY);
      assert.deepEqual(call.body.systemInstruction, { parts: [{ text: request.system }] });
      assert.deepEqual(call.body.contents, [{ role: "user", parts: [{ text: request.prompt }] }]);
      assert.equal(call.body.generationConfig.responseMimeType, "application/json");
      assert.deepEqual(call.body.generationConfig.responseJsonSchema, schema);
    } else if (selected === "openai") {
      assert.equal(call.url.href, "https://api.openai.com/v1/responses");
      assert.equal(call.headers.Authorization, `Bearer ${KEYS.OPENAI_API_KEY}`);
      assert.equal(call.body.instructions, request.system);
      assert.deepEqual(call.body.input, [{ role: "user", content: request.prompt }]);
      assert.equal(call.body.store, false);
      assert.deepEqual(call.body.text.format, { type: "json_schema", name: "trader_analysis", strict: true, schema });
    } else {
      assert.equal(call.url.href, "https://api.anthropic.com/v1/messages");
      assert.equal(call.headers["x-api-key"], KEYS.ANTHROPIC_API_KEY);
      assert.equal(call.headers["anthropic-version"], "2023-06-01");
      assert.equal(call.body.system, request.system);
      assert.deepEqual(call.body.messages, [{ role: "user", content: request.prompt }]);
      assert.deepEqual(call.body.output_config.format, { type: "json_schema", schema });
    }
  });
}

test("the configured default provider is used when no provider is selected", async () => {
  const provider = createTraderAIProvider({
    config: readTraderConfig({ ...ENABLED_ENV, TRADER_AI_PROVIDER: "openai" }),
    fetchImpl: async (url) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      return response(envelope("openai"));
    },
  });
  assert.deepEqual(await provider.generate(request), analysis);
});

test("missing credentials and invalid input fail before any network request", async () => {
  const noFetch = () => assert.fail("invalid requests must not reach a provider");
  const blank = createTraderAIProvider({ config: readTraderConfig({ TRADER_PAID_AI_ENABLED: "true" }), fetchImpl: noFetch });
  await assert.rejects(blank.generate(request), (error) => errorIsSafe(error, "TRADER_PROVIDER_NOT_CONFIGURED", 503));
  const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl: noFetch });
  for (const invalid of [
    { provider: "__proto__" }, { provider: "https://api.example.invalid" }, { provider: null },
    { prompt: "" }, { system: " " }, { prompt: "a".repeat(131_073) }, { signal: {} },
    { schema: { type: "object", properties: {}, required: [] } },
    { schema: { ...schema, required: ["decision"] } },
    { schema: { ...schema, properties: { ...schema.properties, entry: { type: "number", minimum: 0 } } } },
  ]) {
    await assert.rejects(provider.generate({ ...request, ...invalid }), (error) => errorIsSafe(error, "TRADER_INPUT_INVALID", 422));
  }
});

test("provider HTTP, redirect, transport, and malformed response errors never include raw upstream details", async () => {
  for (const fetchImpl of [
    async () => new Response(`upstream-private-detail ${KEYS.GEMINI_API_KEY}`, { status: 429 }),
    async () => new Response("", { status: 302, headers: { Location: "https://api.example.invalid" } }),
    async () => { throw new Error(`upstream-private-detail ${KEYS.GEMINI_API_KEY} https://api.example.invalid`); },
    async () => new Response("not JSON upstream-private-detail", { status: 200 }),
    async () => response({ candidates: [] }),
  ]) {
    const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl });
    await assert.rejects(provider.generate(request), errorIsSafe);
  }
});

test("refused and truncated completions are rejected for all providers even when their text contains valid JSON", async () => {
  const cases = [
    ["gemini", { ...envelope("gemini"), promptFeedback: { blockReason: "SAFETY" } }],
    ["gemini", { candidates: [{ ...envelope("gemini").candidates[0], finishReason: "MAX_TOKENS" }] }],
    ["openai", { ...envelope("openai"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["openai", { status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "refusal", refusal: "upstream-private-detail" }] }] }],
    ["claude", { ...envelope("claude"), stop_reason: "refusal" }],
    ["claude", { ...envelope("claude"), stop_reason: "max_tokens" }],
  ];
  for (const [selected, body] of cases) {
    const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl: async () => response(body) });
    await assert.rejects(provider.generate({ ...request, provider: selected }), errorIsSafe);
  }
});

test("generated JSON must match the requested schema and cannot echo a configured secret", async () => {
  for (const output of [
    "```json\n{}\n```", "null", "[]", "{}",
    JSON.stringify({ ...analysis, decision: "execute" }),
    JSON.stringify({ ...analysis, entry: "100" }),
    JSON.stringify({ ...analysis, notes: [100] }),
    JSON.stringify({ ...analysis, apiKey: "unexpected field" }),
    JSON.stringify({ ...analysis, notes: [KEYS.OPENAI_API_KEY] }),
    JSON.stringify({ ...analysis, notes: [KEYS.OPENAI_API_KEY] }).replace("openai-private", "\\u006fpenai-private"),
  ]) {
    const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl: async () => response(envelope("gemini", output)) });
    await assert.rejects(provider.generate(request), errorIsSafe);
  }
});

test("oversized response bodies and generated output are rejected and the stream is canceled", async () => {
  let canceled = false;
  const oversizedStream = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
    cancel() { canceled = true; },
  }));
  for (const fetchImpl of [
    async () => new Response("{}", { headers: { "Content-Length": "1048577" } }),
    async () => oversizedStream(),
    async () => response(envelope("gemini", JSON.stringify({ ...analysis, notes: ["a".repeat(131_072)] }))),
  ]) {
    const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl });
    await assert.rejects(provider.generate(request), errorIsSafe);
  }
  assert.equal(canceled, true);
});

test("timeout bounds a fetch that ignores abort and returns a safe timeout error", async () => {
  let outboundSignal;
  const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), timeoutMs: 10, fetchImpl: async (_url, options) => {
    outboundSignal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(provider.generate(request), (error) => errorIsSafe(error, "TRADER_PROVIDER_TIMEOUT", 504));
  assert.equal(outboundSignal.aborted, true);
});

test("timeout also bounds a stalled response body and cancels its reader", async () => {
  let canceled = false;
  const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { canceled = true; },
  })) });
  await assert.rejects(provider.generate(request), (error) => errorIsSafe(error, "TRADER_PROVIDER_TIMEOUT", 504));
  assert.equal(canceled, true);
});

test("caller cancellation aborts work safely and an already aborted request never reaches the network", async () => {
  const caller = new AbortController();
  let calls = 0;
  let outboundSignal;
  const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl: async (_url, options) => {
    calls += 1;
    outboundSignal = options.signal;
    return new Promise(() => {});
  } });
  const pending = provider.generate({ ...request, signal: caller.signal });
  caller.abort(new Error(`upstream-private-detail ${KEYS.GEMINI_API_KEY}`));
  await assert.rejects(pending, errorIsSafe);
  assert.equal(outboundSignal.aborted, true);
  assert.equal(calls, 1);
  await assert.rejects(provider.generate({ ...request, signal: caller.signal }), errorIsSafe);
  assert.equal(calls, 1);
});

for (const selected of ["gemini", "openai", "claude"]) {
  test(`${selected} detailed generation normalizes billed usage and uses its documented prompt caching mechanism`, async () => {
    const calls = [];
    const metadata = selected === "gemini"
      ? { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 50, thoughtsTokenCount: 20, totalTokenCount: 190, cachedContentTokenCount: 80 } }
      : selected === "openai"
        ? { usage: { input_tokens: 120, output_tokens: 70, total_tokens: 190, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } } }
        : { usage: { input_tokens: 30, output_tokens: 70, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } };
    const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return response({ ...envelope(selected), ...metadata });
    } });
    const detailed = await provider.generateDetailed({ ...request, provider: selected, maxOutputTokens: 256, cacheKey: "stable-brain-prefix" });
    assert.deepEqual(detailed.data, analysis);
    assert.deepEqual(detailed.usage, { inputTokens: 120, outputTokens: 70, cachedInputTokens: 80, cacheCreationInputTokens: selected === "gemini" ? 0 : 10, totalTokens: 190 });
    assert.equal(detailed.provider, selected);
    assert.equal(detailed.model, readTraderConfig({}).providers[selected].model);
    assert.ok(Number.isFinite(detailed.latencyMs) && detailed.latencyMs >= 0);
    await provider.generateDetailed({ ...request, provider: selected, prompt: "Changed request following the stable system prefix.", maxOutputTokens: 256, cacheKey: "stable-brain-prefix" });
    if (selected === "gemini") {
      assert.equal(calls[0].generationConfig.maxOutputTokens, 256);
      assert.deepEqual(calls[0].systemInstruction, calls[1].systemInstruction);
      assert.equal(calls[0].cachedContent, undefined);
      assert.equal(calls[0].cacheKey, undefined);
    } else if (selected === "openai") {
      assert.equal(calls[0].max_output_tokens, 256);
      assert.match(calls[0].prompt_cache_key, /^[a-f0-9]{64}$/);
      assert.equal(calls[0].prompt_cache_key, calls[1].prompt_cache_key);
      assert.equal(calls[0].instructions, calls[1].instructions);
      assert.ok(!JSON.stringify(calls).includes("stable-brain-prefix"));
    } else {
      assert.equal(calls[0].max_tokens, 256);
      assert.deepEqual(calls[0].system, [{ type: "text", text: request.system, cache_control: { type: "ephemeral", ttl: "5m" } }]);
      assert.deepEqual(calls[0].system, calls[1].system);
    }
  });
}

test("detailed generation reports missing or invalid usage as unavailable instead of inventing token totals", async () => {
  for (const [selected, metadata] of [
    ["gemini", {}], ["openai", {}], ["claude", {}],
    ["gemini", { usageMetadata: { promptTokenCount: 10, totalTokenCount: 9 } }],
    ["gemini", { usageMetadata: { promptTokenCount: 10, totalTokenCount: 20, candidatesTokenCount: 100 } }],
    ["openai", { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 4 } }],
    ["openai", { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: null } } }],
    ["claude", { usage: { input_tokens: -1, output_tokens: 2 } }],
  ]) {
    const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl: async () => response({ ...envelope(selected), ...metadata }) });
    const result = await provider.generateDetailed({ ...request, provider: selected });
    assert.equal(result.usage, null);
    assert.deepEqual(result.data, analysis);
  }
});

test("output token limits and cache hints are validated before sending any request", async () => {
  const provider = createTraderAIProvider({ config: readTraderConfig(ENABLED_ENV), fetchImpl: () => assert.fail("Invalid options must not reach an API") });
  for (const invalid of [{ maxOutputTokens: 127 }, { maxOutputTokens: 8193 }, { maxOutputTokens: 512.5 }, { maxOutputTokens: "512" }, { cacheKey: "" }, { cacheKey: "x".repeat(257) }, { cacheKey: "invalid\nheader" }]) {
    await assert.rejects(provider.generateDetailed({ ...request, ...invalid }), (error) => errorIsSafe(error, "TRADER_INPUT_INVALID", 422));
  }
});
