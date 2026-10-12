import { createWorkspaceRequest } from "./workspace-client.js";
import { initializePolymarketUs } from "./polymarket-us-controller.js";

const usd = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value) : "--";
const number = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value) : "--";
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(value > 0.99 || value < 0.01 ? 2 : 1)}%` : "--";
const date = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) + " CT" : "--";
const shortAddress = value => `${value.slice(0, 6)}...${value.slice(-4)}`;

export function initializePolymarket(root, { fetchImpl, windowRef = root.ownerDocument.defaultView } = {}) {
  if (!root?.matches?.("[data-polymarket]")) return { dispose() {} };
  const document = root.ownerDocument, request = createWorkspaceRequest(root, fetchImpl), abort = new AbortController();
  const usAccount = initializePolymarketUs(root.querySelector("[data-poly-us]"), { fetchImpl });
  const call = (url, body, method) => request(url, body, method, { signal: abort.signal });
  const q = name => root.querySelector(`[data-poly-${name}]`);
  const el = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
  const command = (label, action, id, className = "btn") => { const item = el("button", label, className); item.type = "button"; item.dataset.polyAction = action; if (id) item.dataset.id = id; return item; };
  const icon = (label, action, id, active) => { const item = command(active ? "-" : "+", action, id, "poly-icon"); item.title = label; item.setAttribute("aria-label", label); if (active !== undefined) item.setAttribute("aria-pressed", String(active)); return item; };
  const link = (label, url) => { const item = el("a", label); item.href = url; item.target = "_blank"; item.rel = "noopener noreferrer"; return item; };
  const empty = (target, columns, message) => { const row = el("tr"), cell = el("td", message, "poly-muted"); cell.colSpan = columns; row.append(cell); target.replaceChildren(row); };
  const pnl = (tag, value) => el(tag, usd(value), value >= 0 ? "poly-positive" : "poly-negative");
  const listeners = [];
  const listen = (target, event, fn) => { target?.addEventListener(event, fn); listeners.push(() => target?.removeEventListener(event, fn)); };
  let disposed = false, state = null, markets = [], selectedId = null, selected = null, selectionVersion = 0, pending = 0, timer, radarLoaded = false, settingsDirty = false;
  const settingsForm = q("settings-form"), noteForm = q("note-form"), addressForm = q("address-form");
  function feedback(message, error = false) { if (!disposed) { q("feedback").textContent = message; q("feedback").dataset.error = String(error); } }
  function controls() {
    if (disposed) return;
    for (const button of root.querySelectorAll("button:not([role='tab'])")) if (!button.closest("[data-poly-us]")) button.disabled = pending > 0;
    const running = state?.paper.bot.running === true;
    const start = root.querySelector('[data-poly-action="start"]'), pause = root.querySelector('[data-poly-action="pause"]');
    if (start) start.disabled = !state || running || pending > 0;
    if (pause) pause.disabled = !state || !running || pending > 0;
    for (const control of settingsForm?.elements ?? []) control.disabled = !state || running || pending > 0;
    for (const control of root.querySelectorAll('[data-poly-action="close"]')) control.disabled = running || pending > 0;
    if (!state) for (const control of root.querySelectorAll('[data-poly-action="watch"]')) control.disabled = true;
  }
  async function effect(work, message) {
    pending++; controls();
    try { await work(); if (!disposed && message) feedback(message); }
    catch (error) { if (!disposed) feedback(error.message, true); }
    finally { pending--; controls(); }
  }
  function setTab(key, { focus = false, updateUrl = true } = {}) {
    const tabs = [...root.querySelectorAll("[data-poly-tab]")];
    if (!tabs.some(tab => tab.dataset.polyTab === key)) key = tabs[0]?.dataset.polyTab ?? "markets";
    for (const tab of tabs) { const active = tab.dataset.polyTab === key; tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; if (focus && active) tab.focus(); }
    for (const panel of root.querySelectorAll("[data-poly-panel]")) panel.hidden = panel.dataset.polyPanel !== key;
    if (updateUrl) { const url = new URL(windowRef.location.href); if (key === "markets") url.searchParams.delete("view"); else url.searchParams.set("view", key); windowRef.history.replaceState(windowRef.history.state, "", url); }
    if (key === "radar" && !radarLoaded) void effect(loadRadar);
    if (key === "account") return usAccount.load();
  }
  function checks(analysis) {
    const list = el("ul", undefined, "poly-checks");
    for (const gate of analysis.gates) { const item = el("li"); item.dataset.pass = String(gate.pass); const content = el("div", gate.name); content.append(el("small", gate.detail)); item.append(el("b", gate.pass ? "+" : "-"), content); list.append(item); }
    return list;
  }
  function renderMarkets() {
    if (!q("markets")) return;
    const target = q("markets"), query = q("search").value.trim().toLowerCase(), onlyWatched = q("watch-filter").checked;
    const filtered = markets.filter(market => market.question.toLowerCase().includes(query) && (!onlyWatched || state?.watchlist.includes(market.id)));
    target.replaceChildren(); q("market-count").textContent = `${filtered.length} / ${markets.length} scanned markets`;
    for (const market of filtered) {
      const row = el("tr"), title = el("td"), heading = el("div", undefined, "poly-market-title"); row.dataset.selected = String(market.id === selectedId);
      if (market.image) { const image = el("img"); image.src = market.image; image.alt = ""; image.loading = "lazy"; image.addEventListener("error", () => image.remove(), { once: true }); heading.append(image); }
      heading.append(command(market.question, "select", market.id, "poly-market-select")); title.append(heading);
      const leader = market.outcomes.reduce((a, b) => b.price > a.price ? b : a), probability = el("td", pct(leader.price)); probability.append(el("small", leader.label));
      const watch = el("td"), active = state?.watchlist.includes(market.id) === true;
      watch.append(icon(active ? "Remove from watchlist" : "Add to watchlist", "watch", market.id, active));
      row.append(title, probability, el("td", usd(market.volume24h)), watch); target.append(row);
    }
    if (!filtered.length) empty(target, 4, markets.length ? "No markets match these filters." : "No active binary markets in this scan.");
    const current = noteForm.elements.marketId.value;
    const options = el("option", "General lesson"); options.value = ""; q("note-market").replaceChildren(options);
    for (const market of markets) { const option = el("option", market.question); option.value = market.id; q("note-market").append(option); }
    noteForm.elements.marketId.value = current;
    controls();
  }
  function renderInspector() {
    const target = q("inspector");
    if (!target) return;
    if (!selected) { target.replaceChildren(el("h2", "Market evidence"), el("p", selectedId ? "Loading market evidence..." : "No market selected.", "poly-muted")); return; }
    const { market, analysis, warnings } = selected;
    target.replaceChildren(el("h2", market.question));
    for (const outcome of market.outcomes) {
      const labels = el("div", undefined, "poly-probability"); labels.append(el("span", outcome.label), el("strong", pct(outcome.price)));
      const bar = el("div", undefined, "poly-probability-bar"), fill = el("span"); fill.style.width = `${outcome.price * 100}%`; bar.append(fill); target.append(labels, bar);
    }
    const meta = el("p", `Scheduled end: ${date(market.endDate)}\nLiquidity: ${usd(market.liquidity)}\nObserved: ${date(market.fetchedAt)}`, "poly-muted"); meta.style.whiteSpace = "pre-line"; target.append(meta);
    target.append(link("Open market", market.url));
    const actions = el("div", undefined, "workspace-actions"); actions.append(command("Run research", "research", market.id, "btn primary")); target.append(actions);
    target.append(el("p", `${analysis.score}% screening checks passed. ${analysis.summary}`), checks(analysis));
    target.append(el("p", `Sampled net buying: ${usd(analysis.netFlowUsd)}\nAsk depth within 1 cent: ${usd(analysis.depthUsd)}\nLarge net buyers in sample: ${analysis.buyers.length}`, "poly-muted"));
    for (const warning of warnings) target.append(el("p", warning, "poly-negative"));
    const rules = el("details"), summary = el("summary", "Resolution rules & cautions"); rules.append(summary, el("p", market.description || "No resolution description available.", "poly-rules"));
    const caveats = el("ul", undefined, "poly-caveats"); for (const caveat of analysis.caveats) caveats.append(el("li", caveat)); rules.append(caveats); target.append(rules);
    if (analysis.relatedNotes.length) { const memories = el("details"); memories.append(el("summary", `Relevant lessons (${analysis.relatedNotes.length})`)); for (const note of analysis.relatedNotes) memories.append(el("p", note.text)); target.append(memories); }
    controls();
  }
  async function selectMarket(id) {
    selectedId = id; selected = null; const version = ++selectionVersion; renderMarkets(); renderInspector();
    try {
      const value = await call(`/api/polymarket/markets/${encodeURIComponent(id)}`);
      if (disposed || version !== selectionVersion) return;
      selected = value; renderInspector();
    } catch (error) { if (!disposed && version === selectionVersion) { q("inspector").replaceChildren(el("h2", "Market evidence"), el("p", error.message, "poly-negative"), command("Retry", "select", id)); } }
  }
  function renderMemory() {
    if (!q("research")) return;
    q("research-count").textContent = `${state.research.length} / 10 saved`;
    q("storage").textContent = state.storage.persistent ? `${state.storage.kind.toUpperCase()} SAVED` : "TEMPORARY MEMORY";
    q("research").replaceChildren();
    if (!state.research.length) q("research").append(el("p", "No saved research yet.", "poly-muted"));
    for (const report of state.research) {
      const item = el("article", undefined, "poly-record"), head = el("div", undefined, "poly-record-head"); head.append(el("h4", report.title), icon("Delete research", "delete-research", report.id, true)); item.append(head, el("time", date(report.createdAt)), el("p", report.analysis.summary));
      const evidence = el("details"); evidence.append(el("summary", `${report.analysis.score}% screening checks passed`), checks(report.analysis));
      const sources = el("ul", undefined, "poly-source-links"); for (const source of report.sources) { const row = el("li"); row.append(link(source.name, source.url), el("small", ` / ${date(source.fetchedAt)}`)); sources.append(row); } evidence.append(sources);
      for (const caveat of report.analysis.caveats) evidence.append(el("p", caveat, "poly-muted"));
      for (const note of report.analysis.relatedNotes) evidence.append(el("p", `Retrieved lesson: ${note.text}`));
      item.append(evidence, command("Revisit market", "revisit", report.marketId, "text-action")); q("research").append(item);
    }
    q("notes").replaceChildren();
    if (!state.notes.length) q("notes").append(el("p", "No lessons saved.", "poly-muted"));
    for (const note of state.notes) {
      const item = el("article", undefined, "poly-record"), head = el("div", undefined, "poly-record-head"); head.append(el("small", `${note.marketId ? `Market ${note.marketId}` : "General lesson"} / ${date(note.createdAt)}`), icon("Delete lesson", "delete-note", note.id, true)); item.append(head, el("p", note.text)); q("notes").append(item);
    }
  }
  function renderPaper() {
    if (!q("stats")) return;
    const { paper } = state;
    q("bot-status").textContent = paper.bot.running ? "RUNNING / PAPER" : "PAUSED / PAPER";
    q("stats").replaceChildren();
    for (const [label, value] of [["Paper equity", paper.equity], ["Available cash", paper.cash], ["Realized P&L", paper.realizedPnl], ["Unrealized P&L", paper.unrealizedPnl]]) {
      const group = el("div"); group.append(el("dt", label), label.includes("P&L") ? pnl("dd", value) : el("dd", usd(value))); q("stats").append(group);
    }
    q("cycle").textContent = paper.bot.lastError || (paper.bot.lastCycleAt ? `Last cycle ${date(paper.bot.lastCycleAt)} / ${paper.bot.scanned} screened / ${paper.bot.eligible} eligible` : "Waiting for the first cycle");
    if (!settingsDirty) for (const [key, value] of Object.entries(paper.settings)) settingsForm.elements[key].value = value;
    q("positions").replaceChildren();
    for (const pos of paper.positions) {
      const row = el("tr"), title = el("td", pos.title); title.append(el("small", pos.outcome));
      const marks = el("td", `${(pos.entryPrice * 100).toFixed(2)}c / ${(pos.markPrice * 100).toFixed(2)}c`); marks.append(el("small", `Marked ${date(pos.markedAt)}`));
      const close = el("td"); close.append(command("Close", "close", pos.id)); row.append(title, el("td", number(pos.shares)), marks, pnl("td", pos.shares * pos.markPrice - pos.cost), close); q("positions").append(row);
    }
    if (!paper.positions.length) empty(q("positions"), 5, "No open paper positions.");
    q("trades").replaceChildren();
    for (const trade of paper.trades) {
      const row = el("tr"), title = el("td", `${trade.side} ${trade.outcome}`); title.append(el("small", trade.title), el("small", trade.reason.replaceAll("_", " ") + (trade.partial ? " / partial fill" : "")));
      row.append(title, el("td", `${number(trade.shares)} / ${(trade.price * 100).toFixed(2)}c`), el("td", usd(trade.fee)), trade.side === "SELL" ? pnl("td", trade.realizedPnl) : el("td", "--"), el("td", date(trade.timestamp))); q("trades").append(row);
    }
    if (!paper.trades.length) empty(q("trades"), 5, "No simulated fills recorded.");
  }
  function renderFollowed() {
    if (!q("followed")) return;
    q("followed").replaceChildren();
    for (const address of state.addresses) { const item = el("div"); item.append(link(shortAddress(address), `https://polymarket.com/profile/${address}`), icon("Unfollow wallet", "unfollow", address, true)); q("followed").append(item); }
  }
  async function refreshState() {
    const value = await call("/api/polymarket/state"); if (disposed) return;
    const changed = !state || JSON.stringify([state.notes, state.research, state.storage]) !== JSON.stringify([value.notes, value.research, value.storage]);
    state = value; if (changed) renderMemory(); renderPaper(); renderFollowed(); controls();
  }
  async function loadMarkets() {
    if (!q("markets")) return;
    const value = await call("/api/polymarket/markets"); if (disposed) return;
    markets = value.markets; q("source").textContent = `Gamma / top 100 by 24h volume / ${date(value.fetchedAt)}`; renderMarkets();
  }
  async function loadRadar() {
    const value = await call("/api/polymarket/radar"); if (disposed) return;
    radarLoaded = true; q("radar-source").textContent = `DATA API V2 / ${date(value.fetchedAt)}`; q("leaderboard").replaceChildren();
    for (const trader of value.traders) {
      const row = el("tr"), name = el("td"); name.append(link(trader.name || shortAddress(trader.address), `https://polymarket.com/profile/${trader.address}`), el("small", shortAddress(trader.address)));
      const following = state?.addresses.includes(trader.address) === true, follow = el("td"); follow.append(icon(following ? "Unfollow wallet" : "Follow wallet", following ? "unfollow" : "follow", trader.address, following));
      row.append(el("td", String(trader.rank)), name, pnl("td", trader.pnl), el("td", number(trader.volumeShares)), follow); q("leaderboard").append(row);
    }
    if (!value.traders.length) empty(q("leaderboard"), 5, "No ranked traders returned.");
    q("activity").replaceChildren();
    for (const wallet of value.activity) {
      const item = el("section", undefined, "poly-record"); item.append(el("h4", shortAddress(wallet.address)));
      if (wallet.error || !wallet.trades.length) item.append(el("p", wallet.error || "No sampled activity returned.", "poly-muted"));
      for (const trade of wallet.trades.slice(0, 10)) item.append(el("p", `${trade.side} ${trade.outcome} / ${usd(trade.notional)} / ${trade.title}\n${date(trade.timestamp)}`));
      q("activity").append(item);
    }
    if (!value.activity.length) q("activity").append(el("p", "No wallets followed.", "poly-muted"));
    controls();
  }
  async function follow(address, following) {
    await call("/api/polymarket/radar", { address, following }, "PUT"); await refreshState(); radarLoaded = false; await loadRadar();
  }
  listen(root, "click", event => {
    const tab = event.target.closest("[data-poly-tab]"); if (tab) { setTab(tab.dataset.polyTab); return; }
    const control = event.target.closest("[data-poly-action]"); if (!control || control.disabled) return;
    const action = control.dataset.polyAction, id = control.dataset.id;
    if (action === "select" || action === "revisit") { if (action === "revisit") setTab("markets"); void selectMarket(id); return; }
    void effect(async () => {
      if (action === "refresh") { await loadMarkets(); if (selectedId) await selectMarket(selectedId); }
      if (action === "watch") { await call("/api/polymarket/watchlist", { marketId: id, watching: !state.watchlist.includes(id) }, "PUT"); await refreshState(); renderMarkets(); }
      if (action === "research") { feedback("Researching market evidence..."); await call("/api/polymarket/research", { marketId: id }); await refreshState(); setTab("brain"); feedback("Research saved to your Polymarket Second Brain."); }
      if (action === "delete-note" || action === "delete-research") { await call(`/api/polymarket/${action === "delete-note" ? "notes" : "research"}/${encodeURIComponent(id)}`, undefined, "DELETE"); await refreshState(); }
      if (action === "start" || action === "pause") { state = await call(`/api/polymarket/paper/${action}`, {}); renderPaper(); feedback(action === "start" ? "Paper worker started." : "Paper worker paused."); }
      if (action === "close") { state = await call(`/api/polymarket/paper/positions/${encodeURIComponent(id)}/close`, {}); renderPaper(); feedback("Paper position closed using current bid depth."); }
      if (action === "radar") await loadRadar();
      if (action === "follow" || action === "unfollow") await follow(id, action === "follow");
    });
  });
  listen(root, "keydown", event => {
    const tab = event.target.closest("[data-poly-tab]"); if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const tabs = [...root.querySelectorAll("[data-poly-tab]")], index = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next].dataset.polyTab, { focus: true });
  });
  listen(q("search"), "input", renderMarkets); listen(q("watch-filter"), "change", renderMarkets);
  listen(noteForm, "submit", event => {
    event.preventDefault(); const text = noteForm.elements.text.value, marketId = noteForm.elements.marketId.value;
    void effect(async () => { await call("/api/polymarket/notes", { text, marketId }); if (!disposed && noteForm.elements.text.value === text) noteForm.reset(); await refreshState(); }, "Lesson saved to Polymarket memory.");
  });
  listen(settingsForm, "input", () => { settingsDirty = true; });
  listen(settingsForm, "submit", event => { event.preventDefault(); const body = Object.fromEntries([...new windowRef.FormData(settingsForm)].map(([key, value]) => [key, Number(value)])); void effect(async () => { state = await call("/api/polymarket/paper/settings", body, "PUT"); settingsDirty = false; if (!disposed) renderPaper(); }, "Paper risk limits saved."); });
  listen(addressForm, "submit", event => { event.preventDefault(); const address = addressForm.elements.address.value.trim(); void effect(async () => { await follow(address, true); if (!disposed && addressForm.elements.address.value.trim() === address) addressForm.reset(); }, "Wallet added to radar."); });
  async function poll() {
    try { if (!pending) await refreshState(); } catch (error) { if (!disposed) feedback(error.message, true); }
    if (!disposed) timer = windowRef.setTimeout(poll, 10_000);
  }
  const ready = (async () => {
    const initialView = new URL(windowRef.location.href).searchParams.get("view") ?? root.dataset.polyDefaultTab ?? "markets";
    const accountReady = initialView === "account" ? setTab("account", { updateUrl: false }) : undefined;
    const results = await Promise.allSettled([refreshState(), loadMarkets(), accountReady]); if (disposed) return;
    const errors = results.filter(result => result.status === "rejected");
    feedback(initialView === "account" ? "Your Polymarket US connection / account sync only" : errors.length ? errors.map(result => result.reason.message).join(" ") : "Public market data / rules-based research / paper execution", initialView !== "account" && Boolean(errors.length));
    if (initialView !== "account") await setTab(initialView, { updateUrl: false });
    if (disposed) return;
    if (markets.length) void selectMarket(markets[0].id);
    timer = windowRef.setTimeout(poll, 10_000);
  })();
  return { ready, dispose() { disposed = true; selectionVersion++; abort.abort(); usAccount.dispose(); windowRef.clearTimeout(timer); for (const remove of listeners) remove(); } };
}
