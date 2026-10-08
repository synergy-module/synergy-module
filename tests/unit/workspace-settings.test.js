import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryWorkspaceRepository, createSqliteWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createWorkspaceSettingsService } from "../../src/settings/workspace-settings-service.js";
import { createWorkspaceAIProvider } from "../../src/providers/workspace-ai-provider.js";
import { createBrainModelGateway } from "../../src/agent-brain/brain-model-gateway.js";
import { createMemoryBrainRepository } from "../../src/agent-brain/brain-repository.js";
import { createTraderService } from "../../src/services/trader-service.js";

const encryptionSecret = "fixture-workspace-encryption-secret-only";
const keys = { alice: "fixture-alice-provider-key", bob: "fixture-bob-provider-key" };
const status = {
  defaultProvider: "gemini", paidCallsEnabled: false,
  providers: [
    { id: "gemini", label: "Gemini", model: "gemini-test", configured: false },
    { id: "openai", label: "OpenAI", model: "gpt-test", configured: false },
    { id: "claude", label: "Claude", model: "claude-test", configured: false },
  ],
};
const provider = (overrides = {}) => ({ getStatus: () => structuredClone({ ...status, ...overrides }) });
const schema = { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false };
const generation = { provider: "gemini", system: "Research fixture", prompt: "Summarize the supplied fixture.", schema };
const response = (text = "fixture result") => new Response(JSON.stringify({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ result: text }) }] } }],
  usageMetadata: { promptTokenCount: 3, totalTokenCount: 5, candidatesTokenCount: 2 },
}), { status: 200, headers: { "Content-Type": "application/json" } });

