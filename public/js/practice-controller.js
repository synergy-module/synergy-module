import { createWorkspaceRequest } from "./workspace-client.js";
import { initializeReferenceFeed } from "./reference-feed-controller.js";
import { initializePracticeFeedFields } from "./practice-feed-fields.js";
const number = (value, digits = 2) => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value) : "—";
const money = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value) : "—";
const percent = value => Number.isFinite(value) ? `${number(value)}%` : "—";
export function initializePractice(root, { fetchImpl, windowRef = root.ownerDocument.defaultView } = {}) {
  const doc = root.ownerDocument, request = createWorkspaceRequest(root, fetchImpl), abort = new AbortController(), listeners = [];
  const q = name => root.querySelector(`[data-practice-${name}]`), builder = q("strategy-form"), dataForm = q("data-form");
  let disposed = false, state, selectedTab = "paper", selectedReport, sourceResult, sourceRequest, refreshing = false, timer, initialized = false, priorStrategy = "", selectedFeedEvidence = {};
  const pending = new Set(), strategyDrafts = new Map();
  const reference = initializeReferenceFeed(root, { request, windowRef });
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
  const on = (target, event, handler) => { target?.addEventListener(event, handler); listeners.push(() => target?.removeEventListener(event, handler)); };
  const call = (path, body, method) => request(`/api/practice${path}`, body, method, { signal: abort.signal });
  const feedback = (message, error = false) => { if (!disposed) { q("feedback").textContent = message; q("feedback").dataset.error = String(error); } };
  const strategyFeed = initializePracticeFeedFields(root, { onFeedback: feedback });
  const field = name => builder.elements.namedItem(name);
  const date = value => { if (!Number.isFinite(Date.parse(value))) return "Not observed yet"; try { return new Date(value).toLocaleString("en-US", { timeZone: doc.documentElement.dataset.timezone || "UTC", timeZoneName: "short" }); } catch { return new Date(value).toISOString(); } };
  function button(label, action, id) { const node = el("button", label, "btn"); node.type = "button"; node.dataset.practiceAction = action; if (id) node.dataset.id = id; return node; }
  function rows(target, headings, data, cells, fallback) {
    target.replaceChildren(); if (!data?.length) { target.append(el("p", fallback)); return; }
    const table = el("table", undefined, "practice-table"), head = el("thead"), heading = el("tr"), body = el("tbody");
    headings.forEach(label => { const cell = el("th", label); cell.scope = "col"; heading.append(cell); }); head.append(heading);
    for (const item of data) { const row = el("tr"); for (const value of cells(item)) { const cell = el("td"); if (value?.nodeType) cell.append(value); else cell.textContent = String(value); row.append(cell); } body.append(row); }
    table.append(head, body); target.append(table);
  }
  function setTab(id, focus = false) {
    selectedTab = id === "data" ? "data" : "paper";
    if (selectedTab === "data") void reference.load();
    for (const tab of root.querySelectorAll("[data-practice-tab]")) { const active = tab.dataset.practiceTab === selectedTab; tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; tab.classList.toggle("active", active); if (active && focus) tab.focus(); }
    for (const panel of root.querySelectorAll("[data-practice-panel]")) panel.hidden = panel.dataset.practicePanel !== selectedTab;
    q("submit").disabled = !state || pending.has("strategy"); q("report").hidden = !selectedReport || selectedTab !== "paper";
    for (const form of root.querySelectorAll('[data-practice-order]')) { const book = state?.books.find(b => b.id === form.dataset.practiceOrder); form.querySelector('[type="submit"]').disabled = pending.has(`order:${form.dataset.practiceOrder}`) || !book?.feed || book.cash < 1; }
    for (const sell of root.querySelectorAll('[data-practice-action="sell"]')) sell.disabled = pending.has(`order:${sell.dataset.id}`);
  }
  const tabs = [...root.querySelectorAll("[data-practice-tab]")];
  tabs.forEach((tab, index) => { on(tab, "click", () => setTab(tab.dataset.practiceTab)); on(tab, "keydown", event => { const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1; if (next >= 0) { event.preventDefault(); setTab(tabs[next].dataset.practiceTab, true); } }); });
  function strategyValues() { return Object.fromEntries([...q("strategy-fields").querySelectorAll("[data-strategy-field]")].map(input => [input.dataset.strategyField, input.type === "checkbox" ? input.checked : Number(input.value)])); }
  function renderStrategy(preset) {
    if (priorStrategy) strategyDrafts.set(priorStrategy, strategyValues());
    const definition = state.strategies.find(row => row.id === field("strategyId").value); if (!definition) return;
    priorStrategy = definition.id; q("strategy-description").textContent = definition.description;
    if (definition.marketType === "prediction" && field("feedSource").value !== "polymarket") {
      field("feedSource").value = "polymarket"; field("feedInstrument").value = ""; field("feedMarketId").value = ""; selectedFeedEvidence = {};
    }
    field("feedSource").querySelector('option[value="binance"]').disabled = definition.marketType === "prediction";
    feedFields();
    strategyFeed.render(definition.id);
    applyFeedEvidence();
    q("required-signals").textContent = definition.requiredSignals.length ? "The server checks the strategy's current market, fee and source evidence before each simulated entry. Missing, incomplete or stale evidence means the strategy waits." : "Uses the current public feed. Every order remains simulated.";
    q("strategy-fields").replaceChildren(); q("rules").hidden = !Object.keys(definition.fields).length;
    const values = preset ?? strategyDrafts.get(definition.id) ?? definition.defaults;
    for (const [name, rule] of Object.entries(definition.fields)) {
      const label = el("label", rule.label, rule.type === "boolean" ? "practice-check" : "field"), input = el("input"); input.name = `config_${name}`; input.dataset.strategyField = name; input.type = rule.type === "boolean" ? "checkbox" : "number";
      if (rule.type === "boolean") input.checked = values[name] === true; else { input.min = rule.minimum; input.max = rule.maximum; input.step = rule.step; input.value = values[name] ?? definition.defaults[name]; input.required = true; }
      label.append(input); if (rule.help) label.append(el("small", rule.help, "practice-help")); q("strategy-fields").append(label);
    }
  }
  on(field("strategyId"), "change", () => renderStrategy());
  function feedFields() { const prediction = field("feedSource").value === "polymarket"; q("feed-market").hidden = q("feed-outcome").hidden = !prediction; field("feedMarketId").required = prediction; field("feedMarketId").disabled = field("feedOutcome").disabled = !prediction; field("feedInstrument").placeholder = prediction ? "Outcome token ID" : "BTCUSDT"; }
  on(field("feedSource"), "change", () => { field("feedInstrument").value = ""; field("feedMarketId").value = ""; selectedFeedEvidence = {}; feedFields(); }); feedFields();
  function renderBooks() {
    const list = q("books"), drafts = new Map([...list.querySelectorAll('[data-practice-order]')].map(form => [form.dataset.practiceOrder, form.elements.budgetUsd.value])); list.replaceChildren();
    if (!state.books.length) { const box = el("div", undefined, "practice-empty"); box.append(el("span", "◇", "practice-empty-icon"), el("h3", "Open your first paper account."), el("p", "Pick a market and a virtual balance. Start the feed to follow current prices, then place paper orders or let a strategy observe the market.")); list.append(box); return; }
    for (const book of state.books) {
      const card = el("article", undefined, "practice-card practice-book"), head = el("div", undefined, "practice-book-head"), names = el("div"), stats = el("div", undefined, "practice-book-stats"), actions = el("div", undefined, "workspace-actions");
      names.append(el("h3", book.name), el("p", `${state.strategies.find(s => s.id === book.strategyId)?.label ?? book.strategyId} · ${number(book.observationCount, 0)} live observations`)); head.append(names, el("span", book.worker?.enabled ? "FEED RUNNING" : "FEED PAUSED", "practice-badge"));
      for (const [label, value] of [["Virtual equity", money(book.equity)], ["Virtual cash", money(book.cash)], ["Return", percent(book.returnPercent)]]) { const stat = el("div"); stat.append(el("span", label), el("strong", value)); stats.append(stat); }
      actions.append(button("View results", "book", book.id), button("Refresh live prices", "mark", book.id)); if (book.feed) actions.append(button(book.worker?.enabled ? "Pause feed" : "Start feed", book.worker?.enabled ? "pause" : "start", book.id));
      const remove = button("Delete account", "delete-book", book.id); remove.disabled = Boolean(book.positions?.length); remove.title = remove.disabled ? "Close virtual positions before deleting this account." : "Delete this paper account and its history"; actions.append(remove);
      card.append(head, stats, el("p", `${book.feed?.source || "No source"} · ${book.feed?.instrument || "No instrument"} · Last market observation: ${book.observationCount ? date(book.updatedAt) : "Not observed yet"}.`, "practice-help"), actions);
      if (book.worker?.lastError) card.append(el("p", `No fill on the last feed update: ${book.worker.lastError}`, "practice-help"));
      if (book.strategyId === "manual") {
        const form = el("form", undefined, "practice-order-form"), label = el("label", "Virtual amount ($)", "field"), input = el("input"), submit = el("button", "Paper buy at current ask", "btn primary"); form.dataset.practiceOrder = book.id;
        input.name = "budgetUsd"; input.type = "number"; input.min = 1; input.max = Math.min(book.cash, book.risk.positionUsd); input.step = ".01"; input.value = drafts.get(book.id) ?? Math.min(25, book.cash, book.risk.positionUsd); input.required = true; label.append(input); submit.type = "submit"; submit.disabled = !book.feed || book.cash < 1 || pending.has(`order:${book.id}`);
        form.append(label, submit, el("p", "A fresh quote is fetched before the simulated fill. Fees, depth, cash and your risk limits apply.", "practice-help")); card.append(form);
      }
      list.append(card);
    }
  }
  function chart(curve) {
    const target = q("chart"), points = (curve ?? []).filter(point => Number.isFinite(point.equity)); target.replaceChildren(); if (points.length < 2) { target.append(el("p", "The equity chart appears after two live observations.")); return; }
    const ns = "http://www.w3.org/2000/svg", svg = doc.createElementNS(ns, "svg"), line = doc.createElementNS(ns, "polyline"); const min = Math.min(...points.map(p => p.equity)), max = Math.max(...points.map(p => p.equity)), range = max - min || 1;
    svg.setAttribute("viewBox", "0 0 720 160"); svg.setAttribute("class", "practice-chart"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `Virtual equity from ${money(points[0].equity)} to ${money(points.at(-1).equity)}.`);
    line.setAttribute("points", points.map((p, i) => `${20 + i * 680 / (points.length - 1)},${135 - (p.equity - min) * 115 / range}`).join(" ")); line.setAttribute("fill", "none"); line.setAttribute("stroke", "var(--practice-accent)"); line.setAttribute("stroke-width", "2.5"); svg.append(line); target.append(svg, el("p", `${date(points[0].timestamp)} to ${date(points.at(-1).timestamp)} · Virtual equity ${money(min)} – ${money(max)}`));
  }
  function renderReport(report) {
    if (disposed) return; selectedReport = report; q("report").hidden = selectedTab !== "paper"; q("report-title").textContent = report.name;
    q("report-note").textContent = `Forward paper account · Virtual USD only. Started ${date(report.createdAt)}. Last market observation: ${report.observationCount ? date(report.updatedAt) : "Not observed yet"}. ${report.qa?.message ?? "Open positions use the latest observed bid."}`;
    q("metrics").replaceChildren(); for (const [label, value] of [["Virtual equity", money(report.equity)], ["Return", percent(report.returnPercent)], ["Realized P&L", money(report.realizedPnl)], ["Maximum drawdown", percent(report.maxDrawdownPercent)], ["Closed trades / win rate", `${report.closedTrades ?? 0} / ${percent(report.winRate)}`], ["Simulation fees", money(report.feesPaid)]]) { const metric = el("dl"); metric.append(el("dt", label), el("dd", value)); q("metrics").append(metric); }
    chart(report.equityCurve); q("qa").replaceChildren(el("p", `${report.qa?.cashReconciles ? "Cash reconciles" : "Cash reconciliation needs attention"} · ${report.qa?.noNegativeCash ? "No negative virtual cash" : "Negative virtual cash detected"}. ${report.positions?.length ? "Open positions remain exposed to market moves." : "No open virtual positions."}`));
    if (report.readiness) { const details = el("details"), list = el("ul"); details.append(el("summary", `Research milestones · ${report.readiness.settledGroups} clean completed groups`)); for (const check of report.readiness.checks ?? []) list.append(el("li", `${check.pass ? "Passed" : "Pending"} — ${check.label}`)); details.append(el("p", report.readiness.message), list); q("qa").append(details); }
    rows(q("positions"), ["Instrument", "Quantity", "Entry", "Last bid", "Observed", "Action"], report.positions, p => { const sell = button("Paper sell at current bid", "sell", report.id); sell.dataset.position = p.id; sell.disabled = pending.has(`order:${report.id}`); return [p.instrument, number(p.quantity, 6), money(p.entryPrice), money(p.markPrice), date(p.markedAt), sell]; }, "No open virtual positions.");
    rows(q("ledger"), ["Time", "Side", "Instrument", "Quantity", "Price", "Fee", "Realized P&L"], report.trades, t => [date(t.timestamp), t.side, t.instrument, number(t.quantity, 6), money(t.price), money(t.fee), t.side === "BUY" ? "—" : money(t.pnl)], "No paper orders yet. Every future fill will appear here.");
    const decisions = el("ul"); for (const item of [...(report.decisions ?? [])].reverse()) decisions.append(el("li", `${date(item.timestamp)} · ${item.instrument} · ${item.action}: ${item.reason}`)); q("decisions").replaceChildren(decisions);
  }
  function scheduleRefresh() { windowRef.clearTimeout(timer); if (!disposed && state?.books.some(book => book.worker?.enabled)) timer = windowRef.setTimeout(() => { if (!doc.hidden) void refresh(true); else scheduleRefresh(); }, 15000); }
  function render(value) {
    if (disposed) return; state = value;
    if (!initialized) {
      field("strategyId").replaceChildren(); for (const definition of state.strategies.filter(row => row.id !== "solana-momentum")) { const option = el("option", definition.label); option.value = definition.id; field("strategyId").append(option); }
      field("strategyId").value = state.strategies.some(s => s.id === "manual") ? "manual" : "trend-following"; initialized = true; renderStrategy();
      if (state.presets?.length) {
        const details = el("details"), label = el("label", "Strategy template", "field"), select = el("select"); select.append(el("option", "Choose an optional starting template")); select.options[0].value = "";
        for (const preset of state.presets.filter(row => row.strategyId !== "solana-momentum")) { const option = el("option", preset.label); option.value = preset.id; select.append(option); }
        on(select, "change", () => { const preset = state.presets.find(p => p.id === select.value); if (!preset) return; const definition = state.strategies.find(s => s.id === preset.strategyId); field("strategyId").value = preset.strategyId; field("name").value = preset.label; field("initialCapital").value = preset.initialCapital; renderStrategy({ ...definition.defaults, ...preset.config }); const duration = root.querySelector('[data-forward-field="windowMinutes"]'); if (duration && preset.windowMinutes) duration.value = String(preset.windowMinutes); feedback("Template applied. Choose a live market that provides the strategy's required evidence."); });
        label.append(select); details.append(el("summary", "Start from a named strategy template"), label); builder.prepend(details);
      }
    }
    renderBooks(); if (selectedReport) { const report = state.books.find(b => b.id === selectedReport.id); if (report) renderReport(report); else { selectedReport = null; q("report").hidden = true; } } setTab(selectedTab); scheduleRefresh();
  }
  async function refresh(quiet = false) {
    if (refreshing || disposed) return; refreshing = true; if (!quiet) feedback("Loading your paper accounts…");
    try { render(await call("")); if (!quiet) feedback(state.storage?.persistent === false ? "Virtual accounts use temporary storage on this server. Durable storage is needed to retain results after restart." : "Paper accounts are ready. Start a live feed or place a virtual order."); }
    catch (error) { if (!disposed) { feedback(error.message, true); scheduleRefresh(); } } finally { refreshing = false; }
  }
  async function perform(key, work, message, control) {
    if (pending.has(key) || disposed) return; pending.add(key); if (control) control.disabled = true; feedback("Working on your paper account…");
    try { await work(); if (!disposed) { await refresh(true); feedback(message); } } catch (error) { feedback(error.message, true); }
    finally { pending.delete(key); if (!disposed) { if (control) control.disabled = false; setTab(selectedTab); } }
  }
  function specification() {
    const result = { name: field("name").value.trim(), strategyId: field("strategyId").value, config: strategyValues(), initialCapital: Number(field("initialCapital").value), risk: {}, feed: { source: field("feedSource").value, instrument: field("feedInstrument").value.trim() } };
    for (const key of ["positionUsd", "maxExposurePercent", "maxPositions", "maxDrawdownPercent"]) result.risk[key] = Number(field(key).value);
    result.risk.feeBps = Number(field("feePercent").value) * 100; result.risk.slippageBps = Number(field("slippagePercent").value) * 100;
    if (result.feed.source === "polymarket") { result.feed.marketId = field("feedMarketId").value.trim(); result.feed.outcomeIndex = Number(field("feedOutcome").value); }
    Object.assign(result.feed, strategyFeed.read());
    return result;
  }
  on(builder, "submit", event => { event.preventDefault(); if (!state || !builder.reportValidity()) return; let body; try { body = specification(); } catch (error) { feedback(error.message, true); return; } void perform("strategy", async () => { const report = await call("/books", body); if (!disposed) { renderReport(report); setTab("paper"); } }, "Paper account created. Start its feed or place a virtual order to use current market prices.", q("submit")); });
  const requestId = () => windowRef.crypto?.randomUUID?.() || globalThis.crypto?.randomUUID?.();
  async function order(bookId, body) { const id = requestId(); const report = await call(`/books/${encodeURIComponent(bookId)}/orders`, { ...body, ...(id ? { requestId: id } : {}) }); if (!disposed) { renderReport(report); setTab("paper"); } }
  on(root, "submit", event => { const form = event.target; if (!form.matches("[data-practice-order]")) return; event.preventDefault(); if (!form.reportValidity()) return; const id = form.dataset.practiceOrder; void perform(`order:${id}`, () => order(id, { side: "BUY", budgetUsd: Number(form.elements.budgetUsd.value) }), "Paper buy processed using a freshly fetched quote. Review the fill and fee in your virtual ledger.", form.querySelector('[type="submit"]')); });
  function download(value, name) { if (!windowRef.URL?.createObjectURL) { feedback("Downloads are unavailable in this browser. Use the API to export this record.", true); return; } const url = windowRef.URL.createObjectURL(new windowRef.Blob([JSON.stringify(value, null, 2)], { type: "application/json" })), link = el("a"); link.href = url; link.download = name; doc.body.append(link); link.click(); link.remove(); windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 1000); }
  function applyFeedEvidence() {
    for (const [name, value] of Object.entries(selectedFeedEvidence)) { const input = root.querySelector(`[data-forward-field="${name}"]`); if (input && value) input.value = value; }
  }
  function chooseFeed(source, market, outcome, index) {
    if (source === "binance" && state.strategies.find(row => row.id === field("strategyId").value)?.marketType === "prediction") { field("strategyId").value = "manual"; renderStrategy(); }
    field("feedSource").value = source; field("feedInstrument").value = outcome?.tokenId || market.instrument || "";
    field("feedMarketId").value = source === "polymarket" ? market.id || market.marketId || "" : ""; field("feedOutcome").value = index ?? market.outcomeIndex ?? 0;
    selectedFeedEvidence = { asset: market.asset, windowOpenedAt: market.windowOpenedAt, windowEndsAt: market.windowEndsAt };
    const match = /^(btc|eth|sol|xrp)-updown-(5|15)m-(\d{10})$/.exec(market.slug || "");
    if (match) { const opened = Number(match[3]) * 1000, ends = opened + Number(match[2]) * 60000; if (Date.parse(market.endDate) === ends) selectedFeedEvidence = { asset: match[1].toUpperCase(), windowOpenedAt: new Date(opened).toISOString(), windowEndsAt: new Date(ends).toISOString() }; }
    applyFeedEvidence();
    feedFields(); setTab("paper"); field("name").focus(); feedback(`Selected ${outcome?.label || market.label || market.question || market.instrument}. Review the strategy and virtual balance, then create your paper account.`);
  }
  on(root, "click", event => {
    const control = event.target.closest("[data-practice-action]"); if (!control || control.disabled || !root.contains(control)) return; const action = control.dataset.practiceAction, id = control.dataset.id;
    if (action === "refresh") { void refresh(); return; } if (action === "export") { if (selectedReport) download(selectedReport, `paper-account-${selectedReport.id}.json`); return; } if (action === "export-data") { if (sourceResult) download(sourceResult, "live-market-evidence.json"); return; }
    if (action === "discover") { dataForm.elements.method.value = "discover"; dataForm.elements.source.value = field("feedSource").value; dataFields(); setTab("data", true); dataForm.scrollIntoView?.({ block: "start", behavior: "smooth" }); dataForm.elements.query.focus(); return; }
    if (action === "find-window") { void perform("crypto-window", async () => {
      const read = name => root.querySelector(`[data-forward-field="${name}"]`).value;
      const asset = read("asset"), result = await call("/data/cryptoWindow", { asset, windowMinutes: Number(read("windowMinutes")), outcome: read("direction") });
      chooseFeed("polymarket", { ...result, asset });
    }, "Current contract selected from the provider. Confirm the window, direction and strategy settings before creating the account.", control); return; }
    if (action === "use-feed") { if (!sourceRequest) return; chooseFeed(sourceRequest.source, { ...sourceRequest, ...sourceResult, instrument: sourceResult.instrument || sourceRequest.instrument || "" }); return; }
    if (action === "sell") { void perform(`order:${id}`, () => order(id, { side: "SELL", positionId: control.dataset.position }), "Paper sell processed using a freshly fetched quote. Review the result in your virtual ledger.", control); return; }
    const tasks = { book: async () => renderReport(await call(`/books/${encodeURIComponent(id)}`)), mark: async () => renderReport(await call(`/books/${encodeURIComponent(id)}/refresh`, {})), start: async () => renderReport(await call(`/books/${encodeURIComponent(id)}/start`, { intervalSeconds: 60 })), pause: async () => renderReport(await call(`/books/${encodeURIComponent(id)}/pause`, {})), "delete-book": async () => call(`/books/${encodeURIComponent(id)}`, {}, "DELETE") };
    if (tasks[action]) void perform(`${action}:${id}`, tasks[action], action === "delete-book" ? "Paper account deleted." : action === "start" ? "Live price feed started for this virtual account." : action === "pause" ? "Price feed paused. Open virtual positions remain in this account." : action === "mark" ? "Virtual valuations updated from current market quotes." : "Paper account results loaded.", control);
  });
  dataForm.elements.date.value = new Date().toISOString().slice(0, 10);
  function dataFields() {
    const method = dataForm.elements.method.value, source = dataForm.elements.source.value;
    const fields = { source: ["discover", "quote"].includes(method), instrument: method === "quote", marketId: method === "quote" && source === "polymarket", address: ["wallet", "scanSolana"].includes(method), profile: method === "scanSolana", latitude: method === "weather", longitude: method === "weather", query: method === "discover", outcomeIndex: method === "quote" && source === "polymarket", station: method === "weather", date: method === "weather", timezone: method === "weather" };
    for (const [name, visible] of Object.entries(fields)) { const input = dataForm.elements.namedItem(name); input.closest("label").hidden = !visible; input.disabled = !visible; input.required = visible && !["source", "query", "outcomeIndex", "instrument"].includes(name); } dataForm.elements.instrument.required = fields.instrument && source === "binance"; dataForm.elements.instrument.placeholder = source === "binance" ? "BTCUSDT" : "Outcome token ID";
  }
  on(dataForm.elements.method, "change", dataFields); on(dataForm.elements.source, "change", dataFields); dataFields();
  on(dataForm, "submit", event => {
    event.preventDefault(); if (!dataForm.reportValidity()) return;
    void perform("public-data", async () => {
      const method = dataForm.elements.method.value, body = {}; for (const input of dataForm.elements) if (input.name && !input.disabled && input.name !== "method") body[input.name] = ["latitude", "longitude", "outcomeIndex"].includes(input.name) ? Number(input.value) : input.value.trim();
      const value = await call(`/data/${method}`, body); if (disposed) return; sourceResult = value; sourceRequest = method === "quote" ? body : null;
      q("data-result").hidden = false; q("data-json").textContent = JSON.stringify(value, null, 2); const provenance = value.provenance ?? value;
      q("data-summary").textContent = `${provenance.source || body.source || method} · observed ${date(provenance.fetchedAt ?? value.observedAt ?? value.timestamp)}. ${(provenance.caveats ?? []).join(" ")}`;
      if (value.markets) rows(q("data-preview"), ["Market", "Choose for paper trading"], value.markets.slice(0, 30), market => {
        const choices = el("div", undefined, "workspace-actions");
        if (body.source === "polymarket") (market.outcomes ?? []).forEach((outcome, index) => { if (!outcome.tokenId) return; const choose = el("button", `Use ${outcome.label}`, "btn"); choose.type = "button"; choose.dataset.practiceOutcome = String(index); choose.addEventListener("click", () => chooseFeed(body.source, market, outcome, index)); choices.append(choose); });
        else if (body.source === "binance" && market.instrument) { const choose = el("button", "Use instrument", "btn"); choose.type = "button"; choose.dataset.practiceInstrument = market.instrument; choose.addEventListener("click", () => chooseFeed(body.source, market)); choices.append(choose); }
        return [market.question || market.label || market.instrument, choices];
      }, "No markets found in this public sample.");
      else if (value.checks) { rows(q("data-preview"), ["Token check", "Result", "Evidence"], value.checks, check => [check.label, ({ pass: "Passed", block: "Blocked", unavailable: "Unavailable" })[check.status] || check.status, check.note || String(check.value ?? "No verified evidence")], "No checks available."); for (const message of value.messages ?? []) q("data-preview").append(el("p", message, "practice-help")); q("data-preview").append(el("p", "Screening only. These observations do not supply executable swap prices or enable automatic trades.", "practice-help")); }
      else if (value.instrument) rows(q("data-preview"), ["Instrument", "Current bid", "Current ask", "Observed"], [value], quote => [quote.instrument, money(quote.bid), money(quote.ask), date(quote.observedAt || quote.timestamp)], "No executable quote available."); else q("data-preview").replaceChildren();
      root.querySelector('[data-practice-action="use-feed"]').hidden = method !== "quote" || !["binance", "polymarket"].includes(body.source);
    }, "Current public data received. Review its timestamp and source before paper trading.", dataForm.querySelector('[type="submit"]'));
  });
  setTab(new URLSearchParams(windowRef.location.search).get("view")); void refresh();
  return { refresh, dispose() { disposed = true; reference.dispose(); strategyFeed.dispose(); abort.abort(); windowRef.clearTimeout(timer); listeners.forEach(remove => remove()); } };
}
