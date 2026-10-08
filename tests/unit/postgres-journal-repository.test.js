import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresJournalRepository } from "../../src/repositories/postgres-journal-repository.js";

test("PostgreSQL journal records are scoped to the authenticated operator", async () => {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (/SELECT/.test(text)) return { rows: [{
        id: "entry-1", owner_id: "discord:7", direction: "long", entry_time: "09/08",
        entry_price: "100", exit_price: "101", profit_loss: "+1.00", notes: "held",
        confluences: ["FVG"], screenshot_count: 0, created_at: new Date("2026-09-08T00:00:00.000Z"),
      }] };
      return { rows: [] };
    },
  };
  const repository = createPostgresJournalRepository(client);

  const entries = await repository.list("discord:7");

  assert.equal(calls[0].values[0], "discord:7");
  assert.deepEqual(entries[0], {
    id: "entry-1", direction: "long", entryTime: "09/08", entryPrice: "100",
    exitPrice: "101", pl: "+1.00", notes: "held", confluences: ["FVG"],
    screenshotCount: 0, createdAt: "2026-09-08T00:00:00.000Z",
  });
});

test("PostgreSQL journal inserts all normalized fields with the owner id", async () => {
  const calls = [];
  const client = { async query(text, values = []) { calls.push({ text, values }); return { rows: [] }; } };
  const repository = createPostgresJournalRepository(client);
  const entry = {
    id: "entry-2", direction: "short", entryTime: "09/08", entryPrice: "100",
    exitPrice: "99", pl: "+1.00", notes: "sweep", confluences: ["MSS"],
    screenshotCount: 1, createdAt: "2026-09-08T01:00:00.000Z",
  };

  await repository.create("discord:8", entry);

  assert.match(calls[0].text, /INSERT INTO journal_entries/);
  assert.deepEqual(calls[0].values, [
    "entry-2", "discord:8", "short", "09/08", "100", "99", "+1.00",
    "sweep", JSON.stringify(["MSS"]), 1, "2026-09-08T01:00:00.000Z",
  ]);
});
