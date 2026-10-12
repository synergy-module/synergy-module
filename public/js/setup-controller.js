import { createWorkspaceRequest } from "./workspace-client.js";
import { applyWorkspaceExperience } from "./redline-theme.js";

export function initializeSetup(root, { fetchImpl, windowRef = root.ownerDocument.defaultView, navigate = (path) => windowRef.location.assign(path) } = {}) {
  const request = createWorkspaceRequest(root, fetchImpl), doc = root.ownerDocument, listeners = [], steps = ["welcome", "connections", "preferences", "review"];
  const find = (name) => root.querySelector(`[data-setup-${name}]`), welcome = find("welcome"), defaults = find("preferences"), ai = find("ai"), poly = find("poly"), review = find("review");
  let state, disposed = false, stepBusy = false, aiBusy = false, polyBusy = false, robinhoodBusy = false, broker;
  const on = (element, event, handler) => { element?.addEventListener(event, handler); listeners.push(() => element?.removeEventListener(event, handler)); };
  const say = (name, text) => { if (!disposed && find(name)) find(name).textContent = text; };
  function show(step, focus = false) {
    if (disposed) return;
    const selected = steps.includes(step) ? step : "welcome";
    for (const panel of root.querySelectorAll("[data-setup-step]")) panel.hidden = panel.dataset.setupStep !== selected;
    for (const item of root.querySelectorAll("[data-setup-progress]")) {
      const active = item.dataset.setupProgress === selected;
      if (active) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
      item.dataset.complete = String(steps.indexOf(item.dataset.setupProgress) < steps.indexOf(selected));
    }
    if (focus) { const heading = root.querySelector(`[data-setup-step="${selected}"] h2`); heading.tabIndex = -1; heading.focus(); }
  }
  function render(value, initial = false) {
    if (disposed) return;
    state = value; applyWorkspaceExperience(doc, value);
    if (initial) {
      if (value.profile?.displayName) welcome.elements.displayName.value = value.profile.displayName;
      for (const field of welcome.querySelectorAll('[name="interests"]')) field.checked = value.onboarding?.interests?.includes(field.value) ?? false;
      for (const name of ["theme", "defaultLanding", "timezone", "symbol", "timeframe", "riskPercent"]) defaults.elements.namedItem(name).value = value.preferences[name];
      ai.elements.provider.value = value.preferences.provider;
      review.elements.acknowledgedPracticeIsolation.checked = value.onboarding?.acknowledgedPracticeIsolation === true;
      show(value.onboarding?.step);
    }
    welcome.querySelector('[type="submit"]').disabled = false;
    ai.querySelector('[type="submit"]').disabled = !value.credentialStorageAvailable || aiBusy;
    providerStatus();
    const connected = value.providers.filter((provider) => provider.configured).map((provider) => provider.label);
    say("review-summary", `${value.profile?.displayName || "Your workspace"} · ${value.preferences.symbol} research · ${connected.length ? `AI available: ${connected.join(", ")}.` : "You can add an AI provider any time in Settings."}`);
  }
  function providerStatus() {
    if (!state) return;
    const provider = state.providers.find((entry) => entry.id === ai.elements.provider.value);
    say("ai-status", !state.credentialStorageAvailable ? "Ask your server administrator to enable encrypted credential storage before saving a key." : provider?.configured ? `${provider.label} is connected${provider.source === "server" ? " through your server" : " with a saved key"}. You can add or replace a key below.` : "Your key is encrypted. Saving it does not make a paid AI call.");
  }
  async function transition(step, work) {
    if (stepBusy || !state) return;
    stepBusy = true;
    for (const button of root.querySelectorAll('.setup-actions button')) button.disabled = true;
    say("feedback", "Saving your progress…");
    try {
      await work?.();
      const value = await request("/api/settings/onboarding", { step }, "PATCH");
      if (!disposed) { render(value); show(step, true); say("feedback", "Progress saved. You can come back to setup any time."); }
    } catch (error) { say("feedback", error.message); }
    finally { stepBusy = false; if (!disposed) for (const button of root.querySelectorAll('.setup-actions button')) button.disabled = false; }
  }
  on(welcome, "submit", (event) => {
    event.preventDefault(); if (!welcome.reportValidity()) return;
    const displayName = welcome.elements.displayName.value.trim(), interests = [...welcome.querySelectorAll('[name="interests"]:checked')].map((field) => field.value);
    void transition("connections", async () => { await request("/api/settings/profile", { displayName }, "PATCH"); await request("/api/settings/onboarding", { interests }, "PATCH"); });
  });
  for (const button of root.querySelectorAll("[data-setup-back]")) on(button, "click", () => void transition(button.dataset.setupBack));
  for (const button of root.querySelectorAll("[data-setup-next]")) on(button, "click", () => void transition(button.dataset.setupNext));
  on(defaults, "submit", (event) => {
    event.preventDefault(); if (!defaults.reportValidity()) return;
    const preferences = {}; for (const name of ["theme", "defaultLanding", "timezone", "symbol", "timeframe"]) preferences[name] = defaults.elements.namedItem(name).value;
    preferences.riskPercent = Number(defaults.elements.riskPercent.value);
    void transition("review", async () => { await request("/api/settings/preferences", preferences, "PATCH"); });
  });
  on(ai.elements.provider, "change", providerStatus);
  on(ai, "submit", async (event) => {
    event.preventDefault(); if (aiBusy || !state?.credentialStorageAvailable || !ai.reportValidity()) return;
    aiBusy = true; const provider = ai.elements.provider.value, apiKey = ai.elements.apiKey.value;
    ai.querySelector('[type="submit"]').disabled = true; say("ai-feedback", "Saving your encrypted key…");
    try { const value = await request(`/api/settings/providers/${provider}`, { apiKey }, "PUT"); if (!disposed) { if (ai.elements.apiKey.value === apiKey) ai.elements.apiKey.value = ""; render(value); say("ai-feedback", "Key saved. No paid call was made; the key has not been verified."); } }
    catch (error) { say("ai-feedback", error.message); }
    finally { aiBusy = false; if (!disposed) ai.querySelector('[type="submit"]').disabled = !state?.credentialStorageAvailable; }
  });
  function renderBroker(value) {
    if (disposed) return; broker = value;
    say("robinhood-status", value.connected ? "Connected" : "Not connected");
    say("robinhood-detail", value.connected ? "Your account authorization is saved. Account balances and orders belong to your live workspace." : value.configured ? "Authorize access directly with Robinhood. You will return to Synergy after connecting." : "Your server administrator needs to enable the Robinhood connection. You can continue setup now.");
    find("robinhood-connect").disabled = !value.configured || robinhoodBusy;
  }
  on(find("robinhood-connect"), "click", async () => {
    if (robinhoodBusy || !broker?.configured) return;
    robinhoodBusy = true; renderBroker(broker);
    try {
      const value = await request("/api/robinhood/connect", {}), destination = new URL(value.authorizationUrl);
      if (destination.origin !== "https://robinhood.com" || destination.pathname !== "/oauth") throw new Error("Unexpected Robinhood authorization destination.");
      if (!disposed) windowRef.location.assign(destination.href);
    } catch (error) { say("robinhood-feedback", error.message); }
    finally { robinhoodBusy = false; if (!disposed) renderBroker(broker); }
  });
  function renderPoly(value) {
    if (disposed) return;
    poly.dataset.configured = String(value.configured === true);
    say("poly-status", value.needsReplacement ? "Reconnect needed" : value.connected ? "Connected" : "Not connected");
    poly.querySelector('[type="submit"]').disabled = !value.configured || polyBusy;
    if (!value.configured) say("poly-feedback", "Account connections need server configuration. You can continue and connect later.");
  }
  on(poly, "submit", async (event) => {
    event.preventDefault(); if (polyBusy || poly.dataset.configured !== "true" || !poly.reportValidity()) return;
    polyBusy = true; poly.querySelector('[type="submit"]').disabled = true;
    const body = { keyId: poly.elements.keyId.value.trim(), secretKey: poly.elements.secretKey.value.trim() };
    say("poly-feedback", "Verifying your Polymarket US connection…");
    try { const value = await request("/api/polymarket/us/connect", body); if (!disposed) { poly.reset(); renderPoly(value); say("poly-feedback", "Account connected and verified."); } }
    catch (error) { say("poly-feedback", error.message); }
    finally { polyBusy = false; if (!disposed) poly.querySelector('[type="submit"]').disabled = poly.dataset.configured !== "true"; }
  });
  on(review, "submit", async (event) => {
    event.preventDefault(); if (stepBusy || !review.reportValidity()) return;
    stepBusy = true; const button = review.querySelector('[type="submit"]'); button.disabled = true; say("feedback", "Finishing setup…");
    try { const value = await request("/api/settings/onboarding/complete", { acknowledgedPracticeIsolation: true }); if (!disposed) { render(value); await navigate(value.preferences.defaultLanding || "/home"); } }
    catch (error) { say("feedback", error.message); }
    finally { stepBusy = false; if (!disposed) button.disabled = false; }
  });
  void request("/api/settings").then((value) => { render(value, true); say("feedback", value.onboarding?.completedAt ? "Your setup is complete. You can update your choices here." : "Your progress is saved as you continue."); }).catch((error) => say("feedback", error.message));
  void request("/api/robinhood/state").then(renderBroker).catch((error) => say("robinhood-detail", error.message));
  void request("/api/polymarket/us/state").then(renderPoly).catch((error) => say("poly-feedback", error.message));
  return { dispose() { disposed = true; listeners.forEach((remove) => remove()); ai.elements.apiKey.value = ""; poly.elements.secretKey.value = ""; } };
}
