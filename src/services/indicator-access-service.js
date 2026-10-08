const TRADINGVIEW_USERNAME = /^[A-Za-z0-9_-]{3,64}$/;

function domainError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createIndicatorAccessService({ catalog, requestRepository, now = () => new Date().toISOString() }) {
  if (!Array.isArray(catalog)) throw new TypeError("catalog is required");
  if (!requestRepository?.findByUserId || !requestRepository?.upsertPending) {
    throw new TypeError("requestRepository is required");
  }

  return {
    async getMemberView(userId) {
      const request = await requestRepository.findByUserId(userId);
      return {
        catalog,
        request,
        status: request?.status ?? "NOT_REQUESTED",
      };
    },

    requestAll({ operator, tradingViewUsername, consent }) {
      const activeIndicators = catalog.filter((indicator) => indicator.active);
      if (activeIndicators.length === 0) {
        throw domainError("INDICATORS_UNAVAILABLE", "No active indicators are configured");
      }
      if (consent !== true) {
        throw domainError("CONSENT_REQUIRED", "Explicit consent is required");
      }
      const normalizedUsername = typeof tradingViewUsername === "string" ? tradingViewUsername.trim() : "";
      if (!TRADINGVIEW_USERNAME.test(normalizedUsername)) {
        throw domainError("TRADINGVIEW_USERNAME_INVALID", "TradingView username is invalid");
      }

      return requestRepository.upsertPending({
        userId: operator.id,
        discordUsername: operator.username,
        tradingViewUsername: normalizedUsername,
        indicatorIds: activeIndicators.map((indicator) => indicator.id),
        requestedAt: now(),
      });
    },
  };
}
