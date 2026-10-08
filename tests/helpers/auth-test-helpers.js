import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../../src/app.js";

export const TEST_ROLE_IDS = Object.freeze({
  Developer: "role-dev",
  Admin: "role-admin",
  OS: "role-os",
  Indicators: "role-indicators",
  Journal: "role-journal",
});

export function createDiscordAuthConfig(overrides = {}) {
  return {
    mode: "discord", sessionSecret: "test-secret", roleRefreshMs: 300_000,
    discord: {
      clientId: "client", clientSecret: "secret", redirectUri: "http://localhost/auth/discord/callback", guildId: "guild",
      roleIds: TEST_ROLE_IDS, ...overrides,
    },
  };
}

const testLogins = new WeakMap();
const TEST_INDICATORS = Object.freeze([
  { id: "demo-market-structure", name: "DEMO :: MARKET STRUCTURE", description: "Demonstration catalog record for structure analysis.", tradingViewUrl: null, version: "demo", active: true, demo: true },
  { id: "demo-liquidity-map", name: "DEMO :: LIQUIDITY MAP", description: "Demonstration catalog record for liquidity visualization.", tradingViewUrl: null, version: "demo", active: true, demo: true },
].map(Object.freeze));

// The fake lives entirely in the test harness. Production requests still use the
// application's OAuth state, session regeneration, membership and role checks.
function createTestDiscordProvider({ roles, roleIds }) {
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  function issueTokens(identity) {
    const accessToken = `test-access-${randomUUID()}`;
    const refreshToken = `test-refresh-${randomUUID()}`;
    accessTokens.set(accessToken, identity);
    refreshTokens.set(refreshToken, identity);
    return { accessToken, refreshToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  }
  function requireIdentity(records, key) {
    assert.ok(records.has(key), "expected a registered test OAuth credential");
    return records.get(key);
  }
  return {
    issueCode(username) {
      const code = `test-code-${randomUUID()}`;
      codes.set(code, Object.freeze({
        id: `discord:${username.toLowerCase()}`, username, displayName: username, avatarUrl: null,
      }));
      return code;
    },
    provider: {
      buildAuthorizationUrl({ state }) {
        const url = new URL("https://discord.test/oauth2/authorize");
        url.searchParams.set("state", state);
        return url.href;
      },
      async exchangeCode({ code }) {
        const identity = requireIdentity(codes, code);
        codes.delete(code);
        return issueTokens(identity);
      },
      async getCurrentUser({ accessToken }) { return requireIdentity(accessTokens, accessToken); },
      async getCurrentGuildMember({ accessToken }) {
        requireIdentity(accessTokens, accessToken);
        return { roles: roles.map((role) => roleIds[role]).filter(Boolean) };
      },
      async refreshAccessToken({ refreshToken }) {
        const identity = requireIdentity(refreshTokens, refreshToken);
        refreshTokens.delete(refreshToken);
        return issueTokens(identity);
      },
      async revokeToken({ token }) { accessTokens.delete(token); refreshTokens.delete(token); },
    },
  };
}

export function createTestApp({ roles = ["Developer"], discord = {}, authMode: _authMode, ...appOptions } = {}) {
  const authConfig = appOptions.authConfig ?? createDiscordAuthConfig(discord);
  const fixture = createTestDiscordProvider({ roles: [...roles], roleIds: authConfig.discord?.roleIds ?? TEST_ROLE_IDS });
  const app = createApp({
    environment: "test", sessionSecret: "test-secret", authConfig,
    discordProvider: fixture.provider, indicatorCatalog: TEST_INDICATORS, ...appOptions,
  });
  testLogins.set(app, fixture.issueCode);
  return app;
}

export async function beginTestDiscordLogin(app, { username = "operator", agent = request.agent(app) } = {}) {
  const issueCode = testLogins.get(app);
  assert.ok(issueCode, "use createTestApp to obtain the test-only Discord provider");
  const beginResponse = await agent.get("/auth/discord").expect(302);
  const state = new URL(beginResponse.headers.location).searchParams.get("state");
  assert.ok(state, "Discord authorization redirect must carry OAuth state");
  const code = issueCode(username.trim());
  const callbackPath = `/auth/discord/callback?${new URLSearchParams({ code, state })}`;
  return { agent, beginResponse, code, state, callbackPath };
}

export async function loginTestOperator(app, options = {}) {
  const { agent, callbackPath } = await beginTestDiscordLogin(app, options);
  await agent.get(callbackPath).expect(302).expect("Location", "/auth/complete");
  return agent;
}

export async function readCsrfToken(agent, path) {
  const response = await agent.get(path).expect(200);
  const match = response.text.match(/<meta name="csrf-token" content="([^"]+)">/);
  assert.ok(match, "expected a CSRF metadata token");
  return match[1];
}
