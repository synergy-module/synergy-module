import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES } from "../../src/models/access.js";
import { createRefreshRoles } from "../../src/middleware/refresh-roles.js";
import { requireCapability } from "../../src/middleware/require-capability.js";
import { createInMemorySessionRegistry } from "../../src/repositories/in-memory-session-registry.js";

const ACCESS_DENIED_MESSAGE = "ACCESS FAILED :: INSUFFICIENT PERMISSIONS";

function createResponseHarness() {
  return {
    statusCode: 200,
    body: null,
    redirectTarget: null,
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(target) {
      this.redirectTarget = target;
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookies.push([name, options]);
      return this;
    },
  };
}

test("every protected request checks live operator admission before refresh", async () => {
  for (const operator of [
    { id: "demo:admin", authMode: "demo", rolesSyncedAt: "2026-08-01T00:00:00.000Z" },
    { id: "42", authMode: "discord", rolesSyncedAt: "2026-09-02T11:59:59.999Z" },
  ]) {
    const events = [];
    const middleware = createRefreshRoles({
      authService: {
        assertOperatorAdmission(candidate) {
          events.push(["admission", candidate.id]);
          throw Object.assign(new Error("banned"), { code: "ACCOUNT_BANNED" });
        },
        async refreshOperator() {
          events.push(["refresh"]);
          throw new Error("must not refresh a banned operator");
        },
      },
      refreshAfterMs: 300_000,
      sessionRegistry: createInMemorySessionRegistry(),
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });
    const session = { operator, destroy(callback) { events.push(["destroy"]); callback(); } };
    const response = createResponseHarness();

    await middleware(
      { path: "/api/admin/users/42/unban", sessionID: `sid-${operator.id}`, session },
      response,
      () => events.push(["next"]),
    );

    assert.deepEqual(events, [["admission", operator.id], ["destroy"]]);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, {
      error: "AUTH_REQUIRED",
      loginUrl: "/login?error=account_banned",
    });
  }
});

test("requireCapability returns a structured 403 for denied fragments and APIs", () => {
  for (const requestShape of [
    { isSynergyModuleFragment: true, path: "/indicators" },
    { isSynergyModuleFragment: false, path: "/api/indicator-access/requests" },
  ]) {
    const response = createResponseHarness();
    requireCapability(CAPABILITIES.INDICATORS)(
      { ...requestShape, session: { operator: { capabilities: [CAPABILITIES.BASE] } } },
      response,
      () => assert.fail("next called for denied request"),
    );
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, {
      error: "INSUFFICIENT_PERMISSIONS",
      message: ACCESS_DENIED_MESSAGE,
    });
  }
});

test("requireCapability permits matching capabilities and stores one-shot notice for full denials", () => {
  let nextCalls = 0;
  requireCapability(CAPABILITIES.JOURNAL)(
    { path: "/journal", session: { operator: { capabilities: [CAPABILITIES.BASE, CAPABILITIES.JOURNAL] } } },
    createResponseHarness(),
    () => { nextCalls += 1; },
  );
  assert.equal(nextCalls, 1);

  const deniedSession = { operator: { capabilities: [CAPABILITIES.BASE] } };
  const response = createResponseHarness();
  requireCapability(CAPABILITIES.ADMIN)(
    { path: "/admin", session: deniedSession },
    response,
    () => assert.fail("next called for denied request"),
  );
  assert.equal(deniedSession.accessNotice, ACCESS_DENIED_MESSAGE);
  assert.equal(response.redirectTarget, "/home");
});

test("fresh Discord roles and every demo session skip provider refresh", async () => {
  for (const operator of [
    { id: "42", authMode: "discord", rolesSyncedAt: "2026-09-02T11:56:00.001Z" },
    { id: "demo:operator", authMode: "demo", rolesSyncedAt: "2026-08-01T00:00:00.000Z" },
  ]) {
    let refreshCalls = 0;
    let nextCalls = 0;
    const middleware = createRefreshRoles({
      authService: { refreshOperator: async () => { refreshCalls += 1; } },
      refreshAfterMs: 300_000,
      sessionRegistry: { unregister() { assert.fail("fresh session was unregistered"); } },
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });
    await middleware(
      { path: "/home", sessionID: "sid", session: { operator } },
      createResponseHarness(),
      () => { nextCalls += 1; },
    );
    assert.equal(refreshCalls, 0);
    assert.equal(nextCalls, 1);
  }
});

