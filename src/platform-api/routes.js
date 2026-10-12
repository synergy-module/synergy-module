import { Router } from "express";
import { requireCsrf } from "../security/csrf.js";
import { requireCapability } from "../middleware/require-capability.js";
import { isVerifiedPlatformRequest } from "./request-auth.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";

const sessionOnly = (req, res, next) => isVerifiedPlatformRequest(req)
  ? res.status(403).json({ error: "API_SESSION_REQUIRED", message: "Manage API tokens in your signed-in browser." }) : next();

export function createPlatformApiRoutes({ tokenService, adminService, robinhoodService }) {
  const router = Router(), access = requireCapability("base");
  const handle = work => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return res.json(await work(req, String(req.session.operator.id))); }
    catch (error) {
      const known = error?.code?.startsWith("API_");
      return res.status(known ? error.status : 503).json({ error: known ? error.code : "API_OPERATION_UNAVAILABLE", message: known ? error.message : "This action is temporarily unavailable." });
    }
  };
  router.get("/api/platform/me", access, handle(req => {
    const operator = req.session.operator;
    return { id: operator.id, username: operator.username, displayName: operator.displayName, capabilities: operator.capabilities,
      roles: operator.roles, authMode: operator.authMode, rolesSyncedAt: operator.rolesSyncedAt,
      ...(req.platformIdentity ? { tokenId: req.platformIdentity.tokenId, scopes: req.platformIdentity.scopes } : {}) };
  }));
  router.get("/api/platform/navigation", access, handle(req => ({ pages: Object.values(ROUTE_BY_KEY)
    .filter(route => req.session.operator.capabilities?.includes(route.capability))
    .map(({ key, title, path, description }) => ({ key, title, path, description })),
    apiBase: "/api/v1", operationsUrl: "/api/v1/operations", openapiUrl: "/api/v1/openapi.json" })));
  router.get("/api/platform/tokens", access, sessionOnly, handle((_req, owner) => tokenService.list(owner)));
  router.post("/api/platform/tokens", access, sessionOnly, requireCsrf, async (req, res) => {
    try {
      const { _csrf, ...input } = req.body ?? {};
      res.set("Cache-Control", "no-store");
      return res.status(201).json(await tokenService.issue(req.session.operator, input));
    } catch (error) {
      const known = error?.code?.startsWith("API_");
      return res.status(known ? error.status : 503).json({ error: known ? error.code : "API_OPERATION_UNAVAILABLE", message: known ? error.message : "Could not create an API token." });
    }
  });
  router.delete("/api/platform/tokens/:id", access, sessionOnly, requireCsrf, handle((req, owner) => tokenService.revoke(owner, req.params.id)));
  router.get("/api/platform/audit", access, handle((_req, owner) => tokenService.auditLog(owner)));
  router.post("/api/platform/disconnect", access, requireCsrf, handle((req, owner) => {
    if (!req.platformIdentity?.tokenId) throw Object.assign(new Error("This action requires an API bearer token."), { code: "API_TOKEN_REQUIRED", status: 401 });
    return tokenService.revoke(owner, req.platformIdentity.tokenId);
  }));
  router.get("/api/admin", requireCapability("admin"), handle(() => adminService.getDashboard()));
  // Provider OAuth always requires the account owner's consent. Agents can start
  // authorization and submit the resulting code without borrowing a browser SID.
  router.post("/api/platform/connections/robinhood/begin", access, requireCsrf, handle(async (_req, owner) => {
    const { pending, authorizationUrl } = await robinhoodService.begin(owner);
    await tokenService.saveAuthorization(owner, pending);
    return { authorizationUrl, expiresInSeconds: 600, completeUrl: "/api/v1/platform/connections/robinhood/complete", requiresUserConsent: true };
  }));
  router.post("/api/platform/connections/robinhood/complete", access, requireCsrf, handle(async (req, owner) => {
    if (typeof req.body?.code !== "string" || !req.body.code || req.body.code.length > 4096) throw Object.assign(new Error("Supply the authorization code returned by the account provider."), { code: "API_AUTHORIZATION_INVALID", status: 422 });
    const pending = await tokenService.takeAuthorization(owner, req.body?.state);
    await robinhoodService.complete(owner, pending, req.body.code);
    return { ok: true, connected: true };
  }));
  return router;
}
