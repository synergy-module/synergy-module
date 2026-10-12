import { Router } from "express";
import { requireCapability } from "../middleware/require-capability.js";
import { requireCsrf } from "../security/csrf.js";
import { CAPABILITIES } from "../models/access.js";

export function createPolymarketUsRoutes({ service, logger = console }) {
  const router = Router();
  router.use("/api/polymarket/us", requireCapability(CAPABILITIES.BASE), (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const handle = operation => async (req, res) => {
    try { res.json(await operation(req.session.operator.id, req)); }
    catch (error) {
      const known = error.code?.startsWith("POLY_US_");
      if (!known) logger.error?.("Polymarket US account request failed");
      res.status(known ? error.status : 503).json({ error: known ? error.code : "POLY_US_UNAVAILABLE", message: known ? error.message : "The Polymarket US connection is temporarily unavailable." });
    }
  };
  const empty = req => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) throw Object.assign(new Error("This operation does not accept account fields."), { code: "POLY_US_INPUT", status: 422 });
  };
  router.get("/api/polymarket/us/state", handle(owner => service.state(owner)));
  router.post("/api/polymarket/us/connect", requireCsrf, handle((owner, req) => service.connect(owner, req.body)));
  router.post("/api/polymarket/us/sync", requireCsrf, handle((owner, req) => { empty(req); return service.sync(owner); }));
  router.post("/api/polymarket/us/disconnect", requireCsrf, handle((owner, req) => { empty(req); return service.disconnect(owner); }));
  return router;
}
