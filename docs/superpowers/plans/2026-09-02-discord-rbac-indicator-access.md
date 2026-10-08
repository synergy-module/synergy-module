# Discord RBAC and Indicator Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord SSO, Discord-role-based module authorization, animated permission denials, a TradingView indicator access-request workflow, and a temporary-memory Admin panel to the existing Synergy Module MVC application.

**Architecture:** Keep authentication providers, authorization policy, repositories, route middleware, MVC controllers, and browser controllers separate and dependency-injected. Discord mode uses the OAuth2 authorization-code flow and reads the signed-in member's guild roles; demo mode retains the current local login. All temporary state is stored behind repository interfaces so PostgreSQL and a durable session store can replace the in-memory implementations later.

**Tech Stack:** Node.js 24+, Express 5, EJS, native `fetch`, Node `crypto`, `express-session`, vanilla JavaScript, CSS, Node test runner, Supertest, and JSDOM.

**Spec:** `docs/superpowers/specs/2026-09-02-discord-rbac-indicator-access-design.md`

## Global Constraints

- Keep the project version at `v0.1.2`.
- Preserve the existing terminal, CRT, Matrix, glitch, and progressive fragment-navigation design.
- `AUTH_MODE=demo` is local-only; production must reject demo mode and incomplete Discord configuration.
- Request only Discord OAuth scopes `identify` and `guilds.members.read`; do not add a bot or bot token.
- Treat Discord role IDs as configuration and role names as internal normalized domain values.
- `Developer` and `Admin` grant every capability; `OS` grants base access; `Indicators` and `Journal` are additive module roles.
- Keep every primary navigation link visible and enforce authorization on the server.
- A denied fragment navigation must retain the current page and must not push the denied URL into history.
- TradingView access remains a manual author action; Synergy Module records requests and decisions only.
- Store users, bans, session indexes, and indicator requests in memory for this release, with explicit repository boundaries for PostgreSQL migration.
- Never render or log Discord client secrets, access tokens, refresh tokens, OAuth codes, or session secrets.
- Use TDD for every task: observe the new test fail for the intended reason before implementing production code.
- Preserve all existing tests and verify the final UI in the in-app browser at desktop and mobile widths.

## File Structure

### Configuration and domain policy

- `src/config/auth-config.js` — parse and validate authentication environment values.
- `src/config/indicator-catalog.js` — provide immutable demo and configured indicator records.
- `src/services/role-policy.js` — translate Discord role IDs or demo role names into capabilities.
- `src/models/access.js` — export stable role, capability, and error-code constants.

### Providers and services

- `src/providers/discord-oauth-provider.js` — Discord authorization URLs, token exchange, identity/member reads, token refresh, and best-effort revocation.
- `src/services/auth-service.js` — orchestrate demo/Discord sign-in, bans, operator creation, and role refresh.
- `src/services/indicator-access-service.js` — validate and submit request-all access, read member state, and apply Admin decisions.
- `src/services/admin-service.js` — aggregate users and requests, destroy user sessions, and manage bans.

### Temporary repositories

- `src/repositories/in-memory-user-repository.js` — normalized user snapshots.
- `src/repositories/in-memory-ban-repository.js` — temporary ban records.
- `src/repositories/in-memory-session-registry.js` — user-to-session indexes.
- `src/repositories/in-memory-indicator-request-repository.js` — one request per user.

### Security and middleware

- `src/security/csrf.js` — session-bound anti-forgery token creation and validation.
- `src/middleware/refresh-roles.js` — five-minute Discord membership refresh.
- `src/middleware/require-capability.js` — unified full-page, fragment, and API authorization failures.
- `src/middleware/require-auth.js` — retain unauthenticated behavior and stable error responses.

### MVC and browser surfaces

- `src/controllers/auth-controller.js`, `src/routes/auth-routes.js` — mode-aware login, OAuth callback/completion, and logout.
- `src/controllers/indicator-controller.js`, `src/routes/indicator-routes.js` — Indicators page and request endpoint.
- `src/controllers/admin-controller.js`, `src/routes/admin-routes.js` — Admin page and user/request mutations.
- `src/models/navigation.js`, `src/models/view-models.js` — capability metadata and page data.
- `views/layouts/login.ejs`, `public/js/login-controller.js` — demo and Discord terminal login states.
- `views/pages/indicators.ejs`, `public/js/indicators/indicator-access-controller.js` — catalog and request UI.
- `views/pages/admin.ejs`, `public/js/admin/admin-controller.js` — Admin user/request tables and actions.
- `views/partials/sidebar.ejs`, `views/partials/statusbar.ejs`, `public/js/navigation-controller.js`, `public/js/transition-controller.js`, `public/js/app-shell.js` — visible navigation, identity display, hydration, and denied transition.
- `public/css/synergy-module.css` — responsive terminal styling for the new states.
- `tests/helpers/auth-test-helpers.js` — deterministic demo/Discord app configurations, login, and CSRF extraction for integration tests.
- `tests/helpers/http-test-helpers.js` — minimal Express response harness for middleware unit tests.

---

### Task 1: Authentication Configuration and Role Policy

**Files:**
- Create: `src/models/access.js`
- Create: `src/config/auth-config.js`
- Create: `src/services/role-policy.js`
- Create: `tests/unit/auth-config.test.js`
- Create: `tests/unit/role-policy.test.js`

**Interfaces:**
- Produces: `ROLES`, `CAPABILITIES`, and `ACCESS_ERRORS` string constants.
- Produces: `readAuthConfig({ env, nodeEnvironment }) -> AuthConfig`.
- Produces: `createRolePolicy({ roleIds }).fromDiscordRoleIds(ids)`, `.fromRoleNames(names)`, `.can(operator, capability)`, and `.hasBaseAccess(operator)`.
- `AuthConfig` has `{ mode, sessionSecret, demoRoles, roleRefreshMs, discord }`.

- [ ] **Step 1: Write failing configuration tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readAuthConfig } from "../../src/config/auth-config.js";

test("demo configuration parses roles and refresh minutes", () => {
  const config = readAuthConfig({
    env: { AUTH_MODE: "demo", SESSION_SECRET: "test-secret", DEMO_ROLES: "OS, Indicators,Journal", DISCORD_ROLE_REFRESH_MINUTES: "5" },
    nodeEnvironment: "development",
  });
  assert.equal(config.mode, "demo");
  assert.deepEqual(config.demoRoles, ["OS", "Indicators", "Journal"]);
  assert.equal(config.roleRefreshMs, 300_000);
});

test("production rejects demo mode", () => {
  assert.throws(() => readAuthConfig({
    env: { AUTH_MODE: "demo", SESSION_SECRET: "test-secret" },
    nodeEnvironment: "production",
  }), /Discord authentication is required in production/);
});

