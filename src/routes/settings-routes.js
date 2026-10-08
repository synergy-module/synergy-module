import { Router } from "express";
import { CAPABILITIES } from "../models/access.js";
import { requireCapability } from "../middleware/require-capability.js";
import { requireCsrf } from "../security/csrf.js";
import { createSettingsController } from "../controllers/settings-controller.js";

export function createSettingsRoutes({ settingsService, logger }) {
  const router = Router();
  const access = requireCapability(CAPABILITIES.BASE);
  const controller = createSettingsController({ settingsService, logger });
  router.get("/api/settings", access, controller.state);
  router.put("/api/settings/providers/:provider", access, requireCsrf, controller.saveProvider);
  router.delete("/api/settings/providers/:provider", access, requireCsrf, controller.removeProvider);
  router.patch("/api/settings/preferences", access, requireCsrf, controller.preferences);
  router.put("/api/settings/drafts/:name", access, requireCsrf, controller.saveDraft);
  router.delete("/api/settings/drafts/:name", access, requireCsrf, controller.removeDraft);
  return router;
}
