import test from "node:test";
import assert from "node:assert/strict";
import { createBrainKnowledge } from "../../src/agent-brain/brain-knowledge.js";
import { createMemoryBrainRepository } from "../../src/agent-brain/brain-repository.js";

function setup(t) {
  const repository = createMemoryBrainRepository();
  t.after(() => repository.close());
  return { repository, knowledge: createBrainKnowledge({ repository }) };
}

test("knowledge search ranks lexical matches and returns accurate source citations", async (t) => {
  const { repository, knowledge } = setup(t);
  const payroll = await knowledge.addDocument("owner", { title: "Payroll release rules", text: "Before nonfarm payrolls, pause new entries and review existing exposure." });
  await knowledge.addDocument("owner", { title: "Position sizing", text: "Use a fixed risk budget to calculate position size." });
  await knowledge.addDocument("another-owner", { title: "Payroll confidential", text: "Nonfarm payrolls private confidential plan." });
  const citations = await knowledge.search("owner", "nonfarm payrolls");
  assert.equal(citations[0].documentId, payroll.id);
  assert.equal(citations[0].chunkId, `${payroll.id}:0`);
  assert.equal(citations[0].kind, "knowledge");
  assert.ok(citations[0].score > 0);
  assert.equal(citations.length, 1);
  const original = (await repository.listDocuments("owner")).find((document) => document.id === payroll.id);
  assert.ok(original.text.includes(citations[0].excerpt));
  assert.deepEqual(await knowledge.search("owner", "nonfarm payrolls"), citations);
  assert.deepEqual(await knowledge.search("owner", "unrelatedasteroid"), []);
});

test("summaries omit document bodies and approved memory is searchable", async (t) => {
  const { repository, knowledge } = setup(t);
  await repository.putDocument("owner", { id: "run:approved", title: "Reviewed lesson", kind: "memory", text: "Avoid revenge trading after a losing session." });
  const summaries = await knowledge.listDocuments("owner");
  assert.equal(summaries[0].kind, "memory");
  assert.equal(summaries[0].chunkCount, 1);
  assert.equal(summaries[0].characters, 45);
  assert.equal(Object.hasOwn(summaries[0], "text"), false);
  const results = await knowledge.search("owner", "revenge trading");
  assert.equal(results[0].documentId, "run:approved");
  assert.equal(results[0].kind, "memory");
});

test("long documents yield bounded excerpts and retrieval includes the final portion", async (t) => {
  const { repository, knowledge } = setup(t);
  const source = `${"Ordinary observations about execution. ".repeat(500)} The uncommonquasar protocol requires stopping after two losses.`;
  const added = await knowledge.addDocument("owner", { title: "Long playbook", text: source });
  const results = await knowledge.search("owner", "uncommonquasar", { limit: 1000 });
  assert.ok(results.length > 0 && results.length <= 10);
  assert.ok(results[0].excerpt.includes("uncommonquasar"));
  for (const citation of results) {
    assert.equal(citation.documentId, added.id);
    assert.ok(citation.excerpt.length <= 900);
    assert.ok(source.includes(citation.excerpt));
  }
  assert.equal((await repository.listDocuments("owner"))[0].text, source);
});

test("document deletion immediately removes retrieval results without crossing owners", async (t) => {
  const { repository, knowledge } = setup(t);
  const input = { id: "shared-id", title: "Delta", text: "Cumulative delta divergence observation.", kind: "knowledge" };
  await repository.putDocument("owner-a", input);
  await repository.putDocument("owner-b", input);
  await knowledge.removeDocument("owner-a", "shared-id");
  assert.deepEqual(await knowledge.search("owner-a", "delta"), []);
  assert.equal((await knowledge.search("owner-b", "delta")).length, 1);
});

test("kind filtering occurs before ranking and result limits", async (t) => {
  const { repository, knowledge } = setup(t);
  for (let index = 0; index < 6; index += 1) {
    await repository.putDocument("owner", { id: `knowledge-${index}`, title: "Risk", text: "Risk risk risk.", kind: "knowledge" });
  }
  await repository.putDocument("owner", { id: "approved", title: "Lesson", text: "Review risk before every session.", kind: "memory" });
  const result = await knowledge.search("owner", "risk", { limit: 1, kind: "memory" });
  assert.equal(result.length, 1);
  assert.equal(result[0].documentId, "approved");
  const knowledgeOnly = await knowledge.search("owner", "risk", { kind: "knowledge" });
  assert.ok(knowledgeOnly.every((citation) => citation.kind === "knowledge"));
});

test("retrieval bounds query input and handles Unicode and markup as plain source text", async (t) => {
  const { knowledge } = setup(t);
  await knowledge.addDocument("owner", { title: "Risque", text: '<script>untrusted()</script> Équité, liquidité et risque.' });
  const results = await knowledge.search("owner", "ÉQUITÉ liquidité");
  assert.equal(results.length, 1);
  assert.ok(results[0].excerpt.includes("<script>"));
  assert.deepEqual(await knowledge.search("owner", "the and"), []);
  assert.deepEqual(await knowledge.search("owner", ""), []);
  await assert.rejects(knowledge.search("owner", "x".repeat(4001)), { code: "BRAIN_INVALID_INPUT" });
  await assert.rejects(knowledge.search("owner", {}), { code: "BRAIN_INVALID_INPUT" });
  await assert.rejects(knowledge.addDocument("owner", { title: "Too large", text: "x".repeat(50_001) }), { code: "BRAIN_INVALID_INPUT" });
});

test("indexed retrieval uses bounded candidates, kind filtering and verbatim positive citations", async () => {
  const calls = [];
  const knowledge = createBrainKnowledge({ repository: {
    listDocuments() { throw new Error("Indexed retrieval must not scan the complete document collection"); },
    async searchDocuments(...args) {
      calls.push(args);
      return [
        { id: "match", title: "Reviewed playbook", kind: "memory", text: "Review Équité and liquidity before the next session." },
        { id: "irrelevant", title: "Other", kind: "memory", text: "Unrelated source text." },
      ];
    },
  } });
  const result = await knowledge.search("owner", "the ÉQUITÉ Équité", { kind: "memory" });
  assert.deepEqual(calls, [["owner", ["équité"], { kind: "memory", limit: 64 }]]);
  assert.equal(result.length, 1);
  assert.equal(result[0].documentId, "match");
  assert.equal(result[0].excerpt, "Review Équité and liquidity before the next session.");
  assert.ok(result[0].score > 0);
});
