const DEMO_INDICATORS = [
  {
    id: "demo-market-structure",
    name: "DEMO :: MARKET STRUCTURE",
    description: "Demonstration catalog record for structure analysis.",
    tradingViewUrl: null,
    version: "demo",
    active: true,
    demo: true,
  },
  {
    id: "demo-liquidity-map",
    name: "DEMO :: LIQUIDITY MAP",
    description: "Demonstration catalog record for liquidity visualization.",
    tradingViewUrl: null,
    version: "demo",
    active: true,
    demo: true,
  },
];

function freezeCatalog(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export function normalizeTradingViewUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const trustedHost = hostname === "tradingview.com" || hostname.endsWith(".tradingview.com");
    if (url.protocol !== "https:" || !trustedHost || url.username || url.password || url.port) return null;
    return url.href;
  } catch {
    return null;
  }
}

function validateConfiguredCatalog(entries) {
  return entries.map((entry) => {
    if (entry.tradingViewUrl == null) return { ...entry, tradingViewUrl: null };
    const tradingViewUrl = normalizeTradingViewUrl(entry.tradingViewUrl);
    if (!tradingViewUrl) {
      throw Object.assign(new TypeError("Indicator TradingView URL must use a trusted HTTPS host"), {
        code: "INDICATOR_TRADINGVIEW_URL_INVALID",
      });
    }
    return { ...entry, tradingViewUrl };
  });
}

export function createIndicatorCatalog({ authMode, configuredIndicators = [] } = {}) {
  return freezeCatalog(authMode === "demo"
    ? DEMO_INDICATORS
    : validateConfiguredCatalog(configuredIndicators));
}
