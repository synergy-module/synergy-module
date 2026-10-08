# Synergy Module Market News Calendar Design

**Date:** 2026-09-02  
**Target version:** v0.1.2
**Status:** Implemented; amended to use a public keyless source

## Purpose

Replace the Market News placeholder with a live economic calendar while preserving Synergy Module's terminal-first visual language and seamless in-app navigation. The calendar will display only medium- and high-impact events. The previously considered FinancialJuice/X panel is excluded from this scope.

## User Experience

The Market News route remains a native Synergy Module screen. It will not embed third-party interfaces. Every label, filter, event row, loading state, and error message will use the application's monospace typography, dark terminal surfaces, compact borders, and command-line presentation.

The page contains:

- A terminal-style status header showing the current week, visible event count, data state, and last successful update time.
- Impact controls for `ALL`, `HIGH`, and `MEDIUM`.
- Market controls for `ALL`, `USD`, `EUR`, `GBP`, `JPY`, `CAD`, `AUD`, `NZD`, `CHF`, and `CNY`.
- A current-week event stream grouped by local calendar day.
- Rows containing local time, market/currency, impact, and event name.
- A manual refresh control.

High-impact events use the existing red danger treatment. Medium-impact events use orange. Color will not be the only distinction: rows also include the text labels `HIGH` or `MEDIUM` for accessibility and clarity.

On narrow screens, each event row becomes a compact terminal card while preserving the information order. Desktop layouts use aligned columns. No X, FinancialJuice, social-post, or iframe panel will be included.

## Interaction and Navigation

Impact and market filters combine instantly in the browser without a page reload. The event count updates to reflect the visible rows. A filter combination with no matches displays a terminal-style empty result rather than removing the surrounding page structure.

The route continues to participate in Synergy Module's existing fragment-navigation system. Entering or leaving Market News will use the same glitch transition as the other pages. Event filtering and refreshes occur inside the mounted page and will not trigger a route transition.

## Data Source and Licensing Boundary

Economicium is the selected public provider. The integration uses its free JSON calendar endpoint without an account or API key. Provider access remains isolated behind an application-owned adapter so a future provider can be substituted without changing the controller, view, or browser code.

Only provider-supported data will be requested and displayed. The application will not scrape Forex Factory, FinancialJuice, X, or another website. Economicium states that its calendar is assembled from official public-domain or openly licensed schedules and publishes the JSON specifically for reuse in applications.

No provider credential is required. Calendar requests are made server-side and cached for 24 hours.

## MVC Architecture

### Model and services

`EconomiciumCalendarProvider` owns external HTTP communication. It requests the public calendar, selects the current week's events, validates the response shape, and converts provider failures into typed application errors.

`MarketNewsService` owns application rules. It:

- Requests and caches the current week's calendar.
- Keeps only provider impact levels `medium` and `high`.
- Maps supported countries to the displayed market/currency code.
- Sorts events chronologically.
- Returns a stable application-owned event shape.

The normalized shape contains a deterministic event identifier, ISO timestamp, currency, country, title, importance, and source. Consensus forecasts, released actuals, and previous values are not present in the public feed and are not invented.

The service maintains a shared, single-flight cache so multiple browsers do not cause duplicate provider requests. A 24-hour freshness window meets the once-daily update requirement. If refreshing fails after a prior success, the service returns the last successful data marked as stale.

### Controller

A dedicated Market News controller replaces the generic page controller for this route. It loads the current-week query, asks the service for normalized events, builds the page view model, and renders either the full layout or the existing fragment response.

The controller also exposes `GET /api/market-news/events` for in-page refreshes. Its response contains only normalized Synergy Module data and status metadata; it never proxies a raw provider response.

### View

`views/pages/market-news.ejs` renders the initial event data on the server. This prevents an empty flash during direct navigation and ensures fragment navigation arrives as a complete terminal screen. Reusable partials may be introduced for day groups and event rows when doing so keeps the template readable.

### Browser controller

The Market News browser controller owns impact filtering, market filtering, visible-count updates, local-time formatting, refresh requests, and refresh-state announcements. It must remain safe when mounted more than once by fragment navigation and must remove timers/listeners when the route is replaced.

## Time and Week Boundaries

The server requests a complete current-week range using explicit dates. Provider timestamps remain in ISO form until they reach the browser, where `Intl.DateTimeFormat` converts them to the workstation's local timezone. The displayed header states that times are local.

Day grouping is calculated from the displayed local date. An event near midnight may therefore appear under a different day than the provider's source timezone, which is expected and keeps the interface useful to the local trader.

## Loading, Empty, Stale, and Error States

- **Loading:** Existing events remain visible while the status line reads `SYNCING CALENDAR...`.
- **No scheduled events:** The screen reads `[ NO HIGH / MEDIUM IMPACT EVENTS THIS WEEK ]`.
- **No filter matches:** The screen reads `[ NO EVENTS MATCH ACTIVE FILTERS ]`.
- **Stale data:** Cached events remain visible with a clear `STALE DATA` status and the last successful update time.
- **Unavailable with no cache:** The calendar shell remains visible and reports `[ CALENDAR DATA LINK OFFLINE ]` with a retry control.

All states preserve page structure and terminal styling. Provider error bodies and stack traces are never sent to the browser.

## Accessibility

Filters are real buttons with pressed-state semantics. Status changes use a restrained live region. Tables retain meaningful headers on desktop, and the mobile-card layout exposes equivalent labels. Keyboard focus uses the existing Synergy Module focus treatment. Motion respects the application's reduced-motion behavior.

## Testing Strategy

Unit tests will cover provider normalization, impact filtering, country-to-market mapping, chronological sorting, daily cache reuse, stale-cache fallback, and typed provider failures.

Controller and route integration tests will cover full-page rendering, fragment rendering, the normalized JSON endpoint, empty data, and upstream failure behavior. External HTTP requests will be mocked; the test suite will not require network access.

Browser tests will cover combined impact/market filters, visible counts, local-time/day grouping, manual refresh, loading/error/stale states, and safe remounting after fragment navigation.

Existing navigation and fidelity tests will be updated to assert the new terminal calendar markup while retaining the glitch-transition contract. The complete test suite must pass before the feature is considered complete.

## Configuration and Documentation

The README will document that calendar access requires no account or API key, how daily caching works, and that consensus forecasts and released values are outside the source's public dataset.

No database changes, Discord SSO work, journal integration, alert changes, or social feed work are included in this feature.

## Acceptance Criteria

1. Market News displays live current-week Economicium events without account configuration.
2. Only high- and medium-impact events reach the rendered calendar.
3. Users can combine impact and supported-market filters without navigation or reloads.
4. All calendar content and states look native to the Synergy Module terminal interface.
5. Direct loads and fragment navigation both render correctly and retain seamless glitch transitions.
6. Local times, refresh status, stale data, empty results, and failures are presented accurately.
7. No raw provider error is exposed to the browser.
8. No FinancialJuice/X content or embed is present.
9. Automated tests pass without live network access.
