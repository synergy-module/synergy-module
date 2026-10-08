import test from "node:test";
import assert from "node:assert/strict";
import {
  createEconomiciumCalendarProvider,
  MarketNewsProviderError,
} from "../../src/providers/economicium-calendar-provider.js";

test("provider requests the public calendar without credentials and returns the requested week", async () => {
  const calls = [];
  const provider = createEconomiciumCalendarProvider({
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new Response(JSON.stringify({ events: [
        { date: "2026-08-29", title: "Outside range" },
        { date: "2026-08-30", title: "Inside range" },
        { date: "2026-09-05", title: "Range boundary" },
        { date: "2026-09-06", title: "Outside range" },
      ] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const rows = await provider.fetchWeek({ from: "2026-08-30", to: "2026-09-05" });

  assert.deepEqual(rows.map((row) => row.title), ["Inside range", "Range boundary"]);
  assert.equal(calls[0].url.origin, "https://www.economicium.com");
  assert.equal(calls[0].url.pathname, "/api/calendar");
  assert.equal(calls[0].url.search, "");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test("provider converts HTTP and malformed-payload failures to a safe error", async () => {
  for (const response of [
    new Response("upstream secret detail", { status: 429 }),
    new Response(JSON.stringify({ events: "not an array" }), { status: 200 }),
  ]) {
    const provider = createEconomiciumCalendarProvider({
      fetchImpl: async () => response,
    });
    await assert.rejects(
      provider.fetchWeek({ from: "2026-08-30", to: "2026-09-05" }),
      MarketNewsProviderError,
    );
  }
});

test("provider aborts a bounded request timeout and exposes only a safe typed error", async () => {
  let abortSignal;
  let triggerTimeout;
  const clearedTimers = [];
  const provider = createEconomiciumCalendarProvider({
    requestTimeoutMs: 250,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 250);
      triggerTimeout = callback;
      return "provider-timeout";
    },
    clearTimeoutImpl(timer) {
      clearedTimers.push(timer);
    },
    fetchImpl: async (_url, options) => {
      abortSignal = options.signal;
      return new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => {
          reject(new DOMException("upstream URL/body detail", "AbortError"));
        }, { once: true });
      });
    },
  });

  const request = provider.fetchWeek({ from: "2026-08-30", to: "2026-09-05" });

  assert.equal(typeof triggerTimeout, "function");
  triggerTimeout();
  await assert.rejects(request, (error) => {
    assert.ok(error instanceof MarketNewsProviderError);
    assert.equal(error.message, "Economic calendar provider is unavailable");
    assert.doesNotMatch(error.message, /URL|body/i);
    return true;
  });
  assert.equal(abortSignal.aborted, true);
  assert.deepEqual(clearedTimers, ["provider-timeout"]);
});
