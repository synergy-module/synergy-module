# Synergy Module Discord RBAC and Indicator Access Design

**Date:** 2026-09-02
**Target version:** v0.1.2
**Status:** Approved for implementation planning

## Purpose

Replace the current demonstration-only authentication boundary with a modular authentication system that can run in explicit demo mode locally and use Discord SSO in hosted environments. Authorize site and module access from Discord roles, add a permission-aware terminal navigation experience, provide a TradingView indicator access-request workflow, and give administrators temporary in-memory tools for user, session, ban, and request management.

This release does not add PostgreSQL. All user records, bans, session indexes, and indicator requests are intentionally temporary and reset when the Node.js process restarts. Every store will be accessed through a repository interface so the later database migration does not require controller, policy, route, or view rewrites.

## Scope

### Included

- Explicit `demo` and `discord` authentication modes.
- Discord OAuth2 authorization-code login with guild membership and role retrieval.
- Five-minute Discord role refreshes during active sessions.
- Central role-to-capability policy used by complete pages, fragments, and APIs.
- Visible navigation for every module, including an Admin destination.
- Animated insufficient-permissions handling that retains the current page.
- A modular, config-backed TradingView indicator catalog.
- One-request access workflow covering every active indicator.
- An Admin panel for users, sessions, bans, and indicator request decisions.
- In-memory repositories designed for later PostgreSQL implementations.
- A local `.env` template plus a sanitized `.env.example`.
- Automated unit, integration, interaction, and browser verification.

### Excluded

- Discord bot installation or Discord role modification.
- Persistent database storage.
- Automatic TradingView invite-only access changes.
- Paid subscriptions, billing, expiration management, or webhook notifications.
- Production indicator names and publication URLs, which will replace the clearly marked demo catalog later.

## Authentication Modes and Configuration

`AUTH_MODE` is required and accepts only `demo` or `discord`.

In local development, `AUTH_MODE=demo` preserves the current Matrix/glitch login and assigns the comma-separated roles in `DEMO_ROLES` to authenticated users. In Discord mode, the login presentation remains intact but replaces the username and passkey fields with a terminal-styled `CONTINUE WITH DISCORD` action.

The project-root `.env` will be ignored by Git and contain a safe configuration template:

```text
AUTH_MODE=demo
SESSION_SECRET=replace-with-a-long-random-value

DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=http://127.0.0.1:4173/auth/discord/callback
DISCORD_GUILD_ID=
DISCORD_ROLE_DEVELOPER_ID=
DISCORD_ROLE_ADMIN_ID=
DISCORD_ROLE_OS_ID=
DISCORD_ROLE_INDICATORS_ID=
DISCORD_ROLE_JOURNAL_ID=
DISCORD_ROLE_REFRESH_MINUTES=5

DEMO_ROLES=Developer,Indicators,Journal

HOST=127.0.0.1
PORT=4173
```

`.env.example` will document the same keys without containing a usable secret. Production will refuse to start when demo mode is selected, the session secret is missing, or required Discord configuration is incomplete.

## Discord OAuth Flow

The Discord provider will implement the OAuth2 authorization-code flow directly through Discord API v10:

1. `GET /auth/discord` generates a cryptographically random OAuth state value, stores it in the server session, and redirects to Discord with `identify` and `guilds.members.read` scopes.
2. `GET /auth/discord/callback` requires an exact, single-use state match and exchanges the returned code server-side.
3. The provider retrieves `/users/@me` and `/users/@me/guilds/{guild.id}/member` with the user access token.
4. The role policy maps returned role IDs to named Synergy Module roles and capabilities.
5. Authentication succeeds only when at least one base role—`Developer`, `Admin`, or `OS`—is present.
6. The session is regenerated before saving the operator identity, role snapshot, capability snapshot, Discord access/refresh tokens, token expiry, and role-sync time.

OAuth tokens remain only in the server-side session store. They are never returned in browser markup, client JSON, URLs, or logs. Logout revokes the Discord token when possible, destroys the local session regardless of revocation outcome, and returns the browser to `/login`.

A Discord bot is not required because the site reads the signed-in user's own guild member record. Role IDs are configured explicitly rather than discovered through a bot.

## Role Refresh

Authenticated Discord sessions store `rolesSyncedAt`. On a protected request, the role-sync middleware refreshes guild membership when the snapshot is at least five minutes old. It recalculates capabilities and updates the temporary user record.