test("discord mode reports every missing required value", () => {
  assert.throws(() => readAuthConfig({
    env: { AUTH_MODE: "discord", SESSION_SECRET: "test-secret" },
    nodeEnvironment: "development",
  }), /DISCORD_CLIENT_ID.*DISCORD_CLIENT_SECRET.*DISCORD_GUILD_ID/s);
});
```

- [ ] **Step 2: Run configuration tests and confirm the missing-module failure**

Run: `node --test tests/unit/auth-config.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/config/auth-config.js`.

- [ ] **Step 3: Write failing role-policy tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "../../src/models/access.js";
import { createRolePolicy } from "../../src/services/role-policy.js";

const policy = createRolePolicy({
  roleIds: { Developer: "1", Admin: "2", OS: "3", Indicators: "4", Journal: "5" },
});

test("Admin and Developer inherit every capability", () => {
  for (const id of ["1", "2"]) {
    const operator = policy.fromDiscordRoleIds([id]);
    assert.deepEqual(new Set(operator.capabilities), new Set(Object.values(CAPABILITIES)));
  }
});

test("OS needs additive roles for Indicators and Journal", () => {
  const operator = policy.fromDiscordRoleIds(["3", "4"]);
  assert.equal(policy.can(operator, CAPABILITIES.BASE), true);
  assert.equal(policy.can(operator, CAPABILITIES.INDICATORS), true);
  assert.equal(policy.can(operator, CAPABILITIES.JOURNAL), false);
  assert.equal(policy.can(operator, CAPABILITIES.ADMIN), false);
});

test("module roles alone do not grant base access", () => {
  assert.equal(policy.hasBaseAccess(policy.fromDiscordRoleIds(["4", "5"])), false);
});
```

- [ ] **Step 4: Implement access constants, configuration validation, and the role policy**

```js
// src/models/access.js
export const ROLES = Object.freeze({
  DEVELOPER: "Developer", ADMIN: "Admin", OS: "OS", INDICATORS: "Indicators", JOURNAL: "Journal",
});

export const CAPABILITIES = Object.freeze({
  BASE: "base", INDICATORS: "indicators", JOURNAL: "journal", ADMIN: "admin",
});

export const ACCESS_ERRORS = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
  ACCOUNT_BANNED: "ACCOUNT_BANNED",
  ROLE_SYNC_FAILED: "ROLE_SYNC_FAILED",
});
```

Implement `readAuthConfig` with an allowlist for both modes, a positive numeric refresh interval, trimmed comma-separated demo roles, required production secret, and all nine required Discord values: client ID, secret, redirect URI, guild ID, and five role IDs. Implement `createRolePolicy` with no implicit role-name matching in Discord mode: compare exact configured role IDs, then calculate capabilities from the normalized names.

- [ ] **Step 5: Run the focused tests**

Run: `node --test tests/unit/auth-config.test.js tests/unit/role-policy.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit the configuration and policy boundary**

```bash
git add src/models/access.js src/config/auth-config.js src/services/role-policy.js tests/unit/auth-config.test.js tests/unit/role-policy.test.js
git commit -m "feat: add authentication role policy"
```

---

### Task 2: Temporary Repository Boundaries

**Files:**
- Create: `src/repositories/in-memory-user-repository.js`
- Create: `src/repositories/in-memory-ban-repository.js`
- Create: `src/repositories/in-memory-session-registry.js`
- Create: `src/repositories/in-memory-indicator-request-repository.js`
- Create: `tests/unit/in-memory-auth-repositories.test.js`
- Create: `tests/unit/in-memory-indicator-request-repository.test.js`

**Interfaces:**
- Produces: `createInMemoryUserRepository({ now })` with `upsert`, `findById`, and `list`.
- Produces: `createInMemoryBanRepository({ now })` with `ban`, `unban`, `findByUserId`, `isBanned`, and `list`.
- Produces: `createInMemorySessionRegistry()` with `register`, `unregister`, `listSessionIds`, `activeCount`, and `clearUser`.
- Produces: `createInMemoryIndicatorRequestRepository({ now })` with `upsertPending`, `findByUserId`, `list`, and `decide`.
- Every returned object is a defensive copy; caller mutation cannot alter stored records.

- [ ] **Step 1: Write failing repository tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryUserRepository } from "../../src/repositories/in-memory-user-repository.js";
import { createInMemoryBanRepository } from "../../src/repositories/in-memory-ban-repository.js";
import { createInMemorySessionRegistry } from "../../src/repositories/in-memory-session-registry.js";

test("user upsert preserves first sign-in and updates the role snapshot", () => {
  const users = createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  users.upsert({ id: "42", username: "first", roles: ["OS"], capabilities: ["base"] });
  users.upsert({ id: "42", username: "renamed", roles: ["OS", "Indicators"], capabilities: ["base", "indicators"] });
  const record = users.findById("42");
  assert.equal(record.username, "renamed");
  assert.equal(record.firstSeenAt, "2026-09-02T12:00:00.000Z");
  assert.deepEqual(record.roles, ["OS", "Indicators"]);
});

test("ban records actor and session registry clears all indexed sessions", () => {
  const bans = createInMemoryBanRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  const sessions = createInMemorySessionRegistry();
  sessions.register("42", "sid-a");
  sessions.register("42", "sid-b");
  assert.equal(sessions.activeCount("42"), 2);
  bans.ban({ userId: "42", actorId: "7", reason: "Manual administrative ban" });
  assert.equal(bans.isBanned("42"), true);
  assert.deepEqual(sessions.clearUser("42"), ["sid-a", "sid-b"]);
});
```

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryIndicatorRequestRepository } from "../../src/repositories/in-memory-indicator-request-repository.js";

test("one pending request per user is updated instead of duplicated", () => {
  const repository = createInMemoryIndicatorRequestRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_one", indicatorIds: ["demo-a"] });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_two", indicatorIds: ["demo-a", "demo-b"] });
  assert.equal(repository.list().length, 1);
  assert.equal(repository.findByUserId("42").tradingViewUsername, "tv_two");
  assert.equal(repository.findByUserId("42").status, "PENDING");
});

test("decisions record the administrator and decision time", () => {
  const repository = createInMemoryIndicatorRequestRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_one", indicatorIds: ["demo-a"] });
  const decided = repository.decide({ userId: "42", status: "GRANTED", actorId: "7" });
  assert.equal(decided.status, "GRANTED");
  assert.equal(decided.decidedBy, "7");
  assert.equal(decided.decidedAt, "2026-09-02T12:00:00.000Z");
});
```

- [ ] **Step 2: Run the repository tests and confirm they fail because modules are absent**

Run: `node --test tests/unit/in-memory-auth-repositories.test.js tests/unit/in-memory-indicator-request-repository.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement each focused in-memory repository**

Use a private `Map` in each repository. Normalize IDs with `String(value)`, copy arrays on write and read, sort user/request lists by most recent timestamp descending, and throw stable validation errors for missing records or invalid decisions. The only valid request decisions are `GRANTED` and `DENIED`.

```js
export function createInMemorySessionRegistry() {
  const byUser = new Map();
  return {
    register(userId, sessionId) {
      const key = String(userId);
      const ids = byUser.get(key) ?? new Set();
      ids.add(String(sessionId));
      byUser.set(key, ids);
    },
    unregister(userId, sessionId) {
      const ids = byUser.get(String(userId));
      ids?.delete(String(sessionId));
      if (ids?.size === 0) byUser.delete(String(userId));
    },
    listSessionIds(userId) { return [...(byUser.get(String(userId)) ?? [])]; },
    activeCount(userId) { return byUser.get(String(userId))?.size ?? 0; },
    clearUser(userId) {
      const key = String(userId);
      const ids = [...(byUser.get(key) ?? [])];
      byUser.delete(key);
      return ids;
    },
  };
}
```

- [ ] **Step 4: Run focused repository tests**

