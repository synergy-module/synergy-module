import { Router } from "express";
import { createJournalController } from "../controllers/journal-controller.js";
import { requireCapability } from "../middleware/require-capability.js";
import { CAPABILITIES } from "../models/access.js";
import { requireCsrf } from "../security/csrf.js";
import { createJournalApiController } from "../controllers/journal-api-controller.js";

export function createJournalRoutes({ journalRepository }) {
  const router = Router();
  const journalController = createJournalController();
  const journalApiController = createJournalApiController({ journalRepository });
  const access = requireCapability(CAPABILITIES.JOURNAL);
  router.get("/api/journal", access, journalApiController.list);
  router.get("/api/journal/:id", access, journalApiController.find);
  router.post("/api/journal", access, requireCsrf, journalApiController.create);
  router.get("/journal", access, journalController.index);
  router.get("/journal/new", access, journalController.create);
  router.get("/journal/:id", access, journalController.publicEntry);
  return router;
}