test("SQLite workspace retains encrypted credentials, preferences and incomplete drafts after reopening", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "synergy-module-workspace-"));
  const filename = path.join(directory, "workspace.sqlite");
  let repository;
  try {
    repository = createSqliteWorkspaceRepository(filename);
    let settings = createWorkspaceSettingsService({ repository, aiProvider: provider(), encryptionSecret });
    const saved = await settings.saveProvider("alice", "gemini", { apiKey: keys.alice });
    assert.equal(saved.providers[0].source, "account");
    assert.equal(saved.providers[0].configured, true);
    assert.equal(saved.paidCallsEnabled, false);
    assert.equal(JSON.stringify(saved).includes(keys.alice), false);
    await settings.savePreferences("alice", { provider: "openai", riskPercent: 0.25, routes: { critic: "claude" }, limits: { maxSteps: 8 } });
    await settings.saveDraft("alice", "research", { objective: "unfinished", symbol: "", context: "My saved market notes", accountSize: "" });
    await settings.saveDraft("alice", "journal", { notes: "Execution lesson", confluences: ["HTF alignment"], direction: "long" });
    const stored = JSON.stringify(await repository.read("alice"));
    assert.equal(stored.includes(keys.alice), false);
    assert.match(stored, /ciphertext/);
    await repository.close();
    repository = null;
    assert.equal((await readFile(filename)).includes(Buffer.from(keys.alice)), false);
    repository = createSqliteWorkspaceRepository(filename);
    settings = createWorkspaceSettingsService({ repository, aiProvider: provider(), encryptionSecret });
    const state = await settings.getState("alice");
    assert.equal(state.storage.persistent, true);
    assert.equal(state.preferences.riskPercent, 0.25);
    assert.equal(state.preferences.limits.maxSteps, 8);
    assert.equal(state.preferences.limits.maxTokens, 64000);
    assert.equal(state.preferences.routes.critic, "claude");
    assert.equal(state.drafts.research.fields.context, "My saved market notes");
    assert.deepEqual(state.drafts.journal.fields.confluences, ["HTF alignment"]);
    assert.equal(await settings.getProviderCredential("alice", "gemini"), keys.alice);
    const other = await settings.getState("bob");
    assert.equal(other.providers[0].configured, false);
    assert.equal(other.drafts.research, null);
    assert.equal(other.preferences.riskPercent, 0.5);
    await settings.removeProvider("alice", "gemini");
    await settings.removeDraft("alice", "research");
    assert.equal(await settings.getProviderCredential("alice", "gemini"), null);
    assert.equal((await settings.getState("alice")).drafts.research, null);
  } finally { await repository?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("credential ciphertext is bound to its owner and provider and fails closed after an encryption key change", async () => {
  const repository = createMemoryWorkspaceRepository();
  const settings = createWorkspaceSettingsService({ repository, aiProvider: provider(), encryptionSecret });
  await settings.saveProvider("alice", "gemini", { apiKey: keys.alice });
  const record = (await repository.read("alice")).providers.gemini;
  await repository.update("bob", (state) => { state.providers.gemini = record; });
  await repository.update("alice", (state) => { state.providers.openai = record; });
  await assert.rejects(settings.getProviderCredential("bob", "gemini"), { code: "SETTINGS_CREDENTIAL_UNAVAILABLE" });
  await assert.rejects(settings.getProviderCredential("alice", "openai"), { code: "SETTINGS_CREDENTIAL_UNAVAILABLE" });
  assert.equal((await settings.getState("bob")).providers[0].needsReplacement, true);
  const wrongKey = createWorkspaceSettingsService({ repository, aiProvider: provider(), encryptionSecret: `${encryptionSecret}-changed` });
  assert.equal((await wrongKey.getState("alice")).providers[0].configured, false);
  await assert.rejects(wrongKey.getProviderCredential("alice", "gemini"), { code: "SETTINGS_CREDENTIAL_UNAVAILABLE" });
});

test("credentials require a stable secret while drafts remain usable without credential storage", async () => {
  for (const secret of [undefined, "short", "synergy-module-local-development-secret", "omensite-local-development-secret"]) {
    const settings = createWorkspaceSettingsService({ aiProvider: provider(), encryptionSecret: secret });
    assert.equal((await settings.getState("alice")).credentialStorageAvailable, false);
    await assert.rejects(settings.saveProvider("alice", "gemini", { apiKey: keys.alice }), { code: "SETTINGS_ENCRYPTION_UNAVAILABLE" });
    const state = await settings.saveDraft("alice", "research", { symbol: "SPY" });
    assert.equal(state.drafts.research.fields.symbol, "SPY");
  }
});

test("branding upgrade reads existing v1 credentials and saves replacements in the new version", async () => {
  const repository = createMemoryWorkspaceRepository();
  const iv = Buffer.alloc(12, 7);
  const legacyKey = Buffer.from(hkdfSync("sha256", encryptionSecret, "omensite-workspace-v1", "provider-api-credentials", 32));
  const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["omensite-workspace-v1", "alice", "gemini"])));
  const ciphertext = Buffer.concat([cipher.update(keys.alice, "utf8"), cipher.final()]);
  const legacy = { version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  await repository.update("alice", (state) => { state.providers.gemini = { sealed: legacy }; });
  const settings = createWorkspaceSettingsService({ repository, encryptionSecret });
  assert.equal(await settings.getProviderCredential("alice", "gemini"), keys.alice);
  assert.equal((await settings.getState("alice")).providers[0].configured, true);
  assert.deepEqual((await repository.read("alice")).providers.gemini.sealed, legacy, "reads do not rewrite persisted credentials");
  await repository.update("bob", (state) => { state.providers.gemini = { sealed: legacy }; });
  await assert.rejects(settings.getProviderCredential("bob", "gemini"), { code: "SETTINGS_CREDENTIAL_UNAVAILABLE" });

  await settings.saveProvider("alice", "gemini", { apiKey: keys.alice });
  const saved = (await repository.read("alice")).providers.gemini.sealed;
  assert.equal(saved.version, 2);
  const newKey = Buffer.from(hkdfSync("sha256", encryptionSecret, "synergy-module-workspace-v2", "provider-api-credentials", 32));
  const decipher = createDecipheriv("aes-256-gcm", newKey, Buffer.from(saved.iv, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify(["synergy-module-workspace-v2", "alice", "gemini"])));
  decipher.setAuthTag(Buffer.from(saved.tag, "base64url"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, "base64url")), decipher.final()]).toString("utf8"), keys.alice);
  await repository.update("alice", (state) => { state.providers.gemini.sealed.version = 1; });
  await assert.rejects(settings.getProviderCredential("alice", "gemini"), { code: "SETTINGS_CREDENTIAL_UNAVAILABLE" });
});

test("settings reject invalid preferences, oversized drafts and credential fields in draft storage", async () => {
  const settings = createWorkspaceSettingsService({ aiProvider: provider(), encryptionSecret });
  for (const value of [{ riskPercent: 6 }, { accountSize: "5000" }, { provider: "unknown" }, { routes: { admin: "gemini" } },
    { limits: { maxSteps: 100 } }, { limits: { maxCostUsd: -1 } }, { paidCallsEnabled: true }, { symbol: "<script>" }]) {
    await assert.rejects(settings.savePreferences("alice", value), { code: "SETTINGS_INVALID" });
  }
  for (const fields of [{ apiKey: keys.alice }, { context: "x".repeat(12001) }, { symbol: {} }]) {
    await assert.rejects(settings.saveDraft("alice", "research", fields), { code: "SETTINGS_INVALID" });
  }
  await assert.rejects(settings.saveDraft("alice", "unknown", {}), { code: "SETTINGS_INVALID" });
  await assert.rejects(settings.saveProvider("alice", "gemini", { apiKey: keys.alice, model: "gemini-unpriced" }), { code: "SETTINGS_INVALID" });
  await settings.savePreferences("alice", { routes: { critic: "claude" } });
  assert.deepEqual((await settings.savePreferences("alice", { routes: { critic: "" } })).preferences.routes, {});
});