Run: `node --test tests/unit/in-memory-auth-repositories.test.js tests/unit/in-memory-indicator-request-repository.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit repository boundaries**

```bash
git add src/repositories tests/unit/in-memory-auth-repositories.test.js tests/unit/in-memory-indicator-request-repository.test.js
git commit -m "feat: add temporary access repositories"
```

---

### Task 3: Discord OAuth Provider and Authentication Service

**Files:**
- Create: `src/providers/discord-oauth-provider.js`
- Modify: `src/services/auth-service.js`
- Create: `tests/unit/discord-oauth-provider.test.js`
- Modify: `tests/unit/auth-service.test.js`

**Interfaces:**
- Consumes: `AuthConfig`, the role policy, user repository, and ban repository.
- Produces: `createDiscordOAuthProvider(config)` with `buildAuthorizationUrl`, `exchangeCode`, `getCurrentUser`, `getCurrentGuildMember`, `refreshAccessToken`, and `revokeToken`.
- Produces: `createAuthService(dependencies)` with `authenticateDemo`, `beginDiscord`, `completeDiscord`, `refreshOperator`, and `revokeOperatorToken`.
- `Operator` is `{ id, username, displayName, avatarUrl, authMode, roles, capabilities, rolesSyncedAt, discordAuth }`.

- [ ] **Step 1: Write failing Discord provider tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDiscordOAuthProvider } from "../../src/providers/discord-oauth-provider.js";

test("authorization URL requests only identity and member scopes", () => {
  const provider = createDiscordOAuthProvider({
    clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/callback", guildId: "guild",
    fetchImpl: async () => { throw new Error("unexpected fetch"); },
  });
  const url = new URL(provider.buildAuthorizationUrl({ state: "state-value" }));
  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "identify guilds.members.read");
  assert.equal(url.searchParams.get("state"), "state-value");
});

test("token and profile requests keep credentials in server requests", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth2/token")) return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 604800 });
    if (String(url).endsWith("/users/@me")) return Response.json({ id: "42", username: "omen", global_name: "Omen" });
    return Response.json({ roles: ["role-os", "role-indicators"] });
  };
  const provider = createDiscordOAuthProvider({ clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/callback", guildId: "guild", fetchImpl });
  const token = await provider.exchangeCode({ code: "code" });
  const identity = await provider.getCurrentUser({ accessToken: token.accessToken });
  const member = await provider.getCurrentGuildMember({ accessToken: token.accessToken });
  assert.equal(identity.id, "42");
  assert.deepEqual(member.roles, ["role-os", "role-indicators"]);
  assert.match(calls[0].options.body.toString(), /grant_type=authorization_code/);
  assert.doesNotMatch(calls[0].url, /secret|code/);
});
```

- [ ] **Step 2: Run the provider tests and observe the missing implementation failure**

Run: `node --test tests/unit/discord-oauth-provider.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the Discord API v10 provider**

Use `URL`/`URLSearchParams`, `Content-Type: application/x-www-form-urlencoded`, Bearer authorization for user/member reads, and an abort timeout. Convert non-2xx, timeout, and malformed JSON outcomes into a typed `DiscordProviderError` with a safe `code`; do not include response bodies or token values in messages.

```js
const API_BASE = "https://discord.com/api/v10";

export class DiscordProviderError extends Error {
  constructor(code) {
    super("Discord authentication is temporarily unavailable");
    this.name = "DiscordProviderError";
    this.code = code;
  }
}
```

- [ ] **Step 4: Replace the demo-only auth-service tests with mode-aware failing tests**

```js
const rolePolicy = createRolePolicy({ roleIds: { Developer: "role-dev", Admin: "role-admin", OS: "role-os", Indicators: "role-indicators", Journal: "role-journal" } });
const userRepository = createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" });

test("Discord completion rejects banned users before creating an operator", async () => {
  const service = createAuthService({
    mode: "discord",
    discordProvider: {
      exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: "2026-09-03T12:00:00.000Z" }),
      getCurrentUser: async () => ({ id: "42", username: "omen", displayName: "Omen", avatarUrl: null }),
      getCurrentGuildMember: async () => ({ roles: ["role-os"] }),
    },
    rolePolicy,
    userRepository,
    banRepository: { isBanned: (id) => id === "42" },
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  });
  await assert.rejects(() => service.completeDiscord({ code: "code" }), { code: "ACCOUNT_BANNED" });
});

test("refresh replaces roles and capabilities from Discord membership", async () => {
  const service = createAuthService({
    mode: "discord",
    discordProvider: { getCurrentGuildMember: async () => ({ roles: ["role-os", "role-journal"] }) },
    rolePolicy,
    userRepository,
    banRepository: { isBanned: () => false },
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  });
  const refreshed = await service.refreshOperator({ id: "42", discordAuth: { accessToken: "a" } });
  assert.deepEqual(refreshed.roles, ["OS", "Journal"]);
  assert.deepEqual(refreshed.capabilities, ["base", "journal"]);
});
```

- [ ] **Step 5: Implement the authentication orchestrator**

Keep blank-credential validation for demo mode. Normalize demo IDs as `demo:${username.toLowerCase()}`. `completeDiscord` must exchange the code, fetch user and member in parallel after token exchange, reject banned identities and identities without base access, persist the safe user snapshot, and retain token data only in `operator.discordAuth`. `refreshOperator` must refresh expired tokens before reading membership and return a complete replacement operator.

- [ ] **Step 6: Run provider and authentication tests**

Run: `node --test tests/unit/discord-oauth-provider.test.js tests/unit/auth-service.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit Discord provider and authentication orchestration**

```bash
git add src/providers/discord-oauth-provider.js src/services/auth-service.js tests/unit/discord-oauth-provider.test.js tests/unit/auth-service.test.js
git commit -m "feat: add Discord authentication provider"
```

---

### Task 4: Secure Mode-Aware Login and Session Lifecycle

**Files:**
- Create: `src/security/csrf.js`
- Modify: `src/controllers/auth-controller.js`
- Modify: `src/routes/auth-routes.js`
- Modify: `src/app.js`
- Modify: `src/server.js`
- Modify: `views/layouts/login.ejs`
- Modify: `views/layouts/app.ejs`
- Modify: `public/js/login-controller.js`
- Modify: `public/js/app-shell.js`
- Modify: `tests/integration/auth-routes.test.js`
- Modify: `tests/integration/production-config.test.js`
- Create: `tests/unit/csrf.test.js`
- Create: `tests/helpers/auth-test-helpers.js`
- Create: `tests/helpers/http-test-helpers.js`

**Interfaces:**
- Consumes: auth config, auth service, session registry, and the Express session store.
- Produces: `ensureCsrfToken(req) -> string` and `requireCsrf(req, res, next)`.
- Adds routes `GET /auth/discord`, `GET /auth/discord/callback`, and `GET /auth/complete` while retaining demo `POST /auth/login` and `POST /auth/logout`.
- `createApp` accepts injected `authConfig`, `authService`, repositories, registry, and session store.
- Produces test helpers `createTestApp`, `loginDemo`, `readCsrfToken`, `createDemoAuthConfig`, `createDiscordAuthConfig`, and `createJsonResponseHarness`.

- [ ] **Step 1: Write failing OAuth route and session tests with a local configuration harness**

