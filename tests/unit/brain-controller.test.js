import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { initializeBrainPage } from "../../public/js/brain/brain-controller.js";

const filename = fileURLToPath(new URL("../../views/pages/research.ejs", import.meta.url));
const template = readFileSync(filename, "utf8");
const preferences = { provider: "gemini", symbol: "SPY", timeframe: "15m", accountSize: 50000, riskPercent: .5, pointValue: 1, minRewardRisk: 2, routes: {}, limits: { maxSteps: 12, maxModelCalls: 10, maxTokens: 64000, maxDurationMs: 120000, maxCostUsd: null } };
const workspace = { preferences, drafts: {}, storage: { kind: "sqlite", persistent: true } };
const state = { defaultProvider: "gemini", paidCallsEnabled: true, providers: [{ id: "gemini", model: "gemini-test", configured: true }, { id: "openai", model: "openai-test", configured: false }, { id: "claude", model: "claude-test", configured: true }], runs: [], documents: [] };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function run(overrides = {}) {
  return { id: "run-1", version: 12, status: "awaiting_approval", createdAt: "2026-09-14T12:00:00Z", input: { symbol: "ES", provider: "gemini", mode: "demo" }, metrics: { modelCalls: 0, toolCalls: 6, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, elapsedMs: 300, compactions: 1 },
    graph: { nodes: [{ id: "research", role: "researcher", label: "Gather evidence", status: "complete" }], edges: [] }, trace: [{ at: "2026-09-14T12:00:00Z", type: "tool", agent: "researcher", summary: "Read context", details: { tool: "context.read" } }], result: { proposalStatus: "ready", thesis: { bias: "long", summary: "Illustrative proposal", entry: 100, stop: 98, target: 106, invalidation: "Below 98", evidence: ["Reclaim [snapshot]"], missingData: [] }, risk: { passed: true, quantity: 2, maxLoss: 200, riskBudget: 250, rewardRisk: 3, reasons: [] }, review: { verdict: "pass", reason: "Demo reviewed" }, citations: [{ id: "snapshot", title: "Snapshot", excerpt: "Fictional prices" }] }, ...overrides };
}
function fixture(t, fetchImpl, options = {}) {
  const html = ejs.render(template, { page: { route: { key: "research", title: "Research", uri: "research", description: "Research control panel" } } }, { filename });
  const dom = new JSDOM(`<meta name="csrf-token" content="test-csrf">${html}`, { url: "http://localhost/research" });
  const root = dom.window.document.querySelector("[data-route-view]");
  const { workspaceFetch = async (url) => response(url === "/api/settings" ? workspace : {}), ...controllerOptions } = options;
  const fetchWorkspace = (url, init) => url.startsWith("/api/settings") ? workspaceFetch(url, init) : fetchImpl(url, init);
  const instance = initializeBrainPage(root, { fetchImpl: fetchWorkspace, ...controllerOptions });
  t.after(() => { instance.dispose(); dom.window.close(); });
  return { dom, root, instance, find: (name) => root.querySelector(`[data-brain-${name}]`), field: (name) => root.querySelector("form").elements.namedItem(name) };
}

test("loading older missions appends beyond twenty and selecting one preserves the loaded history", async (t) => {
  const recent = Array.from({ length: 20 }, (_, index) => run({ id: `recent-${index}`, status: "completed" }));
  const older = run({ id: "older", status: "completed", input: { symbol: "OLDER", mode: "demo" } });
  const app = fixture(t, async (url) => {
    if (url === "/api/brain/state") return response({ ...state, runs: recent, runsNextCursor: "next-page" });
    if (url.includes("?cursor=")) return response({ runs: [recent[19], older], nextCursor: null });
    return response({ run: older });
  });
  await tick();
  assert.equal(app.find("more-runs").hidden, false);
  app.find("more-runs").click(); await tick();
  assert.equal(app.find("history").querySelectorAll("[data-run-id]").length, 21);
  app.find("history").querySelector('[data-run-id="older"]').click(); await tick();
  assert.equal(app.find("history").querySelectorAll("[data-run-id]").length, 21);
  assert.equal(app.find("more-runs").hidden, true);
  assert.equal(app.find("status").textContent, "COMPLETED");
});

