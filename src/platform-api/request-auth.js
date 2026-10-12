// A request-local brand cannot be supplied through headers, JSON or a browser cookie.
const verifiedRequests = new WeakSet();

export function markVerifiedPlatformRequest(req) { verifiedRequests.add(req); }
export function isVerifiedPlatformRequest(req) { return verifiedRequests.has(req); }
