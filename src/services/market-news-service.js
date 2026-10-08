const COUNTRY_MARKETS = new Map([
  ["United States", "USD"],
  ["Euro Area", "EUR"], ["Germany", "EUR"], ["France", "EUR"],
  ["Italy", "EUR"], ["Spain", "EUR"], ["Netherlands", "EUR"],
  ["Belgium", "EUR"], ["Austria", "EUR"], ["Ireland", "EUR"],
  ["Portugal", "EUR"], ["Finland", "EUR"], ["Greece", "EUR"],
  ["United Kingdom", "GBP"],
  ["Japan", "JPY"],
  ["Canada", "CAD"],
  ["Australia", "AUD"],
  ["New Zealand", "NZD"],
  ["Switzerland", "CHF"],
  ["China", "CNY"],
]);

function normalizeEvent(row) {
  const country = String(row.country ?? "");
  const market = COUNTRY_MARKETS.get(country);
  const importance = String(row.impact ?? "").toLowerCase();
  const date = String(row.date ?? "");
  const time = String(row.time ?? "");
  const title = String(row.title ?? "").trim();
  const timestamp = new Date(`${date}T${time}:00Z`);
  const id = [date, time, country, title].join("|");

  if (
    row.type !== "economic" || !market || !["high", "medium"].includes(importance) ||
    !title || Number.isNaN(timestamp.valueOf())
  ) return null;

  return {
    id,
    timestamp: timestamp.toISOString(),
    market,
    country,
    title,
    importance,
    actual: null,
    forecast: null,
    previous: null,
    source: "ECONOMICIUM / OFFICIAL SCHEDULES",
  };
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

export function getCalendarWeekRange(date) {
  const sunday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  const saturday = new Date(sunday);
  saturday.setUTCDate(saturday.getUTCDate() + 6);
  return { from: formatUtcDate(sunday), to: formatUtcDate(saturday) };
}

export function createMarketNewsService({ provider, now = () => new Date(), cacheTtlMs = 86_400_000 }) {
  const cacheByKey = new Map();
  const inFlightByKey = new Map();

  async function load(range, key) {
    const rows = await provider.fetchWeek(range);
    const events = rows.map(normalizeEvent).filter(Boolean)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const result = {
      state: "live",
      events,
      updatedAt: now().toISOString(),
      range,
    };
    cacheByKey.set(key, { savedAt: now().valueOf(), result });
    return result;
  }

  return {
    async getCurrentWeek({ force = false } = {}) {
      const range = getCalendarWeekRange(now());
      const key = `${range.from}:${range.to}`;
      const cache = cacheByKey.get(key);
      const fresh = cache && now().valueOf() - cache.savedAt < cacheTtlMs;
      if (!force && fresh) return cache.result;

      const activeLoad = inFlightByKey.get(key);
      if (activeLoad) return activeLoad;

      const promise = load(range, key).catch((error) => {
        const fallback = cacheByKey.get(key);
        if (fallback) return { ...fallback.result, state: "stale" };
        throw error;
      }).finally(() => {
        if (inFlightByKey.get(key) === promise) inFlightByKey.delete(key);
      });
      inFlightByKey.set(key, promise);
      return promise;
    },
  };
}
