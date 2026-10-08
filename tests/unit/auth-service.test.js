import test from "node:test";
import assert from "node:assert/strict";
import { createAuthService } from "../../src/services/auth-service.js";
import { createRolePolicy } from "../../src/services/role-policy.js";
import { createInMemoryUserRepository } from "../../src/repositories/in-memory-user-repository.js";

const rolePolicy = createRolePolicy({
  roleIds: {
    Developer: "role-dev",
    Admin: "role-admin",
    OS: "role-os",
    Indicators: "role-indicators",
    Journal: "role-journal",
  },
});
const now = () => new Date("2026-09-02T12:00:00.000Z");

test("beta guild preview requires live membership on login and refresh, and still enforces bans", async () => {
  let member = true;
  let banned = false;
  const service = createAuthService({
    mode: "discord", discordAccessPolicy: "beta-guild", rolePolicy, now,
    banRepository: { isBanned: () => banned },
    discordProvider: {
      exchangeCode: async () => ({ accessToken: "access", expiresAt: "2099-01-01T00:00:00Z" }),
      getCurrentUser: async () => ({ id: "42", username: "member", displayName: "Member" }),
      getCurrentGuildMember: async () => {
        if (!member) throw Object.assign(new Error("Not a guild member"), { code: "DISCORD_HTTP_ERROR" });
        return { roles: [] };
      },
    },
  });
  const operator = await service.completeDiscord({ code: "code" });
  assert.deepEqual(operator.roles, ["Developer"]);
  assert.deepEqual(new Set(operator.capabilities), new Set(["base", "indicators", "journal", "admin"]));
  assert.equal((await service.refreshOperator(operator)).authMode, "discord");
  member = false;
  await assert.rejects(() => service.completeDiscord({ code: "code" }), { code: "DISCORD_HTTP_ERROR" });
  await assert.rejects(() => service.refreshOperator(operator), { code: "DISCORD_HTTP_ERROR" });
  member = true;
  banned = true;
  await assert.rejects(() => service.completeDiscord({ code: "code" }), { code: "ACCOUNT_BANNED" });
  await assert.rejects(() => service.refreshOperator(operator), { code: "ACCOUNT_BANNED" });
});

test("authentication service exposes only Discord and rejects alternate modes", () => {
  const service = createAuthService();
  assert.equal(service.authenticateDemo, undefined);
  assert.equal(service.authenticate, undefined);
  for (const mode of ["demo", "proxy", "local", ""]) {
    assert.throws(() => createAuthService({ mode }), /AUTH_MODE must be discord/);
  }
});

test("non-Discord operators cannot pass admission or be converted by refresh", async () => {
  let providerCalls = 0;
  const service = createAuthService({
    rolePolicy,
    discordProvider: { getCurrentGuildMember: async () => { providerCalls++; return { roles: ["role-dev"] }; } },
  });
  for (const authMode of ["demo", "proxy", "local", undefined]) {
    const operator = { id: "old-identity", authMode, roles: ["Developer"], capabilities: ["base", "admin"] };
    await assert.rejects(() => service.assertOperatorAdmission(operator), { code: "ACCESS_REVOKED" });
    await assert.rejects(() => service.refreshOperator(operator), { code: "ACCESS_REVOKED" });
  }
  assert.equal(providerCalls, 0);
});

test("Discord authentication rejects module-only roles before persisting an operator", async () => {
  for (const roles of [["role-indicators"], ["role-journal"], ["role-indicators", "role-journal"]]) {
    const userRepository = createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" });
    const service = createAuthService({
      discordProvider: {
        exchangeCode: async () => ({ accessToken: "access" }),
        getCurrentUser: async () => ({ id: "module-user", username: "module_user" }),
        getCurrentGuildMember: async () => ({ roles }),
      },
      rolePolicy,
      userRepository,
      banRepository: { isBanned: () => false },
      now,
    });

    await assert.rejects(
      () => service.completeDiscord({ code: "code" }),
      { code: "ACCESS_REVOKED" },
    );
    assert.equal(userRepository.findById("module-user"), null);
  }
});

test("Discord completion creates a role-backed operator and confines tokens to it", async () => {
  const userRepository = createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  const service = createAuthService({
    mode: "discord",
    discordProvider: {
      exchangeCode: async () => ({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: "2026-09-03T12:00:00.000Z",
      }),
      getCurrentUser: async () => ({
        id: "42",
        username: "omen",
        displayName: "Omen",
        avatarUrl: "https://cdn.discordapp.com/avatars/42/avatar.png",
      }),
      getCurrentGuildMember: async () => ({ roles: ["role-os", "role-indicators"] }),
    },
    rolePolicy,
    userRepository,
    banRepository: { isBanned: () => false },
    now,
  });

  const operator = await service.completeDiscord({ code: "code" });

  assert.deepEqual(operator, {
    id: "42",
    username: "omen",
    displayName: "Omen",
    avatarUrl: "https://cdn.discordapp.com/avatars/42/avatar.png",
    authMode: "discord",
    roles: ["OS", "Indicators"],
    capabilities: ["base", "indicators"],
    rolesSyncedAt: "2026-09-02T12:00:00.000Z",
    lastSignedInAt: "2026-09-02T12:00:00.000Z",
    discordAuth: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2026-09-03T12:00:00.000Z",
    },
  });
  const persisted = userRepository.findById("42");
  assert.equal("discordAuth" in persisted, false);
  assert.doesNotMatch(JSON.stringify(persisted), /access|refresh/);
});

