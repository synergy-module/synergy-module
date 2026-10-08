import test from "node:test";
import assert from "node:assert/strict";
import { createAdminService } from "../../src/services/admin-service.js";
import { createIndicatorCatalog } from "../../src/config/indicator-catalog.js";
import { createInMemoryBanRepository } from "../../src/repositories/in-memory-ban-repository.js";
import { createInMemoryIndicatorRequestRepository } from "../../src/repositories/in-memory-indicator-request-repository.js";
import { createInMemorySessionRegistry } from "../../src/repositories/in-memory-session-registry.js";
import { createInMemoryUserRepository } from "../../src/repositories/in-memory-user-repository.js";

function createAdminServiceHarness({ sessionStore, catalog: suppliedCatalog } = {}) {
  const now = () => "2026-09-02T12:00:00.000Z";
  const userRepository = createInMemoryUserRepository({ now });
  const banRepository = createInMemoryBanRepository({ now });
  const sessionRegistry = createInMemorySessionRegistry();
  const requestRepository = createInMemoryIndicatorRequestRepository({ now });
  const catalog = suppliedCatalog ?? createIndicatorCatalog({ authMode: "demo" });
  const destroyed = [];
  const resolvedStore = sessionStore ?? {
    destroy(sessionId, callback) {
      destroyed.push(sessionId);
      callback();
    },
  };
  const service = createAdminService({
    userRepository, banRepository, sessionRegistry, requestRepository,
    sessionStore: resolvedStore,
    catalog,
    now,
    assertOperatorAdmission(operator) {
      if (banRepository.isBanned(operator.id)) {
        throw Object.assign(new Error("banned"), { code: "ACCOUNT_BANNED" });
      }
    },
  });
  return {
    service, userRepository, banRepository, sessionRegistry, requestRepository,
    catalog, destroyed,
  };
}

test("sign out destroys every indexed session and keeps future login allowed", async () => {
  const { service, banRepository, sessionRegistry, destroyed } = createAdminServiceHarness();
  sessionRegistry.register("42", "sid-a");
  sessionRegistry.register("42", "sid-b");

  const result = await service.signOutUser({ userId: "42", actorId: "7" });

  assert.deepEqual(new Set(destroyed), new Set(["sid-a", "sid-b"]));
  assert.equal(banRepository.isBanned("42"), false);
  assert.equal(sessionRegistry.activeCount("42"), 0);
  assert.deepEqual(result, { userId: "42", signedOutSessions: 2 });
});

test("ban records the actor before invalidating sessions", async () => {
  const order = [];
  const banRepository = createInMemoryBanRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  const originalBan = banRepository.ban;
  banRepository.ban = (input) => {
    order.push("ban");
    return originalBan(input);
  };
  const sessionRegistry = createInMemorySessionRegistry();
  sessionRegistry.register("42", "sid-a");
  const service = createAdminService({
    userRepository: createInMemoryUserRepository(),
    banRepository,
    sessionRegistry,
    requestRepository: createInMemoryIndicatorRequestRepository(),
    sessionStore: { destroy(_sessionId, callback) { order.push("destroy"); callback(); } },
    catalog: createIndicatorCatalog({ authMode: "demo" }),
    now: () => "2026-09-02T12:00:00.000Z",
  });

  const result = await service.banUser({ userId: "42", actorId: "7", reason: "Policy violation" });

  assert.deepEqual(order, ["ban", "destroy"]);
  assert.equal(result.banned, true);
  assert.equal(result.actorId, "7");
  assert.equal(banRepository.findByUserId("42").actorId, "7");
});

test("an administrator cannot ban their own identity", async () => {
  const { service } = createAdminServiceHarness();
  await assert.rejects(
    () => service.banUser({ userId: "7", actorId: "7", reason: "self" }),
    { code: "SELF_BAN_FORBIDDEN" },
  );
});

test("a banned actor cannot cross a service boundary to unban itself or mutate state", async () => {
  const { service, banRepository, requestRepository, sessionRegistry, destroyed } = createAdminServiceHarness();
  const actor = { id: "7", authMode: "demo", roles: ["Admin"], capabilities: ["admin"] };
  banRepository.ban({ userId: "7", actorId: "root", reason: "Concurrent ban" });
  banRepository.ban({ userId: "42", actorId: "root", reason: "Target ban" });
  requestRepository.upsertPending({
    userId: "42", discordUsername: "member", tradingViewUsername: "member_tv",
    indicatorIds: ["demo-market-structure"],
  });
  sessionRegistry.register("42", "sid-42");

  for (const mutate of [
    () => service.unbanUser({ userId: "7", actor }),
    () => service.signOutUser({ userId: "42", actor }),
    () => service.banUser({ userId: "42", actor, reason: "changed" }),
    () => service.decideIndicatorRequest({ userId: "42", actor, status: "GRANTED" }),
  ]) {
    await assert.rejects(Promise.resolve().then(mutate), { code: "ACCOUNT_BANNED" });
  }

  assert.equal(banRepository.isBanned("7"), true);
  assert.equal(banRepository.findByUserId("42").reason, "Target ban");
  assert.equal(requestRepository.findByUserId("42").status, "PENDING");
  assert.deepEqual(sessionRegistry.listSessionIds("42"), ["sid-42"]);
  assert.deepEqual(destroyed, []);
});

