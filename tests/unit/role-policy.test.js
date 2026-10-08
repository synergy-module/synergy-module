import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "../../src/models/access.js";
import { createRolePolicy } from "../../src/services/role-policy.js";

const policy = createRolePolicy({
  roleIds: { Developer: "1", Admin: "2", OS: "3", Indicators: "4", Journal: "5" },
});

test("Admin and Developer inherit every capability", () => {
  for (const id of ["1", "2"]) {
    const operator = policy.fromDiscordRoleIds([id]);
    assert.deepEqual(new Set(operator.capabilities), new Set(Object.values(CAPABILITIES)));
  }
});

test("OS needs additive roles for Indicators and Journal", () => {
  const operator = policy.fromDiscordRoleIds(["3", "4"]);
  assert.equal(policy.can(operator, CAPABILITIES.BASE), true);
  assert.equal(policy.can(operator, CAPABILITIES.INDICATORS), true);
  assert.equal(policy.can(operator, CAPABILITIES.JOURNAL), false);
  assert.equal(policy.can(operator, CAPABILITIES.ADMIN), false);
});

test("module roles alone do not grant base access", () => {
  assert.equal(policy.hasBaseAccess(policy.fromDiscordRoleIds(["4", "5"])), false);
});

test("Discord policy matches configured IDs rather than role names", () => {
  const operator = policy.fromDiscordRoleIds(["Developer", "4"]);

  assert.deepEqual(operator.roles, ["Indicators"]);
  assert.equal(policy.hasBaseAccess(operator), false);
});

test("role-name policy normalizes recognized role names", () => {
  const operator = policy.fromRoleNames([" OS ", "Journal", "Unknown"]);

  assert.deepEqual(operator.roles, ["OS", "Journal"]);
  assert.deepEqual(operator.capabilities, [CAPABILITIES.BASE, CAPABILITIES.JOURNAL]);
});