```js
function createTestApp({ authMode = "demo", authService } = {}) {
  const authConfig = authMode === "discord"
    ? {
        mode: "discord", sessionSecret: "test-secret", demoRoles: [], roleRefreshMs: 300_000,
        discord: {
          clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/auth/discord/callback", guildId: "guild",
          roleIds: { Developer: "role-dev", Admin: "role-admin", OS: "role-os", Indicators: "role-indicators", Journal: "role-journal" },
        },
      }
    : { mode: "demo", sessionSecret: "test-secret", demoRoles: ["Developer"], roleRefreshMs: 300_000, discord: null };
  return createApp({ environment: "test", sessionSecret: "test-secret", authConfig, authService });
}

const discordOperator = {
  id: "42", username: "omen", displayName: "Omen", avatarUrl: null, authMode: "discord",
  roles: ["OS", "Indicators"], capabilities: ["base", "indicators"], rolesSyncedAt: "2026-09-02T12:00:00.000Z",
  discordAuth: { accessToken: "access", refreshToken: "refresh", expiresAt: "2026-09-03T12:00:00.000Z" },
};

test("Discord login stores state and redirects to the provider", async () => {
  const authService = { beginDiscord: () => ({ state: "state-value", authorizationUrl: "https://discord.com/oauth2/authorize?state=state-value" }) };
  const app = createTestApp({ authMode: "discord", authService });
  const agent = request.agent(app);
  const response = await agent.get("/auth/discord").expect(302);
  assert.match(response.headers.location, /^https:\/\/discord\.com\/oauth2\/authorize/);
});

test("Discord callback rejects a mismatched state without authenticating", async () => {
  const authService = { beginDiscord: () => ({ state: "correct", authorizationUrl: "/discord" }), completeDiscord: async () => { throw new Error("must not run"); } };
  const agent = request.agent(createTestApp({ authMode: "discord", authService }));
  await agent.get("/auth/discord").expect(302);
  await agent.get("/auth/discord/callback?code=code&state=wrong").expect(302).expect("Location", "/login?error=invalid_oauth_state");
  await agent.get("/home").expect(302).expect("Location", "/login");
});

test("successful Discord callback regenerates the session and renders completion sequence", async () => {
  const authService = { beginDiscord: () => ({ state: "correct", authorizationUrl: "/discord" }), completeDiscord: async () => discordOperator };
  const agent = request.agent(createTestApp({ authMode: "discord", authService }));
  await agent.get("/auth/discord");
  await agent.get("/auth/discord/callback?code=code&state=correct").expect(302).expect("Location", "/auth/complete");
  await agent.get("/auth/complete").expect(200).expect(/data-auth-complete/);
  await agent.get("/home").expect(200).expect(/Omen/);
});
```

- [ ] **Step 2: Run the focused auth integration tests and observe route failures**

Run: `node --test tests/integration/auth-routes.test.js tests/integration/production-config.test.js`

Expected: FAIL because the new Discord routes and mode validation do not exist.

- [ ] **Step 3: Add deterministic integration-test helpers**

```js
// tests/helpers/auth-test-helpers.js
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../../src/app.js";

export const TEST_ROLE_IDS = Object.freeze({
  Developer: "role-dev", Admin: "role-admin", OS: "role-os", Indicators: "role-indicators", Journal: "role-journal",
});

export function createDemoAuthConfig(demoRoles = ["Developer"]) {
  return { mode: "demo", sessionSecret: "test-secret", demoRoles, roleRefreshMs: 300_000, discord: null };
}

export function createDiscordAuthConfig(overrides = {}) {
  return {
    mode: "discord", sessionSecret: "test-secret", demoRoles: [], roleRefreshMs: 300_000,
    discord: {
      clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/auth/discord/callback", guildId: "guild",
      roleIds: TEST_ROLE_IDS, ...overrides,
    },
  };
}

export function createTestApp({ authMode = "demo", demoRoles = ["Developer"], discord = {}, ...appOptions } = {}) {
  const authConfig = authMode === "discord" ? createDiscordAuthConfig(discord) : createDemoAuthConfig(demoRoles);
  return createApp({ environment: "test", sessionSecret: "test-secret", authConfig, ...appOptions });
}

export async function loginDemo(app, { username = "operator", passkey = "preview" } = {}) {
  const agent = request.agent(app);
  await agent.post("/auth/login").send({ username, passkey }).expect(200);
  return agent;
}

export async function readCsrfToken(agent, path) {
  const response = await agent.get(path).expect(200);
  const match = response.text.match(/<meta name="csrf-token" content="([^"]+)">/);
  assert.ok(match, "expected a CSRF metadata token");
  return match[1];
}
```

```js
// tests/helpers/http-test-helpers.js
export function createJsonResponseHarness() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(location) { this.statusCode = 302; this.location = location; return this; },
  };
}
```

- [ ] **Step 4: Write and run failing CSRF tests**

```js
test("requireCsrf accepts the session token only from body or header", () => {
  const token = "csrf-value";
  const accepted = [];
  requireCsrf({ session: { csrfToken: token }, body: {}, get: (name) => name === "X-CSRF-Token" ? token : undefined }, {}, () => accepted.push(true));
  assert.deepEqual(accepted, [true]);
});

test("requireCsrf returns a stable 403 response for a mismatch", () => {
  const response = createJsonResponseHarness();
  requireCsrf({ session: { csrfToken: "expected" }, body: { _csrf: "wrong" }, get: () => undefined }, response, () => assert.fail("next called"));
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { error: "CSRF_INVALID", message: "REQUEST REJECTED :: SESSION TOKEN INVALID" });
});
```

- [ ] **Step 5: Implement session-bound CSRF and mode-aware auth routes**

Generate 32 random bytes as base64url once per session and compare tokens with `timingSafeEqual` after equal-length checks. Regenerate the session after demo or Discord authentication, then set `operator`, a new CSRF token, and register the new `sessionID` under the user. Consume OAuth state before any provider call. On logout, unregister the session, attempt provider token revocation, and always destroy the local session.

Expose the session token to authenticated full-page views only through escaped metadata, and reuse that stable value across fragment swaps:

```ejs
<meta name="csrf-token" content="<%= csrfToken %>">
```

`app-shell.js` reads this metadata and sends `X-CSRF-Token` with logout. Indicator and Admin browser controllers use the same header. Server-rendered fallback forms receive `csrfToken` from `res.locals` and include it as `_csrf`.

- [ ] **Step 6: Render exact demo, Discord, and completion login states**

```ejs
<% if (authMode === "discord") { %>
  <a class="btn btn-primary btn-login" href="/auth/discord" data-discord-login>[ CONTINUE WITH DISCORD ]</a>
<% } else if (complete) { %>
  <div data-auth-complete data-redirect-to="/home"></div>
<% } else { %>
  <form class="login-form" action="/auth/login" method="post" novalidate data-login-form>
    <label class="field">USER<input name="username" type="text" required data-login-user></label>
    <label class="field">PASSKEY<input name="passkey" type="password" required data-login-passkey></label>
    <div class="login-err" hidden data-login-error></div>
    <button class="btn btn-primary btn-login" type="submit" data-login-submit>[ LOGIN ]</button>
  </form>
<% } %>
```

Refactor the existing Matrix grant sequence so it can start from a successful demo response or the Discord completion marker without duplicating animation code.

- [ ] **Step 7: Wire config and dependencies in `createApp` and `server.js`**

