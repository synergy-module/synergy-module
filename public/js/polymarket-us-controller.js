import { createWorkspaceRequest } from "./workspace-client.js";

const number = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value) : "—";
const amount = (value, currency) => {
  if (!Number.isFinite(value)) return "—";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(value); }
  catch { return `${number(value)} ${currency || ""}`; }
};
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-US", { timeZone: "America/Chicago" }) + " CT" : "—";
const label = value => value?.replace(/^(ORDER_SIDE_|ORDER_STATUS_|OUTCOME_SIDE_)/, "").replaceAll("_", " ") || "—";

export function initializePolymarketUs(root, { fetchImpl } = {}) {
  if (!root) return { load: async () => {}, dispose() {} };
  const document = root.ownerDocument, request = createWorkspaceRequest(root, fetchImpl), abort = new AbortController();
  const q = name => root.querySelector(`[data-poly-us-${name}]`), form = q("form");
  let state = null, pending = false, disposed = false;
  const listeners = [];
  const listen = (target, event, work) => { target.addEventListener(event, work); listeners.push(() => target.removeEventListener(event, work)); };
  const call = (path, body) => request(`/api/polymarket/us/${path}`, body, undefined, { signal: abort.signal });
  const feedback = (message, error = false) => { if (!disposed) { q("feedback").textContent = message; q("feedback").dataset.error = String(error); } };
  function controls() {
    if (disposed) return;
    for (const control of form.elements) control.disabled = pending || !state?.configured;
    q("sync").disabled = pending || !state?.connected || state.needsReplacement;
    q("disconnect").disabled = pending || !state?.connected;
  }
  function rows(target, data, columns, cells, missing) {
    target.replaceChildren();
    for (const item of data ?? []) {
      const row = document.createElement("tr");
      for (const value of cells(item)) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
      target.append(row);
    }
    if (!data?.length) { const row = document.createElement("tr"), cell = document.createElement("td"); cell.colSpan = columns; cell.textContent = missing; row.append(cell); target.append(row); }
  }
  function render() {
    q("status").textContent = state.needsReplacement ? "RECONNECT NEEDED" : state.connected ? "CONNECTED / ACCOUNT SYNC" : "NOT CONNECTED";
    q("details").textContent = !state.configured ? "Account connections are not available on this server yet." : state.needsReplacement
      ? "Saved credentials are unavailable. Replace the connection credentials to reconnect."
      : state.connected ? `Connected ${date(state.connectedAt)}. Last account sync ${date(state.snapshot?.syncedAt)}.`
        : "Use credentials from your existing Polymarket US account. Your Google password is not needed.";
    q("submit").textContent = state.connected ? "Replace & verify connection" : "Connect & verify";
    q("credentials").open = !state.connected || state.needsReplacement;
    const snapshot = state.snapshot;
    q("snapshot").hidden = !snapshot;
    if (snapshot) {
      rows(q("balances"), snapshot.balances?.items, 5, row => [row.currency, amount(row.currentBalance, row.currency), amount(row.buyingPower, row.currency), amount(row.assetNotional, row.currency), date(row.lastUpdated)], "No balance records returned.");
      rows(q("positions"), snapshot.positions?.items, 5, row => [row.title, number(row.netPosition), amount(row.cost?.value, row.cost?.currency), amount(row.cashValue?.value, row.cashValue?.currency), amount(row.realized?.value, row.realized?.currency)], snapshot.positions ? "No positions returned." : "Positions have not been retrieved.");
      rows(q("orders"), snapshot.orders?.items, 6, row => [row.marketSlug, `${label(row.side)} / ${label(row.outcomeSide)}`, amount(row.price?.value, row.price?.currency), number(row.quantity), number(row.filled), label(row.status)], snapshot.orders ? "No open orders returned." : "Open orders have not been retrieved.");
      for (const name of ["balances", "positions", "orders"]) {
        const resource = snapshot[name];
        q(`${name}-date`).textContent = resource ? `${date(resource.observedAt)}${resource.partial ? " / partial results" : ""}` : "NOT SYNCED";
      }
      q("warnings").textContent = [...(snapshot.warnings ?? []), ...(snapshot.positions?.partial ? ["Positions show the first 100 results. Additional positions may exist."] : []), ...(snapshot.orders?.partial ? ["Open orders show the first 100 results. Additional orders may exist."] : [])].join(" ");
    }
    controls();
  }
  async function effect(work, message) {
    if (pending || disposed) return;
    pending = true; controls();
    try { const value = await work(); if (!disposed) { state = value; render(); if (message) feedback(message); } }
    catch (error) { if (!disposed && !state) q("status").textContent = "CONNECTION UNAVAILABLE"; feedback(error.message, true); }
    finally { pending = false; controls(); }
  }
  listen(form, "submit", event => {
    event.preventDefault();
    const credentials = { keyId: form.elements.keyId.value.trim(), secretKey: form.elements.secretKey.value.trim() };
    form.reset(); feedback("Verifying access to your Polymarket US account…");
    void effect(() => call("connect", credentials), "Polymarket US connected. Account access verified.");
  });
  listen(q("sync"), "click", () => { feedback("Syncing account data…"); void effect(() => call("sync", {}), "Account sync finished. Check each section's date and any sync warnings."); });
  listen(q("disconnect"), "click", () => { form.reset(); void effect(() => call("disconnect", {}), "Disconnected. Saved credentials and account snapshots removed from Synergy."); });
  controls();
  return {
    load: () => effect(() => call("state")),
    dispose() { disposed = true; abort.abort(); form.reset(); for (const remove of listeners) remove(); },
  };
}
