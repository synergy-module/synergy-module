import { Router } from "express";
import { createPageController } from "../controllers/page-controller.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";
import { CAPABILITIES } from "../models/access.js";
import { requireCapability } from "../middleware/require-capability.js";
import { requireCsrf } from "../security/csrf.js";

export function createPolymarketRoutes({ service, logger = console }) {
  const router = Router(), access = requireCapability(CAPABILITIES.BASE);
  const handle = operation => async (req, res) => {
    try { res.json(await operation(req.session.operator.id, req)); }
    catch (error) {
      const known = typeof error.code === "string" && error.code.startsWith("POLY_");
      if (!known) logger.error?.("Polymarket request failed");
      res.status(known ? error.status : 500).json({ error: known ? error.code : "POLY_UNAVAILABLE", message: known ? error.message : "The Polymarket workspace is unavailable. Retry shortly." });
    }
  };
  router.get("/polymarket", access, createPageController().show(ROUTE_BY_KEY.polymarket));
  router.use("/api/polymarket", access, (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/api/polymarket/state", handle(owner => service.state(owner)));
  router.get("/api/polymarket/markets", handle(() => service.markets()));
  router.get("/api/polymarket/markets/:id", handle((owner, req) => service.market(owner, req.params.id)));
  router.get("/api/polymarket/radar", handle(owner => service.radar(owner)));
  router.post("/api/polymarket/research", requireCsrf, handle(async (owner, req) => ({ report: await service.research(owner, req.body) })));
  router.post("/api/polymarket/notes", requireCsrf, handle(async (owner, req) => ({ note: await service.note(owner, req.body) })));
  for (const collection of ["notes", "research"]) router.delete(`/api/polymarket/${collection}/:id`, requireCsrf, handle(async (owner, req) => { await service.remove(owner, collection, req.params.id); return { ok: true }; }));
  router.put("/api/polymarket/watchlist", requireCsrf, handle(async (owner, req) => ({ watchlist: await service.watch(owner, req.body) })));
  router.put("/api/polymarket/radar", requireCsrf, handle(async (owner, req) => ({ addresses: await service.address(owner, req.body) })));
  router.put("/api/polymarket/paper/settings", requireCsrf, handle((owner, req) => service.settings(owner, req.body)));
  router.post("/api/polymarket/paper/start", requireCsrf, handle((owner, req) => service.start(owner, req.body)));
  router.post("/api/polymarket/paper/pause", requireCsrf, handle(owner => service.pause(owner)));
  router.post("/api/polymarket/paper/positions/:id/close", requireCsrf, handle((owner, req) => service.closePosition(owner, req.params.id)));
  return router;
}
