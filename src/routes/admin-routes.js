import { Router } from "express";
import { createAdminController } from "../controllers/admin-controller.js";
import { requireCapability } from "../middleware/require-capability.js";
import { CAPABILITIES } from "../models/access.js";
import { requireCsrf } from "../security/csrf.js";

export function createAdminRoutes({ adminService }) {
  const router = Router();
  const controller = createAdminController({ adminService });
  const requireAdmin = requireCapability(CAPABILITIES.ADMIN);

  router.get("/admin", requireAdmin, controller.show);
  router.post("/api/admin/users/:id/sign-out", requireAdmin, requireCsrf, controller.signOutUser);
  router.post("/api/admin/users/:id/ban", requireAdmin, requireCsrf, controller.banUser);
  router.post("/api/admin/users/:id/unban", requireAdmin, requireCsrf, controller.unbanUser);
  router.post(
    "/api/admin/indicator-requests/:userId/decision",
    requireAdmin,
    requireCsrf,
    controller.decideIndicatorRequest,
  );

  return router;
}
