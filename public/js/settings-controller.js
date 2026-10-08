import { createWorkspaceRequest } from "./workspace-client.js";

const roles = ["planner", "researcher", "strategist", "critic"];
export function initializeSettings(root, { fetchImpl, windowRef = root.ownerDocument.defaultView }) {
  const request = createWorkspaceRequest(root, fetchImpl), doc = root.ownerDocument;
  const find = (name) => root.querySelector(`[data-${name}]`);
  const listeners = [], defaults = find("settings-defaults");
  let disposed = false, state, connection, defaultsDirty = false, defaultsRevision = 0, connectionBusy = false;
  const on = (element, event, handler) => { element?.addEventListener(event, handler); listeners.push(() => element?.removeEventListener(event, handler)); };
  const say = (name, text) => { if (!disposed && find(name)) find(name).textContent = text; };
  const field = (name) => defaults.elements.namedItem(name);
  const tabs = [...root.querySelectorAll("[data-settings-tab]")];
  function select(id, focus = false) {
    if (!tabs.some((tab) => tab.dataset.settingsTab === id)) id = "connections";
    for (const panel of root.querySelectorAll("[data-settings-panel]")) panel.hidden = panel.dataset.settingsPanel !== id;
    for (const tab of tabs) { const active = tab.dataset.settingsTab === id; tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; if (active && focus) tab.focus(); }
  }
  tabs.forEach((tab, index) => {
    on(tab, "click", () => select(tab.dataset.settingsTab));
    on(tab, "keydown", (event) => { const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1; if (next >= 0) { event.preventDefault(); select(tabs[next].dataset.settingsTab, true); } });
  });
  select(new URLSearchParams(windowRef.location.search).get("section"));

  function renderSettings(value) {
    if (disposed) return; state = value;
    say("settings-paid", value.paidCallsEnabled ? "PAID ACCESS ENABLED" : "PAID CALLS LOCKED");
    say("settings-storage", value.storage.persistent ? `Persistent ${value.storage.kind.toUpperCase()} storage. Saved defaults, drafts, and credentials survive server restarts.` : "Temporary storage. This server must be configured with durable storage before relying on saved data.");
    for (const form of root.querySelectorAll("[data-provider-form]")) {
      const provider = value.providers.find((entry) => entry.id === form.dataset.providerForm);
      form.querySelector("[data-provider-state]").textContent = provider?.needsReplacement ? "Key unavailable" : provider?.configured ? provider.source === "account" ? "Saved key" : "Server configured" : "Not configured";
      form.querySelector("[data-provider-model]").textContent = provider?.model || "Model configured by your server administrator";
      form.querySelector('[type="submit"]').disabled = !value.credentialStorageAvailable;
      form.querySelector("[data-provider-remove]").disabled = provider?.source !== "account";
      if (!value.credentialStorageAvailable) form.querySelector("[data-provider-feedback]").textContent = "A stable integration encryption key is required on this server before keys can be saved.";
    }
    if (!defaultsDirty) {
      const p = value.preferences;
      for (const name of ["provider", "symbol", "timeframe", "accountSize", "riskPercent", "pointValue", "minRewardRisk"]) field(name).value = p[name];
      for (const role of roles) field(`route_${role}`).value = p.routes[role] ?? "";
      for (const name of ["maxSteps", "maxModelCalls", "maxTokens", "maxCostUsd"]) field(name).value = p.limits[name] ?? "";
      field("durationSeconds").value = p.limits.maxDurationMs / 1000;
    }
    defaults.querySelector('[type="submit"]').disabled = false;
  }
  for (const form of root.querySelectorAll("[data-provider-form]")) {
    const feedback = form.querySelector("[data-provider-feedback]"), submit = form.querySelector('[type="submit"]'), remove = form.querySelector("[data-provider-remove]");
    let busy = false;
    async function save(method) {
      if (busy || !state || (method === "PUT" && !form.reportValidity())) return;
      const submittedKey = form.elements.apiKey.value;
      busy = true; submit.disabled = remove.disabled = true;
      feedback.textContent = method === "PUT" ? "Saving encrypted key…" : "Removing your saved key…";
      try {
        const value = await request(`/api/settings/providers/${form.dataset.providerForm}`, method === "PUT" ? { apiKey: submittedKey } : {}, method);
        if (disposed) return;
        const newerKey = form.elements.apiKey.value !== submittedKey;
        if (!newerKey) form.elements.apiKey.value = "";
        renderSettings(value);
        feedback.textContent = newerKey ? "Earlier change saved. Your newer key is still unsaved." : method === "PUT" ? "Key saved. No provider call was made; the key has not been verified." : value.providers.find((p) => p.id === form.dataset.providerForm)?.source === "server" ? "Your key was removed. This provider now uses the server configuration." : "Your saved key was removed.";
      } catch (error) { if (!disposed) feedback.textContent = error.message; }
      finally { busy = false; if (!disposed && state) { submit.disabled = !state.credentialStorageAvailable; remove.disabled = state.providers.find((p) => p.id === form.dataset.providerForm)?.source !== "account"; } }
    }
    on(form, "submit", (event) => { event.preventDefault(); void save("PUT"); });
    on(remove, "click", () => void save("DELETE"));
  }
  on(defaults, "input", () => { defaultsDirty = true; defaultsRevision++; say("defaults-feedback", "Unsaved changes"); });
  on(defaults, "submit", async (event) => {
    event.preventDefault(); const button = defaults.querySelector('[type="submit"]'); if (button.disabled || !defaults.reportValidity()) return;
    const preferences = { routes: {}, limits: {} };
    for (const name of ["provider", "symbol", "timeframe"]) preferences[name] = field(name).value;
    for (const name of ["accountSize", "riskPercent", "pointValue", "minRewardRisk"]) preferences[name] = Number(field(name).value);
    for (const role of roles) preferences.routes[role] = field(`route_${role}`).value;
    for (const name of ["maxSteps", "maxModelCalls", "maxTokens"]) preferences.limits[name] = Number(field(name).value);
    preferences.limits.maxCostUsd = field("maxCostUsd").value ? Number(field("maxCostUsd").value) : null;
    preferences.limits.maxDurationMs = Number(field("durationSeconds").value) * 1000;
    const revision = defaultsRevision;
    button.disabled = true; say("defaults-feedback", "Saving…");
    try { const value = await request("/api/settings/preferences", preferences, "PATCH"); defaultsDirty = revision !== defaultsRevision; renderSettings(value); say("defaults-feedback", defaultsDirty ? "Earlier defaults saved. Your newer changes are unsaved." : "Defaults saved to your account"); }
    catch (error) { say("defaults-feedback", error.message); } finally { if (!disposed) button.disabled = false; }
  });
  function renderConnection(value) {
    if (disposed) return; connection = value;
    say("connection-state", value.connected ? "Connected" : "Not connected");
    say("connection-detail", value.connected ? "Your Robinhood authorization is saved. Open Accounts for portfolio data, market tools, and reviewed broker requests." : !value.configured ? `Server setup required: ${(value.missing ?? []).join(", ") || "durable broker storage"}.` : "Continue to Robinhood to authorize your account. Your password stays with Robinhood.");
    find("connection-connect").disabled = connectionBusy || !value.configured;
    find("connection-connect").textContent = value.connected ? "Reconnect Robinhood ↗" : "Connect Robinhood ↗";
    find("connection-disconnect").disabled = connectionBusy || !value.connected;
  }
  async function connectionAction(action) {
    if (connectionBusy) return; connectionBusy = true; renderConnection(connection);
    try {
      if (action === "connect") {
        const { authorizationUrl } = await request("/api/robinhood/connect", {}), url = new URL(authorizationUrl);
        if (url.origin !== "https://robinhood.com" || url.pathname !== "/oauth") throw new Error("Unexpected Robinhood authorization destination.");
        if (!disposed) windowRef.location.assign(url.href);
      } else {
        await request("/api/robinhood/disconnect", {}); renderConnection(await request("/api/robinhood/state"));
        say("connection-feedback", "Disconnected. You can also revoke Synergy Module access in Robinhood.");
      }
    } catch (error) { say("connection-feedback", error.message); }
    finally { connectionBusy = false; if (connection && !disposed) renderConnection(connection); }
  }
  on(find("connection-connect"), "click", () => void connectionAction("connect"));
  on(find("connection-disconnect"), "click", () => void connectionAction("disconnect"));
  const outcome = new URLSearchParams(windowRef.location.search).get("robinhood");
  if (outcome) say("connection-feedback", { connected: "Robinhood connected and saved.", cancelled: "Authorization was cancelled.", invalid_state: "Authorization expired. Connect again.", connection_failed: "Connection could not finish. Check its status and try again." }[outcome] ?? "Check your connection status.");

  function renderChecks(readiness) {
    if (disposed) return;
    const rows = (readiness?.checks ?? []).map((check) => { const row = doc.createElement("li"); row.className = "brain-readiness-check"; row.dataset.status = check.status; const status = doc.createElement("span"), detail = doc.createElement("div"), title = doc.createElement("strong"), text = doc.createElement("p"); status.textContent = check.status.toUpperCase(); title.textContent = check.label; text.textContent = check.detail; detail.append(title, text); row.append(status, detail); return row; });
    find("brain-readiness-checks").replaceChildren(...rows);
    say("brain-readiness-time", readiness?.checkedAt ? `Checked ${new Date(readiness.checkedAt).toLocaleString()}` : "Setup check unavailable");
  }
  on(find("brain-evals"), "click", async () => {
    const button = find("brain-evals"); if (button.disabled) return; button.disabled = true;
    say("brain-eval-results", "Running offline checks…");
    try { const report = await request("/api/brain/evals", {}); say("brain-eval-results", `${report.total - report.failed} / ${report.total} passed. ${(report.cases ?? []).filter((item) => !item.passed).map((item) => item.name).join("; ")}`); const brain = await request("/api/brain/state"); renderChecks(brain.readiness); }
    catch (error) { say("brain-eval-results", error.message); } finally { if (!disposed) button.disabled = false; }
  });
  void request("/api/settings").then((value) => { renderSettings(value); say("settings-status", "Settings are saved to your account. Saving a key uses no AI tokens."); }).catch((error) => say("settings-status", error.message));
  void request("/api/robinhood/state").then(renderConnection).catch((error) => say("connection-detail", error.message));
  void request("/api/brain/state").then((value) => renderChecks(value.readiness)).catch(() => say("brain-readiness-time", "Setup checks unavailable. Refresh to retry."));
  return { dispose() { disposed = true; for (const remove of listeners) remove(); } };
}
