# Synergy Module Market News Calendar Implementation Plan

> Source amendment (2026-09-02): the paid Trading Economics adapter described below was subsequently replaced with Economicium's public, keyless JSON calendar at the user's direction. The plan remains as an implementation record; current behavior is documented in the design specification and README.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty Market News screen with a live, full-width, terminal-styled current-week economic calendar containing only medium- and high-impact events.

**Architecture:** A Trading Economics provider adapter performs the licensed external request, and a market-news service normalizes, filters, sorts, and caches provider data. A dedicated MVC controller server-renders the first result and exposes a normalized JSON refresh endpoint; a route-scoped browser controller handles local time, filtering, refreshes, and teardown without interfering with Synergy Module's fragment-navigation glitch transition.

**Tech Stack:** Node.js 24+, Express 5, EJS, native Fetch API, vanilla ES modules, CSS, Node test runner, Supertest, JSDOM

**Spec:** `docs/superpowers/specs/2026-09-02-market-news-calendar-design.md`

## Global Constraints

- Keep package and application version at `v0.1.2`.
- Use the official Trading Economics economic-calendar API; do not scrape Forex Factory, FinancialJuice, X, or another website.
- Read credentials only from `TRADING_ECONOMICS_API_KEY` on the server.
- Never expose credentials, raw provider payloads, provider error bodies, or stack traces to browser code.
- Render only importance `2` (medium/orange) and `3` (high/red).
- Support market filters `USD`, `EUR`, `GBP`, `JPY`, `CAD`, `AUD`, `NZD`, `CHF`, and `CNY`.
- Preserve full-page rendering, fragment rendering, and the existing glitch-transition behavior.
- Keep all calendar content, controls, loading, empty, stale, and error states inside Synergy Module's native terminal design.
- Display event times in the workstation's local timezone.
- Automated tests must use injected fakes and must not require a real API key or network access.
- No database, Discord SSO, journal, alerts, or social-feed changes are in scope.

## File Structure

- Create `src/providers/trading-economics-calendar-provider.js`: credential validation and Trading Economics HTTP boundary.
- Create `src/services/market-news-service.js`: current-week range, normalization, supported-market mapping, sorting, single-flight cache, and stale fallback.
- Create `src/controllers/market-news-controller.js`: page and JSON endpoint behavior.
- Modify `src/routes/page-routes.js`: route Market News through its dedicated controller.
- Modify `src/app.js`: construct and inject the provider/service or accept a test double.
- Modify `views/pages/market-news.ejs`: server-render the calendar shell, controls, events, and terminal states.
- Create `views/partials/market-news-event.ejs`: one accessible, data-addressable event row/card.
- Create `public/js/market-news/market-news-controller.js`: local-time hydration, grouping, filters, refresh, and disposal.
- Modify `public/js/app-shell.js`: mount and dispose the route-specific calendar controller.
- Modify `public/js/page-interactions.js`: remove the obsolete demonstration news-chip behavior.
- Modify `public/css/synergy-module.css`: full-width calendar styling and mobile cards.
- Create `tests/unit/trading-economics-calendar-provider.test.js`: provider boundary tests.
- Create `tests/unit/market-news-service.test.js`: normalization and cache tests.
- Create `tests/unit/market-news-controller.test.js`: browser interaction and lifecycle tests.
- Create `tests/integration/market-news-routes.test.js`: MVC page/API behavior.
- Modify `tests/unit/page-interactions.test.js`: remove the superseded demonstration-chip test.
- Modify `tests/unit/app-shell.test.js`: assert route-controller teardown during fragment navigation.
- Modify `tests/integration/fidelity-markup.test.js`: assert the new calendar geometry hooks.
- Create `.env.example`: safe credential name documentation.
- Modify `README.md`: live calendar setup, behavior, licensing, and v0.1.2 feature description.

---

### Task 1: Trading Economics Provider Boundary

**Files:**
- Create: `src/providers/trading-economics-calendar-provider.js`
- Create: `tests/unit/trading-economics-calendar-provider.test.js`

**Interfaces:**
- Consumes: `apiKey: string | undefined`, `fetchImpl: typeof fetch`, and `baseUrl: string`.
- Produces: `createTradingEconomicsCalendarProvider(options).fetchWeek({ from, to }): Promise<object[]>`.
- Produces: `MarketNewsConfigurationError` for a missing key and `MarketNewsProviderError` for HTTP, network, JSON, or schema failures.

- [ ] **Step 1: Write failing provider tests**

Create tests that prove the key stays server-side, the documented date-range URL is used, and external failures become safe typed errors:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTradingEconomicsCalendarProvider,
  MarketNewsConfigurationError,
  MarketNewsProviderError,
} from "../../src/providers/trading-economics-calendar-provider.js";

test("provider requires a configured API key before making a request", async () => {
  let requested = false;
  const provider = createTradingEconomicsCalendarProvider({
    apiKey: "",
    fetchImpl: async () => {
      requested = true;
      return new Response("[]");
    },
  });

  await assert.rejects(
    provider.fetchWeek({ from: "2026-08-30", to: "2026-09-05" }),
    MarketNewsConfigurationError,
  );
  assert.equal(requested, false);
});

