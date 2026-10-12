import { Router } from "express";
import { createPageController } from "../controllers/page-controller.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";
import { CAPABILITIES } from "../models/access.js";
import { requireCapability } from "../middleware/require-capability.js";
import { requireCsrf } from "../security/csrf.js";

export function createRobinhoodBrainRoutes({ service, broker, logger = console, paper = false }) {
  const router = Router(), access = requireCapability(CAPABILITIES.BASE);
  const handle = (operation, status = 200) => async (req, res) => {
    try { res.status(status).json(await operation(req.session.operator.id, req)); }
    catch (error) {
      const known = /^(RH_BRAIN_|TRADER_|ROBINHOOD_)/.test(error.code ?? "");
      if (!known) logger.error?.("Robinhood Brain request failed");
      res.status(known && Number.isInteger(error.status) ? error.status : 500).json({ error: known ? error.code : "RH_BRAIN_UNAVAILABLE", message: known ? error.message : "Robinhood Brain is unavailable. Retry shortly." });
    }
  };
  const base = paper ? "/api/practice/equities" : "/api/robinhood-brain";
  router.get(paper ? "/practice/equities" : "/robinhood-brain", access, createPageController().show(paper
    ? { ...ROUTE_BY_KEY["robinhood-brain"], key: "robinhood-paper", title: "Equity paper trading", path: "/practice/equities" }
    : ROUTE_BY_KEY["robinhood-brain"]));
  router.use(base, access, (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get(`${base}/state`, handle(owner => service.state(owner)));
  router.get(`${base}/catalog`, handle(async owner => ({ tools: (await broker.state(owner)).tools })));
  router.post(`${base}/catalog/sync`, requireCsrf, handle(async owner => ({ tools: await broker.discover(owner) })));
  router.put(`${base}/policy`, requireCsrf, handle((owner, req) => service.configure(owner, req.body)));
  router.post(`${base}/verify`, requireCsrf, handle(owner => service.verify(owner)));
  router.post(`${base}/cycles`, requireCsrf, handle((owner, req) => service.enqueue(owner, req.body), 202));
  router.post(`${base}/start`, requireCsrf, handle((owner, req) => service.start(owner, req.body)));
  router.post(`${base}/pause`, requireCsrf, handle(owner => service.pause(owner)));
  router.post(`${base}/reconcile`, requireCsrf, handle(owner => service.reconcile(owner)));
  router.post(`${base}/notes`, requireCsrf, handle((owner, req) => service.note(owner, req.body)));
  router.delete(`${base}/notes/:id`, requireCsrf, handle((owner, req) => service.removeNote(owner, req.params.id)));
  return router;
}