Create an explicit default `MemoryStore` when no injected store is present so Admin services can invalidate sessions. Preserve all current dependency injection and production cookie/trust-proxy behavior. `server.js` reads and validates auth configuration before listening; integration tests inject deterministic configuration and provider fakes.

- [ ] **Step 8: Run auth, production, and login animation tests**

Run: `node --test tests/integration/auth-routes.test.js tests/integration/production-config.test.js tests/unit/csrf.test.js tests/unit/login-sequence.test.js tests/unit/login-sphere-integration.test.js`

Expected: all tests PASS.

- [ ] **Step 9: Commit secure login and session lifecycle**

```bash
git add src/security/csrf.js src/controllers/auth-controller.js src/routes/auth-routes.js src/app.js src/server.js views/layouts/login.ejs views/layouts/app.ejs public/js/login-controller.js public/js/app-shell.js tests/integration/auth-routes.test.js tests/integration/production-config.test.js tests/unit/csrf.test.js tests/helpers/auth-test-helpers.js tests/helpers/http-test-helpers.js
git commit -m "feat: add mode-aware Discord login"
```

---

### Task 5: Role Refresh, Capability Middleware, and Denied Transition

**Files:**
- Create: `src/middleware/refresh-roles.js`
- Create: `src/middleware/require-capability.js`
- Modify: `src/middleware/require-auth.js`
- Modify: `src/models/navigation.js`
- Modify: `src/models/view-models.js`
- Modify: `src/routes/page-routes.js`
- Modify: `src/routes/journal-routes.js`
- Modify: `src/controllers/page-controller.js`
- Modify: `views/partials/sidebar.ejs`
- Modify: `views/partials/statusbar.ejs`
- Modify: `views/pages/home.ejs`
- Modify: `public/js/navigation-controller.js`
- Modify: `public/js/transition-controller.js`
- Modify: `tests/unit/navigation.test.js`
- Modify: `tests/unit/navigation-controller.test.js`
- Create: `tests/unit/access-middleware.test.js`
- Create: `tests/integration/role-access-routes.test.js`

**Interfaces:**
- Consumes: `Operator.capabilities`, auth service refresh, role refresh interval, and session registry.
- Produces: `createRefreshRoles({ authService, refreshAfterMs, sessionRegistry })`.
- Produces: `requireCapability(capability)` returning Express middleware.
- Adds navigation route `{ key: "admin", title: "ADMIN", path: "/admin", uri: "admin", view: "admin", capability: "admin" }`.
- Adds structured denial `{ error: "INSUFFICIENT_PERMISSIONS", message: "ACCESS FAILED :: INSUFFICIENT PERMISSIONS" }`.

- [ ] **Step 1: Write failing middleware and route-access tests**

```js
test("requireCapability returns JSON 403 for a denied fragment", () => {
  const response = createJsonResponseHarness();
  requireCapability(CAPABILITIES.INDICATORS)(
    { session: { operator: { capabilities: [CAPABILITIES.BASE] } }, isSynergyModuleFragment: true, path: "/indicators" },
    response,
    () => assert.fail("next called"),
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "INSUFFICIENT_PERMISSIONS");
});

test("Admin can open every module while OS receives 403 for modular fragments", async () => {
  const admin = await loginDemo(createTestApp({ demoRoles: ["Admin"] }), { username: "admin" });
  const os = await loginDemo(createTestApp({ demoRoles: ["OS"] }), { username: "member" });
  for (const path of ["/indicators", "/journal", "/admin"]) await admin.get(path).expect(200);
  for (const path of ["/indicators", "/journal", "/admin"]) {
    await os.get(path).set("X-Synergy-Module-Fragment", "1").expect(403).expect(/INSUFFICIENT_PERMISSIONS/);
  }
});

test("stale Discord roles are refreshed and revoked base access destroys the session", async () => {
  const authService = { refreshOperator: async () => { const error = new Error("revoked"); error.code = "ACCESS_REVOKED"; throw error; } };
  const app = createTestApp({
    authMode: "discord",
    authService,
    configureRoutes(expressApp) {
      expressApp.get("/__test/session", (req, res) => {
        req.session.operator = {
          id: "42", username: "omen", authMode: "discord", roles: ["OS"], capabilities: ["base"],
          rolesSyncedAt: "2026-09-02T11:50:00.000Z", discordAuth: { accessToken: "access" },
        };
        res.sendStatus(204);
      });
    },
  });
  const agent = request.agent(app);
  await agent.get("/__test/session").expect(204);
  await agent.get("/home").expect(302).expect("Location", "/login?error=access_revoked");
  await agent.get("/home").expect(302).expect("Location", "/login");
});
```

- [ ] **Step 2: Run focused access tests and observe missing middleware and route failures**

Run: `node --test tests/unit/access-middleware.test.js tests/integration/role-access-routes.test.js`

Expected: FAIL because capability enforcement is not implemented.

- [ ] **Step 3: Implement role refresh and unified capability enforcement**

Run `requireAuth`, then role refresh, then route-specific capability middleware. For denied full requests, store `req.session.accessNotice = "ACCESS FAILED :: INSUFFICIENT PERMISSIONS"` and redirect to `/home`. Consume the notice once when building the next full Home view. For fragments and `/api/` requests, return JSON 403 without rendering protected views.

- [ ] **Step 4: Add capability metadata and keep all navigation visible**

```js
const ROUTES = [
  { key: "home", title: "HOME", path: "/home", uri: "home", view: "home", capability: CAPABILITIES.BASE },
  { key: "indicators", title: "INDICATORS", path: "/indicators", uri: "indicators", view: "indicators", capability: CAPABILITIES.INDICATORS },
  { key: "market-news", title: "MARKET NEWS", path: "/market-news", uri: "market-news", view: "market-news", capability: CAPABILITIES.BASE },
  { key: "alerts-ict", title: "ALERTS :: ICT", path: "/alerts/ict", uri: "alerts/ict", view: "alerts-ict", capability: CAPABILITIES.BASE },
  { key: "alerts-sr", title: "ALERTS :: S&R", path: "/alerts/support-resistance", uri: "alerts/support-resistance", view: "alerts-sr", capability: CAPABILITIES.BASE },
  { key: "journal", title: "JOURNAL", path: "/journal", uri: "journal", view: "journal-index", capability: CAPABILITIES.JOURNAL },
  { key: "admin", title: "ADMIN", path: "/admin", uri: "admin", view: "admin", capability: CAPABILITIES.ADMIN },
];
```

The sidebar iterates over every navigation entry. It may include `data-required-capability` for diagnostics but must not use it to authorize or hide links.

- [ ] **Step 5: Write a failing denied-navigation interaction test**

```js
test("403 navigation holds the overlay, reports permission failure, and keeps route history", async () => {
  const { dom, controller, transitionCalls, toasts } = createHarness({
    fetchImpl: async () => Response.json({ error: "INSUFFICIENT_PERMISSIONS", message: "ACCESS FAILED :: INSUFFICIENT PERMISSIONS" }, { status: 403 }),
  });
  const originalPath = dom.window.location.pathname;
  await controller.navigate("/admin");
  assert.equal(dom.window.location.pathname, originalPath);
  assert.match(dom.window.document.querySelector("[data-main]").textContent, /HOME/);
  assert.deepEqual(transitionCalls.at(-1), ["fail", "ACCESS FAILED :: INSUFFICIENT PERMISSIONS"]);
  assert.deepEqual(toasts, ["ACCESS FAILED :: INSUFFICIENT PERMISSIONS"]);
});
```

