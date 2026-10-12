import test from "node:test";
import assert from "node:assert/strict";
import { readTraderConfig } from "../../src/config/trader-config.js";
import { createTraderAIProvider } from "../../src/providers/trader-ai-provider.js";
import { createWorkspaceSettingsService } from "../../src/settings/workspace-settings-service.js";
import { createWorkspaceAIProvider } from "../../src/providers/workspace-ai-provider.js";

const schema = { type: "object", additionalProperties: false, required: ["decision"], properties: { decision: { type: "string" } } };
test("Grok uses the fixed xAI Responses endpoint, strict output schema, and normalized usage", async () => {
  const secret = "fixture-grok-secret", calls = [];
  const provider = createTraderAIProvider({ config: readTraderConfig({ XAI_API_KEY: secret, TRADER_PAID_AI_ENABLED: "true" }), fetchImpl: async (url, input) => {
    calls.push({ url, input }); return Response.json({ status: "completed", output: [{ type: "reasoning", encrypted_content: "hidden" },
      { type: "message", status: "completed", content: [{ type: "output_text", text: '{"decision":"wait"}' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  } });
  const result = await provider.generateDetailed({ provider: "grok", system: "Research", prompt: "Fixture context", schema });
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses"); assert.equal(calls[0].input.headers.Authorization, `Bearer ${secret}`);
  assert.equal(JSON.parse(calls[0].input.body).model, "grok-4.7"); assert.equal(result.usage.totalTokens, 15);
  assert.deepEqual(result.data, { decision: "wait" }); assert.ok(!JSON.stringify(result).includes(secret));
});

test("per-owner Grok credentials remain encrypted, isolated, and subject to the paid-call lock", async () => {
  const base = createTraderAIProvider({ config: readTraderConfig({}) });
  const settings = createWorkspaceSettingsService({ aiProvider: base, encryptionSecret: "fixture-stable-key-for-grok-settings" });
  const state = await settings.saveProvider("alice", "grok", { apiKey: "fixture-private-xai-key" });
  assert.equal(state.providers.find(row => row.id === "grok").configured, true);
  assert.equal((await settings.getState("bob")).providers.find(row => row.id === "grok").configured, false);
  await settings.savePreferences("alice", { provider: "grok", routes: { critic: "grok" } });
  const ai = createWorkspaceAIProvider({ settingsService: settings, fallbackProvider: base });
  await assert.rejects(ai.generateDetailed({ ownerId: "alice", provider: "grok", system: "Fixture", prompt: "Fixture", schema }), { code: "TRADER_PAID_AI_LOCKED" });
  assert.ok(!JSON.stringify(state).includes("fixture-private-xai-key"));
});
