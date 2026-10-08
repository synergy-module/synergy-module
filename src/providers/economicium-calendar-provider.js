const DEFAULT_BASE_URL = "https://www.economicium.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

export class MarketNewsProviderError extends Error {
  constructor(message = "Economic calendar provider is unavailable") {
    super(message);
    this.name = "MarketNewsProviderError";
  }
}

export function createEconomiciumCalendarProvider({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const boundedTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? Math.min(requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)
    : DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    async fetchWeek({ from, to }) {
      const url = new URL("/api/calendar", baseUrl);
      const abortController = new AbortController();
      let timeout;

      try {
        timeout = setTimeoutImpl(() => abortController.abort(), boundedTimeoutMs);
        const response = await fetchImpl(url, {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });
        if (!response.ok) throw new MarketNewsProviderError();

        const payload = await response.json();
        if (!Array.isArray(payload?.events)) throw new MarketNewsProviderError();
        return payload.events.filter((event) => event?.date >= from && event.date <= to);
      } catch (error) {
        if (error instanceof MarketNewsProviderError) throw error;
        throw new MarketNewsProviderError();
      } finally {
        if (timeout !== undefined) clearTimeoutImpl(timeout);
      }
    },
  };
}
