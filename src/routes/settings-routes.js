import { Router } from "express";
import { CAPABILITIES } from "../models/access.js";
import { requireCapability } from "../middleware/require-capability.js";
import { requireCsrf } from "../security/csrf.js";
import { createSettingsController } from "../controllers/settings-controller.js";
import { createPageController } from "../controllers/page-controller.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";

export function createSettingsRoutes({ settingsService, logger }) {
  const router = Router();
  const access = requireCapability(CAPABILITIES.BASE);
  const controller = createSettingsController({ settingsService, logger });
  router.get("/setup", access, createPageController().show(ROUTE_BY_KEY.setup));
  router.get("/api/settings", access, controller.state);
  router.put("/api/settings/providers/:provider", access, requireCsrf, controller.saveProvider);
  router.delete("/api/settings/providers/:provider", access, requireCsrf, controller.removeProvider);
  router.patch("/api/settings/preferences", access, requireCsrf, controller.preferences);
  router.patch("/api/settings/profile", access, requireCsrf, controller.profile);
  router.get("/api/settings/onboarding", access, controller.onboarding);
  router.patch("/api/settings/onboarding", access, requireCsrf, controller.saveOnboarding);
  router.post("/api/settings/onboarding/complete", access, requireCsrf, controller.completeOnboarding);
  router.put("/api/settings/drafts/:name", access, requireCsrf, controller.saveDraft);
  router.delete("/api/settings/drafts/:name", access, requireCsrf, controller.removeDraft);
  return router;
}