test("provider requests the official date-range endpoint and returns JSON rows", async () => {
  const calls = [];
  const provider = createTradingEconomicsCalendarProvider({
    apiKey: "account:key",
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new Response(JSON.stringify([{ CalendarId: "42" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const rows = await provider.fetchWeek({ from: "2026-08-30", to: "2026-09-05" });

  assert.deepEqual(rows, [{ CalendarId: "42" }]);
  assert.equal(calls[0].url.pathname, "/calendar/country/All/2026-08-30/2026-09-05");
  assert.equal(calls[0].url.searchParams.get("c"), "account:key");
  assert.equal(calls[0].url.searchParams.get("f"), "json");
  assert.equal(calls[0].options.headers.Accept, "application/json");
});

test("provider converts HTTP and malformed-payload failures to a safe error", async () => {
  for (const response of [
    new Response("upstream secret detail", { status: 429 }),
    new Response(JSON.stringify({ message: "not an array" }), { status: 200 }),
  ]) {
    const provider = createTradingEconomicsCalendarProvider({
      apiKey: "account:key",
      fetchImpl: async () => response,
    });
    await assert.rejects(
      provider.fetchWeek({ from: "2026-08-30", to: "2026-09-05" }),
      MarketNewsProviderError,
    );
  }
});
```

- [ ] **Step 2: Run the provider tests and verify failure**

Run: `node --test tests/unit/trading-economics-calendar-provider.test.js`

Expected: FAIL because the provider module does not exist.

- [ ] **Step 3: Implement the provider**

Implement a small adapter with no provider response logging:

```js
const DEFAULT_BASE_URL = "https://api.tradingeconomics.com";

export class MarketNewsConfigurationError extends Error {
  constructor() {
    super("Trading Economics API key is not configured");
    this.name = "MarketNewsConfigurationError";
  }
}

export class MarketNewsProviderError extends Error {
  constructor(message = "Economic calendar provider is unavailable") {
    super(message);
    this.name = "MarketNewsProviderError";
  }
}

export function createTradingEconomicsCalendarProvider({
  apiKey = process.env.TRADING_ECONOMICS_API_KEY,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  return {
    async fetchWeek({ from, to }) {
      if (!apiKey?.trim()) throw new MarketNewsConfigurationError();
      const url = new URL("/calendar/country/All/" + from + "/" + to, baseUrl);
      url.searchParams.set("c", apiKey);
      url.searchParams.set("f", "json");

      try {
        const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new MarketNewsProviderError();
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new MarketNewsProviderError();
        return rows;
      } catch (error) {
        if (error instanceof MarketNewsConfigurationError || error instanceof MarketNewsProviderError) throw error;
        throw new MarketNewsProviderError();
      }
    },
  };
}
```

- [ ] **Step 4: Run the provider tests**

Run: `node --test tests/unit/trading-economics-calendar-provider.test.js`

Expected: all provider tests PASS.

- [ ] **Step 5: Commit the provider**

```powershell
git add src/providers/trading-economics-calendar-provider.js tests/unit/trading-economics-calendar-provider.test.js
git commit -m "feat: add economic calendar provider"
```

---

### Task 2: Calendar Normalization and Shared Cache

**Files:**
- Create: `src/services/market-news-service.js`
- Create: `tests/unit/market-news-service.test.js`

**Interfaces:**
- Consumes: `provider.fetchWeek({ from, to }): Promise<object[]>`, `now(): Date`, and `cacheTtlMs: number`.
- Produces: `createMarketNewsService(options).getCurrentWeek({ force?: boolean }): Promise<CalendarResult>`.
- Produces: `CalendarResult = { state: "live" | "stale", events: MarketEvent[], updatedAt: string, range: { from: string, to: string } }`.
- Produces: `MarketEvent = { id, timestamp, market, country, title, importance, actual, forecast, previous }`, where values are strings or null.
- Produces: `getCalendarWeekRange(date): { from, to }` using Sunday-through-Saturday UTC dates.

- [ ] **Step 1: Write failing normalization and range tests**

Use representative provider rows to lock the application-owned contract:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMarketNewsService,
  getCalendarWeekRange,
} from "../../src/services/market-news-service.js";

test("week range is the containing Sunday through Saturday", () => {
  assert.deepEqual(getCalendarWeekRange(new Date("2026-09-02T12:00:00Z")), {
    from: "2026-08-30",
    to: "2026-09-05",
  });
});

test("service keeps supported medium and high events and normalizes missing values", async () => {
  const provider = {
    async fetchWeek() {
      return [
        { CalendarId: "3", Date: "2026-09-03T12:30:00", Country: "United States", Event: "Non Farm Payrolls", Importance: 3, Actual: "", Forecast: "75K", Previous: "62K" },
        { CalendarId: "2", Date: "2026-09-02T09:00:00", Country: "Euro Area", Event: "CPI", Importance: 2, Actual: "2.1%", Forecast: "2.0%", Previous: "1.9%" },
        { CalendarId: "1", Date: "2026-09-01T08:00:00", Country: "United Kingdom", Event: "Minor Survey", Importance: 1 },
        { CalendarId: "4", Date: "2026-09-04T08:00:00", Country: "Brazil", Event: "Unsupported Market", Importance: 3 },
      ];
    },
  };
  const service = createMarketNewsService({
    provider,
    now: () => new Date("2026-09-02T12:00:00Z"),
  });

  const result = await service.getCurrentWeek();

  assert.equal(result.state, "live");
  assert.deepEqual(result.events.map((event) => [event.id, event.market, event.importance]), [
    ["2", "EUR", "medium"],
    ["3", "USD", "high"],
  ]);
  assert.equal(result.events[0].timestamp, "2026-09-02T09:00:00.000Z");
  assert.equal(result.events[1].actual, null);
});
```

- [ ] **Step 2: Run the service tests and verify failure**

Run: `node --test tests/unit/market-news-service.test.js`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement range calculation, market mapping, and normalization**

Define an explicit market map. Include `Euro Area`, Germany, France, Italy, Spain, Netherlands, Belgium, Austria, Ireland, Portugal, Finland, and Greece as EUR; United States as USD; United Kingdom as GBP; Japan as JPY; Canada as CAD; Australia as AUD; New Zealand as NZD; Switzerland as CHF; and China as CNY.

```js
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

function nullableText(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value);
}

function normalizeEvent(row) {
  const market = COUNTRY_MARKETS.get(String(row.Country ?? ""));
  const importance = Number(row.Importance);
  const id = nullableText(row.CalendarId);
  const providerTime = String(row.Date ?? "");
  const timestamp = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(providerTime) ? providerTime : providerTime + "Z");
  if (!id || !market || ![2, 3].includes(importance) || Number.isNaN(timestamp.valueOf())) return null;
  return {
    id,
    timestamp: timestamp.toISOString(),
    market,
    country: String(row.Country),
    title: String(row.Event || row.Category || "UNNAMED EVENT"),
    importance: importance === 3 ? "high" : "medium",
    actual: nullableText(row.Actual),
    forecast: nullableText(row.Forecast),
    previous: nullableText(row.Previous),
  };
}
```

Use UTC date arithmetic for the API range, sort by `timestamp`, and omit null normalization results.

- [ ] **Step 4: Add failing cache, force-refresh, and stale-fallback tests**

```js
test("service shares fresh results and force refresh bypasses the cache", async () => {
  let calls = 0;
  const provider = { fetchWeek: async () => [{ CalendarId: String(++calls), Date: "2026-09-02T12:00:00", Country: "Japan", Event: "BoJ Statement", Importance: 3 }] };
  const service = createMarketNewsService({ provider, now: () => new Date("2026-09-02T12:00:00Z") });

  const first = await service.getCurrentWeek();
  const cached = await service.getCurrentWeek();
  const refreshed = await service.getCurrentWeek({ force: true });

  assert.equal(first.events[0].id, "1");
  assert.equal(cached.events[0].id, "1");
  assert.equal(refreshed.events[0].id, "2");
  assert.equal(calls, 2);
});

test("service returns the last successful week as stale when revalidation fails", async () => {
  let fail = false;
  const provider = {
    async fetchWeek() {
      if (fail) throw new Error("offline");
      return [{ CalendarId: "9", Date: "2026-09-02T12:00:00", Country: "Canada", Event: "Rate Decision", Importance: 3 }];
    },
  };
  const service = createMarketNewsService({ provider, now: () => new Date("2026-09-02T12:00:00Z"), cacheTtlMs: 0 });
  await service.getCurrentWeek();
  fail = true;

  const result = await service.getCurrentWeek();

  assert.equal(result.state, "stale");
  assert.equal(result.events[0].id, "9");
});
```

Also test that simultaneous calls share one in-flight provider promise and that a new week does not reuse the prior week's cached result.

- [ ] **Step 5: Implement single-flight caching and stale fallback**

Use one cache entry keyed by `from + ":" + to`, capture `updatedAt` only after a successful fetch, and clear the in-flight promise in `finally`:

```js
export function createMarketNewsService({ provider, now = () => new Date(), cacheTtlMs = 60_000 }) {
  let cache = null;
  let inFlight = null;

  async function load(range) {
    const rows = await provider.fetchWeek(range);
    const events = rows.map(normalizeEvent).filter(Boolean)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const result = {
      state: "live",
      events,
      updatedAt: now().toISOString(),
      range,
    };
    cache = { key: range.from + ":" + range.to, savedAt: now().valueOf(), result };
    return result;
  }

  return {
    async getCurrentWeek({ force = false } = {}) {
      const range = getCalendarWeekRange(now());
      const key = range.from + ":" + range.to;
      const fresh = cache?.key === key && now().valueOf() - cache.savedAt < cacheTtlMs;
      if (!force && fresh) return cache.result;
      if (!force && inFlight?.key === key) return inFlight.promise;

      const promise = load(range).catch((error) => {
        if (cache?.key === key) return { ...cache.result, state: "stale" };
        throw error;
      }).finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
      inFlight = { key, promise };
      return promise;
    },
  };
}
```

- [ ] **Step 6: Run the service tests**

Run: `node --test tests/unit/market-news-service.test.js`

Expected: all range, normalization, mapping, sorting, cache, single-flight, and stale-fallback tests PASS.

- [ ] **Step 7: Commit the market-news service**

```powershell
git add src/services/market-news-service.js tests/unit/market-news-service.test.js
git commit -m "feat: normalize and cache market news"
```

---

### Task 3: Dedicated MVC Page and Refresh Endpoint

**Files:**
- Create: `src/controllers/market-news-controller.js`
- Modify: `src/routes/page-routes.js`
- Modify: `src/app.js`
- Create: `tests/integration/market-news-routes.test.js`
- Modify: `tests/integration/page-routes.test.js`

**Interfaces:**
- Consumes: `marketNewsService.getCurrentWeek({ force }): Promise<CalendarResult>`.
- Produces: authenticated `GET /market-news` full documents and fragments with `page.data.calendar`.
- Produces: authenticated `GET /api/market-news/events`, returning `{ ok: true, calendar: CalendarResult }` or status 503 with `{ ok: false, calendar: { state: "offline", events: [], updatedAt: null, range: null } }`.
- Preserves: `X-Synergy-Module-Path`, `X-Synergy-Module-Title`, and `X-Synergy-Module-Key` response headers through `renderPage`.

- [ ] **Step 1: Write failing route and endpoint integration tests**

Inject a service double through `createApp`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../../src/app.js";

const liveCalendar = {
  state: "live",
  events: [{
    id: "42",
    timestamp: "2026-09-03T12:30:00.000Z",
    market: "USD",
    country: "United States",
    title: "Non Farm Payrolls",
    importance: "high",
    actual: null,
    forecast: "75K",
    previous: "62K",
  }],
  updatedAt: "2026-09-02T12:00:00.000Z",
  range: { from: "2026-08-30", to: "2026-09-05" },
};

async function authenticatedAgent(marketNewsService) {
  const agent = request.agent(createApp({ sessionSecret: "test-secret", marketNewsService, logger: { error() {} } }));
  await agent.post("/auth/login").send({ username: "operator", passkey: "preview" }).expect(200);
  return agent;
}

test("market news renders provider data in full and fragment responses", async () => {
  const service = { getCurrentWeek: async () => liveCalendar };
  const agent = await authenticatedAgent(service);

  await agent.get("/market-news").expect(200).expect(/data-app-shell/).expect(/Non Farm Payrolls/);
  await agent.get("/market-news").set("X-Synergy-Module-Fragment", "1").expect(200)
    .expect(/data-market-news/).expect((response) => assert.doesNotMatch(response.text, /data-app-shell/));
});

test("refresh endpoint returns normalized data and honors a forced refresh", async () => {
  const calls = [];
  const service = { getCurrentWeek: async (options) => { calls.push(options); return liveCalendar; } };
  const agent = await authenticatedAgent(service);

  const response = await agent.get("/api/market-news/events?refresh=1").expect(200);

  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.calendar, liveCalendar);
  assert.deepEqual(calls, [{ force: true }]);
});

test("page preserves the terminal shell while a first load failure makes the API unavailable", async () => {
  const service = { getCurrentWeek: async () => { throw new Error("provider secret body"); } };
  const agent = await authenticatedAgent(service);

  await agent.get("/market-news").expect(200).expect(/CALENDAR DATA LINK OFFLINE/).expect(/data-market-news/);
  const response = await agent.get("/api/market-news/events").expect(503);
  assert.deepEqual(response.body, {
    ok: false,
    calendar: { state: "offline", events: [], updatedAt: null, range: null },
  });
  assert.doesNotMatch(JSON.stringify(response.body), /provider secret body/);
});
```

Add an unauthenticated assertion that `/api/market-news/events` returns 401 under the existing `requireAuth` behavior.

- [ ] **Step 2: Run the integration test and verify failure**

Run: `node --test tests/integration/market-news-routes.test.js`

Expected: FAIL because `createApp` cannot inject a market-news service and no API endpoint exists.

- [ ] **Step 3: Implement the dedicated controller**

Use a single safe offline shape in both page and API paths:

```js
import { buildPageViewModel } from "../models/view-models.js";
import { renderPage } from "./page-controller.js";

const OFFLINE_CALENDAR = Object.freeze({
  state: "offline",
  events: [],
  updatedAt: null,
  range: null,
});

export function createMarketNewsController({ marketNewsService, logger = console }) {
  return {
    show(route) {
      return async (req, res) => {
        let calendar;
        try {
          calendar = await marketNewsService.getCurrentWeek();
        } catch (error) {
          logger.error?.(error);
          calendar = OFFLINE_CALENDAR;
        }
        return renderPage(req, res, buildPageViewModel(route, {
          operator: req.session.operator,
          data: { calendar },
        }));
      };
    },
    async events(req, res) {
      try {
        const calendar = await marketNewsService.getCurrentWeek({ force: req.query.refresh === "1" });
        return res.json({ ok: true, calendar });
      } catch (error) {
        logger.error?.(error);
        return res.status(503).json({ ok: false, calendar: OFFLINE_CALENDAR });
      }
    },
  };
}
```

- [ ] **Step 4: Wire dependency construction and routes**

In `createApp`, add a default service built from `createTradingEconomicsCalendarProvider()`, pass it and `logger` to `createPageRoutes`, and preserve the existing injection pattern:

```js
marketNewsService = createMarketNewsService({
  provider: createTradingEconomicsCalendarProvider(),
}),
```

In `createPageRoutes({ marketNewsService, logger })`, keep the generic loop for `home`, `indicators`, `alerts-ict`, and `alerts-sr`; then register:

```js
const marketNews = createMarketNewsController({ marketNewsService, logger });
router.get(ROUTE_BY_KEY["market-news"].path, marketNews.show(ROUTE_BY_KEY["market-news"]));
router.get("/api/market-news/events", marketNews.events);
```

Because `createPageRoutes` remains mounted after `requireAuth`, both routes remain protected.

- [ ] **Step 5: Update the generic route test**

Give `createApp` a deterministic live service in tests that iterate through every protected route. Keep the current full-document, fragment, metadata, and glitch-navigation assertions unchanged.

- [ ] **Step 6: Run controller and existing route tests**

Run: `node --test tests/integration/market-news-routes.test.js tests/integration/page-routes.test.js tests/integration/error-routes.test.js`

Expected: all selected integration tests PASS with no network calls.

- [ ] **Step 7: Commit the MVC boundary**

```powershell
git add src/app.js src/controllers/market-news-controller.js src/routes/page-routes.js tests/integration/market-news-routes.test.js tests/integration/page-routes.test.js
git commit -m "feat: add market news MVC routes"
```

---

### Task 4: Server-Rendered Terminal Calendar

**Files:**
- Modify: `views/pages/market-news.ejs`
- Create: `views/partials/market-news-event.ejs`
- Modify: `public/css/synergy-module.css`
- Modify: `tests/integration/fidelity-markup.test.js`
- Modify: `tests/integration/market-news-routes.test.js`

**Interfaces:**
- Consumes: `page.data.calendar: CalendarResult | OfflineCalendar`.
- Produces: one `[data-market-news]` route containing `[data-calendar-status]`, `[data-calendar-count]`, `[data-calendar-events]`, event rows, impact controls, market controls, refresh control, and terminal-state messages.
- Produces: each event row with `data-event-id`, `data-event-time`, `data-market`, and `data-impact` hooks for progressive enhancement.

- [ ] **Step 1: Expand failing integration assertions for terminal markup**

Add assertions to the live route test:

```js
const response = await agent.get("/market-news").expect(200);
assert.match(response.text, /data-market-news/);
assert.match(response.text, /data-calendar-impact="high"/);
assert.match(response.text, /data-calendar-market="usd"/);
assert.match(response.text, /data-calendar-refresh/);
assert.match(response.text, /data-event-id="42"/);
assert.match(response.text, /data-impact="high"/);
assert.match(response.text, />HIGH</);
assert.match(response.text, />Non Farm Payrolls</);
assert.match(response.text, />75K</);
assert.doesNotMatch(response.text, /iframe|financialjuice|twitter-timeline|x\\.com/i);
```

Update the fidelity test to replace the old `class="chips"` and `class="empty"` expectations with `market-calendar`, `calendar-toolbar`, `calendar-event`, and `calendar-state`. Inject a one-event service double so the test never reaches the network.

- [ ] **Step 2: Run the market-news rendering tests and verify failure**

Run: `node --test tests/integration/market-news-routes.test.js tests/integration/fidelity-markup.test.js`

Expected: FAIL because the page still contains only the demonstration chips and empty state.

- [ ] **Step 3: Build the accessible EJS calendar shell**

Replace the empty-state screen with a full-width section using this structure:

```ejs
<% const calendar = page.data.calendar; %>
<section class="route market-news" data-route-view data-route-key="<%= page.route.key %>" data-market-news data-calendar-state="<%= calendar.state %>">
  <%- include("../partials/route-head", { page }) %>

  <section class="panel market-calendar" aria-labelledby="market-calendar-title">
    <header class="calendar-console-head">
      <div>
        <p class="panel-kicker" id="market-calendar-title">&gt; ECONOMIC_CALENDAR.EXE</p>
        <p class="calendar-range">WEEK :: <%= calendar.range ? calendar.range.from + " / " + calendar.range.to : "UNAVAILABLE" %> :: TIMES LOCAL</p>
      </div>
      <button class="terminal-button" type="button" data-calendar-refresh>[ REFRESH FEED ]</button>
    </header>

    <div class="calendar-status" role="status" aria-live="polite" data-calendar-status>
      <span>LINK :: <%= calendar.state.toUpperCase() %></span>
      <span>VISIBLE :: <strong data-calendar-count><%= calendar.events.length %></strong></span>
      <span>UPDATED :: <time data-calendar-updated datetime="<%= calendar.updatedAt || "" %>"><%= calendar.updatedAt || "--" %></time></span>
    </div>

    <div class="calendar-toolbar" aria-label="Calendar filters">
      <fieldset class="calendar-filter-group">
        <legend>IMPACT</legend>
        <% for (const impact of ["all", "high", "medium"]) { %>
          <button class="chip <%= impact === "all" ? "active" : "" %>" type="button"
            data-calendar-impact="<%= impact %>" aria-pressed="<%= impact === "all" %>"><%= impact.toUpperCase() %></button>
        <% } %>
      </fieldset>
      <fieldset class="calendar-filter-group">
        <legend>MARKET</legend>
        <% for (const market of ["ALL", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "NZD", "CHF", "CNY"]) { %>
          <button class="chip <%= market === "ALL" ? "active" : "" %>" type="button"
            data-calendar-market="<%= market.toLowerCase() %>" aria-pressed="<%= market === "ALL" %>"><%= market %></button>
        <% } %>
      </fieldset>
    </div>

    <div class="calendar-column-head" aria-hidden="true">
      <span>TIME</span><span>IMPACT</span><span>MARKET</span><span>EVENT</span>
      <span>ACTUAL</span><span>FORECAST</span><span>PREVIOUS</span>
    </div>
    <div class="calendar-events" data-calendar-events>
      <% for (const event of calendar.events) { %>
        <%- include("../partials/market-news-event", { event }) %>
      <% } %>
    </div>

    <div class="calendar-state" data-calendar-empty <%= calendar.events.length || calendar.state === "offline" ? "hidden" : "" %>>
      [ NO HIGH / MEDIUM IMPACT EVENTS THIS WEEK ]
    </div>
    <div class="calendar-state" data-calendar-filter-empty hidden>[ NO EVENTS MATCH ACTIVE FILTERS ]</div>
    <div class="calendar-state calendar-state-error" data-calendar-offline <%= calendar.state === "offline" ? "" : "hidden" %>>
      [ CALENDAR DATA LINK OFFLINE ]
    </div>
  </section>
</section>
```

Use the existing page description and route heading unchanged so fragment metadata and navigation remain compatible.

- [ ] **Step 4: Create the event partial**

Render every label as text, retain `--` for absent values, and provide both color and text importance:

```ejs
<article class="calendar-event calendar-event-<%= event.importance %>"
  data-calendar-event data-event-id="<%= event.id %>"
  data-timestamp="<%= event.timestamp %>"
  data-market="<%= event.market.toLowerCase() %>"
  data-impact="<%= event.importance %>">
  <time class="calendar-event-time" datetime="<%= event.timestamp %>" data-event-time><%= event.timestamp.slice(11, 16) %>Z</time>
  <span class="calendar-impact" data-field="IMPACT"><span aria-hidden="true">●</span> <%= event.importance.toUpperCase() %></span>
  <span class="calendar-market" data-field="MARKET"><%= event.market %></span>
  <span class="calendar-event-title" data-field="EVENT"><%= event.title %></span>
  <span class="calendar-value" data-field="ACTUAL"><%= event.actual ?? "--" %></span>
  <span class="calendar-value" data-field="FORECAST"><%= event.forecast ?? "--" %></span>
  <span class="calendar-value" data-field="PREVIOUS"><%= event.previous ?? "--" %></span>
</article>
```

EJS's escaped output remains mandatory for every provider-derived value.

- [ ] **Step 5: Add terminal-first calendar CSS**

Use existing color/type tokens and add focused selectors:

```css
.market-calendar { padding: 0; overflow: hidden; }
.calendar-console-head,
.calendar-status,
.calendar-toolbar { padding: 14px 16px; border-bottom: 1px solid var(--c-border-soft); }
.calendar-console-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
.calendar-console-head .panel-kicker { margin: 0; }
.calendar-range, .calendar-status { font-size: 10px; letter-spacing: 0.08em; color: var(--c-text-mute); }
.calendar-status { display: flex; flex-wrap: wrap; gap: 8px 24px; background: var(--c-panel-alt); }
.calendar-filter-group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; padding: 0; border: 0; }
.calendar-filter-group + .calendar-filter-group { margin-top: 12px; }
.calendar-filter-group legend { float: left; width: 72px; color: var(--c-green); font-size: 10px; letter-spacing: 0.1em; }
.terminal-button { cursor: pointer; padding: 7px 12px; color: var(--c-green); background: transparent; border: 1px solid var(--c-green); }
.terminal-button:disabled { cursor: wait; color: var(--c-text-faint); border-color: var(--c-border); }
.calendar-column-head,
.calendar-event {
  display: grid;
  grid-template-columns: 72px 92px 68px minmax(240px, 1fr) repeat(3, minmax(80px, 0.45fr));
  gap: 12px;
  align-items: center;
}
.calendar-column-head { padding: 9px 16px; color: var(--c-text-faint); font-size: 9px; letter-spacing: 0.1em; border-bottom: 1px solid var(--c-border-soft); }
.calendar-day-label { padding: 9px 16px; color: var(--c-green); background: var(--c-bg-deep); border-bottom: 1px solid var(--c-border-soft); font-size: 10px; letter-spacing: 0.12em; }
.calendar-event { padding: 12px 16px; border-bottom: 1px solid var(--c-border-faint); font-size: 11px; }
.calendar-event:last-child { border-bottom: 0; }
.calendar-event-high { box-shadow: inset 3px 0 var(--c-red); }
.calendar-event-medium { box-shadow: inset 3px 0 var(--c-amber); }
.calendar-event-high .calendar-impact { color: var(--c-red); }
.calendar-event-medium .calendar-impact { color: var(--c-amber); }
.calendar-event-title { color: var(--c-text); }
.calendar-event-time, .calendar-market, .calendar-value { color: var(--c-text-mid); }
.calendar-state { margin: 16px; padding: 34px 20px; border: 1px dashed var(--c-border); color: var(--c-text-faint); text-align: center; font-size: 11px; }
.calendar-state-error { color: var(--c-red); border-color: var(--c-red); }
```

At `max-width: 760px`, hide `.calendar-column-head`, turn each row into a two-column card, make the event title span both columns, and show `data-field` labels with `::before { content: attr(data-field) " :: "; }`. Preserve high/red and medium/orange left borders.

- [ ] **Step 6: Run rendering and fidelity tests**

Run: `node --test tests/integration/market-news-routes.test.js tests/integration/fidelity-markup.test.js`

Expected: both suites PASS; the response contains native terminal markup and no third-party embed.

- [ ] **Step 7: Commit the terminal view**

```powershell
git add views/pages/market-news.ejs views/partials/market-news-event.ejs public/css/synergy-module.css tests/integration/market-news-routes.test.js tests/integration/fidelity-markup.test.js
git commit -m "feat: render terminal market calendar"
```

---

### Task 5: Local Time, Combined Filters, and Live Refresh

**Files:**
- Create: `public/js/market-news/market-news-controller.js`
- Modify: `public/js/app-shell.js`
- Modify: `public/js/page-interactions.js`
- Create: `tests/unit/market-news-controller.test.js`
- Modify: `tests/unit/page-interactions.test.js`
- Modify: `tests/unit/app-shell.test.js`

**Interfaces:**
- Consumes: server-rendered `[data-market-news]` markup and `GET /api/market-news/events`.
- Produces: `initializeMarketNewsPage(root, { fetchImpl, windowRef, refreshIntervalMs }): { dispose(): void }`.
- Produces: local event times/day headings, combined impact/market filtering, visible count, 60-second automatic refresh, forced manual refresh, and stale/offline status.
- Lifecycle: one controller per route root; `dispose()` aborts active refresh work, clears the interval, and removes listeners.

- [ ] **Step 1: Write failing filter and local-time tests**

Build a JSDOM fixture with high USD, medium EUR, and high EUR rows. Lock both filters to an AND relationship:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initializeMarketNewsPage } from "../../public/js/market-news/market-news-controller.js";

function calendarFixture() {
  const dom = new JSDOM(`
    <section data-market-news data-calendar-state="live">
      <button data-calendar-impact="all" aria-pressed="true"></button>
      <button data-calendar-impact="high" aria-pressed="false"></button>
      <button data-calendar-impact="medium" aria-pressed="false"></button>
      <button data-calendar-market="all" aria-pressed="true"></button>
      <button data-calendar-market="usd" aria-pressed="false"></button>
      <button data-calendar-market="eur" aria-pressed="false"></button>
      <button data-calendar-refresh></button>
      <span data-calendar-count>3</span>
      <span data-calendar-status></span>
      <time data-calendar-updated></time>
      <div data-calendar-events>
        <article data-calendar-event data-event-id="1" data-timestamp="2026-09-02T12:00:00.000Z" data-market="usd" data-impact="high"><time data-event-time></time></article>
        <article data-calendar-event data-event-id="2" data-timestamp="2026-09-02T13:00:00.000Z" data-market="eur" data-impact="medium"><time data-event-time></time></article>
        <article data-calendar-event data-event-id="3" data-timestamp="2026-09-03T14:00:00.000Z" data-market="eur" data-impact="high"><time data-event-time></time></article>
      </div>
      <div data-calendar-empty hidden></div>
      <div data-calendar-filter-empty hidden></div>
      <div data-calendar-offline hidden></div>
    </section>
  `, { url: "http://localhost/market-news" });
  return { dom, root: dom.window.document.querySelector("[data-market-news]") };
}

test("impact and market filters combine and update the visible count", () => {
  const { dom, root } = calendarFixture();
  const instance = initializeMarketNewsPage(root, {
    windowRef: dom.window,
    fetchImpl: async () => new Response(),
    refreshIntervalMs: 0,
  });

  root.querySelector('[data-calendar-impact="high"]').click();
  root.querySelector('[data-calendar-market="eur"]').click();

  const visible = [...root.querySelectorAll("[data-calendar-event]")]
    .filter((row) => !row.hidden).map((row) => row.dataset.eventId);
  assert.deepEqual(visible, ["3"]);
  assert.equal(root.querySelector("[data-calendar-count]").textContent, "1");
  assert.equal(root.querySelector('[data-calendar-impact="high"]').getAttribute("aria-pressed"), "true");
  assert.equal(root.querySelector('[data-calendar-market="eur"]').getAttribute("aria-pressed"), "true");
  instance.dispose();
});

test("timestamps and day headers are formatted through the workstation timezone", () => {
  const { dom, root } = calendarFixture();
  const instance = initializeMarketNewsPage(root, {
    windowRef: dom.window,
    fetchImpl: async () => new Response(),
    refreshIntervalMs: 0,
  });

  assert.match(root.querySelector("[data-event-time]").textContent, /\\d{1,2}:\\d{2}/);
  assert.ok(root.querySelectorAll("[data-calendar-day]").length >= 2);
  instance.dispose();
});
```

- [ ] **Step 2: Run the browser-controller tests and verify failure**

Run: `node --test tests/unit/market-news-controller.test.js`

Expected: FAIL because the route-specific browser controller does not exist.

- [ ] **Step 3: Implement safe event rendering and local grouping**

Create DOM nodes with `textContent`, never `innerHTML`, for API-supplied values:

```js
function displayValue(value) {
  return value === null || value === undefined || value === "" ? "--" : String(value);
}

function createEventRow(documentRef, event) {
  const row = documentRef.createElement("article");
  row.className = "calendar-event calendar-event-" + event.importance;
  row.dataset.calendarEvent = "";
  row.dataset.eventId = event.id;
  row.dataset.timestamp = event.timestamp;
  row.dataset.market = event.market.toLowerCase();
  row.dataset.impact = event.importance;

  const fields = [
    ["time", "", "calendar-event-time"],
    ["span", event.importance.toUpperCase(), "calendar-impact", "IMPACT"],
    ["span", event.market, "calendar-market", "MARKET"],
    ["span", event.title, "calendar-event-title", "EVENT"],
    ["span", displayValue(event.actual), "calendar-value", "ACTUAL"],
    ["span", displayValue(event.forecast), "calendar-value", "FORECAST"],
    ["span", displayValue(event.previous), "calendar-value", "PREVIOUS"],
  ];
  for (const [tag, text, className, label] of fields) {
    const node = documentRef.createElement(tag);
    node.className = className;
    node.textContent = text;
    if (label) node.dataset.field = label;
    if (tag === "time") {
      node.dataset.eventTime = "";
      node.dateTime = event.timestamp;
    }
    row.append(node);
  }
  return row;
}
```

For every row, parse `data-timestamp`, set `[data-event-time]` with `Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })`, and regroup sorted rows into `[data-calendar-day]` sections labeled with `Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "2-digit" })`. Invalid timestamps render as `--:--` under `DATE UNKNOWN`.

- [ ] **Step 4: Implement combined filter state**

Track `impact = "all"` and `market = "all"`. Event delegation updates only the selected filter group, sets `active` and `aria-pressed`, then evaluates:

```js
const impactMatch = filters.impact === "all" || row.dataset.impact === filters.impact;
const marketMatch = filters.market === "all" || row.dataset.market === filters.market;
row.hidden = !(impactMatch && marketMatch);
```

Hide day sections with no visible rows, update `[data-calendar-count]`, show `[data-calendar-filter-empty]` only when events exist but none match, and keep the offline/no-events states mutually exclusive.

- [ ] **Step 5: Add failing refresh and disposal tests**

```js
test("manual refresh requests fresh data and renders it as text", async () => {
  const { dom, root } = calendarFixture();
  const calls = [];
  const instance = initializeMarketNewsPage(root, {
    windowRef: dom.window,
    refreshIntervalMs: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        ok: true,
        calendar: {
          state: "live",
          events: [{ id: "99", timestamp: "2026-09-04T15:00:00.000Z", market: "USD", country: "United States", title: "<img src=x onerror=alert(1)>", importance: "high", actual: "4.2%", forecast: "4.1%", previous: "4.0%" }],
          updatedAt: "2026-09-02T12:01:00.000Z",
          range: { from: "2026-08-30", to: "2026-09-05" },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  root.querySelector("[data-calendar-refresh]").click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(calls[0], "/api/market-news/events?refresh=1");
  assert.equal(root.querySelector("[data-calendar-event]").textContent.includes("<img"), true);
  assert.equal(root.querySelector("img"), null);
  instance.dispose();
});

test("dispose clears polling and aborts an active refresh", async () => {
  const { dom, root } = calendarFixture();
  const signals = [];
  const instance = initializeMarketNewsPage(root, {
    windowRef: dom.window,
    refreshIntervalMs: 10,
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    },
  });
  root.querySelector("[data-calendar-refresh]").click();
  instance.dispose();
  assert.equal(signals[0].aborted, true);
});
```

Also test that a failed refresh retains existing rows, sets a degraded/offline terminal status, re-enables the button, and never permits overlapping refresh requests.

- [ ] **Step 6: Implement refresh and lifecycle behavior**

Use `/api/market-news/events` for scheduled 60-second refreshes and `/api/market-news/events?refresh=1` for the manual button. Set `aria-busy="true"`, disable the button, and announce `SYNCING CALENDAR...` during a request. On success, replace rows, regroup, reapply filters, and render `LIVE` or `STALE DATA`. On failure, retain existing rows and render `DATA LINK DEGRADED :: RETAINING LAST BUFFER`; if there are no rows, reveal `[ CALENDAR DATA LINK OFFLINE ]`.

Use an `AbortController`, a `refreshing` guard, and an optional interval:

```js
const instances = new WeakMap();

export function initializeMarketNewsPage(root, {
  fetchImpl = root.ownerDocument.defaultView.fetch.bind(root.ownerDocument.defaultView),
  windowRef = root.ownerDocument.defaultView,
  refreshIntervalMs = 60_000,
} = {}) {
  if (instances.has(root)) return instances.get(root);
  let disposed = false;
  let refreshing = false;
  let activeRequest = null;

  async function refresh({ force = false } = {}) {
    if (disposed || refreshing) return;
    refreshing = true;
    activeRequest = new AbortController();
    try {
      const suffix = force ? "?refresh=1" : "";
      const response = await fetchImpl("/api/market-news/events" + suffix, {
        headers: { Accept: "application/json" },
        signal: activeRequest.signal,
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error("calendar refresh failed");
      renderCalendar(payload.calendar);
    } catch (error) {
      if (error?.name !== "AbortError") renderRefreshFailure();
    } finally {
      refreshing = false;
      activeRequest = null;
      setBusy(false);
    }
  }

  const interval = refreshIntervalMs > 0
    ? windowRef.setInterval(() => refresh(), refreshIntervalMs)
    : null;
  const instance = {
    dispose() {
      disposed = true;
      activeRequest?.abort();
      if (interval !== null) windowRef.clearInterval(interval);
      root.removeEventListener("click", onClick);
      instances.delete(root);
    },
  };
  instances.set(root, instance);
  return instance;
}
```

- [ ] **Step 7: Mount and dispose the calendar through the app shell**

Import `initializeMarketNewsPage` in `app-shell.js`. Track one active route cleanup:

```js
let disposeActiveRoute = () => {};
const initializeShellPage = (root, route) => {
  disposeActiveRoute();
  disposeActiveRoute = () => {};
  setActiveNavigation(documentRef, route.key);
  drawer.close();
  hydrateJournalCount(root, service);
  if (route.key.startsWith("journal")) {
    initializeJournalPage(root, { ...service, pageState: journalPageState, navigate: (path) => navigator.navigate(path) });
  }
  if (route.key === "market-news") {
    disposeActiveRoute = initializeMarketNewsPage(root, { fetchImpl, windowRef }).dispose;
  }
  initializePageInteractions(root, { showToast: (message) => showTerminalToast(documentRef, message) });
  initializePage(root, route);
};
```

Call `disposeActiveRoute()` inside the shell's own `dispose()`. Add an app-shell test that navigates away from a Market News fragment and proves its scheduled interval is cleared.

- [ ] **Step 8: Remove obsolete generic news-chip behavior**

Delete `[data-news-filter]` selection from `page-interactions.js` and remove its demonstration-only unit test. Retain alert and copy behavior unchanged.

- [ ] **Step 9: Run browser and navigation tests**

Run: `node --test tests/unit/market-news-controller.test.js tests/unit/app-shell.test.js tests/unit/page-interactions.test.js tests/unit/navigation-controller.test.js tests/unit/transition-controller.test.js`

Expected: all selected tests PASS, including controller teardown across fragment navigation.

- [ ] **Step 10: Commit progressive enhancement**

```powershell
git add public/js/market-news/market-news-controller.js public/js/app-shell.js public/js/page-interactions.js tests/unit/market-news-controller.test.js tests/unit/app-shell.test.js tests/unit/page-interactions.test.js
git commit -m "feat: add live calendar interactions"
```

---

### Task 6: Configuration, Documentation, and Full Verification

**Files:**
- Create: `.env.example`
- Modify: `package.json`
- Modify: `README.md`
- Modify: any Market News files required by verification findings, limited to this feature.

**Interfaces:**
- Consumes: `TRADING_ECONOMICS_API_KEY` from either the process environment or a root `.env` file.
- Produces: `npm start` and `npm run dev` loading an optional local `.env` through Node.js 24's built-in `--env-file-if-exists` flag.
- Documents: live-provider setup, safe failure behavior, filter scope, provider licensing responsibility, and v0.1.2 status.

- [ ] **Step 1: Add a safe environment example**

Create exactly:

```dotenv
# Paid Trading Economics API credential.
# Keep the real value in .env; .env is ignored by Git.
TRADING_ECONOMICS_API_KEY=replace-with-your-licensed-key
```

Confirm `.gitignore` continues to ignore `.env` and permits `.env.example`.

- [ ] **Step 2: Load an optional local environment file without adding a dependency**

Update package scripts:

```json
{
  "dev": "node --env-file-if-exists=.env --watch src/server.js",
  "start": "node --env-file-if-exists=.env src/server.js"
}
```

Leave `test`, `test:watch`, dependencies, Node `>=24`, and version `0.1.2` unchanged. The existing Windows batch launcher will continue to call `npm start`.

- [ ] **Step 3: Update the README**

Make these exact content changes:

- Change the v0.1.2 Market News bullet from an interface foundation to a native live economic calendar with high/medium impact and market filters.
- Remove “live market feeds” from the list described as unconnected.
- Change the Market News route description to “Live current-week high- and medium-impact economic calendar.”
- Add a “Live market calendar” setup section instructing users to copy `.env.example` to `.env`, replace the sample value with their licensed key, and restart the app.
- State that missing/invalid credentials leave the terminal interface available with `[ CALENDAR DATA LINK OFFLINE ]`.
- State that production operators must obtain Trading Economics display/distribution rights appropriate to their deployment.
- Update the roadmap item from generic live market data to future streaming updates and configurable alert providers.
- Keep the title, disclaimer, and every version reference at `v0.1.2`.

- [ ] **Step 4: Run focused verification**

Run:

```powershell
node --test tests/unit/trading-economics-calendar-provider.test.js tests/unit/market-news-service.test.js tests/unit/market-news-controller.test.js
node --test tests/integration/market-news-routes.test.js tests/integration/page-routes.test.js tests/integration/fidelity-markup.test.js
```

Expected: all selected unit and integration tests PASS without `TRADING_ECONOMICS_API_KEY` and without network access.

- [ ] **Step 5: Run the complete suite**

Run: `npm test`

Expected: all tests PASS with zero failures, cancellations, or skipped tests.

- [ ] **Step 6: Perform local UI verification**

Start the application with `start-synergy-module.bat`, sign in with any non-empty demo credentials, and inspect `http://127.0.0.1:4173/market-news`.

Verify:

- Without a key, the page shows the full native terminal shell and `[ CALENDAR DATA LINK OFFLINE ]`.
- With a licensed key, only high/red and medium/orange supported-market events appear.
- Impact and market filters combine instantly and update the count.
- Times and day headings match the workstation timezone.
- Manual refresh shows a syncing status and preserves existing rows if the provider is temporarily unavailable.
- Desktop uses aligned columns; a viewport below 760px uses terminal cards.
- Navigating to and from Market News preserves the glitch transition and leaves no polling activity after departure.
- No iframe, X timeline, FinancialJuice content, or provider credential appears in the page source or browser requests.

Stop the local server after verification unless the user asks to keep it running.

- [ ] **Step 7: Inspect the final diff and commit**

Run:

```powershell
git diff --check
git status --short
```

Confirm only planned Market News, configuration, documentation, and test files changed. Then commit:

```powershell
git add .env.example package.json README.md
git commit -m "docs: configure live market calendar"
```

- [ ] **Step 8: Record the verified result**

Run:

```powershell
git status --short --branch
git log -6 --oneline
```

Expected: a clean working tree on the feature branch with all Market News commits present. Record the final test count and whether live-provider visual verification was performed with a licensed key or limited to the offline/test-double states.