test("stale Discord roles replace the operator before authorization continues", async () => {
  const refreshed = {
    id: "42", authMode: "discord", roles: ["OS", "Journal"],
    capabilities: [CAPABILITIES.BASE, CAPABILITIES.JOURNAL], rolesSyncedAt: "2026-09-02T12:00:00.000Z",
  };
  let nextCalls = 0;
  const session = {
    operator: { id: "42", authMode: "discord", roles: ["OS"], capabilities: [CAPABILITIES.BASE], rolesSyncedAt: "2026-09-02T11:55:00.000Z" },
  };
  const middleware = createRefreshRoles({
    authService: { refreshOperator: async () => refreshed },
    refreshAfterMs: 300_000,
    sessionRegistry: { unregister() { assert.fail("valid session was unregistered"); } },
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  });

  await middleware(
    { path: "/journal", sessionID: "sid", session },
    createResponseHarness(),
    () => { nextCalls += 1; },
  );

  assert.equal(session.operator, refreshed);
  assert.equal(nextCalls, 1);
});

test("refresh failures unregister and destroy stale sessions before returning login-safe responses", async () => {
  for (const scenario of [
    { path: "/home", fragment: false, code: "ACCESS_REVOKED", redirect: "/login?error=access_revoked" },
    { path: "/journal", fragment: true, code: "DISCORD_REQUEST_FAILED", loginUrl: "/login?error=role_sync_failed" },
  ]) {
    const unregistered = [];
    let destroyed = 0;
    let nextCalls = 0;
    const middleware = createRefreshRoles({
      authService: {
        refreshOperator: async () => {
          throw Object.assign(new Error("provider detail must stay private"), { code: scenario.code });
        },
      },
      refreshAfterMs: 300_000,
      sessionRegistry: { unregister: (...values) => unregistered.push(values) },
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });
    const session = {
      operator: { id: "42", authMode: "discord", rolesSyncedAt: "2026-09-02T11:54:59.999Z" },
      destroy(callback) { destroyed += 1; callback(); },
    };
    const response = createResponseHarness();

    await middleware(
      { path: scenario.path, isSynergyModuleFragment: scenario.fragment, sessionID: "sid-42", session },
      response,
      () => { nextCalls += 1; },
    );

    assert.deepEqual(unregistered, [["42", "sid-42"]]);
    assert.equal(destroyed, 1);
    assert.equal(nextCalls, 0);
    if (scenario.fragment) {
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.body, { error: "AUTH_REQUIRED", loginUrl: scenario.loginUrl });
      assert.doesNotMatch(JSON.stringify(response.body), /provider detail/);
    } else {
      assert.equal(response.redirectTarget, scenario.redirect);
    }
  }
});

test("refresh destruction failure keeps the SID retryable, clears the cookie, and fails closed", async () => {
  const sessionRegistry = createInMemorySessionRegistry();
  sessionRegistry.register("42", "sid-42");
  const middleware = createRefreshRoles({
    authService: {
      assertOperatorAdmission() {},
      async refreshOperator() {
        throw Object.assign(new Error("provider detail must stay private"), { code: "ACCESS_REVOKED" });
      },
    },
    refreshAfterMs: 300_000,
    sessionRegistry,
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  });
  const session = {
    operator: {
      id: "42", authMode: "discord", rolesSyncedAt: "2026-09-02T11:54:59.999Z",
    },
    destroy(callback) { callback(new Error("private store failure")); },
  };
  const response = createResponseHarness();

  await middleware(
    { path: "/journal", isSynergyModuleFragment: true, sessionID: "sid-42", session },
    response,
    () => assert.fail("revoked session continued"),
  );

  assert.deepEqual(sessionRegistry.listSessionIds("42"), ["sid-42"]);
  assert.equal(sessionRegistry.isRevoked("sid-42"), true);
  assert.deepEqual(response.clearedCookies, [["connect.sid", { path: "/" }]]);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    error: "AUTH_REQUIRED",
    loginUrl: "/login?error=access_revoked",
  });
});
