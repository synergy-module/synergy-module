import { createWorkspaceRequest } from "./workspace-client.js";

const money = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value) : "--";
const date = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) + " CT" : "--";
const LABELS = { claude: "Claude", gemini: "Gemini", grok: "Grok", openai: "ChatGPT / Codex" };

export function initializeRobinhoodBrain(root, { fetchImpl, windowRef = root.ownerDocument.defaultView } = {}) {
  const document = root.ownerDocument, request = createWorkspaceRequest(root, fetchImpl), abort = new AbortController();
  const call = (url, body, method) => request(`/api/robinhood-brain/${url}`, body, method, { signal: abort.signal });
  const q = key => root.querySelector(`[data-rh-${key}]`);
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, action, id, className = "btn") => { const node = el("button", text, className); node.type = "button"; node.dataset.rhAction = action; if (id) node.dataset.id = id; return node; };
  const listeners = [], form = q("policy-form"), noteForm = q("note-form");
  let state, selectedRunId, disposed = false, busy = false, dirty = false, timer;
  const on = (target, event, fn) => { target.addEventListener(event, fn); listeners.push(() => target.removeEventListener(event, fn)); };
  const say = (text, error = false) => { if (!disposed) { q("feedback").textContent = text; q("feedback").dataset.error = String(error); } };
  function controls() {
    if (disposed) return;
    const active = state?.worker.running || state?.runs[0]?.status === "running";
    for (const control of root.querySelectorAll('[data-rh-action],button[type="submit"]')) control.disabled = !state || busy;
    root.querySelector('[data-rh-action="pause"]').disabled = !state || !active;
    root.querySelector('[data-rh-action="demo"]').disabled = !state || busy || active;
    root.querySelector('[data-rh-action="cycle"]').disabled = !state || busy || active || !state.broker.connected || !state.paidCallsEnabled || !state.verifiedAt;
    root.querySelector('[data-rh-action="start"]').disabled = !state || busy || active || !state.broker.connected || !state.paidCallsEnabled || !state.verifiedAt;
    for (const control of form.elements) control.disabled = !state || busy || active;
    const mode = root.querySelector('input[name="rh-mode"]:checked')?.value;
    q("consent-label").hidden = mode !== "autonomous";
    q("authority").textContent = mode === "paper" ? "Paper orders only. No real funds are used."
      : mode === "review" ? "Each prepared order requires its own approval in Accounts."
      : `Account ${state?.policy.accountNumber || "unselected"}; symbols ${(state?.policy.symbols ?? []).join(", ")}; maximum ${money(state?.policy.orderBudgetUsd)} per order. Server activation and ten verified dry-run days are required.`;
  }
  function tab(key, focus = false, updateUrl = true) {
    const tabs = [...root.querySelectorAll("[data-rh-tab]")]; if (!tabs.some(item => item.dataset.rhTab === key)) key = "mission";
    for (const item of tabs) { const active = item.dataset.rhTab === key; item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1; if (focus && active) item.focus(); }
    for (const panel of root.querySelectorAll("[data-rh-panel]")) panel.hidden = panel.dataset.rhPanel !== key;
    if (updateUrl) { const url = new URL(windowRef.location.href); if (key === "mission") url.searchParams.delete("view"); else url.searchParams.set("view", key); windowRef.history.replaceState(windowRef.history.state, "", url); }
  }
  function renderRun() {
    const run = state?.runs.find(row => row.id === selectedRunId) ?? state?.runs[0], target = q("run"); target.replaceChildren();
    if (!run) { target.append(el("p", "No saved cycle.", "poly-muted")); q("phase").textContent = "NO CYCLE"; return; }
    q("phase").textContent = `${run.status.toUpperCase()} / ${run.phase?.toUpperCase() ?? "OBSERVE"}`;
    target.append(el("p", `${date(run.startedAt)} / ${run.mode.toUpperCase()} / ${run.modelCalls ?? 0} model calls`, "rh-run-summary"));
    if (run.mode === "demo") target.append(el("p", "Offline demonstration with synthetic data. No provider or brokerage calls.", "poly-model-note"));
    if (run.error) target.append(el("p", run.error, "poly-negative"));
    for (const thesis of run.theses ?? []) {
      const item = el("article", undefined, "poly-record"); item.append(el("h4", `${thesis.symbol} / ${thesis.direction.replaceAll("_", " ")} / ${thesis.conviction}`), el("p", thesis.summary), el("p", `Review: ${thesis.critic} / ${thesis.critique}`, "poly-muted"), el("p", `Invalidation: ${thesis.invalidation}`, "poly-muted")); target.append(item);
    }
    for (const reject of run.plan?.rejects ?? []) target.append(el("p", `${reject.symbol}: ${reject.reason}`, "poly-model-note"));
    for (const execution of run.executions ?? []) target.append(el("p", `${execution.side.toUpperCase()} ${execution.symbol} / ${execution.quantity} shares @ ${money(execution.limitPrice)} / ${execution.status}`, "rh-run-summary"));
    const trace = el("ol", undefined, "rh-trace"); for (const step of run.events ?? []) { const row = el("li"); row.append(el("b", step.phase), el("span", step.message)); trace.append(row); } target.append(trace);
    if (run.sources?.length) { const details = el("details"); details.append(el("summary", "Source observations")); for (const source of run.sources) details.append(el("p", `${source.tool} / ${source.id} / ${date(source.fetchedAt)}`, "poly-model-note")); target.append(details); }
  }
  function render(value) {
    if (disposed) return;
    const memoryChanged = !state || JSON.stringify([state.notes, state.memories]) !== JSON.stringify([value.notes, value.memories]);
    state = value; q("mode").textContent = value.mode.toUpperCase();
    q("routing").textContent = `${LABELS[value.policy.provider]} research / ${LABELS[value.policy.criticProvider]} review / ${value.paidCallsEnabled ? "AI ENABLED" : "PAID AI LOCKED"}`;
    q("worker").textContent = value.worker.running ? "WORKER RUNNING" : "WORKER PAUSED";
    q("policy-version").textContent = `VERSION ${value.version} / ${value.dryDays.length} VERIFIED DAYS`;
    q("verified").textContent = value.verifiedAt ? `VERIFIED ${date(value.verifiedAt)}` : "MAPPING UNVERIFIED";
    q("storage").textContent = value.storage.persistent ? `${value.storage.kind.toUpperCase()} SAVED` : "TEMPORARY MEMORY";
    q("readiness").replaceChildren();
    for (const check of value.readiness) { const row = el("li"); row.dataset.pass = String(check.pass); row.append(el("b", check.pass ? "+" : "-"), el("span", check.name)); q("readiness").append(row); }
    if (!dirty) {
      for (const [key, field] of Object.entries(value.policy)) form.elements[key].value = key === "symbols" ? field.join(", ") : field;
      form.elements.bindings.value = JSON.stringify(value.bindings, null, 2);
    }
    q("history").replaceChildren();
    for (const run of value.runs) { const entry = button(`${date(run.startedAt)} / ${run.mode}`, "history", run.id, "rh-history-item"); entry.append(el("small", run.status)); q("history").append(entry); }
    renderRun();
    q("stats").replaceChildren();
    const paper = value.paper, equity = paper.cash + paper.positions.reduce((sum, pos) => sum + pos.value, 0);
    for (const [label, text] of [["Paper cash", paper.initialized ? money(paper.cash) : "Not initialized"], ["Paper equity", paper.initialized ? money(equity) : "Not initialized"], ["Realized paper P&L", money(paper.realizedPnl)], ["Open paper positions", String(paper.positions.length)]]) {
      const group = el("div"); group.append(el("dt", label), el("dd", text)); q("stats").append(group);
    }
    q("ledger").replaceChildren();
    for (const entry of value.ledger.slice(0, 50)) { const row = el("tr"); row.append(el("td", `${entry.side.toUpperCase()} ${entry.symbol}`), el("td", `${entry.quantity} / ${money(entry.limitPrice)}`), el("td", `${entry.mode} / ${entry.status}`), el("td", entry.reason), el("td", date(entry.at))); q("ledger").append(row); }
    if (!value.ledger.length) { const row = el("tr"), cell = el("td", "No recorded orders.", "poly-muted"); cell.colSpan = 5; row.append(cell); q("ledger").append(row); }
    if (memoryChanged) {
      q("notes").replaceChildren(); q("memories").replaceChildren();
      for (const note of value.notes) { const item = el("article", undefined, "poly-record"), header = el("div", undefined, "poly-record-head"), remove = button("x", "remove-note", note.id, "poly-icon"); remove.title = "Delete lesson"; remove.setAttribute("aria-label", "Delete lesson"); header.append(el("time", date(note.at)), remove); item.append(header, el("p", note.text)); q("notes").append(item); }
      for (const memory of value.memories) { const item = el("article", undefined, "poly-record"); item.append(el("h4", memory.symbol), el("small", `${memory.source} / ${date(memory.at)}`), el("p", memory.text)); q("memories").append(item); }
      if (!value.notes.length) q("notes").append(el("p", "No lessons saved.", "poly-muted"));
      if (!value.memories.length) q("memories").append(el("p", "No retained research.", "poly-muted"));
    }
    controls();
  }
  async function refresh() { render(await call("state")); }
  async function act(work, message) {
    if (busy) return;
    busy = true; controls();
    try { await work(); if (!disposed && message) say(message); }
    catch (error) { say(error.message, true); }
    finally { busy = false; controls(); }
  }
  on(root, "click", event => {
    const tabButton = event.target.closest("[data-rh-tab]"); if (tabButton) { tab(tabButton.dataset.rhTab); return; }
    const control = event.target.closest("[data-rh-action]"); if (!control || control.disabled) return;
    const action = control.dataset.rhAction;
    if (action === "history") { selectedRunId = control.dataset.id; renderRun(); return; }
    if (action === "pause") { void call("pause", {}).then(value => { render(value); say("Worker paused; new actions blocked. In-flight broker orders still require reconciliation."); }).catch(error => say(error.message, true)); return; }
    void act(async () => {
      if (action === "demo" || action === "cycle") { const result = await call("cycles", { mode: action === "demo" ? "demo" : "cycle" }); selectedRunId = result.id; await refresh(); say("Cycle started."); }
      if (action === "start") { render(await call("start", { version: state.version, mode: root.querySelector('input[name="rh-mode"]:checked').value, authorizeAutonomous: q("consent").checked })); q("consent").checked = false; say("Worker started under the saved policy."); }
      if (action === "reconcile") { render(await call("reconcile", {})); say("Order history checked. Unconfirmed outcomes remain reserved."); }
      if (action === "verify") { const result = await call("verify", {}); q("evidence").textContent = JSON.stringify(result.snapshot, null, 2); await refresh(); say("Broker financial evidence verified."); }
      if (action === "catalog") { const result = await call("catalog/sync", {}); q("catalog").textContent = JSON.stringify(result.tools, null, 2); say("Authenticated tool schemas refreshed."); }
      if (action === "remove-note") render(await call(`notes/${encodeURIComponent(control.dataset.id)}`, undefined, "DELETE"));
    });
  });
  on(root, "keydown", event => {
    const focused = event.target.closest("[data-rh-tab]"); if (!focused || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const tabs = [...root.querySelectorAll("[data-rh-tab]")], index = tabs.indexOf(focused);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; tab(tabs[next].dataset.rhTab, true);
  });
  on(root, "change", event => { if (event.target.name === "rh-mode") controls(); });
  on(form, "input", () => { dirty = true; });
  on(form, "submit", event => {
    event.preventDefault(); if (!state || busy) return;
    void act(async () => {
      const policy = Object.fromEntries(Object.keys(state.policy).map(key => [key, ["provider", "criticProvider", "accountNumber"].includes(key)
        ? form.elements[key].value : key === "symbols" ? form.elements[key].value.split(",").map(symbol => symbol.trim().toUpperCase()).filter(Boolean) : Number(form.elements[key].value)]));
      let bindings; try { bindings = JSON.parse(form.elements.bindings.value); } catch { throw new Error("Broker bindings must be valid JSON."); }
      const value = await call("policy", { version: state.version, policy, bindings }, "PUT"); dirty = false; render(value); q("consent").checked = false;
    }, "Policy saved. Previous autonomous authorization revoked.");
  });
  on(noteForm, "submit", event => { event.preventDefault(); const text = noteForm.elements.text.value; void act(async () => { const value = await call("notes", { text }); if (!disposed && noteForm.elements.text.value === text) noteForm.reset(); render(value); }, "Lesson saved to Robinhood Brain."); });
  async function poll() {
    try { if (!busy) await refresh(); } catch (error) { say(error.message, true); }
    if (!disposed) timer = windowRef.setTimeout(poll, state?.runs[0]?.status === "running" ? 1500 : 5000);
  }
  tab(new URL(windowRef.location.href).searchParams.get("view"), false, false);
  const ready = refresh().then(() => { if (!disposed) { say("Robinhood Brain ready."); timer = windowRef.setTimeout(poll, 1500); } }).catch(error => say(error.message, true));
  void call("catalog").then(value => { if (!disposed) q("catalog").textContent = JSON.stringify(value.tools, null, 2); }).catch(() => {});
  return { ready, dispose() { disposed = true; abort.abort(); windowRef.clearTimeout(timer); for (const remove of listeners) remove(); } };
}
