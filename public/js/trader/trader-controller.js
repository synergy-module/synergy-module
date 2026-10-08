const instances = new WeakMap();
const paidLockMessage = "Paid AI calls locked. Offline demo and checks are available.";
const PROVIDERS = [
  { id: "gemini", label: "Gemini", keyName: "GEMINI_API_KEY" },
  { id: "openai", label: "OpenAI", keyName: "OPENAI_API_KEY" },
  { id: "claude", label: "Claude", keyName: "ANTHROPIC_API_KEY" },
];
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : "—";
}

function money(value) {
  return typeof value === "number" && Number.isFinite(value) ? moneyFormat.format(value) : "—";
}

function asText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function timestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

export function initializeTraderPage(root, {
  fetchImpl = root.ownerDocument.defaultView.fetch.bind(root.ownerDocument.defaultView),
  showToast = () => {},
} = {}) {
  if (instances.has(root)) return instances.get(root);
  const documentRef = root.ownerDocument;
  const windowRef = documentRef.defaultView;
  const form = root.querySelector("[data-trader-form]");
  const find = (selector) => root.querySelector(selector);
  const field = (name) => form.elements.namedItem(name);
  let providers = PROVIDERS.map((provider) => ({ ...provider, configured: false }));
  let runs = [];
  let selectedRun = null;
  let disposed = false;
  let loadingState = false;
  let submitting = false;
  let stateAvailable = false;
  let paidCallsEnabled = false;
  let stateRequest = null;
  let runRequest = null;

  function node(tag, text, className) {
    const element = documentRef.createElement(tag);
    if (text !== undefined) element.textContent = asText(text);
    if (className) element.className = className;
    return element;
  }

  function selectedProvider() {
    return providers.find((provider) => provider.id === field("provider").value) ?? providers[0];
  }

  function report(message, error = false) {
    const feedback = find("[data-trader-feedback]");
    feedback.textContent = message;
    feedback.dataset.error = String(error);
  }

  function updateAvailability() {
    const provider = selectedProvider();
    find("[data-trader-submit]").disabled = loadingState || submitting || !stateAvailable || !paidCallsEnabled || !provider.configured;
    find("[data-trader-demo]").disabled = loadingState || submitting;
    find("[data-trader-refresh]").disabled = loadingState || submitting;
    form.querySelectorAll("input, select, textarea").forEach((element) => { element.disabled = submitting; });
    root.setAttribute("aria-busy", String(loadingState || submitting));
  }

  function renderProvider() {
    const provider = selectedProvider();
    find("[data-trader-model]").textContent = provider.model || "Not available";
    const status = find("[data-trader-provider-status]");
    status.dataset.ready = String(stateAvailable && paidCallsEnabled && provider.configured);
    status.textContent = !stateAvailable
      ? "Provider configuration could not be loaded. Retry to check availability."
      : !paidCallsEnabled
        ? "Paid access is locked. API keys alone cannot enable calls. Offline demo remains available."
      : provider.configured
        ? "API key configured on server. Ready to analyze."
        : `${provider.keyName} is not configured on the server. Offline demo remains available.`;
    find("[data-trader-cost-lock]").textContent = paidCallsEnabled ? "Paid AI access is enabled on the server. Starting an analysis can incur provider charges." : paidLockMessage;
    updateAvailability();
  }

  function renderHistory() {
    const container = find("[data-trader-history]");
    container.replaceChildren();
    find("[data-trader-history-empty]").hidden = runs.length > 0;
    find("[data-trader-history-count]").textContent = `${runs.length} ${runs.length === 1 ? "RUN" : "RUNS"}`;
    for (const run of runs) {
      const button = node("button", undefined, "trader-history-item");
      button.type = "button";
      button.dataset.traderRunId = run.id;
      button.dataset.state = run.status === "ready" ? "ready" : "wait";
      button.setAttribute("aria-pressed", String(selectedRun?.id === run.id));
      button.append(
        node("span", `${run.symbol} / ${run.timeframe}`),
        node("span", run.status === "ready" ? "REVIEW PLAN ↗" : "WAIT", "trader-history-state"),
        node("small", run.mode === "demo" ? "ILLUSTRATIVE DEMO" : `${PROVIDERS.find((provider) => provider.id === run.provider)?.label ?? run.provider} · ${run.model}`),
        node("small", timestamp(run.createdAt)),
      );
      container.append(button);
    }
  }

  function section(title) {
    const element = node("section", undefined, "trader-result-section");
    element.append(node("h4", title));
    return element;
  }

  function list(values, emptyMessage) {
    const element = node("ul");
    for (const value of Array.isArray(values) && values.length ? values : [emptyMessage]) {
      element.append(node("li", value));
    }
    return element;
  }

  function metric(label, value) {
    const element = node("div");
    element.append(node("dt", label), node("dd", value));
    return element;
  }

  function renderRun(run) {
    selectedRun = run;
    const result = find("[data-trader-result]");
    result.replaceChildren();
    result.hidden = false;
    find("[data-trader-empty]").hidden = true;
    const outputState = find("[data-trader-output-state]");
    outputState.textContent = run.status === "ready" ? "READY FOR REVIEW" : "WAIT / NO TRADE";
    outputState.dataset.state = run.status === "ready" ? "ready" : "wait";
    const meta = node("div", undefined, "trader-result-meta");
    meta.append(node("span", `${run.symbol} / ${run.timeframe}`, "trader-result-symbol"), node("span", timestamp(run.createdAt)));
    result.append(meta);
    if (run.mode === "demo") {
      result.append(node("p", "ILLUSTRATIVE DEMO :: Fixed fictional prices and sample reasoning. No AI provider or market data was used.", "trader-demo-banner"));
    }
    result.append(node("h3", `${asText(run.bias).toUpperCase() || "UNDETERMINED"} THESIS`), node("p", run.summary, "trader-summary"));

    const plan = run.plan ?? {};
    const levels = node("dl", undefined, "trader-plan-levels");
    levels.append(metric("PROPOSED ENTRY", number(plan.entry)), metric("STOP", number(plan.stop)), metric("TARGET", number(plan.target)));
    result.append(levels, node("p", `INVALIDATION :: ${asText(plan.invalidation) || "No invalidation supplied."}`, "trader-invalidation"));

    const evidence = section("CONTEXT & EVIDENCE");
    evidence.append(list(run.evidence, "No supporting evidence supplied."));
    result.append(evidence);

    const risk = run.risk ?? {};
    const riskSection = section(risk.passed ? "RISK CHECK :: PASSED" : "RISK CHECK :: WAIT");
    const riskGrid = node("dl", undefined, "trader-risk-grid");
    riskGrid.append(
      metric("RISK BUDGET", money(risk.riskBudget)),
      metric("REWARD / RISK", typeof risk.rewardRisk === "number" ? `${number(risk.rewardRisk)} : 1` : "—"),
      metric("SIZED QUANTITY", number(risk.quantity)),
      metric("MAX. PLANNED LOSS", money(risk.maxLoss)),
      metric("ACCOUNT SIZE", money(risk.accountSize)),
      metric("RISK PER IDEA", typeof risk.riskPercent === "number" ? `${number(risk.riskPercent)}%` : "—"),
    );
    riskSection.append(riskGrid);
    if (risk.reasons?.length) riskSection.append(list(risk.reasons));
    riskSection.append(node("p", `Point value ${money(risk.pointValue)} · Minimum reward / risk ${number(risk.minRewardRisk)} : 1. Quantity is whole shares, units, or contracts. Planned loss excludes fees, slippage, and gaps.`, "trader-risk-note"));
    result.append(riskSection);

    const missing = section("MISSING DATA");
    missing.append(list(run.missingData, "No additional gaps reported by the analysis. Supplied context has not been independently verified."));
    result.append(missing);

    const review = node("div", undefined, "trader-review");
    review.dataset.verdict = run.status === "ready" ? "ready" : "wait";
    review.append(node("strong", `REVIEW :: ${asText(run.review?.verdict).toUpperCase() || "WAIT"}`), node("p", run.review?.reason || "Review unavailable."));
    result.append(review);

    const pipeline = section("RUN TRACE");
    const steps = node("ol", undefined, "trader-steps");
    for (const step of Array.isArray(run.steps) ? run.steps : []) {
      const row = node("li");
      row.dataset.stepStatus = step.status === "complete" ? "complete" : "warning";
      const marker = node("span", step.status === "complete" ? "✓" : "!", "trader-step-marker");
      marker.setAttribute("aria-label", step.status === "complete" ? "Complete" : "Warning");
      const detail = node("div", step.label);
      detail.append(node("span", step.detail, "trader-step-detail"));
      row.append(marker, detail);
      steps.append(row);
    }
    pipeline.append(steps);
    result.append(pipeline);

    const footer = node("div", undefined, "trader-result-footer");
    const provenance = run.mode === "demo" ? "FIXED DEMO" : `${PROVIDERS.find((provider) => provider.id === run.provider)?.label ?? run.provider} / ${run.model}`;
    footer.append(node("p", `${provenance} · ${run.dataSource || "User-supplied context"}\nNo orders submitted.`));
    const copy = node("button", "COPY BRIEFING", "trader-text-button");
    copy.type = "button";
    copy.dataset.traderCopy = "";
    footer.append(copy);
    result.append(footer);
    renderHistory();
  }

  async function loadState() {
    if (disposed || loadingState || submitting) return;
    loadingState = true;
    stateRequest = new windowRef.AbortController();
    updateAvailability();
    report("Checking provider configuration…");
    try {
      const response = await fetchImpl("/api/trader/state", {
        headers: { Accept: "application/json" }, signal: stateRequest.signal,
      });
      const payload = await response.json();
      if (disposed) return;
      if (!response.ok || !Array.isArray(payload.providers) || !Array.isArray(payload.runs)) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Unable to load the trader workspace. Try again.");
      }
      providers = PROVIDERS.map((provider) => {
        const configuration = payload.providers.find((item) => item.id === provider.id);
        return { ...provider, model: configuration?.model, configured: configuration?.configured === true };
      });
      if (!stateAvailable && providers.some((provider) => provider.id === payload.defaultProvider)) field("provider").value = payload.defaultProvider;
      stateAvailable = true;
      paidCallsEnabled = payload.paidCallsEnabled === true;
      runs = payload.runs;
      find("[data-trader-refresh]").hidden = true;
      renderProvider();
      if (runs.length && !selectedRun) renderRun(runs[0]);
      else renderHistory();
      report(!paidCallsEnabled ? paidLockMessage : selectedProvider().configured ? "Ready. Add your context to start an analysis." : "A provider is not configured. Explore the fixed demo while setup continues.");
    } catch (error) {
      if (disposed || error?.name === "AbortError") return;
      stateAvailable = false;
      paidCallsEnabled = false;
      find("[data-trader-refresh]").hidden = false;
      renderProvider();
      report(error.message || "Unable to load the trader workspace. Try again.", true);
    } finally {
      loadingState = false;
      stateRequest = null;
      if (!disposed) updateAvailability();
    }
  }

  async function submitRun(mode) {
    if (disposed || submitting || loadingState) return;
    const provider = selectedProvider();
    if (mode === "analysis" && !paidCallsEnabled) { report(paidLockMessage); return; }
    if (mode === "analysis" && (!stateAvailable || !provider.configured)) {
      report(`${provider.label} is unavailable. Offline demo remains available.`, true);
      return;
    }
    if (mode === "analysis" && !form.reportValidity()) return;
    if (mode === "demo" && ["symbol", "accountSize", "riskPercent", "pointValue", "minRewardRisk"].some((name) => !field(name).reportValidity())) return;
    const payload = {
      provider: provider.id, mode,
      symbol: field("symbol").value.trim().toUpperCase(), timeframe: field("timeframe").value,
      context: mode === "demo"
        ? "Illustrative scenario only. Fictional prices reclaim 100, with a proposed entry at 100, stop at 98, and target at 106. This is not current market data."
        : field("context").value.trim(),
      ...Object.fromEntries(["accountSize", "riskPercent", "pointValue", "minRewardRisk"].map((name) => [name, Number(field(name).value)])),
    };
    submitting = true;
    runRequest = new windowRef.AbortController();
    updateAvailability();
    report(mode === "demo" ? "Loading the fixed illustrative scenario…" : `${provider.label} is analyzing your context and reviewing the proposed plan…`);
    find("[data-trader-submit]").textContent = mode === "analysis" ? "ANALYZING…" : "ANALYZE CONTEXT ↗";
    try {
      const response = await fetchImpl("/api/trader/runs", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": documentRef.querySelector('meta[name="csrf-token"]')?.content ?? "" },
        body: JSON.stringify(payload), signal: runRequest.signal,
      });
      const responsePayload = await response.json();
      if (disposed) return;
      if (!response.ok || !responsePayload.run?.id) throw new Error(typeof responsePayload.message === "string" ? responsePayload.message : "Analysis could not be completed. Try again.");
      runs = [responsePayload.run, ...runs.filter((run) => run.id !== responsePayload.run.id)].slice(0, 10);
      renderRun(responsePayload.run);
      report(mode === "demo" ? "Demo loaded. All prices and reasoning are illustrative." : responsePayload.run.status === "ready" ? "Analysis complete. Review the proposed plan and risk checks." : "Analysis complete. The agent recommends waiting; review the gaps and risk checks.");
    } catch (error) {
      if (disposed || error?.name === "AbortError") return;
      report(error.message || "Analysis could not be completed. Try again.", true);
      showToast("TRADER RUN FAILED");
    } finally {
      submitting = false;
      runRequest = null;
      if (!disposed) {
        find("[data-trader-submit]").textContent = "ANALYZE CONTEXT ↗";
        updateAvailability();
      }
    }
  }

  function onSubmit(event) { event.preventDefault(); submitRun("analysis"); }
  function onChange(event) {
    if (event.target.name !== "provider") return;
    renderProvider();
    report(!paidCallsEnabled ? paidLockMessage : selectedProvider().configured ? "Provider selected. Ready for analysis." : "This provider is not configured. Offline demo remains available.");
  }
  async function onClick(event) {
    const target = event.target.closest?.("[data-trader-demo], [data-trader-refresh], [data-trader-run-id], [data-trader-copy]");
    if (!target || !root.contains(target)) return;
    if (target.hasAttribute("data-trader-demo")) return submitRun("demo");
    if (target.hasAttribute("data-trader-refresh")) return loadState();
    if (target.hasAttribute("data-trader-run-id")) {
      const run = runs.find((item) => item.id === target.dataset.traderRunId);
      if (run) renderRun(run);
      return;
    }
    if (selectedRun && target.hasAttribute("data-trader-copy")) {
      const result = find("[data-trader-result]");
      const briefing = result.innerText || result.textContent;
      try {
        if (!windowRef.navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await windowRef.navigator.clipboard.writeText(briefing);
        if (!disposed) report("Briefing copied to clipboard.");
      } catch {
        if (!disposed) report("Clipboard unavailable. Select the briefing text to copy it manually.", true);
      }
    }
  }

  form.addEventListener("submit", onSubmit);
  form.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  const instance = {
    dispose() {
      disposed = true;
      stateRequest?.abort();
      runRequest?.abort();
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("change", onChange);
      root.removeEventListener("click", onClick);
      instances.delete(root);
    },
  };
  instances.set(root, instance);
  loadState();
  return instance;
}
