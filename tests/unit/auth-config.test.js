import test from "node:test";
import assert from "node:assert/strict";
import { readAuthConfig } from "../../src/config/auth-config.js";

const discordEnvironment = {
  AUTH_MODE: "discord",
  SESSION_SECRET: "test-secret",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_REDIRECT_URI: "http://localhost/auth/discord/callback",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_ROLE_DEVELOPER_ID: "developer-id",
  DISCORD_ROLE_ADMIN_ID: "admin-id",
  DISCORD_ROLE_OS_ID: "os-id",
  DISCORD_ROLE_INDICATORS_ID: "indicators-id",
  DISCORD_ROLE_JOURNAL_ID: "journal-id",
};

test("Discord is the default authentication and parses refresh minutes", () => {
  const config = readAuthConfig({
    env: { ...discordEnvironment, AUTH_MODE: "", DISCORD_ROLE_REFRESH_MINUTES: "5" },
    nodeEnvironment: "development",
  });

  assert.equal(config.mode, "discord");
  assert.equal(config.discord.roleIds.Developer, "developer-id");
  assert.equal(config.roleRefreshMs, 300_000);
});

test("role refresh configuration cannot exceed the five-minute authorization ceiling", () => {
  const config = readAuthConfig({
    env: {
      ...discordEnvironment,
      DISCORD_ROLE_REFRESH_MINUTES: "60",
    },
    nodeEnvironment: "development",
  });

  assert.equal(config.roleRefreshMs, 300_000);
});

test("every environment rejects demo mode", () => {
  for (const nodeEnvironment of [undefined, "development", "test", "production"]) {
    assert.throws(() => readAuthConfig({
      env: { AUTH_MODE: "demo", SESSION_SECRET: "test-secret" },
      nodeEnvironment,
    }), /Discord authentication is required; AUTH_MODE must be discord/);
  }
});

test("missing local configuration cannot fall back to demo access", () => {
  assert.throws(() => readAuthConfig({ env: {}, nodeEnvironment: "development" }),
    /Missing required Discord configuration: DISCORD_CLIENT_ID/);
});

test("discord mode reports every missing required value", () => {
  assert.throws(() => readAuthConfig({
    env: { AUTH_MODE: "discord", SESSION_SECRET: "test-secret" },
    nodeEnvironment: "development",
  }), /DISCORD_CLIENT_ID.*DISCORD_CLIENT_SECRET.*DISCORD_GUILD_ID/s);
});

test("production requires a nonblank session secret", () => {
  assert.throws(() => readAuthConfig({
    env: { ...discordEnvironment, SESSION_SECRET: " " },
    nodeEnvironment: "production",
  }), /SESSION_SECRET is required in production/);
});

test("configuration rejects unsupported authentication modes", () => {
  assert.throws(() => readAuthConfig({
    env: { AUTH_MODE: "local" },
    nodeEnvironment: "development",
  }), /AUTH_MODE must be discord/);
});

test("production rejects the former Authentik mode", () => {
  assert.throws(() => readAuthConfig({
    env: { AUTH_MODE: "proxy", SESSION_SECRET: "proxy-secret", DISCORD_ROLE_REFRESH_MINUTES: "5" },
    nodeEnvironment: "production",
  }), /AUTH_MODE must be discord/);
});

test("configuration rejects a nonpositive role refresh interval", () => {
  assert.throws(() => readAuthConfig({
    env: { ...discordEnvironment, DISCORD_ROLE_REFRESH_MINUTES: "0" },
    nodeEnvironment: "development",
  }), /DISCORD_ROLE_REFRESH_MINUTES must be a positive number/);
});

test("discord configuration maps all required values", () => {
  const config = readAuthConfig({ env: discordEnvironment, nodeEnvironment: "production" });

  assert.deepEqual(config, {
    mode: "discord",
    sessionSecret: "test-secret",
    roleRefreshMs: 300_000,
    discord: {
      accessPolicy: "roles",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost/auth/discord/callback",
      guildId: "guild-id",
      roleIds: {
        Developer: "developer-id",
        Admin: "admin-id",
        OS: "os-id",
        Indicators: "indicators-id",
        Journal: "journal-id",
      },
    },
  });
});

test("beta guild preview requires explicit beta selection and still requires Discord credentials", () => {
  const env = {
    ...discordEnvironment, APP_ENVIRONMENT: "beta", DISCORD_ACCESS_POLICY: "beta-guild",
    DISCORD_ROLE_DEVELOPER_ID: "", DISCORD_ROLE_ADMIN_ID: "", DISCORD_ROLE_OS_ID: "",
    DISCORD_ROLE_INDICATORS_ID: "", DISCORD_ROLE_JOURNAL_ID: "",
  };
  assert.equal(readAuthConfig({ env, nodeEnvironment: "production" }).discord.accessPolicy, "beta-guild");
  for (const environment of ["production", "", "development"]) {
    assert.throws(() => readAuthConfig({ env: { ...env, APP_ENVIRONMENT: environment } }), /only allowed with APP_ENVIRONMENT=beta/);
  }
  assert.throws(() => readAuthConfig({ env: { ...env, DISCORD_CLIENT_SECRET: "" } }), /DISCORD_CLIENT_SECRET/);
  assert.throws(() => readAuthConfig({ env: { ...env, DISCORD_ACCESS_POLICY: "roles" } }), /DISCORD_ROLE_DEVELOPER_ID/);
  assert.throws(() => readAuthConfig({ env: { ...env, DISCORD_ACCESS_POLICY: "public" } }), /DISCORD_ACCESS_POLICY must be/);
});