- [ ] **Step 6: Implement the exact denied transition**

Add a dedicated `403` branch before generic response handling. Hold the overlay until at least 900 ms in normal motion or 120 ms in reduced motion, call `transition.fail(ACCESS_DENIED_MESSAGE)`, show the same toast, schedule overlay removal, and return without parsing a fragment, swapping content, setting the document title, or pushing history.

- [ ] **Step 7: Run navigation, middleware, and route tests**

Run: `node --test tests/unit/access-middleware.test.js tests/unit/navigation.test.js tests/unit/navigation-controller.test.js tests/unit/transition-controller.test.js tests/integration/role-access-routes.test.js tests/integration/page-routes.test.js`

Expected: all tests PASS.

- [ ] **Step 8: Commit authorization and denied-navigation behavior**

```bash
git add src/middleware src/models/navigation.js src/models/view-models.js src/routes/page-routes.js src/routes/journal-routes.js src/controllers/page-controller.js views/partials/sidebar.ejs views/partials/statusbar.ejs views/pages/home.ejs public/js/navigation-controller.js public/js/transition-controller.js tests/unit tests/integration/role-access-routes.test.js tests/integration/page-routes.test.js
git commit -m "feat: enforce modular role access"
```

---

### Task 6: Indicator Catalog and Request-All Workflow

**Files:**
- Create: `src/config/indicator-catalog.js`
- Create: `src/services/indicator-access-service.js`
- Create: `src/controllers/indicator-controller.js`
- Create: `src/routes/indicator-routes.js`
- Replace: `views/pages/indicators.ejs`
- Create: `public/js/indicators/indicator-access-controller.js`
- Modify: `public/js/app-shell.js`
- Modify: `public/css/synergy-module.css`
- Create: `tests/unit/indicator-access-service.test.js`
- Create: `tests/unit/indicator-access-controller.test.js`
- Create: `tests/integration/indicator-routes.test.js`
- Modify: `tests/integration/fidelity-markup.test.js`

**Interfaces:**
- Consumes: operator, CSRF token, catalog, request repository, and Indicators capability middleware.
- Produces: `createIndicatorCatalog({ authMode }) -> frozen Indicator[]`.
- Produces: `createIndicatorAccessService({ catalog, requestRepository, now })` with `getMemberView(userId)` and `requestAll(input)`.
- Adds `GET /indicators` and `POST /api/indicator-access/requests`.
- Client initializer: `initializeIndicatorAccessPage(root, { fetchImpl, showToast }) -> { dispose }`.

- [ ] **Step 1: Write failing catalog and service tests**

```js
function createIndicatorHarness() {
  const now = () => "2026-09-02T12:00:00.000Z";
  const catalog = createIndicatorCatalog({ authMode: "demo" });
  const requestRepository = createInMemoryIndicatorRequestRepository({ now });
  const operator = { id: "42", username: "omen", displayName: "Omen" };
  const service = createIndicatorAccessService({ catalog, requestRepository, now });
  return { catalog, requestRepository, operator, service };
}

test("demo catalog entries are explicitly labeled and immutable", () => {
  const { catalog } = createIndicatorHarness();
  assert.ok(catalog.length >= 2);
  assert.ok(catalog.every((indicator) => indicator.demo === true && indicator.name.startsWith("DEMO ::")));
  assert.throws(() => { catalog[0].name = "changed"; }, TypeError);
});

test("request all validates consent and stores every active indicator", () => {
  const { service, catalog, operator } = createIndicatorHarness();
  assert.throws(() => service.requestAll({ operator, tradingViewUsername: "valid_user", consent: false }), { code: "CONSENT_REQUIRED" });
  const request = service.requestAll({ operator, tradingViewUsername: "valid_user", consent: true });
  assert.equal(request.status, "PENDING");
  assert.deepEqual(request.indicatorIds, catalog.filter((item) => item.active).map((item) => item.id));
});

test("resubmission corrects the username and returns a decided request to pending", () => {
  const { service, requestRepository, operator } = createIndicatorHarness();
  service.requestAll({ operator, tradingViewUsername: "first_user", consent: true });
  requestRepository.decide({ userId: operator.id, status: "DENIED", actorId: "admin" });
  const request = service.requestAll({ operator, tradingViewUsername: "second_user", consent: true });
  assert.equal(request.tradingViewUsername, "second_user");
  assert.equal(request.status, "PENDING");
});
```

- [ ] **Step 2: Run service tests and observe missing-module failures**

Run: `node --test tests/unit/indicator-access-service.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the demo catalog and request service**

Seed these local-only entries so no production access is implied:

```js
const DEMO_INDICATORS = [
  { id: "demo-market-structure", name: "DEMO :: MARKET STRUCTURE", description: "Demonstration catalog record for structure analysis.", tradingViewUrl: null, version: "demo", active: true, demo: true },
  { id: "demo-liquidity-map", name: "DEMO :: LIQUIDITY MAP", description: "Demonstration catalog record for liquidity visualization.", tradingViewUrl: null, version: "demo", active: true, demo: true },
];
```

Accept TradingView usernames matching `/^[A-Za-z0-9_-]{3,64}$/`. Reject no active catalog with `INDICATORS_UNAVAILABLE`, missing consent with `CONSENT_REQUIRED`, and invalid usernames with `TRADINGVIEW_USERNAME_INVALID`.

- [ ] **Step 4: Write failing Indicators route tests**

```js
test("Indicators page renders identity, catalog, request state, and CSRF field", async () => {
  const agent = await loginDemo(createTestApp({ demoRoles: ["OS", "Indicators"] }));
  await agent.get("/indicators").expect(200)
    .expect(/data-indicator-access-root/)
    .expect(/DEMO :: MARKET STRUCTURE/)
    .expect(/NOT REQUESTED/)
    .expect(/name="_csrf"/);
});

test("request API creates one pending all-indicator request", async () => {
  const agent = await loginDemo(createTestApp({ demoRoles: ["OS", "Indicators"] }));
  const csrf = await readCsrfToken(agent, "/indicators");
  await agent.post("/api/indicator-access/requests")
    .set("X-CSRF-Token", csrf)
    .send({ tradingViewUsername: "omen_trader", consent: true })
    .expect(201)
    .expect(({ body }) => {
      assert.equal(body.request.status, "PENDING");
      assert.equal(body.request.indicatorIds.length, 2);
    });
});
```

- [ ] **Step 5: Implement Indicators MVC routes and terminal page**

Render a single route section containing identity/sync metadata, request status, open catalog rows, TradingView username, explicit request checkbox, and one submit action. Use semantic labels, a live status region, and a standard form action for progressive fallback. Show script links only for `GRANTED` requests and only when a catalog URL is non-null.

```ejs
<form action="/api/indicator-access/requests" method="post" data-indicator-request-form>
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <label class="field">TRADINGVIEW USERNAME
    <input name="tradingViewUsername" value="<%= page.data.request?.tradingViewUsername ?? '' %>" required maxlength="64">
  </label>
  <label class="terminal-check"><input name="consent" type="checkbox" value="true" required> I EXPLICITLY REQUEST ACCESS TO EVERY ACTIVE SCRIPT</label>
  <button class="btn btn-primary" type="submit">[ REQUEST ACCESS TO ALL ]</button>
