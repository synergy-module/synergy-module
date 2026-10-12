import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryBrokerRepository } from "../../src/brokers/broker-repository.js";
import { createRobinhoodService } from "../../src/brokers/robinhood-service.js";
import { readRobinhoodConfig } from "../../src/brokers/robinhood-client.js";

const secret = "fixture-only-stable-session-secret-for-setup";
const callback = "https://synergy.test/auth/discord/callback";
function service(env, { persistent = true } = {}) {
  const repository = createMemoryBrokerRepository();
  if (persistent) repository.getStorageStatus = () => ({ kind: "fixture", persistent: true });
  return createRobinhoodService({ repository, config: readRobinhoodConfig(env) });
}

test("Robinhood setup explains missing server prerequisites without exposing values", async () => {
  const state = await service({ ROBINHOOD_TOKEN_ENCRYPTION_KEY: "invalid-private-fixture", ROBINHOOD_REDIRECT_URI: "https://user:private@example.test/invalid" }, { persistent: false }).state("owner");
  assert.equal(state.configured, false); assert.equal(state.setup.ready, false);
  assert.deepEqual(state.setup.checks.filter(check => !check.ready).map(check => check.id), ["encryption", "callback", "storage"]);
  assert.equal(state.setup.redirectUri, null);
  assert.doesNotMatch(JSON.stringify(state), /invalid-private-fixture|user:private/);
  assert.ok(state.setup.checks.every(check => check.label && check.message));
});

test("normal server sign-in settings make Robinhood available without any LLM provider key", async () => {
  const state = await service({ SESSION_SECRET: secret, DISCORD_REDIRECT_URI: callback, NODE_ENV: "production" }).state("owner");
  assert.equal(state.configured, true); assert.equal(state.connected, false);
  assert.equal(state.setup.encryptionKeySource, "SESSION_SECRET");
  assert.equal(state.setup.redirectUri, "https://synergy.test/auth/robinhood/callback");
  assert.ok(state.setup.checks.every(check => check.ready));
  assert.equal(state.liveEnabled, false); assert.equal(state.paused, true);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));
});

test("temporary storage remains a precise connection blocker despite otherwise valid settings", async () => {
  const broker = service({ SESSION_SECRET: secret, DISCORD_REDIRECT_URI: callback }, { persistent: false });
  const state = await broker.state("owner");
  assert.equal(state.configured, false);
  assert.deepEqual(state.setup.checks.filter(check => !check.ready).map(check => check.id), ["storage"]);
  await assert.rejects(broker.begin("owner"), { code: "ROBINHOOD_CONFIG" });
});
