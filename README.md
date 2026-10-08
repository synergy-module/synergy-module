# Synergy Module

Repository: [omensite/synergy-module](https://github.com/omensite/synergy-module). The GitHub organization remains `omensite`; the application and package are named **Synergy Module** and `synergy-module` respectively.

**Version v0.1.2 — Early Development Preview**

> An AI-assisted trading intelligence platform for execution review, structured journaling, indicator research, trader education, and weekly market context.

## Overview

Synergy Module is designed to help discretionary traders convert market activity into a disciplined, repeatable learning process. The platform brings trade records, post-execution analysis, research tools, educational material, and market intelligence into a single operational workspace.

The long-term objective is to use AI to examine trade executions alongside the trader's thesis, risk plan, confluences, and outcome. Rather than merely reporting profit and loss, Synergy Module aims to identify recurring behaviors, highlight strengths and weaknesses, and produce practical feedback that can improve future decision-making.

## Product direction

- **AI-assisted execution analysis** — Evaluate entries, exits, risk management, timing, market context, and recurring behavioral patterns to generate objective post-trade feedback.
- **Extensive trade journal** — Capture a trade's thesis, direction, confluences, execution details, result, and lessons in a consistent, searchable record.
- **Indicator library** — Organize indicator references, configurations, use cases, and supporting research in one accessible catalog.
- **Educational content** — Provide structured material for developing market knowledge, execution discipline, and repeatable trading processes.
- **Weekly market intelligence** — Deliver a focused briefing on meaningful market developments, scheduled events, and conditions that may affect the coming trading week.

## What v0.1.2 includes

This release establishes Synergy Module's application architecture and core user experience:

- An Express 5 and EJS Model-View-Controller application.
- Clean, refreshable routes with progressive fragment navigation.
- Seamless terminal-style page transitions and glitch effects.
- A cinematic Matrix-inspired login sequence with animated terminal graphics.
- Discord-only OAuth2 popup sign-in that preserves the retro terminal, with server-enforced, role-based module access and a same-tab fallback in every environment.
- A PostgreSQL-backed Admin panel for user sessions, bans, roles, and indicator-access decisions.
- A request-all indicator workflow that records TradingView usernames and consent for manual access grants.
- A PostgreSQL-backed trade journal with create, list, detail, and shareable-view workflows shared by beta and production.
- A native live economic calendar with high/medium impact and market filters.
- An Agentic Trader workspace with Gemini, OpenAI, and Claude provider selection, structured thesis generation, deterministic risk checks, a second AI review, and an explicit demo mode.
- Automated integration and unit tests for routing, authentication, navigation, transitions, and journal behavior.

Agentic Trader analysis requires a configured AI provider and explicit server activation. Brain now includes a Robinhood workspace for stocks, options, and crypto: OAuth connection, authenticated tool discovery, dated research, order previews, separate operator confirmations, and durable activity. Live submissions and paid AI remain disabled by default. See [Robinhood setup and current limits](docs/robinhood.md). Execution-data imports, unattended trading, AI journal review, automated TradingView access grants, and editorial content pipelines remain planned capabilities.

## Technology

- Node.js 24+
- Express 5
- EJS server-rendered views
- Vanilla JavaScript with progressive enhancement
- CSS-based terminal, CRT, Matrix, and glitch presentation
- `express-session` authentication boundary
- PostgreSQL-backed authenticated journal API

The application renders complete pages on direct requests. Internal navigation requests route fragments, replaces only the active content area, updates browser history, and rehydrates page-specific behavior. This preserves the fluidity of a client application while retaining dependable server routes and refresh behavior.

## Run locally

### Windows launcher

Double-click `start-synergy-module.bat` from the project root. The launcher installs missing dependencies and opens the server at:

```text
http://127.0.0.1:3000
```

Press `Ctrl+C` in the terminal window to stop the server.

Set `SYNERGY_MODULE_SKIP_BROWSER=1` when starting the launcher without opening a browser.

The launcher calls the existing `npm start` command. That command reads the local `.env` file automatically; the launcher never prints authentication secrets.

### Command line

```bash
npm install
npm start
```

Copy `.env.example` to `.env` before the first local run and fill in the Discord application, guild, and role IDs described below. Set a random `SESSION_SECRET` and register `http://127.0.0.1:3000/auth/discord/callback` in the Discord application. The local server listens on `127.0.0.1:3000`. Missing Discord settings stop startup with a list of missing variable names; no development login is available. The `.env` file is ignored by Git and must remain uncommitted.

For automatic restarts during development:

```bash
npm run dev
```

### Live market calendar

Market News is officially powered by Economicium's public JSON API. Synergy Module retrieves the calendar directly from this public endpoint, so no account, API key, or environment configuration is required.

Synergy Module keeps only high- and medium-impact economic releases, maps each country to its affected currency, converts release times to the workstation's timezone, and groups the results by day. The server caches a successful response for 24 hours; the terminal's refresh control can request an immediate update. If the source is temporarily unavailable, the last successful in-memory result remains visible as stale data.

The source provides release schedules and impact classifications derived from official public or openly licensed sources. It deliberately does not provide proprietary consensus forecasts, actual releases, or previous values. See the [Economicium calendar](https://www.economicium.com/economic-calendar/) and its [public JSON endpoint](https://www.economicium.com/api/calendar).

## Agentic Trader

The connected **Agent Brain** is available at `/brain`. It adds a bounded ReAct runtime, four routed agent roles, workflow planning, retrieval, persistent memory, critique, versioned human approval, tracing, budgets and an offline evaluation suite. See [the implementation map and setup guide](docs/agent-brain.md) for all 18 capabilities, limits, storage, and pricing configuration. Run `npm run eval:brain` to exercise the system without an API key.

Open `/trader` from the sidebar or Home quick access. Gemini is selected by default; OpenAI and Claude are also available in the provider selector. The page reports each provider's configuration status and model. It never receives or stores API keys.

Paid AI calls are **locked by default** across both workspaces. Keep `TRADER_PAID_AI_ENABLED=false` while building and validating the system. Adding an API key does not unlock analysis; the provider adapter also rejects direct calls. Demos, retrieval, saved research review and offline evaluations remain available. The `/brain` readiness panel shows current storage, sources, memory, configuration and the latest offline check results, with live validation clearly marked as pending.

Provider credentials are optional during offline setup. When needed later, store them in the ignored local `.env` file or the hosted web service's environment:

| Provider | Server secret | Optional model override |
| --- | --- | --- |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| Claude | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |

`TRADER_AI_PROVIDER` sets the initial selection (`gemini`, `openai`, or `claude`). Only the selected provider receives a run; there is no automatic fallback to another provider. Keys stay on the server. The Compose configuration forwards these optional settings to the web service. An absent key leaves that provider unavailable while the rest of Synergy Module continues to work.

Only an explicit server-side `TRADER_PAID_AI_ENABLED=true` followed by a server restart enables billable requests. There is no browser control or request parameter that can activate them. Leave this disabled until setup has been reviewed and paid usage is explicitly authorized.

Enter the instrument, timeframe, market observations, and risk settings. The workflow collects economic-calendar context, asks the selected model for a structured thesis, calculates position size and reward/risk on the server, and requests a separate review when the numeric checks pass. AI calls send the entered context and calendar data to the selected provider. The current workspace displays USD; `pointValue` is the dollar value of a one-point price move for one unit or contract.

The server rejects invalid long/short stop geometry, missing levels, insufficient context, and plans that cannot fit one whole unit within the risk budget. A failed check or a review requesting more evidence produces a WAIT result. READY means the supplied plan passed these checks; it does not establish the accuracy of the observations or authorize an order. Sizing excludes commissions, slippage, margin, instrument tick sizes, and portfolio exposure.

**Run demo** uses explicitly labeled illustrative levels without calling an AI or market provider. This makes the entire workflow reviewable before configuring credentials. Demo outputs are not market signals or paper fills.

The `/trader` analysis workflow operates on manually supplied market context; it does not subscribe to live prices, footprints, or DOM. Economic-calendar freshness is reported separately. Its ten most recent runs per operator remain in bounded process memory. The separate `/brain` workflow stores research durably and now includes the Robinhood connection and reviewed broker-action endpoints. Accepting research never submits a broker order. Access uses the existing base-site capability and CSRF-protected authenticated APIs.

Provider protocols use the official [Gemini structured-output API](https://ai.google.dev/gemini-api/docs/structured-output), [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses), and [Claude structured-output API](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Provider contract tests use fake HTTP responses; paid API calls require configured credentials and separate live verification.

## Authentication and access

Discord is the only authentication method in local development, beta, and production. `AUTH_MODE` defaults to `discord`; any other value is rejected. The former username/passkey endpoint returns 404 and old non-Discord sessions are invalidated. Offline Trader and Brain demos remain available after Discord sign-in and do not call paid AI providers.

### Discord SSO setup

Discord authentication uses an OAuth2 application and the signed-in member's server roles. A Discord bot, bot user, and bot token are not required.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), then open **OAuth2**.
2. Register this exact local redirect URI: `http://127.0.0.1:3000/auth/discord/callback`. Register the deployment's HTTPS callback separately before hosting. If you change the local host or port, update both this registration and `DISCORD_REDIRECT_URI` to match.
3. Copy the application's client ID and client secret into the matching `.env` entries. Never commit the populated `.env` file.
4. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click the server and roles to copy their IDs. With `DISCORD_ACCESS_POLICY=site-roles`, set `DISCORD_GUILD_ID`, `DISCORD_REQUIRED_ROLE_ID` for membership, and `DISCORD_ROLE_ADMIN_ID` for administration. Configuration uses IDs, not editable role names; the membership and administrator IDs must differ.
5. Generate a long, random `SESSION_SECRET`, for example with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`, and store it in the ignored local `.env` or deployment's secret configuration.
6. Keep `AUTH_MODE=discord` and restart the application.

The retro terminal opens Discord sign-in in a separate popup. After Discord confirms the identity and server roles, the popup closes and the original terminal plays its handshake and ACCESS GRANTED animation. If popups are blocked, the terminal offers a same-tab sign-in link. Closing the popup leaves a Cancel / Retry control; unfinished attempts time out after five minutes. Discord controls its own authorization screen.

Popup completion is checked through the server session with an attempt identifier; no access tokens, refresh tokens, or OAuth codes are sent between browser windows. The regular `/auth/discord` redirect and `/auth/discord/callback` remain available, so the registered callback URL does not change.

Users authorize only the `identify` and `guilds.members.read` OAuth2 scopes. Synergy Module rechecks the member's roles every five minutes by default. If Discord cannot confirm membership during a required refresh, access fails closed until the identity can be verified again.

`DISCORD_ACCESS_POLICY=roles` is the default and requires the five role IDs. An existing beta deployment that admits every guild member can explicitly select `DISCORD_ACCESS_POLICY=beta-guild` with `APP_ENVIRONMENT=beta`. This preserves the former gateway's full preview access, including Admin, after a successful live Discord membership check; no role IDs are needed. Membership is rechecked at least every five minutes, and removed members or failed Discord checks lose access. This policy is rejected outside the beta environment.

To require one specific role before any permission mapping, set `DISCORD_REQUIRED_ROLE_ID`. Developer and Admin roles cannot bypass this requirement. Existing sessions without a matching guild/role/policy grant must sign in again. Role checks still fail closed when Discord is unavailable.

The Synergy Module deployment uses `DISCORD_ACCESS_POLICY=site-roles`, `DISCORD_GUILD_ID=1554634103997861889`, `DISCORD_REQUIRED_ROLE_ID=1554903899343814857` (SynergyModule), `DISCORD_ROLE_ADMIN_ID=1557751441693736991` (SMA*), and `DISCORD_ROLE_REFRESH_MINUTES=1`. SynergyModule grants the regular workspace, including Journal and Indicators; SMA* additionally maps to the site's `Admin` role. SMA* alone cannot bypass required membership or a site ban. Other Discord roles and legacy Developer mappings do not confer administration under this policy. Missing or identical membership/admin role IDs stop startup.

Administrators see **Administration** in the sidebar and can ban/unban accounts and terminate sessions. A ban blocks subsequent sign-in and invalidates current sessions. All existing and future administrative endpoints must use `requireCapability(CAPABILITIES.ADMIN)` after authentication and role refresh; mutations must also enforce CSRF. The `Admin` role inherits all capabilities from the central `CAPABILITIES` registry, so additional administrative functions should reuse this permission instead of creating separate Discord role checks.

Role changes take effect on the next protected request after the one-minute snapshot expires. Switching the membership policy, guild, required role, or administrator role invalidates prior admission grants, so old preview privileges cannot survive the change. Login, OAuth callbacks, static assets, and the minimal readiness endpoint remain public so sign-in and deployment can work; workspace pages and APIs require admission.

The legacy `roles` policy remains modular:

- `Developer` and `Admin` grant base access, Indicators, Journal, and Admin capabilities.
- `OS` grants base site access.
- `Indicators` adds access to the Indicators module.
- `Journal` adds access to the Journal module.
- A member must have `Developer`, `Admin`, or `OS` for base site access; module-only roles do not admit a user by themselves.

Every primary navigation item remains visible. When a user selects a module they cannot access, the existing terminal transition reports `ACCESS FAILED :: INSUFFICIENT PERMISSIONS` and returns them to the current page.

### Saved access records and TradingView access

When `DATABASE_URL` is configured, user snapshots, bans, indicator requests and decisions, login sessions and revocations, journal entries, and Brain records are saved in PostgreSQL. Admin displays `POSTGRESQL CONNECTED` only when all its repositories use persistent storage. Development without a database still displays `TEMPORARY MEMORY MODE` for its in-memory Admin repositories. Valid sessions from before the storage migration populate their user snapshot on the next protected request.

Synergy Module records a request for all active invite-only indicators, including the member's TradingView username and explicit consent. An authorized administrator must still open TradingView's **Manage Access** interface, grant or deny access manually, and then record the matching decision in Synergy Module. The application does not call an undocumented TradingView endpoint or grant access automatically.

## Application routes

- `/login` — Authentication terminal
- `/auth/discord` — The application's only sign-in entry point
- `/home` — Operations dashboard
- `/trader` — Agentic Trader analysis, risk review, and demo workspace
- `/brain` — Agent Brain mission control, workflow traces, human review, knowledge, memory and evaluations
- `/api/brain/*` — Authenticated brain runs, decisions, cancellation, documents and offline evaluations; mutations require CSRF
- `/api/trader/state` — Provider readiness and the authenticated operator's recent runs
- `/api/trader/runs` — Create an analysis or demo run (authenticated POST with CSRF)
- `/indicators` — Invite-only indicator catalog and access-request workflow
- `/market-news` — Live current-week high- and medium-impact economic calendar
- `/alerts/ict` — ICT alert workspace
- `/alerts/support-resistance` — Support and resistance alert workspace
- `/journal` — Trade journal
- `/journal/new` — New journal entry
- `/journal/:id` — Public journal record
- `/admin` — User, session, ban, and indicator-request administration

## Testing

Run the complete automated test suite with:

```bash
npm test
```

The real PostgreSQL persistence test is opt-in. Set `TEST_DATABASE_URL` to a disposable test database, then run `npm test`. It applies all migrations and verifies durable records, concurrent decisions, session revocation, and authenticated reads after replacing the app runtime. It never uses the application's `DATABASE_URL` or calls a paid AI provider.

## Roadmap

See the [project evolution roadmap](docs/project-roadmap.md) for the visual redesign sequence, current capability inventory, and decisions for the next product direction. The ideas below come from the original product direction and remain subject to that review.

1. Trade-execution ingestion from supported brokers or structured imports.
2. AI-assisted post-trade analysis and pattern detection.
3. Production indicator, educational-content, and weekly market-intelligence libraries.
4. Future streaming updates and configurable alert providers.

## Production considerations

The planned application domains are `synergymodule.dev` for development/beta and `synergymodule.app` for production; register each exact OAuth callback, including any subdomain, with the relevant provider. The example files do not change deployed DNS, routing, or provider registrations. Robinhood callback support remains subject to the issue documented in [Robinhood setup](docs/robinhood.md).

Branding upgrades preserve saved data: keep existing database URLs, data directories/volumes, session secrets, and credential-encryption keys. The hosting template intentionally retains the existing external network names `omen_edge` and `omen_data`. Legacy identifiers remain only where required for upgrade compatibility or external resources such as the GitHub organization and the installed Omensite Harness. Existing browser preferences and saved journal data remain readable; previously encrypted credentials retain their decryption compatibility.

Saved provider credentials use a versioned format: this release reads existing v1 records and writes v2 when an API key is saved or replaced. Upgrade every application instance sharing the database before saving keys. Earlier releases cannot read v2 records, so a rollback must retain the compatible credential reader. No database schema migration is needed for this rename.

Production startup requires `AUTH_MODE=discord` with complete Discord application/guild configuration, the role IDs when using the default roles policy, `SESSION_SECRET`, and a durable `express-session` store. The in-memory store is reserved for local development and automated tests. Authentik proxy authentication has been removed; forwarded identity headers cannot create a session, and existing sessions from the former authentication mode must sign in again. The explicit beta-guild policy preserves existing beta guild preview access; other deployments use Discord roles.

The hosted runtime supplies PostgreSQL for sessions, Admin records, journals, and Brain runs, documents, memory, and cache. Beta and production must receive the same `DATABASE_URL` and separate `SESSION_SECRET` values. Records belong to Discord identities, so shared-database deployments also share journal records, bans, and indicator decisions once both run this version. Revoked session IDs remain recorded to prevent a late concurrent session save from restoring access.

This repository includes `Dockerfile`, `compose.hosting.yml`, and `environment.hosting.example` for Portainer GitOps deployments. The beta stack tracks `dev`; the production stack tracks `main`. Run `npm run migrate` only through the production-only migration profile after a verified backup. The runner requires `APP_ENVIRONMENT=production`, `APP_ALLOW_MIGRATIONS=true`, and `DATABASE_URL`; the web service always receives `APP_ALLOW_MIGRATIONS=false`. The runner applies migrations 001 (sessions/journal), 002 (Brain), 003 (Admin), and 004 (Robinhood workspaces) together in a transaction and can be rerun. Apply them before deploying this version: `/health` reports `503` if the database is unavailable or any required table is missing. Connecting a database alone does not create the schema. Preserve `ROBINHOOD_TOKEN_ENCRYPTION_KEY` alongside database backups, and use the same key for deployments sharing broker records.

For StayLively repository deployments, follow [the StayLively deployment guide](docs/staylively-deployment.md). Creating a new server does not copy the former deployment's environment variables or database connection. The Docker image requires those runtime settings before it can start.

The hosting Compose file fixes `AUTH_MODE=discord` and attaches only the existing `security-headers@file,compression@file` Traefik middleware. Old Portainer `AUTH_MODE=proxy` and `APP_AUTH_MIDDLEWARE` values no longer control this app. Host rules, domains, networks, and HTTPS routing are unchanged.

To switch an existing beta stack, populate the Discord client ID, client secret, guild ID, and redirect URI in Portainer before redeploying the updated `dev` revision. For `synergymodule.dev`, register `https://synergymodule.dev/auth/discord/callback` on the Discord application. Use `DISCORD_ACCESS_POLICY=beta-guild` to preserve membership-based full preview, or supply all five role IDs for the default roles policy. Missing required settings stop deployment instead of admitting anonymous users. If an additional Authentik gate is configured outside this app's router (for example on a shared entrypoint), remove that gate for this app as part of the hosting rollout.

Deployments must use HTTPS, either directly in Node.js or through a trusted reverse proxy, because production session cookies are marked `Secure`. `createApp` trusts one proxy hop by default in production; deployments with a different topology must provide the appropriate `trustProxy` value.

## Project reference

The accepted static prototype is preserved in `reference/static-original/` for design and interaction comparisons during development.

## Disclaimer

Synergy Module is trading-analysis and educational software. It does not provide financial advice, guarantee trading performance, or replace independent research and risk management.
