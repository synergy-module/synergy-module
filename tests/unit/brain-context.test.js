import test from "node:test";
import assert from "node:assert/strict";
import { createBrainContext, appendBrainObservation, getBrainRoleContext, verifyBrainCitations } from "../../src/agent-brain/brain-context.js";

const INPUT = { objective: "Research the ES setup with cited evidence.", context: "Manual snapshot: entry 100, stop 98, target 106.", accountSize: 50000, riskPercent: 0.5, pointValue: 50, minRewardRisk: 2 };

test("compaction retains objective, immutable risk rules and observed citation IDs", () => {
  let context = createBrainContext(INPUT, { maxChars: 4096 });
  for (let index = 0; index < 20; index += 1) context = appendBrainObservation(context, "researcher", {
    type: "tool_observation", summary: `Read evidence chunk ${index}.`, data: "Evidence ".repeat(400), citations: [{ id: "snapshot" }, { id: "doc:0" }],
  });
  assert.ok(context.compactions > 0);
  assert.ok(JSON.stringify(context).length <= 4096);
  assert.equal(context.objective, INPUT.objective);
  assert.equal(context.riskRules.riskPercent, 0.5);
  assert.equal(context.riskRules.pointValue, 50);
  assert.equal(context.riskRules.minRewardRisk, 2);
  assert.match(context.riskRules.policy, /No orders/);
  assert.deepEqual(context.citationIds, ["snapshot", "doc:0"]);
  assert.ok(context.memoryNote.length > 0);
});

test("agent histories are isolated while compact source evidence is shared", () => {
  let context = createBrainContext(INPUT);
  context = appendBrainObservation(context, "researcher", { summary: "Read a support level.", data: { support: 98 }, citations: [{ id: "snapshot" }] });
  context = appendBrainObservation(context, "strategist", { summary: "Prepared a proposal.", data: { target: 106 } });
  const strategist = getBrainRoleContext(context, "strategist");
  assert.equal(strategist.history.length, 1);
  assert.equal(strategist.history[0].summary, "Prepared a proposal.");
  assert.equal(strategist.sharedEvidence.length, 1);
  assert.match(strategist.sharedEvidence[0].excerpt, /98/);
  assert.equal(getBrainRoleContext(context, "critic").history.length, 0);
  strategist.riskRules.riskPercent = 5;
  assert.equal(context.riskRules.riskPercent, 0.5);
});

test("context append does not mutate an earlier durable checkpoint", () => {
  const original = createBrainContext(INPUT);
  const next = appendBrainObservation(original, "researcher", { summary: "Observed snapshot", data: "data", citations: ["snapshot"] });
  assert.equal(original.histories.researcher.length, 0);
  assert.equal(original.citationIds.length, 0);
  assert.equal(next.histories.researcher.length, 1);
});

test("only observed citations can ground a proposal", () => {
  const sources = [{ id: "snapshot", title: "Manual snapshot" }, { id: "doc:0", title: "Playbook" }];
  const valid = verifyBrainCitations({ evidence: ["The snapshot gives 98 support. [snapshot]", "The playbook calls for a reclaim. [doc:0]"] }, sources);
  assert.equal(valid.passed, true);
  assert.deepEqual(valid.citations.map((citation) => citation.id), ["snapshot", "doc:0"]);
  const fabricated = verifyBrainCitations({ evidence: ["Invented liquidity. [nonexistent]"] }, sources);
  assert.equal(fabricated.passed, false);
  assert.match(fabricated.reasons.join(" "), /unobserved/);
  const uncited = verifyBrainCitations({ evidence: ["Unsupported price observation."] }, sources);
  assert.equal(uncited.passed, false);
  assert.match(uncited.reasons.join(" "), /must cite/);
});

test("working context bounds and role names are enforced", () => {
  assert.throws(() => createBrainContext(INPUT, { maxChars: 20000 }));
  assert.throws(() => appendBrainObservation(createBrainContext(INPUT), "broker", {}));
  assert.throws(() => getBrainRoleContext(createBrainContext(INPUT), "broker"));
});
