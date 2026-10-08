import { randomBytes, timingSafeEqual } from "node:crypto";

const INVALID_CSRF_RESPONSE = Object.freeze({
  error: "CSRF_INVALID",
  message: "REQUEST REJECTED :: SESSION TOKEN INVALID",
});

export function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("base64url");
  }
  return req.session.csrfToken;
}

function matchesToken(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function requireCsrf(req, res, next) {
  const supplied = req.body?._csrf ?? req.get?.("X-CSRF-Token");
  if (matchesToken(req.session?.csrfToken, supplied)) return next();
  return res.status(403).json(INVALID_CSRF_RESPONSE);
}
