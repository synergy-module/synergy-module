import assert from "node:assert/strict";
import test from "node:test";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

function inMemoryRepository() {
  const records = new Map();
  return {
    async list(ownerId) { return records.get(ownerId) ?? []; },
    async find(ownerId, id) { return (records.get(ownerId) ?? []).find((entry) => entry.id === id); },
    async create(ownerId, entry) {
      records.set(ownerId, [entry, ...(records.get(ownerId) ?? [])]);
      return entry;
    },
  };
}

test("journal API persists normalized entries for the signed-in operator", async () => {
  const app = createTestApp({ journalRepository: inMemoryRepository() });
  const agent = await loginTestOperator(app);
  const csrf = await readCsrfToken(agent, "/journal");

  const created = await agent.post("/api/journal")
    .set("X-CSRF-Token", csrf)
    .send({ direction: "long", entryTime: "", entryPrice: "100", exitPrice: "102", notes: "held", confluences: ["FVG"], screenshotCount: 0 })
    .expect(201);
  assert.equal(created.body.entry.pl, "+2.00");

  const listed = await agent.get("/api/journal").expect(200);
  assert.equal(listed.body.entries.length, 1);
  assert.equal(listed.body.entries[0].id, created.body.entry.id);
});

test("journal API requires authentication and CSRF on writes", async () => {
  const app = createTestApp({ journalRepository: inMemoryRepository() });
  const unauthenticated = await import("supertest").then(({ default: request }) => request(app));
  await unauthenticated.get("/api/journal").expect(401);
  const agent = await loginTestOperator(app);
  await agent.post("/api/journal").send({ direction: "long" }).expect(403);
});
