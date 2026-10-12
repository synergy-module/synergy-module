import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceSettingsService } from "../../src/settings/workspace-settings-service.js";
import { createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";

test("profile, appearance and onboarding persist per owner without changing broker or provider state", async () => {
  const repository = createMemoryWorkspaceRepository();
  const service = createWorkspaceSettingsService({ repository, now: () => new Date("2026-10-12T12:00:00Z") });
  await service.saveProfile("alice", { displayName: " Alice " });
  await service.savePreferences("alice", { theme: "light", timezone: "Europe/London", notifications: { researchCompleted: false }, density: "compact", reducedMotion: true });
  await service.saveOnboarding("alice", { step: "review", interests: ["practice", "practice", "research"] });
  const saved = await service.completeOnboarding("alice", { acknowledgedPracticeIsolation: true });
  assert.equal(saved.profile.displayName, "Alice");
  assert.equal(saved.preferences.theme, "light");
  assert.equal(saved.preferences.notifications.orderUpdates, true);
  assert.equal(saved.preferences.notifications.researchCompleted, false);
  assert.deepEqual(saved.onboarding.interests, ["practice", "research"]);
  assert.equal(saved.onboarding.completedAt, "2026-10-12T12:00:00.000Z");
  assert.equal(saved.onboarding.version, 1);
  assert.equal(saved.paidCallsEnabled, false);
  const reopened = createWorkspaceSettingsService({ repository });
  assert.equal((await reopened.getExperience("alice")).profile.displayName, "Alice");
  assert.equal((await reopened.getExperience("bob")).onboarding.completedAt, null);
  assert.equal((await reopened.getExperience("bob")).preferences.theme, "system");
});

test("setup cannot be completed without a name and explicit practice isolation acknowledgment", async () => {
  const service = createWorkspaceSettingsService();
  await assert.rejects(service.completeOnboarding("alice", { acknowledgedPracticeIsolation: true }), { code: "SETUP_PROFILE_REQUIRED" });
  await service.saveProfile("alice", { displayName: "Alice" });
  await assert.rejects(service.completeOnboarding("alice", {}), { code: "SETUP_REVIEW_REQUIRED" });
  await assert.rejects(service.completeOnboarding("alice", { acknowledgedPracticeIsolation: "true" }), { code: "SETUP_REVIEW_REQUIRED" });
  await assert.rejects(service.saveOnboarding("alice", { completedAt: "forged" }), { code: "SETTINGS_INVALID" });
  assert.equal((await service.getExperience("alice")).onboarding.completedAt, null);
});

test("preferences reject unsupported values, invalid time zones and privilege-bearing fields", async () => {
  const service = createWorkspaceSettingsService();
  for (const value of [{ theme: "javascript:evil" }, { timezone: "Invalid/Zone" }, { notifications: { email: true } }, { notifications: { orderUpdates: "yes" } }, { reducedMotion: 1 }, { defaultLanding: "https://evil.test" }, { currency: "UNKNOWN" }, { density: "huge" }]) await assert.rejects(service.savePreferences("alice", value), { code: "SETTINGS_INVALID" });
  for (const value of [{ displayName: "" }, { displayName: "a".repeat(81) }, { displayName: "Alice", role: "admin" }, { displayName: "Alice\u0000" }]) await assert.rejects(service.saveProfile("alice", value), { code: "SETTINGS_INVALID" });
  await assert.rejects(service.saveOnboarding("alice", { interests: ["enable-live"] }), { code: "SETTINGS_INVALID" });
});
