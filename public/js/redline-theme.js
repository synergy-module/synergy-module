const preferenceKey = "synergy-module-theme";
const legacyPreferenceKey = "omensite-theme";
const themes = new Set(["core", "daylight", "dark", "light", "system"]);

export function applyWorkspaceExperience(documentRef, value) {
  const preferences = value?.preferences ?? {};
  if (preferences.density) documentRef.documentElement.dataset.density = preferences.density;
  if (typeof preferences.reducedMotion === "boolean") documentRef.documentElement.dataset.reducedMotion = String(preferences.reducedMotion);
  if (preferences.timezone) documentRef.documentElement.dataset.timezone = preferences.timezone;
  if (preferences.currency) documentRef.documentElement.dataset.currency = preferences.currency;
  if (preferences.notifications) documentRef.documentElement.dataset.notifications = JSON.stringify(preferences.notifications);
  if (value?.profile?.displayName) for (const name of documentRef.querySelectorAll("[data-display-name]")) name.textContent = value.profile.displayName;
  if (preferences.theme) {
    documentRef.documentElement.dataset.themePreference = preferences.theme;
    const EventType = documentRef.defaultView?.CustomEvent;
    if (EventType) documentRef.dispatchEvent(new EventType("synergy-module:preferences", { detail: preferences }));
  }
}

/** Only the color preference is cached locally; account data stays on the server. */
export function initializeColorTheme({ documentRef = document, windowRef = window, fetchImpl = windowRef.fetch?.bind(windowRef) } = {}) {
  const controls = [...documentRef.querySelectorAll("[data-color-theme]")];
  const ThemeEvent = documentRef.defaultView?.Event ?? windowRef.Event;
  const media = windowRef.matchMedia?.("(prefers-color-scheme: light)");
  let selected = "core";
  let saveQueue = Promise.resolve();
  function apply(theme) {
    selected = themes.has(theme) ? theme : "core";
    documentRef.documentElement.dataset.themePreference = selected;
    documentRef.documentElement.dataset.theme = ["light", "daylight"].includes(selected) || (selected === "system" && media?.matches) ? "daylight" : "core";
    for (const button of controls) {
      const choice = button.dataset.colorTheme;
      button.setAttribute("aria-pressed", String(choice === selected || (choice === "dark" && selected === "core") || (choice === "light" && selected === "daylight")));
    }
    documentRef.dispatchEvent(new ThemeEvent("synergy-module:themechange"));
  }
  let stored;
  try {
    const storage = windowRef.localStorage;
    stored = storage?.getItem(preferenceKey);
    if (stored == null) {
      stored = storage?.getItem(legacyPreferenceKey);
      if (themes.has(stored)) { storage.setItem(preferenceKey, stored); storage.removeItem(legacyPreferenceKey); }
    }
  } catch { /* Color selection works when browser storage is blocked. */ }
  apply(documentRef.documentElement.dataset.themePreference || stored);
  const select = (event) => {
    const theme = event.currentTarget.dataset.colorTheme;
    apply(theme);
    try { windowRef.localStorage?.setItem(preferenceKey, theme); } catch { /* The selected palette still applies. */ }
    const csrf = documentRef.querySelector('meta[name="csrf-token"]')?.content;
    if (csrf && fetchImpl) {
      const normalized = theme === "core" ? "dark" : theme === "daylight" ? "light" : theme;
      saveQueue = saveQueue.then(async () => {
        const response = await fetchImpl("/api/settings/preferences", { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ theme: normalized }) });
        if (!response.ok) throw new Error("Theme preference was not saved to your account.");
      }).catch(() => { for (const button of controls) button.title = "Theme changed on this device. Save it in Settings to sync your account."; });
    }
  };
  const preferencesChanged = (event) => apply(event.detail?.theme);
  const systemChanged = () => { if (selected === "system") apply("system"); };
  controls.forEach((button) => button.addEventListener("click", select));
  documentRef.addEventListener("synergy-module:preferences", preferencesChanged);
  media?.addEventListener?.("change", systemChanged);
  return () => {
    controls.forEach((button) => button.removeEventListener("click", select));
    documentRef.removeEventListener("synergy-module:preferences", preferencesChanged);
    media?.removeEventListener?.("change", systemChanged);
  };
}
