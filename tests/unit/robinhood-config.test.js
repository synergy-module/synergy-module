import test from "node:test";
import assert from "node:assert/strict";
import { createBrokerCipher, readRobinhoodConfig } from "../../src/brokers/robinhood-client.js";

const callback = "https://synergymodule.test/auth/discord/callback";
const sessionSecret = "fixture-session-secret-stable-across-restarts";
const integrationSecret = "fixture-integration-secret-stable-across-restarts";
const hosted = { NODE_ENV: "production", DISCORD_REDIRECT_URI: callback, SESSION_SECRET: sessionSecret };

test("hosted Robinhood setup derives a stable dedicated key from the configured session secret", () => {
  const first = readRobinhoodConfig(hosted), restarted = readRobinhoodConfig({ ...hosted });
  assert.equal(first.configured, true);
  assert.equal(first.encryptionKeySource, "SESSION_SECRET");
  assert.equal(first.redirectSource, "DISCORD_REDIRECT_URI");
  assert.equal(first.redirectUri, "https://synergymodule.test/auth/robinhood/callback");
  assert.equal(first.liveEnabled, false);
  assert.deepEqual(first.missing, []);
  assert.match(first.encryptionKey, /^[a-f0-9]{64}$/);
  assert.notEqual(first.encryptionKey, sessionSecret);
  const sealed = createBrokerCipher(first.encryptionKey).seal("owner", { accessToken: "fixture-token" });
  assert.equal(createBrokerCipher(restarted.encryptionKey).open("owner", sealed).accessToken, "fixture-token");
  assert.throws(() => createBrokerCipher(restarted.encryptionKey).open("another-owner", sealed), { code: "ROBINHOOD_RECONNECT" });
  const rotated = readRobinhoodConfig({ ...hosted, SESSION_SECRET: `${sessionSecret}-rotated` });
  assert.throws(() => createBrokerCipher(rotated.encryptionKey).open("owner", sealed), { code: "ROBINHOOD_RECONNECT" });
});

test("integration encryption secret takes precedence and is domain separated from the raw key", () => {
  const rawHex = "ab".repeat(32);
  const first = readRobinhoodConfig({ ...hosted, INTEGRATIONS_ENCRYPTION_KEY: rawHex });
  assert.equal(first.configured, true);
  assert.equal(first.encryptionKeySource, "INTEGRATIONS_ENCRYPTION_KEY");
  assert.notEqual(first.encryptionKey, rawHex);
  assert.equal(first.encryptionKey, readRobinhoodConfig({ ...hosted, INTEGRATIONS_ENCRYPTION_KEY: rawHex, SESSION_SECRET: "other-session" }).encryptionKey);
  assert.notEqual(first.encryptionKey, readRobinhoodConfig(hosted).encryptionKey);
});

test("explicit broker key and callback remain authoritative without changing saved encryption keys", () => {
  const explicitKey = "CD".repeat(32), explicitRedirect = "https://approved.test/auth/robinhood/callback";
  const config = readRobinhoodConfig({ ...hosted, INTEGRATIONS_ENCRYPTION_KEY: integrationSecret,
    ROBINHOOD_TOKEN_ENCRYPTION_KEY: ` ${explicitKey} `, ROBINHOOD_REDIRECT_URI: explicitRedirect });
  assert.equal(config.configured, true);
  assert.equal(config.encryptionKey, explicitKey);
  assert.equal(config.encryptionKeySource, "ROBINHOOD_TOKEN_ENCRYPTION_KEY");
  assert.equal(config.redirectSource, "ROBINHOOD_REDIRECT_URI");
  assert.equal(config.redirectUri, explicitRedirect);
  const invalidKey = readRobinhoodConfig({ ...hosted, ROBINHOOD_TOKEN_ENCRYPTION_KEY: "invalid" });
  assert.equal(invalidKey.configured, false);
  assert.equal(invalidKey.encryptionKeySource, "ROBINHOOD_TOKEN_ENCRYPTION_KEY");
  assert.deepEqual(invalidKey.missing, ["ROBINHOOD_TOKEN_ENCRYPTION_KEY"]);
  const invalidRedirect = readRobinhoodConfig({ ...hosted, ROBINHOOD_REDIRECT_URI: "https://approved.test/wrong" });
  assert.equal(invalidRedirect.configured, false);
  assert.equal(invalidRedirect.redirectSource, "ROBINHOOD_REDIRECT_URI");
  assert.deepEqual(invalidRedirect.missing, ["ROBINHOOD_REDIRECT_URI"]);
});

test("missing or weak stable keys fail closed, including a weak configured integration override", () => {
  for (const env of [
    { SESSION_SECRET: undefined }, { SESSION_SECRET: "short" }, { SESSION_SECRET: " ".repeat(40) },
    { INTEGRATIONS_ENCRYPTION_KEY: "too-short", SESSION_SECRET: sessionSecret },
  ]) {
    const config = readRobinhoodConfig({ ...hosted, ...env });
    assert.equal(config.configured, false);
    assert.equal(config.encryptionKey, "");
    assert.deepEqual(config.missing, ["ROBINHOOD_TOKEN_ENCRYPTION_KEY"]);
  }
  const blankOverrides = readRobinhoodConfig({ ...hosted, INTEGRATIONS_ENCRYPTION_KEY: " ", ROBINHOOD_TOKEN_ENCRYPTION_KEY: " " });
  assert.equal(blankOverrides.configured, true);
  assert.equal(blankOverrides.encryptionKeySource, "SESSION_SECRET");
});

test("callback fallback accepts only a trusted configured origin with the existing transport restrictions", () => {
  const missing = readRobinhoodConfig({ SESSION_SECRET: sessionSecret, NODE_ENV: "production", HOST: "attacker.test", HTTP_HOST: "attacker.test", FORWARDED_HOST: "attacker.test" });
  assert.equal(missing.configured, false);
  assert.equal(missing.redirectSource, null);
  assert.equal(missing.redirectUri, undefined);
  for (const uri of ["http://synergymodule.test/auth/discord/callback", "https://u:p@synergymodule.test/auth/discord/callback", "not-a-url"]) {
    assert.equal(readRobinhoodConfig({ ...hosted, DISCORD_REDIRECT_URI: uri }).configured, false);
  }
  assert.equal(readRobinhoodConfig({ ...hosted, NODE_ENV: "development", DISCORD_REDIRECT_URI: "http://127.0.0.1:3000/auth/discord/callback" }).configured, true);
  assert.equal(readRobinhoodConfig({ ...hosted, DISCORD_REDIRECT_URI: "http://127.0.0.1:3000/auth/discord/callback" }).configured, false);
});
