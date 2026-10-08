import { isFragmentRequest } from "./fragment-request.js";

export function requireAuth(req, res, next) {
  if (req.session?.operator) {
    return next();
  }

  if (isFragmentRequest(req) || req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "AUTH_REQUIRED", loginUrl: "/login" });
  }

  return res.redirect("/login");
}