test("an old pagination response cannot replace a refreshed history or the selected mission", async (t) => {
  let finishPage, stateReads = 0;
  const current = run({ status: "completed" });
  const app = fixture(t, async (url) => {
    if (url === "/api/brain/state") return response({ ...state, runs: [current], runsNextCursor: ++stateReads === 1 ? "old-cursor" : "fresh-cursor" });
    if (url.includes("?cursor=")) return new Promise((resolve) => { finishPage = resolve; });
    return response({ run: current });
  });
  await tick(); app.find("more-runs").click(); await tick();
  assert.equal(app.find("more-runs").disabled, true);
  app.find("refresh").click(); await tick();
  finishPage(response({ runs: [run({ id: "stale-run", status: "completed" })], nextCursor: null })); await tick();
  assert.equal(app.find("history").querySelector('[data-run-id="stale-run"]'), null);
  assert.equal(app.find("more-runs").hidden, false);
  assert.equal(app.find("more-runs").disabled, false);
  assert.equal(app.find("status").textContent, "COMPLETED");
});

test("source pagination exposes loading, recoverable failure and a complete loaded count", async (t) => {
  let attempts = 0;
  const source = (id) => ({ id, title: `Source ${id}`, kind: "knowledge", characters: 12 });
  const app = fixture(t, async (url) => {
    if (url === "/api/brain/state") return response({ ...state, documents: [source("one")], documentsNextCursor: "source-cursor" });
    return ++attempts === 1 ? response({ message: "Please retry" }, 503) : response({ documents: [source("two")], nextCursor: null });
  });
  await tick(); assert.equal(app.find("document-count").textContent, "1+ SOURCES");
  app.find("more-documents").click(); await tick();
  assert.match(app.find("sources-feedback").textContent, /retry/);
  assert.equal(app.find("more-documents").disabled, false);
  app.find("more-documents").click(); await tick();
  assert.equal(app.find("documents").querySelectorAll("[data-document-id]").length, 2);
  assert.equal(app.find("document-count").textContent, "2 SOURCES");
  assert.equal(app.find("more-documents").hidden, true);
});

test("a saved review note is restored only for its associated mission", async (t) => {
  const saved = { ...workspace, drafts: { research: { fields: { approvalRunId: "run-1", approvalNote: "Check the date before accepting" } } } };
  const app = fixture(t, async () => response({ ...state, runs: [run()] }), { workspaceFetch: async () => response(saved) });
  const other = fixture(t, async () => response({ ...state, runs: [run({ id: "run-2" })] }), { workspaceFetch: async () => response(saved) });
  await tick();
  assert.equal(app.find("note").value, "Check the date before accepting");
  assert.equal(other.find("note").value, "");
});

test("leaving an unfinished review saves its note with the exact mission id", async (t) => {
  let written;
  const app = fixture(t, async () => response({ ...state, runs: [run()] }), { workspaceFetch: async (url, options) => {
    if (url.endsWith("/drafts/research")) written = JSON.parse(options.body).fields;
    return response(workspace);
  } });
  await tick();
  app.find("note").value = "Need a newer quote";
  app.find("note").dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  app.instance.dispose(); await tick();
  assert.equal(written.approvalRunId, "run-1");
  assert.equal(written.approvalNote, "Need a newer quote");
});
test("Gemini defaults and unavailable role routes disable paid missions but keep demo", async (t) => {
  const app = fixture(t, async () => response(state)); await tick();
  assert.equal(app.field("provider").value, "gemini"); assert.equal(app.find("start").disabled, false);
  app.field("route_critic").value = "openai"; app.field("route_critic").dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  assert.equal(app.find("start").disabled, true); assert.equal(app.find("demo").disabled, false);
  assert.match(app.find("provider").textContent, /Settings/); assert.equal(app.root.querySelector('input[type="password"]'), null);
});