test("session invalidation attempts every session and unregisters only successful destroys", async () => {
  const attempted = [];
  const { service, sessionRegistry } = createAdminServiceHarness({
    sessionStore: {
      destroy(sessionId, callback) {
        attempted.push(sessionId);
        callback(sessionId === "sid-b" ? new Error("private store failure") : undefined);
      },
    },
  });
  sessionRegistry.register("42", "sid-a");
  sessionRegistry.register("42", "sid-b");
  sessionRegistry.register("42", "sid-c");

  await assert.rejects(
    () => service.signOutUser({ userId: "42", actorId: "7" }),
    (error) => {
      assert.equal(error.code, "SESSION_INVALIDATION_FAILED");
      assert.equal(error.message, "One or more sessions could not be invalidated");
      assert.doesNotMatch(error.message, /private store failure/);
      return true;
    },
  );
  assert.deepEqual(new Set(attempted), new Set(["sid-a", "sid-b", "sid-c"]));
  assert.deepEqual(sessionRegistry.listSessionIds("42"), ["sid-b"]);
});

test("dashboard exposes only safe user fields with ban and session state and newest requests first", async () => {
  const { service, userRepository, banRepository, sessionRegistry, requestRepository } = createAdminServiceHarness();
  userRepository.upsert({
    id: "42", username: "member", displayName: "Member", avatarUrl: null,
    authMode: "discord", roles: ["OS", "Indicators"], capabilities: ["base", "indicators"],
    rolesSyncedAt: "2026-09-02T11:55:00.000Z", lastSignedInAt: "2026-09-02T10:15:00.000Z",
    discordAuth: { accessToken: "must-not-leak" },
  });
  banRepository.ban({ userId: "42", actorId: "7", reason: "Policy violation" });
  sessionRegistry.register("42", "sid-a");
  requestRepository.upsertPending({
    userId: "42", discordUsername: "member", tradingViewUsername: "member_tv",
    indicatorIds: ["demo-market-structure"],
  });

  const dashboard = await service.getDashboard();

  assert.equal(dashboard.users.length, 1);
  assert.equal(dashboard.users[0].banned, true);
  assert.equal(dashboard.users[0].activeSessions, 1);
  assert.deepEqual(dashboard.users[0].roles, ["OS", "Indicators"]);
  assert.equal(dashboard.users[0].lastSignedInAt, "2026-09-02T10:15:00.000Z");
  assert.equal("discordAuth" in dashboard.users[0], false);
  assert.doesNotMatch(JSON.stringify(dashboard), /must-not-leak/);
  assert.deepEqual(dashboard.requests[0].indicators[0], {
    id: "demo-market-structure",
    name: "DEMO :: MARKET STRUCTURE",
    tradingViewUrl: null,
  });
});

test("dashboard request audit includes only sanitized publication descriptors", async () => {
  const catalog = Object.freeze([
    Object.freeze({ id: "safe", name: "SAFE SCRIPT", active: true, tradingViewUrl: "https://www.tradingview.com/script/safe/" }),
    Object.freeze({ id: "unsafe", name: "UNSAFE SCRIPT", active: true, tradingViewUrl: "javascript:alert(1)" }),
    Object.freeze({ id: "retired", name: "RETIRED SCRIPT", active: false, tradingViewUrl: "https://www.tradingview.com/script/retired/" }),
  ]);
  const { service, requestRepository } = createAdminServiceHarness({ catalog });
  requestRepository.upsertPending({
    userId: "42", discordUsername: "member", tradingViewUsername: "member_tv",
    indicatorIds: ["safe", "unsafe", "retired", "missing"],
  });
  requestRepository.decide({ userId: "42", status: "GRANTED", actorId: "7" });

  const [request] = (await service.getDashboard()).requests;

  assert.deepEqual(request.indicators, [
    { id: "safe", name: "SAFE SCRIPT", tradingViewUrl: "https://www.tradingview.com/script/safe/" },
    { id: "unsafe", name: "UNSAFE SCRIPT", tradingViewUrl: null },
    { id: "retired", name: "RETIRED SCRIPT", tradingViewUrl: null },
    { id: "missing", name: "missing", tradingViewUrl: null },
  ]);
  assert.equal(request.status, "GRANTED");
  assert.equal(request.decidedBy, "7");
  assert.equal(request.decidedAt, "2026-09-02T12:00:00.000Z");
});

test("indicator decisions are delegated to repository validation", async () => {
  const { service, requestRepository } = createAdminServiceHarness();
  requestRepository.upsertPending({
    userId: "42", discordUsername: "member", tradingViewUsername: "member_tv",
    indicatorIds: ["demo-market-structure"],
  });

  assert.equal((await service.decideIndicatorRequest({ userId: "42", actorId: "7", status: "GRANTED" })).status, "GRANTED");
  await assert.rejects(
    () => service.decideIndicatorRequest({ userId: "42", actorId: "8", status: "DENIED" }),
    { code: "INDICATOR_REQUEST_NOT_PENDING" },
  );
  assert.equal(requestRepository.findByUserId("42").status, "GRANTED");
  await assert.rejects(
    () => service.decideIndicatorRequest({ userId: "42", actorId: "7", status: "PENDING" }),
    { code: "INVALID_DECISION" },
  );
});
