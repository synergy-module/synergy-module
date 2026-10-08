import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { initializeTraderPage } from "../../public/js/trader/trader-controller.js";

const templatePath = fileURLToPath(new URL("../../views/pages/trader.ejs", import.meta.url));
const template = readFileSync(templatePath, "utf8");
const state = {
  defaultProvider: "gemini",
  paidCallsEnabled: true,
  providers: [
    { id: "gemini", label: "Gemini", model: "gemini-test", configured: true },
    { id: "openai", label: "OpenAI", model: "openai-test", configured: false },
    { id: "claude", label: "Claude", model: "claude-test", configured: true },
  ],
  runs: [],
};

function run(overrides = {}) {
  return {
    id: "run-1", createdAt: "2026-09-14T15:30:00.000Z", provider: "gemini", model: "gemini-test",
    mode: "analysis", symbol: "ES", timeframe: "15m", status: "ready", bias: "long",
    summary: "A reclaim supports a conditional long thesis.",
    plan: { entry: 100, stop: 98, target: 106, invalidation: "A close below 98 invalidates the idea." },
    risk: { accountSize: 50000, riskPercent: 0.5, riskBudget: 250, pointValue: 50, minRewardRisk: 2, rewardRisk: 3, quantity: 2, maxLoss: 200, passed: true, reasons: [] },
    evidence: ["User supplied a reclaim level."], missingData: ["Independent price verification unavailable."],
    steps: [{ id: "context", label: "Read context", status: "complete", detail: "Reviewed the supplied observations." }, { id: "review", label: "Review plan", status: "warning", detail: "Verify the market data before acting." }],
    review: { verdict: "ready", reason: "Proposed sizing is within the stated risk budget." },
    dataSource: "User-supplied context; unverified", ...overrides,
  };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function fixture(t, fetchImpl, options = {}) {
  const html = ejs.render(template, { page: { route: { key: "trader", title: "Agentic Trader", uri: "trader", description: "Agent workspace" } } }, { filename: templatePath });
  const dom = new JSDOM(`<meta name="csrf-token" content="csrf-test-token">${html}`, { url: "http://localhost/trader" });
  const root = dom.window.document.querySelector("[data-trader]");
  const instance = initializeTraderPage(root, { fetchImpl, ...options });
  t.after(() => { instance.dispose(); dom.window.close(); });
  return {
    dom, root, instance,
    find: (selector) => root.querySelector(selector),
    form: root.querySelector("[data-trader-form]"),
    field: (name) => root.querySelector("[data-trader-form]").elements.namedItem(name),
  };
}

async function tick() { await new Promise((resolve) => setImmediate(resolve)); }

function submit({ dom, form, field }) {
  field("context").value ||= "2026-09-14 15:00 UTC: price reclaimed 100 after a sweep of 98, with resistance at 106.";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
}

test("loads provider readiness with Gemini selected and no credential fields or browser storage", async (t) => {
  const calls = [];
  const app = fixture(t, async (url, options) => { calls.push({ url, options }); return response(state); });
  assert.equal(app.find("[data-trader-submit]").disabled, true);
  await tick();

  assert.equal(calls[0].url, "/api/trader/state");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(app.field("provider").value, "gemini");
  assert.equal(app.find("[data-trader-model]").textContent, "gemini-test");
  assert.equal(app.find("[data-trader-submit]").disabled, false);
  assert.match(app.find("[data-trader-provider-status]").textContent, /configured on server/);
  assert.equal(app.root.querySelectorAll('input[type="radio"][name="provider"]').length, 3);
  assert.equal(app.root.querySelector('input[type="password"]'), null);
  assert.equal(app.dom.window.localStorage.length, 0);
  assert.equal(app.dom.window.sessionStorage.length, 0);
});

test("provider switching shows model and server setup names while retaining every provider option", async (t) => {
  const app = fixture(t, async () => response(state));
  await tick();
  app.find('input[value="openai"]').click();
  assert.equal(app.field("provider").value, "openai");
  assert.equal(app.find("[data-trader-model]").textContent, "openai-test");
  assert.match(app.find("[data-trader-provider-status]").textContent, /OPENAI_API_KEY/);
  assert.equal(app.find("[data-trader-submit]").disabled, true);
  assert.equal(app.find("[data-trader-demo]").disabled, false);

  app.find('input[value="claude"]').click();
  assert.equal(app.find("[data-trader-model]").textContent, "claude-test");
  assert.equal(app.find("[data-trader-submit]").disabled, false);
  assert.equal(app.find("[data-trader-provider-status]").dataset.ready, "true");
});

test("honors the server default provider and distinguishes an unconfigured Claude key", async (t) => {
  const app = fixture(t, async () => response({ ...state, defaultProvider: "claude", providers: state.providers.map((provider) => ({ ...provider, configured: false })) }));
  await tick();
  assert.equal(app.field("provider").value, "claude");
  assert.match(app.find("[data-trader-provider-status]").textContent, /ANTHROPIC_API_KEY/);
  assert.equal(app.find("[data-trader-submit]").disabled, true);
});

test("submits selected context and numeric risk parameters with CSRF then renders the actual result", async (t) => {
  const calls = [];
  let finishRun;
  const app = fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("state")) return response(state);
    return new Promise((resolve) => { finishRun = resolve; });
  });
  await tick();
  app.find('input[value="claude"]').click();
  app.field("symbol").value = "nq";
  app.field("timeframe").value = "1h";
  app.field("context").value = "  Context with a dated market observation and clear proposed price levels.  ";
  app.field("riskPercent").value = "1";
  app.field("pointValue").value = "20";
  submit(app);
  submit(app);

  assert.equal(calls.length, 2);
  const request = calls[1];
  assert.equal(request.url, "/api/trader/runs");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["X-CSRF-Token"], "csrf-test-token");
  assert.deepEqual(JSON.parse(request.options.body), {
    provider: "claude", mode: "analysis", symbol: "NQ", timeframe: "1h",
    context: "Context with a dated market observation and clear proposed price levels.",
    accountSize: 50000, riskPercent: 1, pointValue: 20, minRewardRisk: 2,
  });
  assert.equal(app.root.getAttribute("aria-busy"), "true");
  assert.equal(app.find("[data-trader-demo]").disabled, true);
  assert.equal(app.field("context").disabled, true);
  assert.match(app.find("[data-trader-feedback]").textContent, /Claude is analyzing/);
  assert.equal(app.find("[data-trader-result]").hidden, true);

  finishRun(response({ run: run({ provider: "claude", model: "claude-test", symbol: "NQ", timeframe: "1h" }) }));
  await tick();
  assert.equal(app.root.getAttribute("aria-busy"), "false");
  assert.equal(app.find("[data-trader-empty]").hidden, true);
  assert.equal(app.find("[data-trader-result]").hidden, false);
  assert.match(app.find("[data-trader-result]").textContent, /NQ \/ 1h/);
  assert.match(app.find("[data-trader-result]").textContent, /\$200\.00/);
  assert.match(app.find("[data-trader-result]").textContent, /claude-test/);
  assert.equal(app.find("[data-trader-output-state]").textContent, "READY FOR REVIEW");
  assert.equal(app.field("context").disabled, false);
});

