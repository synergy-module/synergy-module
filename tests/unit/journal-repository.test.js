import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { initializeAppShell } from "../../public/js/app-shell.js";
import { LocalStorageJournalRepository } from "../../public/js/journal/local-storage-journal-repository.js";
import { createJournalService } from "../../public/js/journal/journal-service.js";

function fakeStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}

test("repository migrates legacy entries before inserting new records under the current brand", () => {
  const storage = fakeStorage({
    "omensite.journal.v1": JSON.stringify([{ id: "older", direction: "long" }]),
  });
  const repository = new LocalStorageJournalRepository(storage);
  const newest = { id: "newer", direction: "short" };

  repository.create(newest);

  const listed = repository.list();
  assert.deepEqual(listed.map(({ id, direction }) => ({ id, direction })), [newest, { id: "older", direction: "long" }]);
  assert.deepEqual(JSON.parse(storage.getItem("synergy-module.journal.v1")).map(({ id, direction }) => ({ id, direction })), [newest, { id: "older", direction: "long" }]);
  assert.equal(storage.getItem("omensite.journal.v1"), null);
  assert.deepEqual(listed[1].confluences, []);
});

test("repository finds entries by string ID and clears persisted records", () => {
  const storage = fakeStorage({
    "omensite.journal.v1": JSON.stringify([{ id: 42, direction: "long" }]),
  });
  const repository = new LocalStorageJournalRepository(storage);

  assert.deepEqual(repository.find("42"), {
    id: 42, direction: "long", entryTime: "--", entryPrice: "0", exitPrice: "0",
    pl: "+0.00", notes: "", confluences: [], screenshotCount: 0, createdAt: "",
  });
  repository.clear();
  assert.deepEqual(repository.list(), []);
  assert.equal(storage.getItem("omensite.journal.v1"), null);
  assert.equal(storage.getItem("synergy-module.journal.v1"), null);
});

test("repository preserves legacy journal data and a readable session copy when migration writes fail", () => {
  const saved = JSON.stringify([{ id: "saved-trade", direction: "long", notes: "keep this" }]);
  const storage = fakeStorage({ "omensite.journal.v1": saved });
  storage.setItem = () => { throw new Error("Quota exceeded"); };
  const repository = new LocalStorageJournalRepository(storage);
  assert.equal(repository.find("saved-trade").notes, "keep this");
  assert.equal(repository.persistenceAvailable, false);
  assert.equal(storage.getItem("omensite.journal.v1"), saved);
  assert.equal(storage.getItem("synergy-module.journal.v1"), null);
});

test("current journal data takes precedence and clearing also removes stale legacy records", () => {
  const storage = fakeStorage({
    "synergy-module.journal.v1": "[]",
    "omensite.journal.v1": JSON.stringify([{ id: "stale", direction: "long" }]),
  });
  const repository = new LocalStorageJournalRepository(storage);
  assert.deepEqual(repository.list(), []);
  repository.clear();
  assert.deepEqual(new LocalStorageJournalRepository(storage).list(), []);
});

test("custom journal namespaces do not import or clear legacy product data", () => {
  const saved = JSON.stringify([{ id: "saved-trade", direction: "long" }]);
  const storage = fakeStorage({ "omensite.journal.v1": saved });
  const repository = new LocalStorageJournalRepository(storage, "isolated.journal");
  assert.deepEqual(repository.list(), []);
  repository.clear();
  assert.equal(storage.getItem("omensite.journal.v1"), saved);
});

test("malformed persisted data falls back to an empty journal", () => {
  const storage = fakeStorage({ "omensite.journal.v1": "{" });
  const repository = new LocalStorageJournalRepository(storage);

  assert.deepEqual(repository.list(), []);
});

test("repository discards malformed records and normalizes safe legacy defaults", () => {
  const storage = fakeStorage({
    "omensite.journal.v1": JSON.stringify([
      {},
      { id: "legacy-1", direction: "long", confluences: "FVG", notes: 27, screenshotCount: "many" },
      { id: "bad-direction", direction: "sideways" },
    ]),
  });
  const repository = new LocalStorageJournalRepository(storage);

  assert.deepEqual(repository.list(), [{
    id: "legacy-1",
    direction: "long",
    confluences: [],
    notes: "",
    screenshotCount: 0,
    entryTime: "--",
    entryPrice: "0",
    exitPrice: "0",
    pl: "+0.00",
    createdAt: "",
  }]);
});

test("service creates a normalized entry through the repository seam", () => {
  const repository = new LocalStorageJournalRepository(fakeStorage());
  const service = createJournalService(
    repository,
    () => new Date("2026-09-01T00:00:00.000Z"),
    () => "entry-1",
  );

  const entry = service.create({
    direction: "short", entryTime: "", entryPrice: "100", exitPrice: "99",
    notes: "note", confluences: ["MSS"], screenshotCount: 1,
  });

  assert.deepEqual(entry, {
    id: "entry-1", direction: "short", entryTime: "--", entryPrice: "100", exitPrice: "99",
    pl: "+1.00", notes: "note", confluences: ["MSS"], screenshotCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(service.find("entry-1"), entry);
  assert.deepEqual(service.list(), [entry]);
});

test("repository keeps a session copy when persistent writes fail", () => {
  const repository = new LocalStorageJournalRepository({
    getItem() { return null; },
    setItem() { throw new Error("storage denied"); },
    removeItem() {},
  });
  const entry = { id: "memory-1", direction: "long" };

  repository.create(entry);

  assert.deepEqual(repository.list(), [entry]);
  assert.deepEqual(repository.find("memory-1"), entry);
});

test("app shell remains usable when localStorage access throws", () => {
  const dom = new JSDOM('<main data-app-shell data-main><section data-route-view data-route-key="journal"><div data-journal-list></div></section></main>', { url: "http://localhost/journal" });
  const windowRef = {
    location: dom.window.location,
    history: dom.window.history,
    matchMedia: () => ({ matches: true }),
    setTimeout: dom.window.setTimeout.bind(dom.window),
    setInterval: () => 0,
    clearInterval() {},
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    get localStorage() { throw new Error("localStorage unavailable"); },
  };

  const instance = initializeAppShell({
    documentRef: dom.window.document,
    windowRef,
    fetchImpl: async () => new Response("", { status: 500 }),
  });

  assert.ok(instance.navigator);
  instance.dispose();
});
