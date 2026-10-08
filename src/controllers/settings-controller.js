const ERRORS = Object.freeze({
  SETTINGS_INVALID: [422, "Check the settings fields and try again."],
  SETTINGS_AUTH_REQUIRED: [401, "Sign in to manage your workspace."],
  SETTINGS_ENCRYPTION_UNAVAILABLE: [503, "Configure a stable integration encryption key before saving API credentials."],
  SETTINGS_CREDENTIAL_UNAVAILABLE: [503, "A saved credential could not be read. Restore the integration encryption key or replace the credential."],
});
export function createSettingsController({ settingsService, logger = console }) {
  const handle = (operation) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return res.json(await operation(req, String(req.session.operator.id))); }
    catch (error) {
      const known = Object.hasOwn(ERRORS, error?.code) ? ERRORS[error.code] : null;
      if (!known) logger.error?.("Workspace settings request failed");
      const [status, message] = known ?? [500, "Workspace settings are unavailable. Try again."];
      return res.status(status).json({ error: known ? error.code : "SETTINGS_UNAVAILABLE", message });
    }
  };
  return {
    state: handle((_req, owner) => settingsService.getState(owner)),
    saveProvider: handle((req, owner) => settingsService.saveProvider(owner, req.params.provider, { apiKey: req.body?.apiKey })),
    removeProvider: handle((req, owner) => settingsService.removeProvider(owner, req.params.provider)),
    preferences: handle((req, owner) => { const { _csrf, ...preferences } = req.body ?? {}; return settingsService.savePreferences(owner, preferences); }),
    saveDraft: handle((req, owner) => settingsService.saveDraft(owner, req.params.name, req.body?.fields)),
    removeDraft: handle((req, owner) => settingsService.removeDraft(owner, req.params.name)),
  };
}