test("saved keys never authorize paid calls or cause requests during saving", async () => {
  let calls = 0;
  const fallbackProvider = provider();
  const settings = createWorkspaceSettingsService({ aiProvider: fallbackProvider, encryptionSecret });
  const ai = createWorkspaceAIProvider({ settingsService: settings, fallbackProvider, fetchImpl: async () => { calls += 1; return response(); } });
  await settings.saveProvider("alice", "gemini", { apiKey: keys.alice });
  assert.equal((await ai.getOwnerStatus("alice")).providers[0].configured, true);
  assert.equal(ai.getStatus().providers[0].configured, false);
  await assert.rejects(ai.generateDetailed({ ...generation, ownerId: "alice" }), { code: "TRADER_PAID_AI_LOCKED" });
  assert.equal(calls, 0);
});

test("brain gateway uses only the current owner's saved provider key, including concurrent requests and cache isolation", async () => {
  const sentKeys = [];
  const fallbackProvider = provider({ paidCallsEnabled: true });
  const settings = createWorkspaceSettingsService({ aiProvider: fallbackProvider, encryptionSecret });
  await settings.saveProvider("alice", "gemini", { apiKey: keys.alice });
  await settings.saveProvider("bob", "gemini", { apiKey: keys.bob });
  const ai = createWorkspaceAIProvider({ settingsService: settings, fallbackProvider, fetchImpl: async (_url, request) => {
    sentKeys.push(request.headers["x-goog-api-key"]);
    return response();
  } });
  const gateway = createBrainModelGateway({ aiProvider: ai, repository: createMemoryBrainRepository() });
  const results = await Promise.all([gateway.generate("alice", generation), gateway.generate("bob", generation)]);
  assert.deepEqual(sentKeys.sort(), Object.values(keys).sort());
  assert.equal(results[0].data.result, "fixture result");
  assert.equal((await gateway.generate("alice", generation)).cache.status, "hit");
  await assert.rejects(gateway.generate("charlie", generation), { code: "TRADER_PROVIDER_NOT_CONFIGURED" });
  assert.equal(sentKeys.length, 2);
  await settings.removeProvider("alice", "gemini");
  await assert.rejects(gateway.generate("alice", generation), { code: "TRADER_PROVIDER_NOT_CONFIGURED" });
});

test("server fallback remains available and is disclosed after an account key is removed", async () => {
  let fallbackCalls = 0;
  const fallbackProvider = {
    ...provider({ paidCallsEnabled: true, providers: status.providers.map((item) => ({ ...item, configured: item.id === "gemini" })) }),
    async generateDetailed(input) { fallbackCalls += 1; assert.equal(input.provider, "gemini"); return { data: { result: "server result" }, provider: "gemini", model: "gemini-test", usage: null }; },
  };
  const settings = createWorkspaceSettingsService({ aiProvider: fallbackProvider, encryptionSecret });
  const ai = createWorkspaceAIProvider({ settingsService: settings, fallbackProvider });
  await settings.saveProvider("alice", "gemini", { apiKey: keys.alice });
  const removed = await settings.removeProvider("alice", "gemini");
  assert.equal(removed.providers[0].source, "server");
  assert.equal((await ai.generate({ ...generation, ownerId: "alice" })).result, "server result");
  assert.equal(fallbackCalls, 1);
});

test("provider responses cannot echo a saved key into research results", async () => {
  const fallbackProvider = provider({ paidCallsEnabled: true });
  const settings = createWorkspaceSettingsService({ aiProvider: fallbackProvider, encryptionSecret });
  await settings.saveProvider("alice", "gemini", { apiKey: keys.alice });
  const ai = createWorkspaceAIProvider({ settingsService: settings, fallbackProvider, fetchImpl: async () => response(keys.alice) });
  await assert.rejects(ai.generate({ ...generation, ownerId: "alice" }), { code: "TRADER_PROVIDER_ERROR" });
});

test("asynchronous owner configuration does not allow two simultaneous analyses for one account", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const service = createTraderService({ aiProvider: {
    ...provider(),
    async getOwnerStatus() { return { ...status, paidCallsEnabled: true, providers: status.providers.map((item) => ({ ...item, configured: true })) }; },
    async generate(request) { calls += 1; assert.equal(request.ownerId, "alice"); await pending; return {
      bias: "neutral", summary: "Insufficient verified source evidence", evidence: [], missingData: ["Current price"],
      entry: null, stop: null, target: null, invalidation: "Await verified evidence",
    }; },
  } });
  const input = { provider: "gemini", mode: "analysis", symbol: "SPY", timeframe: "15m", accountSize: 10000, riskPercent: 0.5,
    pointValue: 1, minRewardRisk: 2, context: "Manually supplied fixture with insufficient verified market evidence." };
  const first = service.run("alice", input);
  const second = service.run("alice", input);
  await assert.rejects(second, { code: "TRADER_RUN_IN_PROGRESS" });
  release();
  await first;
  assert.equal(calls, 1);
});
