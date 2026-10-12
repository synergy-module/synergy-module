import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { observeWorkspaceUpdate } from "../../public/js/workspace-notifications.js";

test("optional completion notices honor preferences and ignore history on initial load", t => {
  const dom = new JSDOM("<main></main>"); t.after(() => dom.window.close());
  const doc = dom.window.document, root = doc.querySelector("main");
  observeWorkspaceUpdate(root, "/api/brain/state", { runs: [{ id: "first", status: "running" }] });
  assert.equal(doc.querySelector("[data-workspace-notification]"), null);
  doc.documentElement.dataset.notifications = JSON.stringify({ researchCompleted: false });
  observeWorkspaceUpdate(root, "/api/brain/state", { runs: [{ id: "first", status: "completed" }] });
  assert.equal(doc.querySelector("[data-workspace-notification]"), null);
  doc.documentElement.dataset.notifications = "{}";
  observeWorkspaceUpdate(root, "/api/practice", { books: [{ id: "paper", trades: [] }] });
  observeWorkspaceUpdate(root, "/api/practice/books/paper/orders", { id: "paper", mode: "PAPER", trades: [{ id: "fill" }] });
  assert.match(doc.querySelector("[data-workspace-notification]").textContent, /virtual fills/);
  assert.equal(doc.querySelector("[data-workspace-notification]").getAttribute("role"), "status");
});