test("demo submits explicit role routes and budgets with CSRF then renders review", async (t) => {
  const calls = []; const app = fixture(t, async (url, options) => { calls.push({ url, options }); return response(url.endsWith("state") ? state : { run: run() }); }); await tick();
  app.field("route_critic").value = "claude"; app.field("maxCostUsd").value = "0.25"; app.find("demo").click(); await tick();
  const call = calls.find((item) => item.url.endsWith("runs")), body = JSON.parse(call.options.body);
  assert.equal(call.options.headers["X-CSRF-Token"], "test-csrf"); assert.equal(body.mode, "demo"); assert.equal(body.routes.critic, "claude"); assert.equal(body.limits.maxCostUsd, .25); assert.equal(body.limits.maxDurationMs, 120000);
  assert.equal(app.find("approval").hidden, false); assert.match(app.find("result").textContent, /2 whole units/); assert.match(app.find("trace").textContent, /CONTEXT|context/);
});
test("approval sends displayed version and review note and refreshes accepted memory", async (t) => {
  let decision; const app = fixture(t, async (url, options) => {
    if (url.endsWith("state")) return response({ ...state, runs: [run()] });
    if (url.endsWith("decision")) { decision = JSON.parse(options.body); return response({ run: run({ status: "completed", version: 14, approval: { decision: "approve", note: decision.note } }) }); }
    return response({ documents: [{ id: "run:run-1", title: "Approved ES research", kind: "memory", characters: 80 }] });
  }); await tick(); app.find("note").value = "Keep the lesson"; app.find("approve").click(); await tick();
  assert.deepEqual(decision, { version: 12, decision: "approve", note: "Keep the lesson" }); assert.equal(app.find("approval").hidden, true); assert.match(app.find("documents").textContent, /Approved ES research/);
});
test("conflicting approval preserves review and shows server message", async (t) => {
  const app = fixture(t, async (url) => url.endsWith("state") ? response({ ...state, runs: [run()] }) : response({ message: "The run changed. Reload it." }, 409)); await tick(); app.find("approve").click(); await tick();
  assert.equal(app.find("approval").hidden, false); assert.equal(app.find("approve").disabled, false); assert.match(app.find("feedback").textContent, /run changed/);
});
test("untrusted model, trace and document markup is displayed as text", async (t) => {
  const malicious = '<img src=x onerror="alert(1)">'; const value = run(); value.result.thesis.summary = malicious; value.trace[0].summary = malicious; value.result.citations[0].excerpt = malicious;
  const app = fixture(t, async () => response({ ...state, runs: [value], documents: [{ id: "d", title: malicious, kind: "knowledge", characters: 12 }] })); await tick();
  assert.equal(app.root.querySelector("img"), null); assert.match(app.find("result").textContent, /<img/); assert.match(app.find("documents").textContent, /<img/); assert.equal(app.dom.window.localStorage.length, 0);
});
test("polling advances a running mission to its approval checkpoint", async (t) => {
  let poll; const timers = []; const fakeWindow = { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} };
  const app = fixture(t, async (url) => { if (url.endsWith("state")) return response({ ...state, runs: [run({ status: "running", result: null })] }); poll = url; return response({ run: run() }); }, { windowRef: fakeWindow }); await tick();
  assert.equal(app.find("cancel").hidden, false); await timers.at(-1)();
  assert.equal(poll, "/api/brain/runs/run-1"); assert.equal(app.find("cancel").hidden, true); assert.equal(app.find("approval").hidden, false);
});
test("cancellation targets the selected run and stops further polling", async (t) => {
  const calls = []; const app = fixture(t, async (url, options) => { calls.push({ url, options }); return response(url.endsWith("state") ? { ...state, runs: [run({ status: "running", result: null })] } : { run: run({ status: "cancelled", result: null }) }); }); await tick(); app.find("cancel").click(); await tick();
  assert.equal(calls[1].url, "/api/brain/runs/run-1/cancel"); assert.equal(calls[1].options.method, "POST"); assert.equal(app.find("status").textContent, "CANCELLED"); assert.equal(app.find("demo").disabled, false);
});
test("navigation disposal aborts pending requests without modifying a detached page", async (t) => {
  let signal; const app = fixture(t, (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  await tick(); app.instance.dispose(); assert.equal(signal.aborted, true);
});
test("failed initial state can be retried with Refresh", async (t) => {
  let attempts = 0; const app = fixture(t, async () => ++attempts === 1 ? response({ message: "Temporarily offline" }, 503) : response(state)); await tick();
  assert.match(app.find("feedback").textContent, /offline/); app.find("refresh").click(); await tick(); assert.equal(app.find("demo").disabled, false);
});
test("source form supports knowledge only and sends text with CSRF", async (t) => {
  let payload; const app = fixture(t, async (url, options) => { if (url.endsWith("state")) return response(state); if (options.method === "POST") { payload = JSON.parse(options.body); assert.equal(options.headers["X-CSRF-Token"], "test-csrf"); return response({ document: { id: "source" } }, 201); } return response({ documents: [{ id: "source", title: "ES lesson", kind: "knowledge", characters: 25 }] }); }); await tick();
  const form = app.find("document-form"); form.elements.title.value = "ES lesson"; form.elements.text.value = "Use dated session context.";
  form.dispatchEvent(new app.dom.window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.equal(payload.kind, "knowledge"); assert.equal(payload.text, "Use dated session context."); assert.equal(form.querySelector('option[value="memory"]'), null); assert.match(app.find("documents").textContent, /ES lesson/);
});
test("configured keys cannot unlock analysis without explicit server enablement", async (t) => {
  for (const flag of [false, undefined, "true"]) {
    const calls = []; const app = fixture(t, async (url) => { calls.push(url); return response({ ...state, paidCallsEnabled: flag }); }); await tick();
    assert.equal(app.find("start").disabled, true); assert.equal(app.find("demo").disabled, false);
    assert.match(app.find("cost-lock").textContent, /Paid AI calls locked/);
    app.field("provider").value = "claude"; app.find("form").dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
    app.find("form").dispatchEvent(new app.dom.window.Event("submit", { bubbles: true, cancelable: true })); await tick();
    assert.equal(app.find("start").disabled, true); assert.deepEqual(calls, ["/api/brain/state"]);
  }
});

test("locked mode still runs the explicit offline demo", async (t) => {
  const calls = []; const app = fixture(t, async (url, options) => { calls.push({ url, options }); return response(url.endsWith("state") ? { ...state, paidCallsEnabled: false } : { run: run() }); }); await tick();
  app.find("demo").click(); await tick();
  assert.equal(JSON.parse(calls[1].options.body).mode, "demo"); assert.equal(app.find("approval").hidden, false);
  assert.match(app.find("cost-lock").textContent, /Paid AI calls locked/);
});

test("failed readiness refresh disables paid submissions and disposed failures leave markup unchanged", async (t) => {
  let attempts = 0; const app = fixture(t, async () => ++attempts === 1 ? response(state) : response({ message: "Server unavailable" }, 503)); await tick();
  assert.equal(app.find("start").disabled, false); app.find("refresh").click(); await tick();
  assert.equal(app.find("start").disabled, true); assert.equal(app.find("demo").disabled, false);
  let fail; const detached = fixture(t, () => new Promise((_resolve, reject) => { fail = reject; }));
  await tick(); detached.instance.dispose(); const before = detached.root.outerHTML; fail(new Error("Aborted")); await tick();
  assert.equal(detached.root.outerHTML, before);
});


test('research restores account defaults and saved drafts while keeping configuration in Settings', async (t) => {
  const saved = { ...workspace, preferences: { ...preferences, provider: 'claude', riskPercent: .75, routes: { critic: 'claude' } }, drafts: { research: { fields: { objective: 'Continue this saved research', symbol: 'BTC', timeframe: '1h', context: 'My unfinished dated market context' } }, knowledge: { fields: { title: 'Saved playbook', text: 'Saved source draft' } } } };
  const app = fixture(t, async () => response(state), { workspaceFetch: async () => response(saved) }); await tick();
  assert.equal(app.field('provider').value, 'claude'); assert.equal(app.field('riskPercent').value, '0.75');
  assert.equal(app.field('objective').value, 'Continue this saved research'); assert.equal(app.field('symbol').value, 'BTC');
  assert.equal(app.find('document-form').elements.title.value, 'Saved playbook');
  assert.equal(app.root.querySelector('input[type="password"]'), null);
  assert.equal(app.field('provider').type, 'hidden');
  const tab = (name) => app.root.querySelector(`[data-brain-view="${name}"]`);
  tab('mission').dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(tab('knowledge').getAttribute('aria-selected'), 'true');
  assert.equal(app.dom.window.document.activeElement, tab('knowledge'));
  assert.equal(app.field('context').value, 'My unfinished dated market context');
});

test('unavailable saved defaults block paid research while the offline demo stays available', async (t) => {
  const calls = [];
  const app = fixture(t, async (url) => { calls.push(url); return response(state); }, { workspaceFetch: async () => response({ message: 'Unavailable' }, 503) }); await tick();
  assert.equal(app.find('start').disabled, true); assert.equal(app.find('demo').disabled, false);
  app.find('form').dispatchEvent(new app.dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(calls, ['/api/brain/state']);
});

test('late draft restoration does not overwrite input already typed by the user', async (t) => {
  let complete;
  const app = fixture(t, async () => response(state), { workspaceFetch: (url) => url === '/api/settings' ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(response({ saved: true })) });
  await tick(); app.field('objective').value = 'Keep the text I am typing'; app.field('objective').dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  complete(response({ ...workspace, drafts: { research: { fields: { objective: 'Old saved draft' } } } })); await tick();
  assert.equal(app.field('objective').value, 'Keep the text I am typing');
});

test('leaving Research flushes the draft with CSRF and does not write credentials to browser storage', async (t) => {
  const writes = [];
  const app = fixture(t, async () => response(state), { workspaceFetch: async (url, options) => { if (url === '/api/settings') return response(workspace); writes.push({ url, options }); return response({ saved: true }); } }); await tick();
  app.field('context').value = 'Keep this research after I leave'; app.field('context').dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.instance.dispose(); await tick();
  const saved = writes.find((item) => item.url === '/api/settings/drafts/research');
  assert.equal(saved.options.method, 'PUT'); assert.equal(saved.options.keepalive, true);
  assert.equal(saved.options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(JSON.parse(saved.options.body).fields.context, 'Keep this research after I leave');
  assert.equal(app.dom.window.localStorage.length, 0);
});
