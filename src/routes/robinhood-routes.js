import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { requireCsrf } from "../security/csrf.js";
import { requireCapability } from "../middleware/require-capability.js";
import { CAPABILITIES } from "../models/access.js";

export function createRobinhoodRoutes({ robinhoodService }) {
  const router = Router(), access = requireCapability(CAPABILITIES.BASE);
  const handle = (work) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return await work(req, res, req.session.operator.id); }
    catch (error) {
      const known = typeof error.code === "string" && error.code.startsWith("ROBINHOOD_");
      res.status(known ? error.status ?? 500 : 503).json({ error: known ? error.code : "ROBINHOOD_UNAVAILABLE", message: known ? error.message : "The Robinhood workspace is temporarily unavailable." });
    }
  };
  router.use(["/api/robinhood", "/auth/robinhood"], (req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); next(); }, access);
  router.get("/api/robinhood/state", handle(async (req, res, owner) => res.json(await robinhoodService.state(owner))));
  router.post("/api/robinhood/connect", requireCsrf, handle(async (req, res, owner) => {
    if (req.session.robinhoodOAuth?.createdAt > Date.now() - 30000) return res.status(429).json({ message: "A Robinhood sign-in is already starting. Try again shortly." });
    const { pending, authorizationUrl } = await robinhoodService.begin(owner);
    req.session.robinhoodOAuth = { ...pending, ownerId: owner };
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    res.json({ authorizationUrl });
  }));
  router.get("/auth/robinhood/callback", async (req, res) => {
    const pending = req.session.robinhoodOAuth;
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!pending || typeof pending.state !== "string" || Buffer.byteLength(state) !== Buffer.byteLength(pending.state)
      || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) return res.redirect("/settings?section=connections&robinhood=invalid_state");
    delete req.session.robinhoodOAuth;
    try {
      await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      if (req.query.error) return res.redirect("/settings?section=connections&robinhood=cancelled");
      await robinhoodService.complete(req.session.operator.id, pending, req.query.code);
      return res.redirect("/settings?section=connections&robinhood=connected");
    } catch { return res.redirect("/settings?section=connections&robinhood=connection_failed"); }
  });
  router.post("/api/robinhood/disconnect", requireCsrf, handle(async (req, res, owner) => { await robinhoodService.disconnect(owner); res.json({ ok: true }); }));
  router.post("/api/robinhood/pause", requireCsrf, handle(async (req, res, owner) => { await robinhoodService.pause(owner, req.body?.paused); res.json({ ok: true }); }));
  router.post("/api/robinhood/discover", requireCsrf, handle(async (req, res, owner) => res.json({ tools: await robinhoodService.discover(owner) })));
  router.post("/api/robinhood/read", requireCsrf, handle(async (req, res, owner) => res.json({ snapshot: await robinhoodService.read(owner, req.body?.tool, req.body?.arguments) })));
  router.post("/api/robinhood/actions", requireCsrf, handle(async (req, res, owner) => res.status(201).json({ action: await robinhoodService.propose(owner, {
    tool: req.body?.tool, arguments: req.body?.arguments, reason: req.body?.reason, requestId: req.body?.requestId, source: "operator",
  }) })));
  router.post("/api/robinhood/actions/:id/decision", requireCsrf, handle(async (req, res, owner) => res.json({ action: await robinhoodService.decide(owner, req.params.id, req.body ?? {}) })));
  return router;
}
