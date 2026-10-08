import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryUserRepository } from "../../src/repositories/in-memory-user-repository.js";
import { createInMemoryBanRepository } from "../../src/repositories/in-memory-ban-repository.js";
import { createInMemorySessionRegistry } from "../../src/repositories/in-memory-session-registry.js";

test("user upsert preserves first and last sign-in while updating the role snapshot", () => {
  let repositoryNow = "2026-09-02T11:00:00.000Z";
  const users = createInMemoryUserRepository({ now: () => repositoryNow });
  users.upsert({
    id: "42", username: "first", roles: ["OS"], capabilities: ["base"],
    rolesSyncedAt: "2026-09-02T10:00:00.000Z", lastSignedInAt: "2026-09-02T09:00:00.000Z",
  });
  repositoryNow = "2026-09-02T12:00:00.000Z";
  users.upsert({
    id: "42", username: "renamed", roles: ["OS", "Indicators"], capabilities: ["base", "indicators"],
    rolesSyncedAt: "2026-09-02T12:00:00.000Z",
  });
  const record = users.findById("42");
  assert.equal(record.username, "renamed");
  assert.equal(record.firstSeenAt, "2026-09-02T11:00:00.000Z");
  assert.deepEqual(record.roles, ["OS", "Indicators"]);
  assert.equal(record.rolesSyncedAt, "2026-09-02T12:00:00.000Z");
  assert.equal(record.lastSignedInAt, "2026-09-02T09:00:00.000Z");
  assert.equal(record.lastSeenAt, "2026-09-02T12:00:00.000Z");
});
test("user records and inputs are defensively copied and list is newest first", () => {
  let timestamp = "2026-09-02T12:00:00.000Z";
  const users = createInMemoryUserRepository({ now: () => timestamp });
  const roles = ["OS"];
  const input = { id: 42, username: "omen", roles, capabilities: ["base"] };
  const stored = users.upsert(input);
  roles.push("Indicators");
  input.username = "mutated";
  stored.roles.push("Journal");
  timestamp = "2026-09-02T13:00:00.000Z";
  users.upsert({ id: "7", username: "newer", roles: [], capabilities: [] });
  assert.equal(users.findById(42).username, "omen");
  assert.deepEqual(users.findById(42).roles, ["OS"]);
  const listed = users.list();
  listed[0].username = "changed";
  assert.equal(users.findById("7").username, "newer");
  assert.deepEqual(listed.map(({ id }) => id), ["7", "42"]);
});

test("missing users return null", () => {
  const users = createInMemoryUserRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  assert.equal(users.findById("missing"), null);
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

test("ban records are defensively copied, can be unbanned, and list newest first", () => {
  let timestamp = "2026-09-02T12:00:00.000Z";
  const bans = createInMemoryBanRepository({ now: () => timestamp });
  const first = bans.ban({ userId: 42, actorId: 7, reason: "first" });
  first.reason = "changed";
  timestamp = "2026-09-02T13:00:00.000Z";
  bans.ban({ userId: "7", actorId: "8", reason: "second" });
  assert.equal(bans.findByUserId(42).reason, "first");
  assert.deepEqual(bans.list().map(({ userId }) => userId), ["7", "42"]);
  bans.unban({ userId: 42 });
  assert.equal(bans.isBanned("42"), false);
  assert.equal(bans.findByUserId("42"), null);
});

test("session registry normalizes IDs, deduplicates sessions, and unregisters users", () => {
  const sessions = createInMemorySessionRegistry();
  sessions.register(42, 7);
  sessions.register("42", "7");
  sessions.register("42", "8");
  assert.deepEqual(sessions.listSessionIds(42), ["7", "8"]);
  sessions.unregister(42, 7);
  assert.deepEqual(sessions.listSessionIds("42"), ["8"]);
  sessions.unregister("42", "8");
  assert.equal(sessions.activeCount(42), 0);
  assert.deepEqual(sessions.clearUser("42"), []);
});

test("session registry returns a fresh session ID list", () => {
  const sessions = createInMemorySessionRegistry();
  sessions.register("42", "sid-a");
  const ids = sessions.listSessionIds("42");
  ids.push("sid-b");
  assert.deepEqual(sessions.listSessionIds("42"), ["sid-a"]);
});