- Loss of guild membership or all base roles destroys the session immediately.
- A refresh failure fails closed and ends the session rather than retaining potentially revoked access.
- Administrative mutations require a role snapshot newer than five minutes and perform refresh first when necessary.
- Demo sessions keep their configured roles and do not call Discord.

## Authorization Policy

The policy service is the only place that converts roles into capabilities.

| Discord role | Capabilities |
|---|---|
| `Developer` | Base site, Indicators, Journal, Admin, and every future module |
| `Admin` | Base site, Indicators, Journal, Admin, and every future module |
| `OS` | Base site only |
| `Indicators` | Indicators module, provided a base role is also present |
| `Journal` | Journal module, provided a base role is also present |

Current route requirements are:

| Surface | Required capability |
|---|---|
| Home, Market News, Alerts | Base site |
| Indicators page and request API | Indicators |
| Journal routes | Journal |
| Admin page and Admin APIs | Admin |

Full-page routes, fragment routes, and API routes use the same server-side capability middleware. Client-side display state never grants access.

## Navigation and Access-Denied Transition

All primary module links remain visible to authenticated users, including Indicators, Journal, and Admin. Links do not expose protected data before authorization.

For progressive fragment navigation to a restricted destination:

1. The current glitch-routing overlay starts normally.
2. The existing page remains mounted and the URL is not committed.
3. The server responds with status `403` and a structured, terminal-safe error body.
4. The client holds the overlay in its loading state for the approved transition duration.
5. The overlay changes to `ACCESS FAILED :: INSUFFICIENT PERMISSIONS`.
6. The overlay closes, focus returns safely, and the prior page remains active without a denied history entry.

A direct full-page visit to a restricted URL redirects to `/home` and displays a one-time terminal access-denied notice. Restricted APIs return JSON `403` responses. The behavior will respect `prefers-reduced-motion` while preserving the same result.

## Indicator Catalog

The catalog is a dedicated configuration module independent of request storage and UI rendering. Each entry contains:

- Stable ID
- Display name
- Short description
- TradingView publication URL, nullable for demo entries
- Indicator version
- Active status
- Demo flag

Demo mode will seed clearly labeled demonstration entries with no claim of real TradingView access. Discord mode may run with an empty catalog; in that state the page explains that no active indicators are configured. Replacing or adding an indicator requires changing only the catalog configuration.

## Indicators Access Workflow

An authorized member sees their Discord identity, role-sync status, the active indicator catalog, their request status, one TradingView username field, and an explicit confirmation that they are requesting invite-only access.

Submitting `REQUEST ACCESS TO ALL` creates or updates one request for the member covering every currently active indicator. The normalized TradingView username is validated, the explicit-consent flag is required, and duplicate pending records are not created.

Request states are:

- `NOT_REQUESTED`
- `PENDING`
- `GRANTED`
- `DENIED`

Members may correct their TradingView username by resubmitting; this returns the request to `PENDING` and records the new request time. A granted state displays configured script links and instructions for locating invite-only scripts in TradingView.

Synergy Module does not claim to grant access automatically. An Admin or Developer must use TradingView's Manage Access interface, then mark the Synergy Module request `GRANTED`. This preserves TradingView's supported request and author-managed access process.

## Temporary Repositories

The first implementation defines separate interfaces and in-memory implementations for:

- User repository: latest Discord/demo identity, roles, capabilities, sign-in time, and sync time.
- Ban repository: user ID, reason, actor, and timestamp.
- Session registry: user-to-session index used for global sign-out and immediate ban enforcement.
- Indicator request repository: one request per user with username, indicator snapshot, state, actor, and timestamps.

Repositories receive normalized domain objects and expose no Express request or response objects. Later PostgreSQL repositories will implement the same contracts. A visible `TEMPORARY MEMORY MODE` notice in Admin explains that all records reset with the process.

## Admin Panel

`/admin` is present in navigation for every authenticated user but requires the Admin capability.

### User Management

The user table shows people seen since process start with:

- Discord/demo user ID and username
- Effective roles and module capabilities
- Last sign-in and last role synchronization
- Active session count
- Banned or allowed state

Actions:

- `SIGN OUT`: destroys every active Synergy Module session for the selected user but permits a future login.
- `BAN`: records an in-memory ban, then destroys every active session for the selected user.
- `UNBAN`: removes the in-memory ban and permits authentication again.

The current administrator cannot ban their own user ID. A self-targeted sign-out is allowed and completes by returning that browser to login. All actions require confirmation and return terminal-styled success or safe failure feedback.

