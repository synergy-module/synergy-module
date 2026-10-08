const FRAGMENT_HEADER_PREFIX = "X-Synergy-Module";
// Accept requests from tabs opened before the branding upgrade.
const LEGACY_FRAGMENT_HEADER_PREFIX = "X-Omensite";

export function isFragmentRequest(req) {
  return req.isSynergyModuleFragment === true
    || req.get?.(`${FRAGMENT_HEADER_PREFIX}-Fragment`) === "1"
    || req.get?.(`${LEGACY_FRAGMENT_HEADER_PREFIX}-Fragment`) === "1";
}

export function fragmentRequest(req, res, next) {
  req.isSynergyModuleFragment = isFragmentRequest(req);
  req.fragmentHeaderPrefix = req.get(`${FRAGMENT_HEADER_PREFIX}-Fragment`) !== "1"
    && req.get(`${LEGACY_FRAGMENT_HEADER_PREFIX}-Fragment`) === "1"
    ? LEGACY_FRAGMENT_HEADER_PREFIX : FRAGMENT_HEADER_PREFIX;
  next();
}
