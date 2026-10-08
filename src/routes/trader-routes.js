import { Router } from "express";
import { createPageController } from "../controllers/page-controller.js";
import { createTraderController } from "../controllers/trader-controller.js";
import { requireCapability } from "../middleware/require-capability.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";
import { requireCsrf } from "../security/csrf.js";

export function createTraderRoutes({ traderService, logger }) {
  const router = Router();
  const route = ROUTE_BY_KEY.trader;
  const access = requireCapability(route.capability);
  const controller = createTraderController({ traderService, logger });
  router.get(route.path, access, (req, res) => res.redirect("/research"));
  router.get("/api/trader/state", access, controller.state);
  router.post("/api/trader/runs", access, requireCsrf, controller.run);
  return router;
}
