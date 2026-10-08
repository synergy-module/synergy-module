import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

const apiKey = "fixture-private-account-api-key";
const provider = {
  getStatus: () => ({ defaultProvider: "gemini", paidCallsEnabled: false, providers: [
    { id: "gemini", model: "gemini-test", configured: false },
    { id: "openai", model: "gpt-test", configured: false },
    { id: "claude", model: "claude-test", configured: false },
  ] }),
  generate: () => { throw new Error("Settings tests must never issue paid calls"); },
};
const makeApp = (options = {}) => createTestApp({ integrationsEncryptionKey: "fixture-stable-workspace-key-only", traderAIProvider: provider, ...options });

test("blank integration encryption configuration falls back to the stable session secret", async (t) => {
  const previous = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "";
  t.after(() => { if (previous === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY; else process.env.INTEGRATIONS_ENCRYPTION_KEY = previous; });
  const app = makeApp({ integrationsEncryptionKey: "", sessionSecret: "fixture-stable-session-fallback-secret" });
  const agent = await loginTestOperator(app);
  const csrf = await readCsrfToken(agent, "/settings");
  const saved = await agent.put("/api/settings/providers/gemini").set("X-CSRF-Token", csrf).send({ apiKey }).expect(200);
  assert.equal(saved.body.providers[0].configured, true);
  assert.doesNotMatch(saved.text, new RegExp(apiKey));
});

test("workspace fragment navigation preserves the requested setup or knowledge section", async () => {
  const agent = await loginTestOperator(makeApp());
  for (const path of ["/research?view=knowledge", "/settings?section=defaults", "/settings?section=system"]) {
    await agent.get(path).set("X-Synergy-Module-Fragment", "1").expect(200).expect("X-Synergy-Module-Path", path);
  }
});

test("settings requires authentication and a CSRF token for every mutation", async () => {
  const app = makeApp();
  await request(app).get("/api/settings").expect(401);
  await request(app).put("/api/settings/providers/gemini").send({ apiKey }).expect(401);
  const agent = await loginTestOperator(app);
  await agent.get("/api/settings").expect(200).expect("Cache-Control", "no-store");
  await agent.put("/api/settings/providers/gemini").send({ apiKey }).expect(403);
  await agent.delete("/api/settings/providers/gemini").expect(403);
  await agent.patch("/api/settings/preferences").send({ provider: "openai" }).expect(403);
  await agent.put("/api/settings/drafts/research").send({ fields: { symbol: "SPY" } }).expect(403);
  await agent.delete("/api/settings/drafts/research").expect(403);
});

test("saved provider configuration and drafts are visible only to their owner and reflected in the Brain", async () => {
  const app = makeApp();
  const alice = await loginTestOperator(app, { username: "alice-settings" });
  const bob = await loginTestOperator(app, { username: "bob-settings" });
  const csrf = await readCsrfToken(alice, "/home");
  const save = await alice.put("/api/settings/providers/gemini").set("X-CSRF-Token", csrf).send({ apiKey }).expect(200);
  assert.equal(save.body.providers[0].configured, true);
  assert.equal(save.body.providers[0].source, "account");
  assert.equal(save.body.paidCallsEnabled, false);
  assert.doesNotMatch(save.text, new RegExp(apiKey));
  await alice.patch("/api/settings/preferences").set("X-CSRF-Token", csrf).send({ riskPercent: 0.25 }).expect(200);
  await alice.put("/api/settings/drafts/research").set("X-CSRF-Token", csrf).send({ fields: { objective: "Alice's unfinished research", context: "Retained source notes" } }).expect(200);
  const own = await alice.get("/api/settings").expect(200);
  assert.equal(own.body.preferences.riskPercent, 0.25);
  assert.equal(own.body.drafts.research.fields.context, "Retained source notes");
  const other = await bob.get("/api/settings").expect(200);
  assert.equal(other.body.providers[0].configured, false);
  assert.equal(other.body.preferences.riskPercent, 0.5);
  assert.equal(other.body.drafts.research, null);
  const brain = await alice.get("/api/brain/state").expect(200);
  assert.equal(brain.body.providers[0].configured, true);
  assert.equal(brain.body.paidCallsEnabled, false);
  assert.doesNotMatch(brain.text, new RegExp(apiKey));
  const otherBrain = await bob.get("/api/brain/state").expect(200);
  assert.equal(otherBrain.body.providers[0].configured, false);
  await alice.delete("/api/settings/providers/gemini").set("X-CSRF-Token", csrf).expect(200);
  await alice.delete("/api/settings/drafts/research").set("X-CSRF-Token", csrf).expect(200);
  const cleared = await alice.get("/api/settings").expect(200);
  assert.equal(cleared.body.providers[0].configured, false);
  assert.equal(cleared.body.drafts.research, null);
});

test("settings returns safe validation and storage errors without exposing credentials in responses or logs", async () => {
  const logs = [];
  const app = makeApp({ logger: { error: (message) => logs.push(message) } });
  const agent = await loginTestOperator(app);
  const csrf = await readCsrfToken(agent, "/home");
  await agent.put("/api/settings/providers/unknown").set("X-CSRF-Token", csrf).send({ apiKey }).expect(422);
  await agent.put("/api/settings/drafts/research").set("X-CSRF-Token", csrf).send({ fields: { apiKey } }).expect(422);
  const failureApp = makeApp({ workspaceSettingsService: { async getState() { throw new Error(apiKey); } }, logger: { error: (message) => logs.push(message) } });
  const failureAgent = await loginTestOperator(failureApp);
  const failed = await failureAgent.get("/api/settings").expect(500);
  assert.doesNotMatch(failed.text, new RegExp(apiKey));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(apiKey));
});
