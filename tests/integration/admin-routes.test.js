import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import session from "express-session";
import { JSDOM } from "jsdom";
import { createInMemoryBanRepository } from "../../src/repositories/in-memory-ban-repository.js";
import { createInMemoryIndicatorRequestRepository } from "../../src/repositories/in-memory-indicator-request-repository.js";
import { createInMemorySessionRegistry } from "../../src/repositories/in-memory-session-registry.js";
import { createInMemoryUserRepository } from "../../src/repositories/in-memory-user-repository.js";
import { beginTestDiscordLogin, createDiscordAuthConfig, createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

function createAdminRouteHarness(roles = ["Admin"], appOptions = {}) {
  const now = () => "2026-09-02T12:00:00.000Z";
  const userRepository = createInMemoryUserRepository({ now });
  const banRepository = createInMemoryBanRepository({ now });
  const sessionRegistry = createInMemorySessionRegistry();
  const indicatorRequestRepository = createInMemoryIndicatorRequestRepository({ now });
  userRepository.upsert({
    id: "42", username: "member", displayName: "Member", authMode: "discord",
    roles: ["OS", "Indicators"], capabilities: ["base", "indicators"],
    rolesSyncedAt: "2026-09-02T11:55:00.000Z", lastSignedInAt: "2026-09-02T10:30:00.000Z",
  });
  indicatorRequestRepository.upsertPending({
    userId: "42", discordUsername: "member", tradingViewUsername: "member_tv",
    indicatorIds: ["demo-market-structure"],
  });
  return {
    app: createTestApp({
      roles, userRepository, banRepository, sessionRegistry, indicatorRequestRepository,
      ...appOptions,
    }),
    userRepository, banRepository, sessionRegistry, indicatorRequestRepository,
  };
}

test("Admin page renders memory warning, safe users and mutation tokens", async () => {
  const { app, userRepository } = createAdminRouteHarness(["Admin"]);
  userRepository.upsert({
    id: "unsafe", username: "safe-name", displayName: "Safe Name", roles: ["OS"], capabilities: ["base"],
    discordAuth: { accessToken: "must-not-render" },
  });
  const agent = await loginTestOperator(app, { username: "admin" });
  const response = await agent.get("/admin").expect(200)
    .expect(/TEMPORARY MEMORY MODE/)
    .expect(/data-admin-root/)
    .expect(/data-admin-users/)
    .expect(/name="_csrf"/);
  const dom = new JSDOM(response.text);

  assert.equal(dom.window.document.querySelectorAll("[data-admin-user-row]").length, 3);
  assert.equal(dom.window.document.querySelectorAll("[data-admin-request-row]").length, 0);
  assert.doesNotMatch(response.text, /must-not-render/);
  assert.ok(dom.window.document.querySelector('button[data-admin-action="ban"][disabled]'));
  const member = dom.window.document.querySelector('[data-admin-user-row][data-user-id="42"]');
  assert.equal(member.querySelector("[data-admin-last-sign-in] time").dateTime, "2026-09-02T10:30:00.000Z");
  assert.equal(member.querySelector("[data-admin-role-sync] time").dateTime, "2026-09-02T11:55:00.000Z");
  dom.window.close();
});

test("retired indicator requests stay out of Administration without deleting their history", async () => {
  const harness = createAdminRouteHarness(["Admin"]);
  harness.indicatorRequestRepository.decide({ userId: "42", status: "GRANTED", actorId: "reviewer-7" });
  const before = structuredClone(harness.indicatorRequestRepository.list());
  const agent = await loginTestOperator(harness.app, { username: "admin" });
  const response = await agent.get("/admin").expect(200);
  assert.doesNotMatch(response.text, /data-admin-requests|data-admin-request-row|PENDING REQUESTS|MANUAL TRADINGVIEW ACCESS/);
  assert.deepEqual(harness.indicatorRequestRepository.list(), before);
  const dom = new JSDOM(response.text);
  assert.equal(dom.window.document.querySelectorAll(".cortex-kpi").length, 2);
  assert.ok(dom.window.document.querySelector('[data-admin-action="sign-out"]'));
  dom.window.close();
});

test("OS cannot mutate Admin resources and capability is checked before CSRF", async () => {
  const { app, banRepository } = createAdminRouteHarness(["OS"]);
  const agent = await loginTestOperator(app, { username: "member" });

  await agent.post("/api/admin/users/42/ban")
    .send({ _csrf: "anything", reason: "blocked" })
    .expect(403)
    .expect(({ body }) => assert.equal(body.error, "INSUFFICIENT_PERMISSIONS"));
  assert.equal(banRepository.isBanned("42"), false);
});

test("Admin can ban, unban, sign out, and decide an indicator request", async () => {
  const { app, sessionRegistry, indicatorRequestRepository } = createAdminRouteHarness(["Admin"]);
  const admin = await loginTestOperator(app, { username: "admin" });
  const csrf = await readCsrfToken(admin, "/admin");
  sessionRegistry.register("42", "not-present-in-store");

  await admin.post("/api/admin/users/42/ban")
    .set("X-CSRF-Token", csrf).send({ reason: "Policy violation" })
    .expect(200).expect(({ body }) => assert.equal(body.user.banned, true));
  await admin.post("/api/admin/users/42/unban")
    .set("X-CSRF-Token", csrf)
    .expect(200).expect(({ body }) => assert.equal(body.user.banned, false));
  await admin.post("/api/admin/users/42/sign-out")
    .set("X-CSRF-Token", csrf)
    .expect(200).expect(({ body }) => assert.equal(body.user.activeSessions, 0));
  await admin.post("/api/admin/indicator-requests/42/decision")
    .set("X-CSRF-Token", csrf).send({ status: "GRANTED" })
    .expect(200).expect(({ body }) => assert.equal(body.request.status, "GRANTED"));
  await admin.post("/api/admin/indicator-requests/42/decision")
    .set("X-CSRF-Token", csrf).send({ status: "DENIED" })
    .expect(409).expect(({ body }) => assert.deepEqual(body, {
      ok: false,
      error: "INDICATOR_REQUEST_NOT_PENDING",
      message: "INDICATOR REQUEST ALREADY DECIDED :: RESUBMIT TO REOPEN",
    }));
  assert.equal(indicatorRequestRepository.findByUserId("42").status, "GRANTED");
});

test("Admin actions reject missing CSRF without changing temporary state", async () => {
  const { app, banRepository } = createAdminRouteHarness(["Developer"]);
  const admin = await loginTestOperator(app, { username: "developer" });

  await admin.post("/api/admin/users/42/ban").send({ reason: "blocked" })
    .expect(403).expect(({ body }) => assert.equal(body.error, "CSRF_INVALID"));
  assert.equal(banRepository.isBanned("42"), false);
});

test("self-ban is blocked while self-sign-out invalidates the current Admin session", async () => {
  const { app, banRepository } = createAdminRouteHarness(["Admin"]);
  const admin = await loginTestOperator(app, { username: "admin" });
  const csrf = await readCsrfToken(admin, "/admin");

  await admin.post("/api/admin/users/discord%3Aadmin/ban")
    .set("X-CSRF-Token", csrf).send({ reason: "self" })
    .expect(409).expect(({ body }) => assert.equal(body.error, "SELF_BAN_FORBIDDEN"));
  assert.equal(banRepository.isBanned("discord:admin"), false);
  await admin.post("/api/admin/users/discord%3Aadmin/sign-out")
    .set("X-CSRF-Token", csrf)
    .expect(200).expect(({ body }) => {
      assert.equal(body.selfSignedOut, true);
      assert.equal(body.redirectTo, "/login");
    });
  await admin.get("/home").expect(302).expect("Location", "/login");
});

test("Admin mutations support ordinary HTML form posts", async () => {
  const { app, banRepository } = createAdminRouteHarness(["Admin"]);
  const admin = await loginTestOperator(app, { username: "admin" });
  const csrf = await readCsrfToken(admin, "/admin");

  await admin.post("/api/admin/users/42/ban").type("form")
    .send({ _csrf: csrf, reason: "Policy violation" })
    .expect(303).expect("Location", "/admin");
  assert.equal(banRepository.isBanned("42"), true);
});

test("unauthenticated Admin API requests are rejected", async () => {
  await request(createAdminRouteHarness(["Admin"]).app)
    .post("/api/admin/users/42/sign-out").send({})
    .expect(401);
});

test("a just-banned Admin cannot self-unban while session destruction is delayed", async () => {
  const sessionStore = new session.MemoryStore();
  const harness = createAdminRouteHarness(["Admin"], { sessionStore, logger: { error() {} } });
  const banningAdmin = await loginTestOperator(harness.app, { username: "root-admin" });
  const bannedAdmin = await loginTestOperator(harness.app, { username: "racing-admin" });
  const banningCsrf = await readCsrfToken(banningAdmin, "/admin");
  const bannedCsrf = await readCsrfToken(bannedAdmin, "/admin");
  const [bannedSessionId] = harness.sessionRegistry.listSessionIds("discord:racing-admin");
  const originalDestroy = sessionStore.destroy.bind(sessionStore);
  let signalDestroy;
  let releaseDestroy;
  const destroyReached = new Promise((resolve) => { signalDestroy = resolve; });
  const destroyReleased = new Promise((resolve) => { releaseDestroy = resolve; });
  let held = false;
  let signalBannedSessionRead;
  const bannedSessionRead = new Promise((resolve) => { signalBannedSessionRead = resolve; });
  const originalGet = sessionStore.get.bind(sessionStore);
  let banDestroyPending = false;
  sessionStore.get = (sessionId, callback) => {
    if (banDestroyPending && sessionId === bannedSessionId) signalBannedSessionRead();
    return originalGet(sessionId, callback);
  };
  sessionStore.destroy = (sessionId, callback) => {
    if (sessionId === bannedSessionId && !held) {
      held = true;
      banDestroyPending = true;
      signalDestroy();
      return destroyReleased.then(() => originalDestroy(sessionId, callback));
    }
    return originalDestroy(sessionId, callback);
  };

  const banRequest = banningAdmin.post("/api/admin/users/discord%3Aracing-admin/ban")
    .set("X-CSRF-Token", banningCsrf)
    .send({ reason: "Concurrent ban" })
    .then((response) => response);
  await destroyReached;
  const selfUnban = bannedAdmin.post("/api/admin/users/discord%3Aracing-admin/unban")
    .set("X-CSRF-Token", bannedCsrf)
    .then((response) => response);
  await bannedSessionRead;
  releaseDestroy();

  assert.equal((await banRequest).status, 200);
  const unbanResponse = await selfUnban;
  assert.equal(unbanResponse.status, 401);
  assert.equal(unbanResponse.body.loginUrl, "/login?error=account_banned");
  assert.equal(harness.banRepository.isBanned("discord:racing-admin"), true);
  await bannedAdmin.get("/home").expect(302).expect("Location", "/login");
});

test("failed ban invalidation retains a fail-closed SID that cannot unban or load protected content", async () => {
  const sessionStore = new session.MemoryStore();
  const harness = createAdminRouteHarness(["Admin"], { sessionStore, logger: { error() {} } });
  const banningAdmin = await loginTestOperator(harness.app, { username: "root-admin" });
  const { agent: bannedAdmin, callbackPath } = await beginTestDiscordLogin(harness.app, { username: "failed-admin" });
  const bannedLogin = await bannedAdmin.get(callbackPath).expect(302).expect("Location", "/auth/complete");
  const banningCsrf = await readCsrfToken(banningAdmin, "/admin");
  const bannedCsrf = await readCsrfToken(bannedAdmin, "/admin");
  const [bannedSessionId] = harness.sessionRegistry.listSessionIds("discord:failed-admin");
  const originalCookie = bannedLogin.headers["set-cookie"][0].split(";", 1)[0];
  const originalDestroy = sessionStore.destroy.bind(sessionStore);
  sessionStore.destroy = (sessionId, callback) => sessionId === bannedSessionId
    ? callback(new Error("private store failure"))
    : originalDestroy(sessionId, callback);

  await banningAdmin.post("/api/admin/users/discord%3Afailed-admin/ban")
    .set("X-CSRF-Token", banningCsrf)
    .send({ reason: "Concurrent ban" })
    .expect(503);

  assert.deepEqual(harness.sessionRegistry.listSessionIds("discord:failed-admin"), [bannedSessionId]);
  assert.equal(harness.sessionRegistry.isRevoked(bannedSessionId), true);
  await bannedAdmin.post("/api/admin/users/discord%3Afailed-admin/unban")
    .set("X-CSRF-Token", bannedCsrf)
    .expect(401);
  assert.equal(harness.banRepository.isBanned("discord:failed-admin"), true);
  await request(harness.app).get("/home").set("Cookie", originalCookie)
    .expect(302).expect("Location", "/login?error=account_banned")
    .expect((response) => assert.doesNotMatch(response.text, /SYNERGY MODULE OVERVIEW/));
});

test("an Admin mutation refreshes Discord roles at five minutes even when configuration is higher", async () => {
  const banRepository = createInMemoryBanRepository();
  banRepository.ban({ userId: "42", actorId: "root", reason: "Existing ban" });
  let refreshCalls = 0;
  const authService = {
    assertOperatorAdmission() {},
    async refreshOperator() {
      refreshCalls += 1;
      throw Object.assign(new Error("role removed"), { code: "ACCESS_REVOKED" });
    },
  };
  const authConfig = {
    ...createDiscordAuthConfig(),
    roleRefreshMs: 3_600_000,
  };
  const app = createTestApp({
    authConfig,
    authService,
    banRepository,
    configureRoutes(expressApp) {
      expressApp.get("/__test/admin-session", (req, res) => {
        req.session.operator = {
          id: "admin-7",
          username: "admin",
          authMode: "discord",
          roles: ["Admin"],
          capabilities: ["base", "admin"],
          rolesSyncedAt: new Date(Date.now() - 300_001).toISOString(),
          discordAuth: { accessToken: "private-token" },
        };
        req.session.csrfToken = "fixed-csrf-token";
        res.sendStatus(204);
      });
    },
  });
  const agent = request.agent(app);
  await agent.get("/__test/admin-session").expect(204);

  await agent.post("/api/admin/users/42/unban")
    .set("X-CSRF-Token", "fixed-csrf-token")
    .expect(401)
    .expect(({ body }) => assert.equal(body.loginUrl, "/login?error=access_revoked"));

  assert.equal(refreshCalls, 1);
  assert.equal(banRepository.isBanned("42"), true);
});
