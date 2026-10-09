import test from "node:test";
import assert from "node:assert/strict";
import { readSynergyResearchConfig } from "../../src/config/synergy-research-config.js";
import { createSynergyResearch } from "../../src/agent-brain/synergy-research.js";

test("shared research configuration is independent and never serializes credentials", () => {
  assert.equal(createSynergyResearch({ config: readSynergyResearchConfig({ DATABASE_URL: "postgres://app" }) }), null);
  const config = readSynergyResearchConfig({ SYNERGY_RESEARCH_DATABASE_URL: "postgres://reader:secret@db/research", SYNERGY_RESEARCH_DATABASE_SSL: "require" });
  assert.equal(config.ssl, true);
  assert.equal(config.configured, true);
  assert.doesNotMatch(JSON.stringify(config), /secret|reader|postgres/);
  assert.throws(() => readSynergyResearchConfig({ SYNERGY_RESEARCH_DATABASE_URL: "https://example.com" }), /PostgreSQL URL/);
  assert.throws(() => readSynergyResearchConfig({ SYNERGY_RESEARCH_DATABASE_SSL: "ignore" }), /disable or require/);
});

test("database failures are distinct from empty results and never expose connection details", async () => {
  const service = createSynergyResearch({ pool: { query: async () => { throw new Error("postgres://reader:private@db"); } } });
  assert.equal((await service.status()).connected, false);
  await assert.rejects(service.search("NQ strategy"), error => error.code === "SYNERGY_RESEARCH_UNAVAILABLE" && !error.message.includes("private"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.search("NQ", { signal: controller.signal }), { code: "SYNERGY_RESEARCH_CANCELLED" });
});
