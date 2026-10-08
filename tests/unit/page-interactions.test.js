import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initializePageInteractions } from "../../public/js/page-interactions.js";

function page(html) {
  const dom = new JSDOM(`<section data-route-view>${html}</section>`);
  return { dom, root: dom.window.document.querySelector("section") };
}

test("alert controls emit the accepted standby copy", () => {
  const { root } = page(`<button data-alert-standby>+ NEW RULE</button>`);
  const messages = [];
  initializePageInteractions(root, { showToast: (message) => messages.push(message) });
  root.querySelector("button").click();
  assert.deepEqual(messages, ["ALERT ENGINE :: STANDBY :: MODULE PENDING"]);
});

test("copy controls attempt clipboard write and confirm with the accepted copy", async () => {
  const { dom, root } = page(`<span id="value">omen://code</span><button data-copy-target="#value" data-copy-message="LINK COPIED">COPY</button>`);
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  const messages = [];
  initializePageInteractions(root, { showToast: (message) => messages.push(message) });
  root.querySelector("button").click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.deepEqual(copied, ["omen://code"]);
  assert.deepEqual(messages, ["LINK COPIED"]);
});