test("explicit demo needs no key or market context and uses the visible risk settings", async (t) => {
  const calls = [];
  const app = fixture(t, async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith("state")
      ? { ...state, providers: state.providers.map((provider) => ({ ...provider, configured: false })) }
      : { run: run({ mode: "demo" }) });
  });
  await tick();
  assert.equal(app.field("context").value, "");
  assert.equal(app.find("[data-trader-submit]").disabled, true);
  app.field("accountSize").value = "10000";
  app.field("riskPercent").value = "0.25";
  app.field("pointValue").value = "50";
  app.field("minRewardRisk").value = "4";
  app.find("[data-trader-demo]").click();
  await tick();
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.mode, "demo");
  assert.equal(payload.symbol, "SPY");
  assert.equal(payload.accountSize, 10000);
  assert.equal(payload.riskPercent, 0.25);
  assert.equal(payload.pointValue, 50);
  assert.equal(payload.minRewardRisk, 4);
  assert.match(payload.context, /Illustrative scenario only/);
  assert.match(app.find(".trader-demo-banner").textContent, /No AI provider or market data was used/);
  assert.match(app.find("[data-trader-history]").textContent, /ILLUSTRATIVE DEMO/);
});

test("an invalid risk field prevents demo submission without requiring market context", async (t) => {
  let calls = 0;
  const app = fixture(t, async () => { calls += 1; return response(state); });
  await tick();
  app.field("riskPercent").value = "10";
  app.find("[data-trader-demo]").click();
  await tick();
  assert.equal(calls, 1);
  assert.equal(app.field("riskPercent").validity.rangeOverflow, true);
});

test("API errors retain the previous run, display the error, and release busy controls", async (t) => {
  const toasts = [];
  const app = fixture(t, async (url) => response(url.endsWith("state") ? { ...state, runs: [run()] } : { error: "provider_unavailable", message: "Provider quota exceeded. Try again later." }, url.endsWith("state") ? 200 : 503), { showToast: (message) => toasts.push(message) });
  await tick();
  submit(app);
  await tick();
  assert.match(app.find("[data-trader-feedback]").textContent, /quota exceeded/);
  assert.equal(app.find("[data-trader-feedback]").dataset.error, "true");
  assert.match(app.find("[data-trader-result]").textContent, /A reclaim supports/);
  assert.equal(app.find("[data-trader-submit]").disabled, false);
  assert.equal(app.find("[data-trader-history-count]").textContent, "1 RUN");
  assert.deepEqual(toasts, ["TRADER RUN FAILED"]);
});

