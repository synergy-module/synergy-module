import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import session from "express-session";
import { CAPABILITIES } from "../../src/models/access.js";
import { beginTestDiscordLogin, createDiscordAuthConfig, createTestApp, readCsrfToken } from "../helpers/auth-test-helpers.js";

const guildId = "1554634103997861889", requiredRoleId = "1554903899343814857", adminRoleId = "1557751441693736991";
const storeCall = (store, method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, value) => error ? reject(error) : resolve(value)));

function fixture() {
  const members = new Map([["admin", [requiredRoleId, adminRoleId]], ["member", [requiredRoleId]]]);
  const sessionStore = new session.MemoryStore();
  const authConfig = createDiscordAuthConfig({ accessPolicy: "site-roles", guildId, requiredRoleId,
    roleIds: { Admin: adminRoleId, Developer: "legacy-dev", OS: "", Indicators: "", Journal: "" } });
  authConfig.roleRefreshMs = 60_000;
  let nextIdentity;
  const discordProvider = {
    buildAuthorizationUrl: ({ state }) => `https://discord.test/authorize?state=${state}`,
    exchangeCode: async () => ({ accessToken: nextIdentity, expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
    getCurrentUser: async ({ accessToken }) => ({ id: accessToken, username: accessToken }),
    getCurrentGuildMember: async ({ accessToken }) => ({ roles: members.get(accessToken) ?? [] }),
  };
  const app = createTestApp({ authConfig, sessionStore, discordProvider, logger: { warn() {}, error() {} } });
  return {
    app, members, sessionStore, discordProvider,
    async login(identity, agent = request.agent(app)) {
      nextIdentity = identity;
      const { callbackPath } = await beginTestDiscordLogin(app, { agent });
      return { agent, response: await agent.get(callbackPath) };
    },
    async expireRoles(identity, amend = () => {}) {
      const sessions = await storeCall(sessionStore, "all");
      const [sid, value] = Object.entries(sessions).find(([, value]) => value.operator?.id === identity);
      value.operator.rolesSyncedAt = new Date(Date.now() - 60_001).toISOString();
      amend(value.operator);
      await storeCall(sessionStore, "set", sid, value);
    },
  };
}

test("only the SMA role adds every site capability and an Administration navigation item", async () => {
  const h = fixture();
  const { agent: admin } = await h.login("admin");
  const page = await admin.get("/admin").expect(200);
  assert.match(page.text, /data-nav-key="admin"[^>]*aria-current="page"/);
  assert.match(page.text, /Administration/);
  const operator = h.app.locals.userRepository.findById("admin");
  assert.deepEqual(operator.roles, ["Admin"]);
  assert.deepEqual(new Set(operator.capabilities), new Set(Object.values(CAPABILITIES)));
  assert.equal(operator.requiredRoleGrant, `${guildId}:${requiredRoleId}:site-roles:${adminRoleId}`);

  for (const extra of [[], ["SMA*"], ["legacy-dev"], ["some-other-admin-id"]]) {
    h.members.set("member", [requiredRoleId, ...extra]);
    const { agent } = await h.login("member");
    const home = await agent.get("/home").expect(200);
    assert.doesNotMatch(home.text, /data-nav-key="admin"/);
    await agent.get("/journal").expect(200);
    await agent.get("/research").expect(200);
    await agent.get("/admin").set("X-Synergy-Module-Fragment", "1").expect(403);
    for (const action of ["ban", "unban", "sign-out"]) {
      await agent.post(`/api/admin/users/admin/${action}`).send({}).expect(403)
        .expect(({ body }) => assert.equal(body.error, "INSUFFICIENT_PERMISSIONS"));
    }
  }
});

test("SMA administrators can block sign-in, unban members, and end sessions", async () => {
  const h = fixture();
  const { agent: admin } = await h.login("admin"), { agent: member } = await h.login("member");
  const csrf = await readCsrfToken(admin, "/admin");
  await admin.post("/api/admin/users/member/ban").set("X-CSRF-Token", csrf).send({ reason: "Test access suspension" }).expect(200);
  assert.equal(h.app.locals.banRepository.isBanned("member"), true);
  await member.get("/home").expect(302).expect("Location", "/login");
  h.members.set("member", [requiredRoleId, adminRoleId]);
  assert.equal((await h.login("member", member)).response.headers.location, "/login?error=account_banned", "SMA cannot bypass an account ban");
  await admin.post("/api/admin/users/member/unban").set("X-CSRF-Token", csrf).expect(200);
  assert.equal(h.app.locals.banRepository.isBanned("member"), false);
  assert.equal((await h.login("member", member)).response.headers.location, "/auth/complete");
  await admin.post("/api/admin/users/member/sign-out").set("X-CSRF-Token", csrf).expect(200);
  await member.get("/api/brain/state").expect(401);
});

test("removing SMA removes administration on refresh while preserving membership access", async () => {
  const h = fixture(), { agent } = await h.login("admin");
  const csrf = await readCsrfToken(agent, "/admin");
  h.members.set("admin", [requiredRoleId]);
  await h.expireRoles("admin");
  await agent.post("/api/admin/users/member/ban").set("X-CSRF-Token", csrf).send({ reason: "Must fail" }).expect(403);
  assert.equal(h.app.locals.banRepository.isBanned("member"), false);
  const home = await agent.get("/home").expect(200);
  assert.doesNotMatch(home.text, /data-nav-key="admin"/);
  assert.equal(h.app.locals.userRepository.findById("admin").capabilities.includes("admin"), false);
  h.members.set("admin", [requiredRoleId, adminRoleId]);
  await h.expireRoles("admin");
  await agent.get("/admin").expect(200);
  h.members.set("admin", [adminRoleId]);
  await h.expireRoles("admin");
  await agent.get("/api/brain/state").expect(401).expect(({ body }) => assert.equal(body.loginUrl, "/login?error=access_revoked"));
});

test("SMA alone cannot bypass the required SynergyModule membership role", async () => {
  const h = fixture(); h.members.set("admin", [adminRoleId]);
  assert.equal((await h.login("admin")).response.headers.location, "/login?error=access_revoked");
});

test("old full-preview sessions and changed admin-role mappings cannot retain elevated permissions", async () => {
  const h = fixture(), { response } = await h.login("admin");
  const cookie = response.headers["set-cookie"][0].split(";", 1)[0];
  const changedConfig = structuredClone(h.app.locals.authConfig);
  changedConfig.discord.roleIds.Admin = "1557751441693736992";
  const changed = createTestApp({ authConfig: changedConfig, sessionStore: h.sessionStore, discordProvider: h.discordProvider });
  await request(changed).get("/admin").set("Cookie", cookie).expect(302).expect("Location", "/login?error=access_revoked");
  const { agent } = await h.login("admin");
  await h.expireRoles("admin", (operator) => {
    operator.requiredRoleGrant = `${guildId}:${requiredRoleId}:beta-role`;
    operator.rolesSyncedAt = new Date().toISOString();
    operator.roles = ["Developer"];
  });
  await agent.post("/api/admin/users/member/ban").send({}).expect(401);
  assert.equal(h.app.locals.banRepository.isBanned("member"), false);
});
