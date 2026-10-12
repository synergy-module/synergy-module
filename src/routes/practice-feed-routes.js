import { Router } from "express";
import { requireCsrf } from "../security/csrf.js";
import { requireCapability } from "../middleware/require-capability.js";

export function createPracticeFeedRoutes({ service }) {
  const router = Router();
  router.use("/api/practice/feeds", requireCapability("base"), (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const handle = work => async (req, res) => {
    try { return res.json(await work(req.session.operator.id, req)); }
    catch (error) {
      const known = error?.code?.startsWith("PRACTICE_");
      return res.status(known ? error.status ?? 422 : 503).json({ error: known ? error.code : "PRACTICE_FEED_UNAVAILABLE", message: known ? error.message : "Reference data is temporarily unavailable." });
    }
  };
  router.get("/api/practice/feeds", handle(owner => service.state(owner)));
  router.put("/api/practice/feeds/polybolt", requireCsrf, handle((owner, req) => { const { _csrf, ...credentials } = req.body ?? {}; return service.connect(owner, credentials); }));
  router.delete("/api/practice/feeds/polybolt", requireCsrf, handle(owner => service.disconnect(owner)));
  router.post("/api/practice/feeds/polybolt/start", requireCsrf, handle((owner, req) => { const { _csrf, ...input } = req.body ?? {}; return service.start(owner, input); }));
  router.post("/api/practice/feeds/polybolt/stop", requireCsrf, handle(owner => service.stop(owner)));
  router.get("/api/practice/feeds/polybolt/snapshot", handle((owner, req) => {
    if (Object.keys(req.query).some(field => !["symbol", "channel", "limit"].includes(field))
      || req.query.limit !== undefined && (typeof req.query.limit !== "string" || !/^\d{1,4}$/.test(req.query.limit))) {
      throw Object.assign(new Error("Choose a valid sample filter and limit."), { code: "PRACTICE_FEED_INVALID", status: 422 });
    }
    return service.snapshot(owner, { ...req.query, ...(req.query.limit === undefined ? {} : { limit: Number(req.query.limit) }) });
  }));
  return router;
}
