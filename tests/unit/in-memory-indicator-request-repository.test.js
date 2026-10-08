import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryIndicatorRequestRepository } from "../../src/repositories/in-memory-indicator-request-repository.js";

test("one pending request per user is updated instead of duplicated", () => {
  const repository = createInMemoryIndicatorRequestRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_one", indicatorIds: ["demo-a"] });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_two", indicatorIds: ["demo-a", "demo-b"] });
  assert.equal(repository.list().length, 1);
  assert.equal(repository.findByUserId("42").tradingViewUsername, "tv_two");
  assert.equal(repository.findByUserId("42").status, "PENDING");
});

test("indicator request records and inputs are defensively copied and list is newest first", () => {
  let timestamp = "2026-09-02T12:00:00.000Z";
  const repository = createInMemoryIndicatorRequestRepository({ now: () => timestamp });
  const indicatorIds = ["demo-a"];
  const input = { userId: 42, discordUsername: "omen", tradingViewUsername: "tv_one", indicatorIds };
  const stored = repository.upsertPending(input);
  indicatorIds.push("mutated");
  input.tradingViewUsername = "mutated";
  stored.indicatorIds.push("changed");
  timestamp = "2026-09-02T13:00:00.000Z";
  repository.upsertPending({ userId: "7", discordUsername: "other", tradingViewUsername: "tv_two", indicatorIds: [] });
  assert.equal(repository.findByUserId(42).tradingViewUsername, "tv_one");
  assert.deepEqual(repository.findByUserId(42).indicatorIds, ["demo-a"]);
  const listed = repository.list();
  listed[0].status = "changed";
  assert.equal(repository.findByUserId("7").status, "PENDING");
  assert.deepEqual(listed.map(({ userId }) => userId), ["7", "42"]);
});

test("decisions record the administrator and decision time", () => {
  const repository = createInMemoryIndicatorRequestRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_one", indicatorIds: ["demo-a"] });
  const decided = repository.decide({ userId: "42", status: "GRANTED", actorId: "7" });
  assert.equal(decided.status, "GRANTED");
  assert.equal(decided.decidedBy, "7");
  assert.equal(decided.decidedAt, "2026-09-02T12:00:00.000Z");
});

test("only pending requests can be decided and resubmission reopens a decision", () => {
  let timestamp = "2026-09-02T12:00:00.000Z";
  const repository = createInMemoryIndicatorRequestRepository({ now: () => timestamp });
  const pending = {
    userId: "42",
    discordUsername: "omen",
    tradingViewUsername: "tv_one",
    indicatorIds: ["demo-a"],
  };
  repository.upsertPending(pending);
  repository.decide({ userId: "42", status: "GRANTED", actorId: "7" });

  assert.throws(
    () => repository.decide({ userId: "42", status: "DENIED", actorId: "8" }),
    { code: "INDICATOR_REQUEST_NOT_PENDING" },
  );
  assert.equal(repository.findByUserId("42").status, "GRANTED");
  assert.equal(repository.findByUserId("42").decidedBy, "7");

  timestamp = "2026-09-02T13:00:00.000Z";
  repository.upsertPending({ ...pending, tradingViewUsername: "tv_two" });
  const denied = repository.decide({ userId: "42", status: "DENIED", actorId: "8" });
  assert.equal(denied.status, "DENIED");
  assert.equal(denied.tradingViewUsername, "tv_two");
  assert.equal(denied.decidedBy, "8");
});

test("list uses a decision timestamp when it is newer than a request timestamp", () => {
  let timestamp = "2026-09-02T12:00:00.000Z";
  const repository = createInMemoryIndicatorRequestRepository({ now: () => timestamp });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_one", indicatorIds: ["demo-a"] });
  timestamp = "2026-09-02T13:00:00.000Z";
  repository.upsertPending({ userId: "7", discordUsername: "other", tradingViewUsername: "tv_two", indicatorIds: ["demo-b"] });
  timestamp = "2026-09-02T14:00:00.000Z";
  repository.decide({ userId: "42", status: "GRANTED", actorId: "admin" });
  assert.deepEqual(repository.list().map(({ userId }) => userId), ["42", "7"]);
});

test("decide rejects missing requests and invalid decisions without mutation", () => {
  const repository = createInMemoryIndicatorRequestRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  assert.throws(() => repository.decide({ userId: "missing", status: "GRANTED", actorId: "7" }), { code: "INDICATOR_REQUEST_NOT_FOUND" });
  repository.upsertPending({ userId: "42", discordUsername: "omen", tradingViewUsername: "tv_one", indicatorIds: ["demo-a"] });
  assert.throws(() => repository.decide({ userId: "42", status: "PENDING", actorId: "7" }), { code: "INVALID_DECISION" });
  assert.equal(repository.findByUserId("42").status, "PENDING");
});

test("missing indicator requests return null", () => {
  const repository = createInMemoryIndicatorRequestRepository({ now: () => "2026-09-02T12:00:00.000Z" });
  assert.equal(repository.findByUserId("missing"), null);
});
