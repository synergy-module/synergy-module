import assert from "node:assert/strict";
import test from "node:test";
import session from "express-session";
import request from "supertest";
import { beginTestDiscordLogin, createDiscordAuthConfig, createTestApp } from "../helpers/auth-test-helpers.js";

const guildId = "1554634103997861889", requiredRoleId = "1554903899343814857";
const storeCall = (store, method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, value) => error ? reject(error) : resolve(value)));

function fixture({ roles = [requiredRoleId], accessPolicy = "beta-role", sessionStore = new session.MemoryStore(), required = true, guild = guildId } = {}) {
  const membership = { roles, error: null, checks: 0 };
  const authConfig = createDiscordAuthConfig({ accessPolicy, guildId: guild, ...(required ? { requiredRoleId } : {}) });
  authConfig.roleRefreshMs = 60_000;
  const app = createTestApp({ authConfig, appEnvironment: "beta", sessionStore, logger: { warn() {}, error() {} },
    discordProvider: {
      buildAuthorizationUrl: ({ state }) => `https://discord.test/authorize?state=${state}`,
      exchangeCode: async () => ({ accessToken: "test-access", refreshToken: "test-refresh", expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      getCurrentUser: async () => ({ id: "operator", username: "operator" }),
      getCurrentGuildMember: async () => { membership.checks++; if (membership.error) throw membership.error; return { roles: membership.roles }; },
    },
  });
  return { app, membership, sessionStore };
}

async function login(app, agent = request.agent(app)) {
  const { callbackPath } = await beginTestDiscordLogin(app, { agent });
  return { agent, response: await agent.get(callbackPath) };
}

test("the required Discord role gates beta access and cannot be replaced by another role or Administrator", async () => {
  for (const roles of [[], ["role-dev"], ["role-admin"], ["SynergyModule"], ["unrelated-role"]]) {
    const { app } = fixture({ roles });
    const { agent, response } = await login(app);
    assert.equal(response.status, 302); assert.equal(response.headers.location, "/login?error=access_revoked");
    assert.equal(app.locals.userRepository.findById("operator"), null);
    await agent.get("/brain").expect(302).expect("Location", "/login");
    await agent.get("/api/brain/state").expect(401);
  }
  const { app } = fixture({ accessPolicy: "roles", roles: ["role-dev"] });
  assert.equal((await login(app)).response.headers.location, "/login?error=access_revoked");
});

test("a member with the exact role enters the existing workspace and stores a guild-bound admission grant", async () => {
  const { app, membership } = fixture();
  const { agent, response } = await login(app);
  assert.equal(response.headers.location, "/auth/complete");
  await agent.get("/auth/complete").expect(200);
  await agent.get("/home").expect(200);
  await agent.get("/brain").expect(200);
  await agent.get("/api/brain/state").expect(200);
  const snapshot = app.locals.userRepository.findById("operator");
  assert.equal(snapshot.requiredRoleGrant, `${guildId}:${requiredRoleId}:beta-role`);
  assert.equal(snapshot.discordAuth, undefined);
  assert.equal(membership.checks, 1, "fresh role verification is shared by the session's protected requests");
});

test("fresh legacy, other-guild, and changed-policy sessions cannot retain access after the gate is installed", async () => {
  for (const previous of [
    { required: false, accessPolicy: "beta-guild" },
    { guild: "1253355545809649735" },
    { accessPolicy: "beta-guild" },
  ]) {
    const sessionStore = new session.MemoryStore();
    const old = fixture({ ...previous, sessionStore });
    const { response } = await login(old.app);
    assert.equal(response.headers.location, "/auth/complete");
    const cookie = response.headers["set-cookie"][0].split(";", 1)[0];
    const current = fixture({ sessionStore });
    await request(current.app).get("/api/brain/state").set("Cookie", cookie).expect(401);
    await request(current.app).get("/home").set("Cookie", cookie).expect(302).expect("Location", "/login");
    assert.equal(current.membership.checks, 0, "an unmatched grant is rejected before trusting a fresh snapshot");
  }
});

test("role removal, leaving the guild, or failed Discord verification revoke the session at its next one-minute refresh", async () => {
  for (const failure of ["role-removed", "left-guild", "unavailable"]) {
    const { app, sessionStore, membership } = fixture();
    const { agent } = await login(app);
    const sessions = await storeCall(sessionStore, "all");
    const [sid, stored] = Object.entries(sessions).find(([, value]) => value.operator);
    stored.operator.rolesSyncedAt = new Date(Date.now() - 60_001).toISOString();
    await storeCall(sessionStore, "set", sid, stored);
    if (failure === "role-removed") membership.roles = ["role-dev", "role-admin"];
    else membership.error = Object.assign(new Error("Membership unavailable"), { code: failure === "left-guild" ? "DISCORD_HTTP_ERROR" : "DISCORD_TIMEOUT" });
    const response = await agent.get("/api/brain/state").expect(401);
    assert.equal(response.body.loginUrl, failure === "role-removed" ? "/login?error=access_revoked" : "/login?error=role_sync_failed");
    await agent.get("/home").expect(302).expect("Location", "/login");
    assert.equal(await storeCall(sessionStore, "get", sid), undefined);
    membership.roles = [requiredRoleId]; membership.error = null;
    assert.equal((await login(app, agent)).response.headers.location, "/auth/complete");
  }
});

test("a nonmember cannot authenticate even if they hold that role in another server", async () => {
  const { app, membership } = fixture();
  membership.error = Object.assign(new Error("Not a guild member"), { code: "DISCORD_HTTP_ERROR" });
  assert.equal((await login(app)).response.headers.location, "/login?error=discord_auth_failed");
});
