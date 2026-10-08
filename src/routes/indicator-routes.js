import { Router } from "express";
import { createIndicatorController } from "../controllers/indicator-controller.js";
import { requireCapability } from "../middleware/require-capability.js";
import { CAPABILITIES } from "../models/access.js";
import { requireCsrf } from "../security/csrf.js";

export function createIndicatorRoutes({ indicatorAccessService }) {
  const router = Router();
  const indicatorController = createIndicatorController({ indicatorAccessService });

  router.get(
    "/indicators",
    requireCapability(CAPABILITIES.INDICATORS),
    indicatorController.show,
  );
  router.post(
    "/api/indicator-access/requests",
    requireCapability(CAPABILITIES.INDICATORS),
    requireCsrf,
    indicatorController.requestAll,
  );

  return router;
}
