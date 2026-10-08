import assert from "node:assert/strict";
import test from "node:test";
import { HttpJournalRepository } from "../../public/js/journal/http-journal-repository.js";

test("HTTP journal repository reads and writes through the shared API", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return Response.json({ entry: { id: "created" } }, { status: 201 });
    return Response.json({ entries: [{ id: "listed" }] });
  };
  const repository = new HttpJournalRepository(fetchImpl, "csrf-token");

  assert.deepEqual(await repository.list(), [{ id: "listed" }]);
  assert.deepEqual(await repository.create({ direction: "long" }), { id: "created" });
  assert.equal(requests[1].options.headers["X-CSRF-Token"], "csrf-token");
  assert.equal(requests[1].options.credentials, "same-origin");
});

test("HTTP journal repository rejects failed responses", async () => {
  const repository = new HttpJournalRepository(async () => Response.json({}, { status: 503 }), "csrf");
  await assert.rejects(repository.list(), /Journal request failed/);
});
