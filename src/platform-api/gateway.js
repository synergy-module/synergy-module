import { Router } from "express";
import { createHash } from "node:crypto";
import { markVerifiedPlatformRequest } from "./request-auth.js";
import { createOpenApiDocument, matchesOperation, operationCatalog } from "./operation-catalog.js";

export function createPlatformApiGateway({ router, tokenService, now = () => Date.now(), rateLimit = 120, rateWindowMs = 60_000 }) {
  const gateway = Router();
  const requests = new Map(), invalidRequests = new Map();
  function allow(buckets, key, limit, increment = true) {
    const at = now();
    if (buckets.size >= 10_000) {
      for (const [id, entry] of buckets) if (entry.until <= at) buckets.delete(id);
      if (!buckets.has(key) && buckets.size >= 10_000) return Math.ceil(rateWindowMs / 1000);
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= at) { bucket = { count: 0, until: at + rateWindowMs }; buckets.set(key, bucket); }
    if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.until - at) / 1000));
    if (increment) bucket.count++;
    return 0;
  }
  const limited = (res, seconds) => res.status(429).set("Retry-After", String(seconds)).json({ error: "API_RATE_LIMITED", message: "Too many API requests. Wait before retrying." });
  gateway.use((_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); next(); });
  gateway.get("/openapi.json", (_req, res) => res.json(createOpenApiDocument(router)));
  gateway.get("/operations", (_req, res) => res.json({ version: "v1", operations: operationCatalog(router) }));
  gateway.use(async (req, res) => {
    const addressKey = `ip:${req.ip ?? req.socket?.remoteAddress ?? "unknown"}`;
    const addressWait = allow(requests, addressKey, 300) || allow(invalidRequests, addressKey, 30, false);
    if (addressWait) return limited(res, addressWait);
    const authorization = req.get("Authorization");
    if (typeof authorization !== "string" || authorization.length > 607 || !/^Bearer [^\s]+$/i.test(authorization)) {
      allow(invalidRequests, addressKey, 30);
      return res.status(401).json({ error: "API_TOKEN_REQUIRED", message: "Send Authorization: Bearer <token>. Create a token in Settings → AI access." });
    }
    // Hash the supplied bearer before any database lookup or Discord refresh.
    // The rate limiter never stores plaintext credentials.
    const tokenWait = allow(requests, `token:${createHash("sha256").update(authorization.slice(7)).digest("hex")}`, rateLimit);
    if (tokenWait) return limited(res, tokenWait);
    let identity;
    try { identity = await tokenService.authenticate(authorization.slice(7)); }
    catch (error) {
      allow(invalidRequests, addressKey, 30);
      return res.status(error?.code?.startsWith("API_") ? error.status : 503).json({ error: error?.code?.startsWith("API_") ? error.code : "API_UNAVAILABLE",
        message: error?.code?.startsWith("API_") ? error.message : "Account authorization is temporarily unavailable." });
    }
    const path = `/api/v1${req.path}`;
    const operation = operationCatalog(router).find(item => matchesOperation(item, req.method, path));
    if (!operation) return res.status(404).json({ error: "API_OPERATION_NOT_FOUND", message: "See /api/v1/operations for supported actions." });
    if (operation.access !== "bearer") return res.status(403).json({ error: "API_SESSION_REQUIRED", message: "This action requires an interactive browser session.", ...(operation.alternative ? { alternative: operation.alternative } : {}) });
    const missing = operation.scopes.filter(scope => !identity.token.scopes.includes(scope));
    if (missing.length || !identity.operator.capabilities?.includes(operation.capability)) {
      return res.status(403).json({ error: "API_SCOPE_FORBIDDEN", message: "The token or account does not have permission for this action.", requiredScopes: operation.scopes });
    }
    // The gateway is mounted before express-session. This identity exists only on
    // the current request and can never be saved as, or replace, a cookie session.
    if (req.session) return res.status(500).json({ error: "API_MOUNT_INVALID", message: "The API gateway must be mounted before browser sessions." });
    req.session = { operator: identity.operator };
    req.platformIdentity = { tokenId: identity.token.id, ownerId: identity.operator.id, scopes: identity.token.scopes };
    markVerifiedPlatformRequest(req);
    req.url = `/api${req.url}`;
    res.once("finish", () => {
      tokenService.audit(identity.operator.id, { tokenId: identity.token.id, method: req.method, operation: operation.browserPath, status: res.statusCode }).catch(() => {});
    });
    router(req, res, error => {
      if (res.headersSent) return;
      res.status(error ? 503 : 404).json({ error: error ? "API_OPERATION_UNAVAILABLE" : "API_OPERATION_NOT_FOUND", message: error ? "This action is temporarily unavailable." : "The requested action was not found." });
    });
  });
  return gateway;
}