</form>
```

- [ ] **Step 6: Write failing browser-controller tests and implement progressive enhancement**

Test that submission sends JSON with the CSRF header, prevents overlapping submissions, renders `PENDING` using `textContent`, and reports safe validation failures without replacing the route. Register `initializeIndicatorAccessPage` in `app-shell.js` for the `indicators` route and return a disposer that removes listeners and aborts an active request.

- [ ] **Step 7: Style Indicators states responsively**

Add purpose-specific classes using existing colors, borders, mono fonts, and spacing tokens. Use an open table/list layout rather than nested generic cards. Below the current mobile breakpoint, stack catalog metadata and keep the request button full-width. Do not alter global terminal or transition styling.

- [ ] **Step 8: Run the Indicators test slice**

Run: `node --test tests/unit/indicator-access-service.test.js tests/unit/indicator-access-controller.test.js tests/integration/indicator-routes.test.js tests/integration/fidelity-markup.test.js tests/unit/app-shell.test.js`

Expected: all tests PASS.

- [ ] **Step 9: Commit the Indicators workflow**

```bash
git add src/config/indicator-catalog.js src/services/indicator-access-service.js src/controllers/indicator-controller.js src/routes/indicator-routes.js views/pages/indicators.ejs public/js/indicators public/js/app-shell.js public/css/synergy-module.css tests/unit/indicator-access-service.test.js tests/unit/indicator-access-controller.test.js tests/integration/indicator-routes.test.js tests/integration/fidelity-markup.test.js tests/unit/app-shell.test.js
git commit -m "feat: add indicator access requests"
```

---

### Task 7: Temporary-Memory Admin Panel

**Files:**
- Create: `src/services/admin-service.js`
- Create: `src/controllers/admin-controller.js`
- Create: `src/routes/admin-routes.js`
- Create: `views/pages/admin.ejs`
- Create: `public/js/admin/admin-controller.js`
- Modify: `src/app.js`
- Modify: `public/js/app-shell.js`
- Modify: `public/css/synergy-module.css`
- Create: `tests/unit/admin-service.test.js`
- Create: `tests/unit/admin-controller.test.js`
- Create: `tests/integration/admin-routes.test.js`
- Modify: `tests/unit/app-shell.test.js`

**Interfaces:**
- Consumes: user, ban, session, and request repositories; Express session store; catalog; Admin capability middleware; and CSRF middleware.
- Produces: `createAdminService(dependencies)` with `getDashboard`, `signOutUser`, `banUser`, `unbanUser`, and `decideIndicatorRequest`.
- Adds `GET /admin`, `POST /api/admin/users/:id/sign-out`, `POST /api/admin/users/:id/ban`, `POST /api/admin/users/:id/unban`, and `POST /api/admin/indicator-requests/:userId/decision`.
- Client initializer: `initializeAdminPage(root, { fetchImpl, showToast, windowRef }) -> { dispose }`.

- [ ] **Step 1: Write failing Admin service tests**

```js
function createAdminServiceHarness() {
  const now = () => "2026-09-02T12:00:00.000Z";
  const userRepository = createInMemoryUserRepository({ now });
  const banRepository = createInMemoryBanRepository({ now });
  const sessionRegistry = createInMemorySessionRegistry();
  const requestRepository = createInMemoryIndicatorRequestRepository({ now });
  const catalog = createIndicatorCatalog({ authMode: "demo" });
  const destroyed = [];
  const sessionStore = { destroy(sessionId, callback) { destroyed.push(sessionId); callback(); } };
  const service = createAdminService({ userRepository, banRepository, sessionRegistry, requestRepository, sessionStore, catalog, now });
  return { service, userRepository, banRepository, sessionRegistry, requestRepository, destroyed };
}

test("sign out destroys every indexed session and keeps future login allowed", async () => {
  const { service, banRepository, sessionRegistry, destroyed } = createAdminServiceHarness();
  sessionRegistry.register("42", "sid-a");
  sessionRegistry.register("42", "sid-b");
  await service.signOutUser({ userId: "42", actorId: "7" });
  assert.deepEqual(new Set(destroyed), new Set(["sid-a", "sid-b"]));
  assert.equal(banRepository.isBanned("42"), false);
  assert.equal(sessionRegistry.activeCount("42"), 0);
});

test("ban records the actor before invalidating sessions", async () => {
  const { service, banRepository } = createAdminServiceHarness();
  const result = await service.banUser({ userId: "42", actorId: "7", reason: "Policy violation" });
  assert.equal(result.banned, true);
  assert.equal(banRepository.findByUserId("42").actorId, "7");
});

test("an administrator cannot ban their own identity", async () => {
  const { service } = createAdminServiceHarness();
  await assert.rejects(() => service.banUser({ userId: "7", actorId: "7", reason: "self" }), { code: "SELF_BAN_FORBIDDEN" });
});
```

- [ ] **Step 2: Run Admin service tests and observe the missing-module failure**

Run: `node --test tests/unit/admin-service.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement Admin aggregation and promisified session destruction**

`getDashboard` joins safe user records with current ban state, active session counts, and sorted requests. `destroySession` wraps `sessionStore.destroy(sessionId, callback)` in a Promise. Destroy all known sessions even when one destroy fails, then throw one safe aggregate error if any failed. Ban before session destruction so a race cannot establish another permitted session between both operations.

- [ ] **Step 4: Write failing Admin route tests**

```js
function createAdminRouteHarness(demoRoles = ["Admin"]) {
  const now = () => "2026-09-02T12:00:00.000Z";
  const userRepository = createInMemoryUserRepository({ now });
  const banRepository = createInMemoryBanRepository({ now });
  const sessionRegistry = createInMemorySessionRegistry();
  const indicatorRequestRepository = createInMemoryIndicatorRequestRepository({ now });
  userRepository.upsert({ id: "42", username: "member", displayName: "Member", roles: ["OS", "Indicators"], capabilities: ["base", "indicators"] });
  indicatorRequestRepository.upsertPending({ userId: "42", discordUsername: "member", tradingViewUsername: "member_tv", indicatorIds: ["demo-market-structure"] });
  return {
    app: createTestApp({ demoRoles, userRepository, banRepository, sessionRegistry, indicatorRequestRepository }),
    userRepository, banRepository, sessionRegistry, indicatorRequestRepository,
  };
}

test("Admin page renders memory warning, users, requests, and mutation tokens", async () => {
  const { app } = createAdminRouteHarness(["Admin"]);
  const agent = await loginDemo(app, { username: "admin" });
  await agent.get("/admin").expect(200)
    .expect(/TEMPORARY MEMORY MODE/)
    .expect(/data-admin-root/)
    .expect(/data-admin-users/)
    .expect(/data-admin-requests/)
    .expect(/name="_csrf"/);
});

test("OS cannot mutate Admin resources", async () => {
  const { app } = createAdminRouteHarness(["OS"]);
  const agent = await loginDemo(app, { username: "member" });
  await agent.post("/api/admin/users/42/ban").send({ _csrf: "anything", reason: "blocked" }).expect(403).expect(/INSUFFICIENT_PERMISSIONS/);
});

test("Admin can ban, unban, sign out, and decide an indicator request", async () => {
  const { app } = createAdminRouteHarness(["Admin"]);
  const admin = await loginDemo(app, { username: "admin" });
  const csrf = await readCsrfToken(admin, "/admin");
  await admin.post("/api/admin/users/42/ban").set("X-CSRF-Token", csrf).send({ reason: "Policy violation" }).expect(200).expect(({ body }) => assert.equal(body.user.banned, true));
  await admin.post("/api/admin/users/42/unban").set("X-CSRF-Token", csrf).expect(200).expect(({ body }) => assert.equal(body.user.banned, false));
  await admin.post("/api/admin/users/42/sign-out").set("X-CSRF-Token", csrf).expect(200);
  await admin.post("/api/admin/indicator-requests/42/decision").set("X-CSRF-Token", csrf).send({ status: "GRANTED" }).expect(200).expect(({ body }) => assert.equal(body.request.status, "GRANTED"));
});
```

