const readable = (value) => String(value ?? "").replaceAll("_", " ");
const when = (value) => new Date(value).toLocaleString();
export function initializeRobinhood(root, { request, windowRef, onEvidence }) {
  const find = (name) => root.querySelector(`[data-rh-${name}]`), doc = root.ownerDocument;
  const form = find("form"), group = find("group"), select = find("tool");
  let state = null, busy = false, disposed = false, loaded = false, selectedSnapshot = null, requestId = null;
  const listeners = [];
  function on(element, event, handler) { element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler)); }
  function el(tag, text, className) { const node = doc.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; }
  function message(text, error = false) { if (!disposed) { find("feedback").textContent = text; find("feedback").dataset.error = String(error); } }
  const chosen = () => state?.tools.find((tool) => tool.name === select.value);
  function controls() {
    find("connect").disabled = busy || !state?.configured;
    find("connect").textContent = state?.connected ? "RECONNECT ROBINHOOD ↗" : "CONNECT ROBINHOOD ↗";
    for (const name of ["discover", "disconnect"]) find(name).disabled = busy || !state?.connected;
    find("pause").disabled = busy || !state?.connected || !state.liveEnabled;
    find("pause").textContent = state?.paused ? "ENABLE REVIEWED SUBMISSIONS" : "PAUSE SUBMISSIONS";
    find("refresh").disabled = busy; select.disabled = busy || !state?.connected || !select.options.length;
    find("submit").disabled = busy || !state?.connected || !chosen();
    for (const button of root.querySelectorAll("[data-rh-decision]")) {
      const action = state?.actions.find((item) => item.id === button.dataset.id);
      button.disabled = busy || !action || action.expiresAt <= Date.now() || (button.dataset.rhDecision === "approve" && (!state.liveEnabled || state.paused || !button.closest("article").querySelector("input[type=checkbox]")?.checked));
    }
  }
  async function task(work) {
    if (busy || disposed) return; busy = true; controls();
    try { await work(); } catch (error) { message(error.message, true); }
    finally { busy = false; if (!disposed) controls(); }
  }
  function fieldNode(key, schema, required) {
    const label = el("label", undefined, "field"); label.append(el("span", `${schema.title || readable(key).toUpperCase()}${required ? " *" : ""}`));
    let control;
    if (Array.isArray(schema.enum)) {
      control = el("select"); if (!required) control.append(new windowRef.Option("Leave unset", ""));
      for (const value of schema.enum) control.append(new windowRef.Option(String(value), JSON.stringify(value)));
      control.dataset.valueType = "enum";
    } else if (schema.type === "boolean") {
      control = el("select"); if (!required) control.append(new windowRef.Option("Leave unset", ""));
      control.append(new windowRef.Option("Yes", "true"), new windowRef.Option("No", "false")); control.dataset.valueType = "json";
    } else if (schema.type === "object" || schema.type === "array" || schema.anyOf || schema.oneOf || schema.$ref) {
      control = el("textarea"); control.rows = 3; control.placeholder = schema.type === "array" ? '[]' : '{}'; control.dataset.valueType = "json";
      label.append(el("small", "Structured values: enter valid JSON matching the broker field definition below."));
    } else {
      control = el("input"); control.type = ["integer", "number"].includes(schema.type) ? "number" : "text";
      if (control.type === "number") { control.step = schema.type === "integer" ? "1" : "any"; control.dataset.valueType = "number"; }
      if (schema.minimum !== undefined) control.min = schema.minimum;
      if (schema.maximum !== undefined) control.max = schema.maximum;
      if (schema.maxLength) control.maxLength = Math.min(16000, schema.maxLength);
    }
    control.dataset.parameter = key; control.required = required; control.autocomplete = "off";
    if (schema.default !== undefined && !["object", "array"].includes(schema.type)) control.value = control.dataset.valueType === "enum" ? JSON.stringify(schema.default) : String(schema.default);
    label.append(control); if (schema.description) label.append(el("small", schema.description)); return label;
  }
  function renderFields() {
    requestId = null;
    const tool = chosen(); find("fields").replaceChildren();
    if (!tool) { controls(); return; }
    const schema = tool.inputSchema;
    for (const [key, property] of Object.entries(schema.properties ?? {})) find("fields").append(fieldNode(key, property, schema.required?.includes(key)));
    const details = el("details"); details.append(el("summary", "Broker field definitions"), el("pre", JSON.stringify(schema, null, 2))); find("fields").append(details);
    const mutation = tool.kind !== "read";
    find("reason-field").hidden = !mutation; form.elements.namedItem("reason").required = mutation;
    find("submit").textContent = mutation ? "PREPARE FOR REVIEW" : "FETCH DATA";
    find("action-help").textContent = mutation ? "This prepares an exact request for your review. Orders receive a Robinhood preview. Nothing is submitted by this button." : "Reads data from Robinhood and saves a dated snapshot. No model call is made.";
    controls();
  }
  function toolGroup(tool) {
    if (tool.group === group.value) return true;
    const token = { Equities: "equity", Options: "option", Crypto: "crypto" }[group.value];
    return token && tool.kind !== "read" && tool.name.includes(`_${token}_`);
  }
  function renderTools() {
    const previous = select.value;
    const tools = state?.tools.filter(toolGroup) ?? [];
    select.replaceChildren(...tools.map((tool) => new windowRef.Option(readable(tool.name), tool.name)));
    if (tools.some((tool) => tool.name === previous)) select.value = previous;
    find("tool-count").textContent = `${state?.tools.length ?? 0} AVAILABLE`;
    for (const button of root.querySelectorAll("[data-rh-market]")) button.setAttribute("aria-pressed", String(button.dataset.rhMarket === group.value));
    renderFields();
  }
  function showSnapshot(snapshot) {
    if (!snapshot) return;
    selectedSnapshot = snapshot;
    const data = find("data"); data.replaceChildren(el("h4", readable(snapshot.tool).toUpperCase()), el("time", `Retrieved ${when(snapshot.fetchedAt)}`));
    if (snapshot.result.structuredContent !== null) data.append(el("pre", JSON.stringify(snapshot.result.structuredContent, null, 2)));
    else for (const item of snapshot.result.content ?? []) data.append(el("pre", item.text));
    find("use").hidden = false;
  }
  function renderActions() {
    const list = find("actions"); list.replaceChildren();
    if (!state.actions.length) list.append(el("p", "No broker requests. Prepare an order preview or another change to review it here.", "brain-placeholder"));
    for (const action of state.actions.slice(0, 20)) {
      const article = el("article", undefined, "rh-action"); article.dataset.status = action.status;
      article.append(el("h4", `${readable(action.tool).toUpperCase()} / ${readable(action.status).toUpperCase()}`), el("p", action.reason), el("time", `Created ${when(action.createdAt)} · ${action.source === "brain" ? "Brain proposal" : "Your request"}`));
      const args = el("details"); args.open = action.status === "awaiting_approval"; args.append(el("summary", "Exact request details"), el("pre", JSON.stringify(action.arguments, null, 2))); article.append(args);
      if (action.preview) { const preview = el("details"); preview.open = action.status === "awaiting_approval"; preview.append(el("summary", "Robinhood preview and warnings"), el("pre", JSON.stringify(action.preview.structuredContent ?? action.preview.content, null, 2))); article.append(preview); }
      if (action.result) { const result = el("details"); result.append(el("summary", "Broker response (check order history for fills)"), el("pre", JSON.stringify(action.result.structuredContent ?? action.result.content, null, 2))); article.append(result); }
      if (action.message) article.append(el("p", action.message));
      if (action.status === "awaiting_approval") {
        article.append(el("p", `Preview expires ${when(action.expiresAt)}. ${state.liveEnabled ? "" : "Live submissions are locked on the server."}`));
        const label = el("label"), checkbox = el("input"); checkbox.type = "checkbox";
        label.append(checkbox, el("span", "I reviewed the account, instrument, quantities, prices, and broker warnings for this exact request.")); article.append(label);
        const buttons = el("div", undefined, "rh-buttons");
        for (const [decision, text] of [["approve", "CONFIRM & SEND TO ROBINHOOD"], ["reject", "REJECT REQUEST"]]) {
          const button = el("button", text, decision === "approve" ? "btn btn-solid" : "btn"); button.type = "button"; button.dataset.rhDecision = decision; button.dataset.id = action.id; button.dataset.version = action.version; buttons.append(button);
        }
        article.append(buttons);
      }
      list.append(article);
    }
  }
  async function refresh({ announce = false } = {}) {
    const result = await request("/api/robinhood/state"); if (disposed) return;
    state = result; loaded = true;
    find("status").textContent = state.connected ? "ROBINHOOD CONNECTED" : "AWAITING ROBINHOOD";
    find("lock").textContent = !state.liveEnabled ? "LIVE SUBMISSIONS LOCKED" : state.paused ? "SUBMISSIONS PAUSED" : "CONFIRMATION REQUIRED";
    find("setup").hidden = state.connected;
    find("config").textContent = !state.configured ? `Server setup pending: ${state.missing.join(", ") || "persistent broker storage"}.` : "Connection is ready. Continue to Robinhood to authorize this account.";
    renderTools(); renderActions();
    find("events").replaceChildren(...state.events.slice(0, 30).map((event) => {
      const item = el("li", `${readable(event.event)}${event.tool ? ` · ${readable(event.tool)}` : ""}`); item.append(el("time", when(event.at))); return item;
    }));
    if (!state.events.length) find("events").append(el("li", "No Robinhood activity yet."));
    if (!selectedSnapshot && state.snapshots.length) showSnapshot(state.snapshots[0]);
    if (announce) message(state.connected ? "Connection and saved activity refreshed." : "Connect Robinhood to discover available account and market tools.");
    controls();
  }
  on(find("refresh"), "click", () => void task(() => refresh({ announce: true })));
  on(find("connect"), "click", () => void task(async () => {
    const { authorizationUrl } = await request("/api/robinhood/connect", {});
    const url = new URL(authorizationUrl);
    if (url.origin !== "https://robinhood.com" || url.pathname !== "/oauth") throw new Error("Unexpected Robinhood authorization destination.");
    windowRef.location.assign(url.href);
  }));
  on(find("disconnect"), "click", () => void task(async () => { await request("/api/robinhood/disconnect", {}); selectedSnapshot = null; find("data").replaceChildren(); find("use").hidden = true; await refresh(); message("Disconnected. New broker calls are stopped. You can also revoke Synergy Module access in Robinhood."); }));
  on(find("pause"), "click", () => void task(async () => { await request("/api/robinhood/pause", { paused: !state.paused }); await refresh(); message(state.paused ? "New broker submissions are paused. Existing orders remain in Robinhood." : "Reviewed submissions enabled. Every change still requires confirmation."); }));
  on(find("discover"), "click", () => void task(async () => { await request("/api/robinhood/discover", {}); await refresh(); message("Available Robinhood tools and fields refreshed."); }));
  on(group, "change", renderTools); on(select, "change", renderFields); on(form, "input", () => { requestId = null; });
  for (const button of root.querySelectorAll("[data-rh-market]")) on(button, "click", () => { group.value = button.dataset.rhMarket; renderTools(); });
  on(form, "submit", (event) => { event.preventDefault(); void task(async () => {
    if (!form.reportValidity()) return;
    const tool = chosen(); if (!tool) return;
    const args = Object.create(null);
    for (const input of find("fields").querySelectorAll("[data-parameter]")) {
      if (input.value === "" && !input.required) continue;
      try { args[input.dataset.parameter] = input.dataset.valueType === "number" ? Number(input.value) : ["json", "enum"].includes(input.dataset.valueType) ? JSON.parse(input.value) : input.value; }
      catch { throw new Error(`Check the structured value for ${readable(input.dataset.parameter)}.`); }
    }
    if (tool.kind === "read") { const { snapshot } = await request("/api/robinhood/read", { tool: tool.name, arguments: args }); if (!disposed) showSnapshot(snapshot); message("Dated Robinhood snapshot saved. You can use it as mission evidence."); }
    else { requestId ??= windowRef.crypto.randomUUID(); await request("/api/robinhood/actions", { tool: tool.name, arguments: args, reason: form.elements.namedItem("reason").value, requestId }); await refresh(); message("Request prepared for your separate review. Nothing has been submitted."); }
  }); });
  on(find("actions"), "change", controls);
  on(find("actions"), "click", (event) => { const button = event.target.closest("[data-rh-decision]"); if (!button || button.disabled) return; void task(async () => {
    try { await request(`/api/robinhood/actions/${encodeURIComponent(button.dataset.id)}/decision`, { decision: button.dataset.rhDecision, version: Number(button.dataset.version) }); message(button.dataset.rhDecision === "approve" ? "Robinhood acknowledged the request. Check order history for fills." : "Request rejected."); }
    finally { await refresh(); }
  }); });
  on(find("use"), "click", () => { if (selectedSnapshot) onEvidence(selectedSnapshot); });
  const outcome = new URLSearchParams(windowRef.location?.search).get("robinhood");
  if (outcome) message({ connected: "Robinhood connected. Sync tools or fetch account data to begin.", cancelled: "Robinhood authorization was cancelled.", invalid_state: "Robinhood sign-in expired. Start the connection again.", connection_failed: "Robinhood could not finish the connection. Reconnect or refresh tools if authorization was saved." }[outcome] ?? "Refresh your Robinhood connection.", outcome !== "connected");
  return { async open() { if (!loaded && !busy) await task(() => refresh({ announce: !outcome })); }, refresh, dispose() { disposed = true; for (const remove of listeners) remove(); } };
}