### Indicator Requests

The request table shows Discord identity, TradingView username, requested indicators, submission time, state, deciding actor, and decision time. Admins can mark a pending request `GRANTED` or `DENIED`. Active catalog entries link to their TradingView publication pages when URLs are configured, assisting the manual Manage Access process.

## Request Protection

- OAuth callbacks require single-use cryptographic state validation.
- The application uses regenerated sessions after successful authentication.
- Session cookies remain HTTP-only, same-site, and secure in production.
- Every state-changing indicator and Admin request is POST-only and requires a session-bound anti-forgery token.
- Administrative POST routes recheck Admin capability independently of page access.
- User-supplied names, reasons, and usernames are normalized, length-bounded, and escaped at rendering.
- Provider errors and credentials are never exposed to the client.
- Authentication and authorization failures use stable error codes and safe display messages.

## Error Handling

- Invalid or reused OAuth state returns a login-safe authentication failure.
- Discord code-exchange or profile failures return a general provider-unavailable message and log only safe diagnostic context.
- Non-members and members without a base role receive an access-denied login result.
- Banned users receive a stable banned-access message without creating an authenticated session.
- Role refresh failure destroys the local session and requires a fresh login.
- Indicator submission with no active catalog returns a safe unavailable state.
- Repository errors are handled through the existing terminal error boundary.
- Attempted self-ban and invalid Admin status changes return validation errors without mutation.

## MVC and Module Boundaries

The implementation will retain the current Express/EJS structure and add focused modules rather than expanding `app.js` or page controllers into multi-purpose files:

- Configuration parsing and validation
- Discord OAuth provider
- Authentication orchestration service
- Role policy service
- Role-refresh and capability middleware
- User, ban, session, and indicator-request repositories
- Indicators controller and routes
- Admin controller and routes
- Server-rendered Indicators and Admin views
- Small client controllers for indicator submission, Admin actions, and denied transitions

All external providers and repositories are dependency-injected through `createApp` for deterministic tests.

## Verification

### Unit tests

- Configuration validation for both auth modes.
- Discord role ID mapping and capability calculation.
- Base-role admission and full-access inheritance.
- In-memory user, ban, session, and request repository behavior.
- TradingView username validation and duplicate request updates.
- Navigation controller handling for structured `403` responses.

### Integration tests

- Demo login retains the existing flow and configured roles.
- Discord redirect includes exact scopes and state.
- Callback rejects missing, mismatched, and reused state.
- Callback exchanges a mocked code, verifies guild membership, and saves the correct identity.
- Missing base role and banned identities cannot establish sessions.
- Five-minute role refresh updates or revokes permissions.
- Every full, fragment, and API route enforces the same capabilities.
- Sign-out, ban, unban, self-ban prevention, and request decisions are authorized and mutate only intended records.
- Anti-forgery failures cannot mutate state.

### Browser verification

- Matrix/glitch login remains visually consistent in demo and Discord modes.
- Existing fragment transitions remain seamless for allowed routes.
- Denied module navigation pauses, displays the exact permission failure, and returns to the prior page without changing history.
- Indicators request states update without full-page visual discontinuity.
- Admin user and request actions provide clear terminal confirmations.
- Desktop and mobile layouts preserve readable controls, tables, focus order, and reduced-motion behavior.

The complete existing test suite must remain green. No completion claim is made until the application is exercised through the in-app browser and the relevant desktop and mobile states are visually inspected.

## Migration to PostgreSQL

The hosted-server database phase will replace only repository implementations and the production session store. Controllers, routes, authorization rules, domain objects, and views will retain their contracts. The future schema will persist users, role snapshots, bans, indicator catalog entries, requests, request decisions, and durable sessions, followed separately by the journal migration.

## External Platform Constraints

Discord OAuth2 supports retrieving the signed-in user's guild member record with the `guilds.members.read` scope; no bot is needed for this read-only role authorization design.

TradingView invite-only access is author-managed. The application records explicit user requests and administrative decisions but does not scrape TradingView, automate browser actions, or call an undocumented access endpoint.

## References

- [Discord OAuth2 documentation](https://docs.discord.com/developers/topics/oauth2)
- [TradingView script publishing documentation](https://www.tradingview.com/pine-script-docs/writing/publishing/)
- [TradingView vendor requirements](https://www.tradingview.com/support/solutions/43000549951-vendor-requirements/)