- [ ] **Step 5: Implement Admin MVC routes and page**

Render two open terminal tables/rails: `USER MANAGEMENT` and `INDICATOR ACCESS REQUESTS`. Include stable row data attributes, exact role/capability output, timestamps as `<time datetime>`, confirmation prompts, and POST forms with CSRF fields for non-JavaScript fallback. Disable self-ban in markup and enforce it again in the service.

- [ ] **Step 6: Write failing Admin browser-controller tests and implement actions**

Test confirmation cancellation, CSRF headers, double-submit prevention, row state changes using `textContent`, safe errors, self sign-out redirect, and disposer abort behavior. Event delegation should handle buttons with `data-admin-action` and derive endpoints only from server-rendered data attributes; never construct an action from user-visible text.

- [ ] **Step 7: Style desktop and mobile Admin views**

Keep the existing terminal palette and sharp panel geometry. Desktop uses dense aligned rows; mobile converts each row into a labeled record with no horizontal page overflow. Destructive actions use the existing danger treatment, and decision actions retain clear focus-visible states.

- [ ] **Step 8: Run the Admin test slice**

Run: `node --test tests/unit/admin-service.test.js tests/unit/admin-controller.test.js tests/integration/admin-routes.test.js tests/unit/app-shell.test.js tests/integration/fidelity-markup.test.js`

Expected: all tests PASS.

- [ ] **Step 9: Commit the Admin panel**

```bash
git add src/services/admin-service.js src/controllers/admin-controller.js src/routes/admin-routes.js views/pages/admin.ejs public/js/admin public/js/app-shell.js public/css/synergy-module.css src/app.js tests/unit/admin-service.test.js tests/unit/admin-controller.test.js tests/integration/admin-routes.test.js tests/unit/app-shell.test.js tests/integration/fidelity-markup.test.js
git commit -m "feat: add temporary user administration"
```

---

### Task 8: Environment Templates, Documentation, and End-to-End Verification

**Files:**
- Create locally, ignored: `.env`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `start-synergy-module.bat`
- Modify: `tests/integration/server-config.test.js`

**Interfaces:**
- Consumes: all completed authentication, authorization, Indicators, and Admin functionality.
- Produces: a local demo configuration that starts on `127.0.0.1:4173` and a safe committed template for Discord setup.

- [ ] **Step 1: Write the ignored local environment file through the repository editing workflow**

Use these exact non-secret local values:

```text
AUTH_MODE=demo
SESSION_SECRET=synergy-module-local-v0-1-2-change-before-hosting
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

Confirm with `git status --short --ignored .env` that Git reports `!! .env`, never `?? .env`.

- [ ] **Step 2: Update `.env.example` and README with exact setup guidance**

Document how to create the Discord application, register the exact callback URI, copy guild/role IDs with Discord Developer Mode, switch `AUTH_MODE`, generate a production session secret, and restart. State that a bot is not required and that users authorize `identify` plus `guilds.members.read`. Explain the temporary-memory reset behavior and the manual TradingView Manage Access step. Preserve the Economicium public API documentation and version `v0.1.2`.

- [ ] **Step 3: Make the Windows launcher honor `.env` and verify startup**

Keep dependency installation behavior intact. Ensure the launcher starts the existing `npm start` command, which loads `.env`, and opens `http://127.0.0.1:4173`. Update its displayed authentication mode/status copy without printing secret values.

- [ ] **Step 4: Run formatting and secret checks**

Run:

```powershell
git diff --check
git status --short --ignored .env
rg -n "DISCORD_CLIENT_SECRET=.+|access_token|refresh_token" --glob "!node_modules/**" --glob "!.git/**" .
```

Expected: no diff errors; `.env` is ignored; source contains only provider field names/test fixtures and no real token or secret value.

- [ ] **Step 5: Run the complete automated suite**

Run: `npm test`

Expected: every test PASS with zero failures, cancellations, or skipped tests.

- [ ] **Step 6: Restart the local server in demo mode and verify HTTP readiness**

Run the app on the `.env` host/port and request `http://127.0.0.1:4173/login`.

Expected: HTTP 200 and the login page identifies `v0.1.2` without printing any environment secret.

- [ ] **Step 7: Verify the complete desktop interaction path in the in-app browser**

At the current desktop viewport:

1. Sign in through demo mode.
2. Confirm the Matrix/glitch grant sequence completes.
3. Open Home, Market News, Alerts, Journal, Indicators, and Admin through fragment navigation.
4. Submit a valid TradingView username and explicit consent; confirm status becomes `PENDING` without a full-page flash.
5. In Admin, mark the request `GRANTED`; return to Indicators and confirm the granted state.
6. Create a second demo identity under the same Developer configuration, sign it out from Admin, and verify its next protected request returns to login.
7. Ban and unban the second identity; verify banned authentication is rejected and unbanned authentication succeeds.
8. Restart temporarily with `DEMO_ROLES=OS`, select Indicators/Admin/Journal, and confirm each transition pauses, shows `ACCESS FAILED :: INSUFFICIENT PERMISSIONS`, retains the source page, and leaves browser history unchanged. Restore the documented `.env` roles and restart after this check.
9. Confirm Market News still loads its live public calendar and filters.
10. Inspect browser console errors and warnings; expected result is none attributable to the application.

- [ ] **Step 8: Verify mobile layout and reduced motion**

At a mobile-sized viewport, inspect Login, Indicators, and Admin. Confirm no horizontal page overflow, every field has a visible label, Admin actions remain reachable, and dense rows become readable stacked records. Enable reduced motion and confirm login and permission denial complete quickly without losing their final status.

- [ ] **Step 9: Review the implementation against the approved spec**

Check every Included, Excluded, Request Protection, Error Handling, and Verification item in `docs/superpowers/specs/2026-09-02-discord-rbac-indicator-access-design.md`. Confirm no bot, TradingView scraper, undocumented TradingView endpoint, database dependency, hidden navigation item, or production demo fallback was introduced.

- [ ] **Step 10: Commit docs and final compatibility updates**

```bash
git add .env.example README.md start-synergy-module.bat tests/integration/server-config.test.js
git commit -m "docs: add Discord authentication setup"
```

- [ ] **Step 11: Run final branch verification before publishing**

Run:

```powershell
npm test
git diff --check
git status --short --branch
git log --oneline -8
```

Expected: all tests PASS, no diff errors, only `.env` remains ignored, and the branch contains focused commits for policy, repositories, Discord auth, RBAC/navigation, Indicators, Admin, and documentation.