test("untrusted model strings render as text across thesis, plan, evidence, review, trace, and history", async (t) => {
  const hostile = '<img src=x onerror="alert(1)">';
  const unsafeRun = run({
    id: '\"><script>alert(1)</script>', symbol: hostile, summary: hostile, bias: hostile,
    plan: { entry: null, stop: null, target: null, invalidation: hostile },
    evidence: [hostile], missingData: [hostile], review: { verdict: hostile, reason: hostile },
    steps: [{ id: hostile, label: hostile, detail: hostile, status: "warning" }], dataSource: hostile,
  });
  const app = fixture(t, async () => response({ ...state, runs: [unsafeRun] }));
  await tick();
  assert.equal(app.root.querySelector("img, script"), null);
  assert.match(app.find("[data-trader-result]").textContent, /<img src=x/);
  assert.match(app.find("[data-trader-history]").textContent, /<img src=x/);
  assert.equal(app.find("[data-trader-run-id]").dataset.traderRunId, unsafeRun.id);
});

test("history restores complete run details and waiting status without another request", async (t) => {
  let calls = 0;
  const waiting = run({ id: "run-2", status: "wait", symbol: "NQ", summary: "Insufficient evidence. Wait for confirmation.", review: { verdict: "wait", reason: "Missing confirmation." } });
  const app = fixture(t, async () => { calls += 1; return response({ ...state, runs: [run(), waiting] }); });
  await tick();
  app.find('[data-trader-run-id="run-2"]').click();
  assert.equal(calls, 1);
  assert.match(app.find("[data-trader-result]").textContent, /Insufficient evidence/);
  assert.equal(app.find("[data-trader-output-state]").textContent, "WAIT / NO TRADE");
  assert.equal(app.find('[data-trader-run-id="run-2"]').getAttribute("aria-pressed"), "true");
  assert.equal(app.find('[data-trader-run-id="run-1"]').getAttribute("aria-pressed"), "false");
});

test("state failure offers a retry and subsequent successful load unlocks configured analysis", async (t) => {
  let calls = 0;
  const app = fixture(t, async () => {
    calls += 1;
    if (calls === 1) throw new Error("Connection unavailable.");
    return response(state);
  });
  await tick();
  assert.equal(app.find("[data-trader-submit]").disabled, true);
  assert.equal(app.find("[data-trader-demo]").disabled, false);
  assert.equal(app.find("[data-trader-refresh]").hidden, false);
  app.find("[data-trader-refresh]").click();
  await tick();
  assert.equal(calls, 2);
  assert.equal(app.find("[data-trader-submit]").disabled, false);
  assert.equal(app.find("[data-trader-refresh]").hidden, true);
  assert.equal(app.find("[data-trader-feedback]").dataset.error, "false");
});

test("dispose aborts loading and prevents a late state response from changing detached DOM", async (t) => {
  let finishState;
  let signal;
  const app = fixture(t, async (_url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finishState = resolve; });
  });
  app.instance.dispose();
  app.root.remove();
  const before = app.root.outerHTML;
  finishState(response({ ...state, runs: [run()] }));
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(app.root.outerHTML, before);
});

test("dispose aborts an active analysis and prevents late output or toast updates", async (t) => {
  let finishRun;
  let signal;
  const toasts = [];
  const app = fixture(t, async (url, options) => {
    if (url.endsWith("state")) return response(state);
    signal = options.signal;
    return new Promise((resolve) => { finishRun = resolve; });
  }, { showToast: (message) => toasts.push(message) });
  await tick();
  submit(app);
  app.instance.dispose();
  const before = app.root.outerHTML;
  finishRun(response({ run: run() }));
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(app.root.outerHTML, before);
  assert.deepEqual(toasts, []);
});

test("reinitialization is idempotent and does not duplicate state requests", async (t) => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(state); };
  const app = fixture(t, fetchImpl);
  assert.equal(initializeTraderPage(app.root, { fetchImpl }), app.instance);
  await tick();
  assert.equal(calls, 1);
});

test("keys and provider switching cannot bypass a missing or disabled paid-call flag", async (t) => {
  for (const flag of [false, undefined, "true"]) {
    const calls = []; const app = fixture(t, async (url) => { calls.push(url); return response({ ...state, paidCallsEnabled: flag }); }); await tick();
    assert.equal(app.find("[data-trader-submit]").disabled, true);
    assert.equal(app.find("[data-trader-demo]").disabled, false);
    assert.match(app.find("[data-trader-cost-lock]").textContent, /Paid AI calls locked/);
    app.find('input[value="claude"]').click(); submit(app); await tick();
    assert.equal(app.find("[data-trader-submit]").disabled, true);
    assert.equal(app.find("[data-trader-provider-status]").dataset.ready, "false");
    assert.deepEqual(calls, ["/api/trader/state"]);
  }
});

test("paid-call lock permits the explicitly selected fixed demo", async (t) => {
  const calls = []; const app = fixture(t, async (url, options) => { calls.push({ url, options }); return response(url.endsWith("state") ? { ...state, paidCallsEnabled: false } : { run: run({ mode: "demo" }) }); }); await tick();
  app.find("[data-trader-demo]").click(); await tick();
  assert.equal(JSON.parse(calls[1].options.body).mode, "demo");
  assert.match(app.find("[data-trader-result]").textContent, /No AI provider or market data was used/);
  assert.equal(app.find("[data-trader-submit]").disabled, true);
});
