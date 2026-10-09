import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBrainToolPolicy } from "../../src/agent-brain/brain-tool-policy.js";
import { createMemoryBrainToolPolicyRepository, createSqliteBrainToolPolicyRepository } from "../../src/agent-brain/brain-tool-policy-repository.js";
import { createBrainTools } from "../../src/agent-brain/brain-tools.js";

const input = { mode: "analysis", provider: "gemini", symbol: "NQ", timeframe: "5m", context: "Historical research context only; no current market prices are supplied.", accountSize: 50000, riskPercent: 0.5, pointValue: 20, minRewardRisk: 2 };
test("agent assignments AND module gates apply to every invocation, including revocation", async () => {
  const policy = createBrainToolPolicy({ repository: createMemoryBrainToolPolicyRepository() });
  let reads = 0;
  const tools = createBrainTools({ toolPolicy: policy, synergyResearch: { async search() { reads++; return { matches: [], citations: [] }; } } });
  const execute = role => tools.execute({ name: "synergy.search", arguments: { query: "NQ" }, role, ownerId: "operator", input });
  for (const role of ["planner", "researcher", "strategist", "critic"]) await assert.rejects(execute(role), { code: "BRAIN_TOOL_DENIED" });
  let state = await policy.read();
  for (const role of ["planner", "researcher", "strategist", "critic"]) {
    const section = `agent:${role}`;
    state = await policy.update(section, { version: state.version, tools: [...state.assignments[section], "synergy-mcp"] }, "admin");
    await assert.rejects(execute(role), { code: "BRAIN_TOOL_DENIED" });
  }
  state = await policy.update("module:retrieval", { version: state.version, tools: [...state.assignments["module:retrieval"], "synergy-mcp"] }, "admin");
  for (const role of ["planner", "researcher", "strategist", "critic"]) await execute(role);
  assert.equal(reads, 4);
  assert.ok((await tools.definitions("researcher")).some(tool => tool.name === "synergy.search"));
  state = await policy.update("module:retrieval", { version: state.version, tools: state.assignments["module:retrieval"].filter(id => id !== "synergy-mcp") }, "admin");
  await assert.rejects(execute("researcher"), { code: "BRAIN_TOOL_DENIED" });
  assert.equal(reads, 4);
  assert.ok(!(await tools.definitions("researcher")).some(tool => tool.name === "synergy.search"));
  assert.equal(state.history.at(-1).actorId, "admin");
});

test("policy changes reject stale versions, unknown tools/sections and role escalation", async () => {
  const policy = createBrainToolPolicy({ repository: createMemoryBrainToolPolicyRepository() });
  for (const [section, body] of [["__proto__", {version:0,tools:[]}], ["agent:planner",{version:0,tools:["risk"]}], ["module:memory",{version:0,tools:["synergy-mcp"]}], ["agent:researcher",{version:0,tools:["shell"]}], ["agent:researcher",{version:0,tools:["context","context"]}], ["agent:researcher",{version:0,tools:[],actorId:"someone"}]]) {
    await assert.rejects(policy.update(section, body, "admin"), { code: "BRAIN_TOOL_POLICY_INPUT" });
  }
  const first = await policy.update("agent:researcher", { version: 0, tools: [] }, "admin");
  assert.equal(first.version, 1);
  const second = await policy.update("agent:researcher", { version: 1, tools: [] }, "admin");
  assert.equal(second.version, 1, "Idempotent save does not create another audit entry");
  await assert.rejects(policy.update("agent:critic", { version:0, tools:[] }, "other-admin"), { code:"BRAIN_TOOL_POLICY_CONFLICT" });
});

test("SQLite tool policy survives restart and concurrent writers cannot overwrite a revision", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "brain-tool-policy-"));
  const filename = path.join(directory, "app.sqlite");
  let repository = createSqliteBrainToolPolicyRepository(filename);
  await createBrainToolPolicy({repository}).update("agent:researcher", {version:0,tools:[]}, "admin");
  await repository.close(); repository = createSqliteBrainToolPolicyRepository(filename);
  const other = createSqliteBrainToolPolicyRepository(filename);
  t.after(async () => { await repository.close(); await other.close(); await rm(directory, {recursive:true,force:true}); });
  const policy = createBrainToolPolicy({repository});
  assert.deepEqual((await policy.read()).assignments["agent:researcher"], []);
  const results = await Promise.allSettled([policy.update("agent:planner",{version:1,tools:[]},"admin"),createBrainToolPolicy({repository:other}).update("agent:critic",{version:1,tools:[]},"other")]);
  assert.equal(results.filter(item => item.status === "fulfilled").length,1);
  assert.equal(results.find(item=>item.status === "rejected").reason.code,"BRAIN_TOOL_POLICY_CONFLICT");
});