test("Discord completion rejects identities without base access before persistence", async () => {
  const userRepository = createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  const service = createAuthService({
    mode: "discord",
    discordProvider: {
      exchangeCode: async () => ({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: "2026-09-03T12:00:00.000Z",
      }),
      getCurrentUser: async () => ({ id: "42", username: "omen", displayName: "Omen", avatarUrl: null }),
      getCurrentGuildMember: async () => ({ roles: ["role-indicators"] }),
    },
    rolePolicy,
    userRepository,
    banRepository: { isBanned: () => false },
    now,
  });

  await assert.rejects(() => service.completeDiscord({ code: "code" }), { code: "ACCESS_REVOKED" });
  assert.equal(userRepository.findById("42"), null);
});

test("Discord completion rejects banned users before creating an operator", async () => {
  const userRepository = createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  const service = createAuthService({
    mode: "discord",
    discordProvider: {
      exchangeCode: async () => ({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: "2026-09-03T12:00:00.000Z",
      }),
      getCurrentUser: async () => ({
        id: "42",
        username: "omen",
        displayName: "Omen",
        avatarUrl: null,
      }),
      getCurrentGuildMember: async () => ({ roles: ["role-os"] }),
    },
    rolePolicy,
    userRepository,
    banRepository: { isBanned: (id) => id === "42" },
    now,
  });

  await assert.rejects(() => service.completeDiscord({ code: "code" }), { code: "ACCOUNT_BANNED" });
  assert.equal(userRepository.findById("42"), null);
});

test("refresh replaces roles and capabilities from Discord membership", async () => {
  let repositoryNow = "2026-09-02T11:00:00.000Z";
  const userRepository = createInMemoryUserRepository({ now: () => repositoryNow });
  userRepository.upsert({
    id: "42", username: "omen", displayName: "Omen", avatarUrl: null, authMode: "discord",
    roles: ["OS"], capabilities: ["base"], rolesSyncedAt: "2026-09-02T11:00:00.000Z",
    lastSignedInAt: "2026-09-01T15:30:00.000Z",
  });
  repositoryNow = "2026-09-02T12:00:00.000Z";
  const service = createAuthService({
    mode: "discord",
    discordProvider: { getCurrentGuildMember: async () => ({ roles: ["role-os", "role-journal"] }) },
    rolePolicy,
    userRepository,
    banRepository: { isBanned: () => false },
    now,
  });

  const refreshed = await service.refreshOperator({
    id: "42",
    username: "omen",
    displayName: "Omen",
    avatarUrl: null,
    authMode: "discord",
    roles: ["Indicators"],
    capabilities: ["indicators"],
    rolesSyncedAt: "2026-09-02T11:00:00.000Z",
    lastSignedInAt: "2026-09-01T15:30:00.000Z",
    discordAuth: { accessToken: "a", refreshToken: "r", expiresAt: "2026-09-03T12:00:00.000Z" },
  });

  assert.deepEqual(refreshed.roles, ["OS", "Journal"]);
  assert.deepEqual(refreshed.capabilities, ["base", "journal"]);
  assert.equal(refreshed.rolesSyncedAt, "2026-09-02T12:00:00.000Z");
  assert.equal(refreshed.lastSignedInAt, "2026-09-01T15:30:00.000Z");
  const persisted = userRepository.findById("42");
  assert.equal(persisted.rolesSyncedAt, "2026-09-02T12:00:00.000Z");
  assert.equal(persisted.lastSeenAt, "2026-09-02T12:00:00.000Z");
  assert.equal(persisted.lastSignedInAt, "2026-09-01T15:30:00.000Z");
});

test("final admission awaits and rechecks bans and base access", async () => {
  let banned = false;
  const service = createAuthService({
    rolePolicy,
    banRepository: { isBanned: () => banned }, now,
  });
  const operator = { id: "late-ban", authMode: "discord", roles: ["OS"], capabilities: ["base"] };

  assert.equal(await service.assertOperatorAdmission(operator), operator);
  banned = true;
  await assert.rejects(() => service.assertOperatorAdmission(operator), { code: "ACCOUNT_BANNED" });
  banned = false;
  await assert.rejects(
    () => service.assertOperatorAdmission({ ...operator, capabilities: ["indicators"] }),
    { code: "ACCESS_REVOKED" },
  );
});

test("refresh exchanges an expired token before replacing Discord membership", async () => {
  const service = createAuthService({
    mode: "discord",
    discordProvider: {
      refreshAccessToken: async () => ({
        accessToken: "renewed-access",
        refreshToken: "renewed-refresh",
        expiresAt: "2026-09-03T12:00:00.000Z",
      }),
      getCurrentGuildMember: async ({ accessToken }) => (
        accessToken === "renewed-access"
          ? { roles: ["role-os"] }
          : { roles: ["role-indicators"] }
      ),
    },
    rolePolicy,
    userRepository: createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" }),
    banRepository: { isBanned: () => false },
    now,
  });

  const refreshed = await service.refreshOperator({
    id: "42",
    username: "omen",
    displayName: "Omen",
    avatarUrl: null,
    authMode: "discord",
    roles: ["OS"],
    capabilities: ["base"],
    rolesSyncedAt: "2026-09-01T12:00:00.000Z",
    discordAuth: {
      accessToken: "expired-access",
      refreshToken: "refresh",
      expiresAt: "2026-09-02T11:59:59.000Z",
    },
  });

  assert.deepEqual(refreshed.roles, ["OS"]);
  assert.deepEqual(refreshed.discordAuth, {
    accessToken: "renewed-access",
    refreshToken: "renewed-refresh",
    expiresAt: "2026-09-03T12:00:00.000Z",
  });
});
