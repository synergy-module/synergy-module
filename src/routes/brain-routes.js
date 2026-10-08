import { Router } from "express";
import { createPageController } from "../controllers/page-controller.js";
import { createBrainController } from "../controllers/brain-controller.js";
import { CAPABILITIES } from "../models/access.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";
import { requireCapability } from "../middleware/require-capability.js";
import { requireCsrf } from "../security/csrf.js";

export function createBrainRoutes({ brainService, brainKnowledge, brainTools, brainEvaluator, robinhoodService, logger }) {
  const router = Router();
  const access = requireCapability(CAPABILITIES.BASE);
  const controller = createBrainController({ brainService, brainKnowledge, brainTools, brainEvaluator, robinhoodService, logger });
  router.get("/brain", access, createPageController().show(ROUTE_BY_KEY.brain));
  router.get("/api/brain/state", access, controller.state);
  router.post("/api/brain/evals", access, requireCsrf, controller.evaluations);
  router.get("/api/brain/runs", access, controller.runs);
  router.get("/api/brain/runs/:id", access, controller.getRun);
  router.post("/api/brain/runs", access, requireCsrf, controller.start);
  router.post("/api/brain/runs/:id/decision", access, requireCsrf, controller.decision);
  router.post("/api/brain/runs/:id/cancel", access, requireCsrf, controller.cancel);
  router.get("/api/brain/documents", access, controller.documents);
  router.post("/api/brain/documents", access, requireCsrf, controller.addDocument);
  router.delete("/api/brain/documents/:id", access, requireCsrf, controller.removeDocument);
  return router;
}
