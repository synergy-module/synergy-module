import test from "node:test";
import assert from "node:assert/strict";
import { NAVIGATION, ROUTE_BY_KEY, getRouteByPath } from "../../src/models/navigation.js";

test("clean routes resolve to the expected view metadata", () => {
  assert.deepEqual(getRouteByPath("/research"), {
    key: "research",
    title: "Research",
    path: "/research",
    uri: "research",
    description: "Give your agents an objective. Review the evidence, then decide what to keep.",
    view: "research",
    capability: "base",
  });
});

test("unknown paths return undefined", () => {
  assert.equal(getRouteByPath("/missing"), undefined);
});

test("navigation groups research, isolated practice and live accounts by task", () => {
  assert.deepEqual(NAVIGATION.map((route) => route.key), [
    "home", "research", "brain", "polymarket", "market-news", "practice", "live", "accounts", "journal", "settings",
  ]);
  assert.deepEqual(NAVIGATION.map((route) => route.capability), [
    "base", "base", "base", "base", "base", "base", "base", "base", "journal", "base",
  ]);
  assert.equal(ROUTE_BY_KEY["journal-new"].view, "journal-new");
  assert.equal(ROUTE_BY_KEY["journal-public"].view, "journal-public");
  assert.equal(NAVIGATION.find((route) => route.key === "practice").group, "Practice");
  assert.equal(NAVIGATION.find((route) => route.key === "live").group, "Live trading");
});
