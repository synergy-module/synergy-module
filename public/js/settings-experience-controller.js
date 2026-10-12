import { applyWorkspaceExperience } from "./redline-theme.js";
import { initializeReferenceFeed } from "./reference-feed-controller.js";

export function initializeExperienceSettings(root, { request, windowRef, onState }) {
  const doc = root.ownerDocument, form = root.querySelector("[data-settings-profile]"), tokenForm = root.querySelector("[data-agent-token-form]");
  const find = (name) => root.querySelector(`[data-${name}]`), listeners = [];
  let disposed = false, dirty = false, revision = 0, savedState, tokensLoaded = false, tokensBusy = false;
  const reference = initializeReferenceFeed(root, { request, windowRef });
  const on = (el, event, handler) => { el?.addEventListener(event, handler); listeners.push(() => el?.removeEventListener(event, handler)); };
  const say = (name, message) => { if (!disposed && find(name)) find(name).textContent = message; };
  const input = (name) => form.elements.namedItem(name);
  function render(value) {
    if (disposed) return;
    savedState = value;
    applyWorkspaceExperience(doc, value);
    if (!dirty) {
      const p = value.preferences ?? {};
      input("displayName").value = value.profile?.displayName || doc.querySelector("[data-display-name]")?.textContent.trim() || "";
      for (const [key, fallback] of Object.entries({ theme: "system", density: "comfortable", timezone: "America/Chicago", currency: "USD", defaultLanding: "/home" })) input(key).value = p[key] ?? fallback;
      input("reducedMotion").checked = p.reducedMotion === true;
      for (const key of ["researchCompleted", "orderUpdates", "practiceResults"]) input(`notification_${key}`).checked = p.notifications?.[key] !== false;
    }
    form.querySelector('[type="submit"]').disabled = false;
  }
  on(form, "input", () => { dirty = true; revision++; say("profile-feedback", "Unsaved changes"); });
  on(form, "submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled || !form.reportValidity()) return;
    const currentRevision = revision, profile = { displayName: input("displayName").value.trim() };
    const preferences = { notifications: {}, reducedMotion: input("reducedMotion").checked };
    for (const key of ["theme", "density", "timezone", "currency", "defaultLanding"]) preferences[key] = input(key).value;
    for (const key of ["researchCompleted", "orderUpdates", "practiceResults"]) preferences.notifications[key] = input(`notification_${key}`).checked;
    button.disabled = true; say("profile-feedback", "Saving your preferences…");
    let profileSaved = false;
    try {
      if (savedState?.profile?.displayName !== profile.displayName) { await request("/api/settings/profile", profile, "PATCH"); profileSaved = true; }
      const value = await request("/api/settings/preferences", preferences, "PATCH");
      if (disposed) return;
      dirty = currentRevision !== revision;
      onState(value);
      say("profile-feedback", dirty ? "Saved. Your newer edits are still unsaved." : "Preferences saved to your account.");
    } catch (error) { say("profile-feedback", `${profileSaved ? "Your name was saved. Preferences could not be saved: " : ""}${error.message}`); }
    finally { if (!disposed) button.disabled = false; }
  });
  function renderTokens(value) {
    const list = find("agent-token-list"); list.replaceChildren();
    for (const token of value.tokens ?? []) {
      const row = doc.createElement("div"), detail = doc.createElement("div"), name = doc.createElement("strong"), info = doc.createElement("p"), scopes = doc.createElement("small"), revoke = doc.createElement("button");
      row.className = "agent-token-row"; name.textContent = token.name;
      info.textContent = token.revokedAt ? "Revoked" : `Expires ${new Date(token.expiresAt).toLocaleDateString()} · ${token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "Never used"}`;
      scopes.textContent = (token.scopes ?? []).join(" · ");
      revoke.type = "button"; revoke.className = "btn btn-danger"; revoke.textContent = "Revoke"; revoke.disabled = Boolean(token.revokedAt);
      revoke.addEventListener("click", async () => {
        if (revoke.disabled) return; revoke.disabled = true;
        try { await request(`/api/platform/tokens/${encodeURIComponent(token.id)}`, {}, "DELETE"); if (!disposed) { say("agent-feedback", "Access revoked. This token can no longer make requests."); await loadTokens(true); } }
        catch (error) { say("agent-feedback", error.message); if (!disposed) revoke.disabled = false; }
      });
      detail.append(name, info, scopes); row.append(detail, revoke); list.append(row);
    }
    if (!list.children.length) { const empty = doc.createElement("p"); empty.textContent = "No access tokens yet. Create one for the assistant you want to connect."; list.append(empty); }
    if (!tokensLoaded) {
      const fieldset = find("agent-scopes"); fieldset.replaceChildren();
      const legend = doc.createElement("legend"); legend.textContent = "What can this assistant do?"; fieldset.append(legend);
      for (const scope of value.scopes ?? []) {
        const label = doc.createElement("label"), checkbox = doc.createElement("input"), detail = doc.createElement("span"), title = doc.createElement("strong"), description = doc.createElement("small");
        label.className = "preference-toggle"; if (scope.id === "live:trade") label.classList.add("live-permission");
        checkbox.type = "checkbox"; checkbox.name = "scopes"; checkbox.value = scope.id; checkbox.checked = ["workspace:read", "workspace:write", "research:write", "testing:write"].includes(scope.id);
        title.textContent = scope.label; description.textContent = scope.description; detail.append(title, description); label.append(checkbox, detail); fieldset.append(label);
      }
    }
    tokensLoaded = true; tokenForm.querySelector('[type="submit"]').disabled = false;
  }
  async function loadTokens(force = false) {
    if (disposed || tokensBusy || (tokensLoaded && !force)) return;
    tokensBusy = true; say("agent-feedback", "Loading access tokens…");
    try { const value = await request("/api/platform/tokens"); if (!disposed) { renderTokens(value); say("agent-feedback", "Each assistant has only the permissions you select."); } }
    catch (error) { say("agent-feedback", error.message); }
    finally { tokensBusy = false; }
  }
  on(root.querySelector('[data-settings-tab="automation"]'), "click", () => void loadTokens());
  on(root.querySelector('[data-settings-tab="connections"]'), "click", () => void reference.load());
  on(root, "keydown", () => { windowRef.setTimeout?.(() => {
    if (root.querySelector('[data-settings-tab="automation"]')?.getAttribute("aria-selected") === "true") void loadTokens();
    if (root.querySelector('[data-settings-tab="connections"]')?.getAttribute("aria-selected") === "true") void reference.load();
  }, 0); });
  if (new URLSearchParams(windowRef.location.search).get("section") === "automation") void loadTokens();
  if (new URLSearchParams(windowRef.location.search).get("section") === "connections") void reference.load();
  if (windowRef.location.origin) say("api-base", `${windowRef.location.origin}/api/v1`);
  on(tokenForm, "submit", async (event) => {
    event.preventDefault(); const button = tokenForm.querySelector('[type="submit"]');
    if (button.disabled || !tokenForm.reportValidity()) return;
    const scopes = [...tokenForm.querySelectorAll('input[name="scopes"]:checked')].map((field) => field.value);
    if (!scopes.length) { say("agent-feedback", "Choose at least one permission."); return; }
    button.disabled = true; say("agent-feedback", "Creating access token…");
    try {
      const value = await request("/api/platform/tokens", { name: tokenForm.elements.name.value.trim(), scopes, expiresInDays: Number(tokenForm.elements.expiresInDays.value) });
      if (disposed) return;
      find("agent-token-value").value = value.token; find("agent-new-token").hidden = false; find("agent-token-value").focus();
      tokenForm.elements.name.value = ""; await loadTokens(true); say("agent-feedback", "Token created. Copy it below before leaving this page.");
    } catch (error) { say("agent-feedback", error.message); }
    finally { if (!disposed) button.disabled = false; }
  });
  on(find("agent-token-copy"), "click", async () => {
    try { await windowRef.navigator.clipboard.writeText(find("agent-token-value").value); say("agent-feedback", "Token copied."); }
    catch { find("agent-token-value").focus(); find("agent-token-value").select(); say("agent-feedback", "Select and copy the token using your keyboard."); }
  });
  on(find("agent-token-dismiss"), "click", () => { find("agent-token-value").value = ""; find("agent-new-token").hidden = true; });
  return { render, dispose() { disposed = true; reference.dispose(); listeners.forEach((remove) => remove()); find("agent-token-value").value = ""; } };
}
