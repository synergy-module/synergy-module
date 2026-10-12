import { Router } from "express";
import { createPageController } from "../controllers/page-controller.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";
import { CAPABILITIES } from "../models/access.js";
import { requireCapability } from "../middleware/require-capability.js";
import { requireCsrf } from "../security/csrf.js";

export function createPracticeRoutes({ service, logger = console }) {
  const router = Router(), access = requireCapability(CAPABILITIES.BASE);
  const handle = (fn, status = 200) => async (req, res) => {
    try { res.status(status).json(await fn(req.session.operator.id, req)); }
    catch (error) {
      const known = /^(PRACTICE_|POLY_)/.test(error.code ?? "");
      if (!known) logger.error?.("Practice request failed");
      res.status(known ? error.status ?? 422 : error.message === "Workspace storage limit reached" ? 413 : 500).json({
        error: known ? error.code : "PRACTICE_UNAVAILABLE", message: known ? error.message : error.message === "Workspace storage limit reached" ? "This practice record is full. Export its results and start a new paper account." : "The practice workspace is unavailable. Retry shortly.",
      });
    }
  };
  router.get("/practice", access, createPageController().show(ROUTE_BY_KEY.practice));
  router.get("/live", access, createPageController().show(ROUTE_BY_KEY.live));
  router.use("/api/practice", access, (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/api/practice", handle(owner => service.state(owner)));
  router.post("/api/practice/books", requireCsrf, handle((owner, req) => service.createBook(owner, req.body), 201));
  router.get("/api/practice/books/:id", handle((owner, req) => service.book(owner, req.params.id)));
  router.delete("/api/practice/books/:id", requireCsrf, handle((owner, req) => service.removeBook(owner, req.params.id)));
  router.post("/api/practice/books/:id/orders", requireCsrf, handle((owner, req) => service.placeOrder(owner, req.params.id, req.body)));
  router.post("/api/practice/books/:id/refresh", requireCsrf, handle((owner, req) => service.refreshBook(owner, req.params.id)));
  router.post("/api/practice/books/:id/start", requireCsrf, handle((owner, req) => service.start(owner, req.params.id, req.body)));
  router.post("/api/practice/books/:id/pause", requireCsrf, handle((owner, req) => service.pause(owner, req.params.id)));
  router.post("/api/practice/books/:id/positions/:positionId/close", requireCsrf, handle((owner, req) => {
    if (Object.keys(req.body ?? {}).some(key => key !== "_csrf")) throw Object.assign(new Error("Close a paper position with an empty request body. The current market price is fetched by the server."), { code: "PRACTICE_INPUT", status: 422 });
    return service.placeOrder(owner, req.params.id, { side: "SELL", positionId: req.params.positionId });
  }));
  router.get("/api/practice/data/:method", handle((_owner, req) => {
    const input = { ...req.query }; for (const name of ["latitude", "longitude", "outcomeIndex", "bucketSeconds", "windowMinutes"]) if (typeof input[name] === "string" && input[name].trim()) input[name] = Number(input[name]);
    return service.publicData(req.params.method, input);
  }));
  router.post("/api/practice/data/:method", requireCsrf, handle((_owner, req) => service.publicData(req.params.method, req.body)));
  router.post("/api/practice/evidence/:method", requireCsrf, handle((_owner, req) => service.evidence(req.params.method, req.body)));
  return router;
}
