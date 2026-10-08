import assert from "node:assert/strict";
import test from "node:test";
import session from "express-session";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDiscordAuthConfig } from "../helpers/auth-test-helpers.js";

test("every environment rejects explicitly configured demo authentication", () => {
  for (const environment of ["development", "test", "production"]) {
    assert.throws(
      () => createApp({ environment, authConfig: { mode: "demo" }, sessionStore: new session.MemoryStore() }),
      /Discord authentication is required; AUTH_MODE must be discord/,
    );
  }
});

test("production still requires an explicitly injected session store", () => {
  assert.throws(
    () => createApp({ environment: "production", authConfig: createDiscordAuthConfig() }),
    /sessionStore is required in production/,
  );
});

test("injected Discord configuration requires the same credentials and role IDs as startup", () => {
  for (const [field, expectedKey] of [
    ["clientId", "DISCORD_CLIENT_ID"], ["clientSecret", "DISCORD_CLIENT_SECRET"],
    ["redirectUri", "DISCORD_REDIRECT_URI"], ["guildId", "DISCORD_GUILD_ID"],
  ]) {
    assert.throws(() => createApp({
      environment: "test", authConfig: createDiscordAuthConfig({ [field]: " " }),
    }), new RegExp(expectedKey));
  }
  assert.throws(() => createApp({
    environment: "test", authConfig: createDiscordAuthConfig({ roleIds: {} }),
  }), /DISCORD_ROLE_DEVELOPER_ID.*DISCORD_ROLE_JOURNAL_ID/);
  assert.throws(() => createApp({
    environment: "test", authConfig: createDiscordAuthConfig({ accessPolicy: "public" }),
  }), /DISCORD_ACCESS_POLICY must be roles or beta-guild/);
});

test("injected beta guild policy requires explicit beta context and still requires Discord credentials", () => {
  const authConfig = createDiscordAuthConfig({ accessPolicy: "beta-guild", roleIds: {} });
  for (const appEnvironment of ["", "development", "production"]) {
    assert.throws(() => createApp({ environment: "test", appEnvironment, authConfig }),
      /only allowed with APP_ENVIRONMENT=beta/);
  }
  const app = createApp({ environment: "test", appEnvironment: "beta", authConfig });
  assert.equal(app.locals.authConfig.discord.accessPolicy, "beta-guild");
  assert.throws(() => createApp({
    environment: "test", appEnvironment: "beta",
    authConfig: { ...authConfig, discord: { ...authConfig.discord, clientSecret: "" } },
  }), /DISCORD_CLIENT_SECRET/);
});

test("injected role refresh defaults to five minutes, caps larger values, and rejects invalid intervals", () => {
  for (const [roleRefreshMs, expected] of [[undefined, 300_000], [60_000, 60_000], [3_600_000, 300_000]]) {
    const app = createApp({
      environment: "test", authConfig: { ...createDiscordAuthConfig(), roleRefreshMs },
    });
    assert.equal(app.locals.authConfig.roleRefreshMs, expected);
  }
  for (const roleRefreshMs of [0, -1, NaN, Infinity, null, "300000"]) {
    assert.throws(() => createApp({
      environment: "test", authConfig: { ...createDiscordAuthConfig(), roleRefreshMs },
    }), /roleRefreshMs must be a positive number/);
  }
});

test("injected production secrets are trimmed and cannot be blank", () => {
  assert.throws(() => createApp({
    environment: "production", sessionSecret: " ", authConfig: createDiscordAuthConfig(),
    sessionStore: new session.MemoryStore(),
  }), /SESSION_SECRET is required in production/);
  const app = createApp({
    environment: "test", sessionSecret: " padded-test-secret ", authConfig: createDiscordAuthConfig(),
  });
  assert.equal(app.locals.authConfig.sessionSecret, "padded-test-secret");
});

test("createApp retains an explicit MemoryStore for session invalidation", () => {
  const defaultStoreApp = createApp({ environment: "test", authConfig: createDiscordAuthConfig() });
  assert.ok(defaultStoreApp.locals.sessionStore instanceof session.MemoryStore);

  const injectedStore = new session.MemoryStore();
  const injectedStoreApp = createApp({ environment: "test", authConfig: createDiscordAuthConfig(), sessionStore: injectedStore });
  assert.equal(injectedStoreApp.locals.sessionStore, injectedStore);
});

test("production config trusts the configured proxy and emits HTTPS-only session cookies", async () => {
  const app = createApp({
    environment: "production",
    authConfig: createDiscordAuthConfig(),
    authService: { beginDiscord: () => ({ state: "state", authorizationUrl: "/provider" }) },
    sessionStore: new session.MemoryStore(),
    trustProxy: 1,
  });

  assert.equal(app.get("trust proxy"), 1);
  const response = await request(app).get("/auth/discord").set("X-Forwarded-Proto", "https").expect(302);
  assert.match(response.headers["set-cookie"][0], /Secure/);
});
