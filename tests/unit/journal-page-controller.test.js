import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { initializeJournalPage } from "../../public/js/journal/journal-page-controller.js";

function newEntryDocument() {
  return new JSDOM(`
    <section data-route-key="journal-new">
      <output data-toast hidden></output>
      <form data-journal-form>
        <button type="button" data-journal-direction="long" class="dir-opt on-long">LONG</button>
        <button type="button" data-journal-direction="short" class="dir-opt">SHORT</button>
        <input name="entryTime">
        <input name="entryPrice">
        <input name="exitPrice">
        <div data-journal-confluences><div data-journal-selected-confluences></div><div data-journal-available-confluences></div></div>
        <input type="file" data-journal-screenshots>
        <output data-journal-screenshot-count></output>
        <textarea name="notes"></textarea>
        <button type="button" data-journal-save-draft>SAVE DRAFT</button>
        <button type="submit">SUBMIT ENTRY</button>
      </form>
    </section>
  `);
}

test("new journal page saves selected form values and navigates through the shared navigator", () => {
  const dom = newEntryDocument();
  const root = dom.window.document.querySelector("[data-route-key]");
  let received;
  const destinations = [];
  initializeJournalPage(root, {
    create(input) {
      received = input;
      return { ...input, id: "entry-7" };
    },
    navigate(path) { destinations.push(path); },
  });

  root.querySelector('[name="entryTime"]').value = "09/01 08:30";
  root.querySelector('[name="entryPrice"]').value = "100";
  root.querySelector('[name="exitPrice"]').value = "102";
  root.querySelector('[name="notes"]').value = "breakout held";
  root.querySelector('[data-journal-confluence-option="FVG"]').click();
  root.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  assert.deepEqual(received, {
    direction: "long", entryTime: "09/01 08:30", entryPrice: "100", exitPrice: "102",
    notes: "breakout held", confluences: ["FVG"], screenshotCount: 0,
  });
  assert.deepEqual(destinations, ["/journal/entry-7"]);
});

test("new journal page saves the chosen direction to persistent draft storage", async (t) => {
  const dom = newEntryDocument();
  const root = dom.window.document.querySelector("[data-route-key]");
  const saved = [];
  const instance = initializeJournalPage(root, { create() {}, navigate() {}, async saveDraft(fields) { saved.push(structuredClone(fields)); } });
  t.after(() => { instance?.dispose(); dom.window.close(); });

  root.querySelector('[data-journal-direction="short"]').click();
  root.querySelector("[data-journal-save-draft]").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(root.querySelector('[data-journal-direction="short"]').classList.contains("on-short"));
  assert.equal(root.querySelector('[data-journal-direction="short"]').getAttribute("aria-pressed"), "true");
  assert.equal(root.querySelector('[data-journal-direction="long"]').getAttribute("aria-pressed"), "false");
  assert.equal(saved.at(-1).direction, "short");
  assert.match(root.querySelector(".workspace-save-state").textContent, /Draft saved to your account/);
});

test("selected confluences can be removed and returned to the available controls", () => {
  const dom = newEntryDocument();
  const root = dom.window.document.querySelector("[data-route-key]");
  initializeJournalPage(root, { create() {}, navigate() {} });

  root.querySelector('[data-journal-confluence-option="FVG"]').click();
  root.querySelector('[data-journal-confluence-selected="FVG"]').click();

  assert.equal(root.querySelector('[data-journal-confluence-selected="FVG"]'), null);
  assert.ok(root.querySelector('[data-journal-confluence-option="FVG"]'));
  assert.match(root.querySelector("[data-journal-selected-confluences]").textContent, /none selected/);
});

test("journal toasts auto-dismiss after 2.4 seconds", () => {
  const dom = newEntryDocument();
  const root = dom.window.document.querySelector("[data-route-key]");
  let delay;
  let dismiss;
  dom.window.setTimeout = (callback, milliseconds) => { delay = milliseconds; dismiss = callback; return 1; };
  initializeJournalPage(root, { create(input) { return { ...input, id: "entry-toast" }; }, navigate() {} });
  root.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(delay, 2400);
  assert.equal(root.querySelector("[data-toast]").hidden, false);
  dismiss();
  assert.equal(root.querySelector("[data-toast]").hidden, true);
});

test("new journal page retains the in-session draft across fragment hydration and resets it after submit", () => {
  const service = {
    pageState: { newEntry: null, screenshotCount: 0 },
    create(input) { return { ...input, id: "entry-8" }; },
    navigate() {},
  };
  const first = newEntryDocument();
  const firstRoot = first.window.document.querySelector("[data-route-key]");
  initializeJournalPage(firstRoot, service);

  firstRoot.querySelector('[data-journal-direction="short"]').click();
  for (const [name, value] of [["entryTime", "09/01 08:30"], ["entryPrice", "100"], ["exitPrice", "98"], ["notes", "retest held"]]) {
    const field = firstRoot.querySelector(`[name="${name}"]`);
    field.value = value;
    field.dispatchEvent(new first.window.Event("input", { bubbles: true }));
  }
  firstRoot.querySelector('[data-journal-confluence-option="FVG"]').click();
  const screenshots = firstRoot.querySelector("[data-journal-screenshots]");
  Object.defineProperty(screenshots, "files", { value: { length: 2 } });
  screenshots.dispatchEvent(new first.window.Event("change", { bubbles: true }));

  const revisit = newEntryDocument();
  const revisitRoot = revisit.window.document.querySelector("[data-route-key]");
  initializeJournalPage(revisitRoot, service);

  assert.ok(revisitRoot.querySelector('[data-journal-direction="short"]').classList.contains("on-short"));
  assert.equal(revisitRoot.querySelector('[name="entryTime"]').value, "09/01 08:30");
  assert.equal(revisitRoot.querySelector('[name="notes"]').value, "retest held");
  assert.ok(revisitRoot.querySelector('[data-journal-confluence-selected="FVG"]'));
  assert.match(revisitRoot.querySelector("[data-journal-screenshot-count]").textContent, /2 ATTACHED/);

  revisitRoot.querySelector("form").dispatchEvent(new revisit.window.Event("submit", { bubbles: true, cancelable: true }));
  assert.deepEqual(service.pageState.newEntry, { direction: "long", entryTime: "", entryPrice: "", exitPrice: "", notes: "", confluences: [] });
  assert.equal(service.pageState.screenshotCount, 0);
});

test("journal rows and semantic journal buttons retain their terminal visual treatment", async () => {
  const dom = new JSDOM('<section data-route-key="journal"><div class="list" data-journal-list></div><div data-journal-empty></div></section>');
  const root = dom.window.document.querySelector("[data-route-key]");
  initializeJournalPage(root, {
    list: () => [{ id: "entry-9", direction: "long", entryTime: "09/01", confluences: ["FVG"], pl: "+1.00" }],
  });
  const stylesheet = await readFile(new URL("../../public/css/synergy-module.css", import.meta.url), "utf8");
  const style = dom.window.document.createElement("style");
  style.textContent = stylesheet;
  dom.window.document.head.append(style);

  const row = root.querySelector(".row");
  assert.equal(row.tagName, "A");
  assert.ok(row.querySelector(".journal-entry-time"));
  assert.ok(row.querySelector(".journal-entry-confluences"));
  assert.equal(dom.window.getComputedStyle(row).textDecoration, "none");
  const direction = dom.window.document.createElement("button");
  direction.className = "dir-opt";
  dom.window.document.body.append(direction);
  assert.equal(dom.window.getComputedStyle(direction).appearance, "none");
});

test("malformed storage results do not break journal list or public hydration", () => {
  const listDom = new JSDOM('<section data-route-key="journal"><div data-journal-list></div><div data-journal-empty></div></section>');
  const listRoot = listDom.window.document.querySelector("[data-route-key]");
  assert.doesNotThrow(() => initializeJournalPage(listRoot, { list: () => [] }));
  assert.equal(listRoot.querySelectorAll("[data-journal-list] .row").length, 0);

  const publicDom = new JSDOM(`
    <section data-route-key="journal-public" data-entry-id="missing">
      <div data-journal-not-found hidden></div>
      <div data-journal-public-view><pre data-webhook-embed></pre><span data-public-link></span><div data-journal-record></div></div>
    </section>
  `);
  const publicRoot = publicDom.window.document.querySelector("[data-route-key]");
  assert.doesNotThrow(() => initializeJournalPage(publicRoot, { find: () => undefined }));
  assert.equal(publicRoot.querySelector("[data-journal-not-found]").hidden, false);
  assert.equal(publicRoot.querySelector("[data-journal-public-view]").hidden, true);
});

test("public record renders safe legacy defaults and copies its link", async () => {
  const dom = new JSDOM(`
    <section data-route-key="journal-public" data-entry-id="legacy-1">
      <output data-toast hidden></output>
      <div data-journal-not-found hidden></div>
      <div data-journal-public-view>
        <pre data-webhook-embed></pre><span data-public-link></span>
        <button data-journal-copy-link>COPY</button><div data-journal-record></div>
      </div>
    </section>
  `, { url: "http://localhost/journal/legacy-1" });
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (value) => copied.push(value) } });
  const root = dom.window.document.querySelector("[data-route-key]");
  initializeJournalPage(root, {
    find: () => ({
      id: "legacy-1", direction: "long", entryTime: "--", entryPrice: "0", exitPrice: "0",
      pl: "+0.00", notes: "", confluences: [], screenshotCount: 0,
    }),
  });

  root.querySelector("[data-journal-copy-link]").click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(root.querySelector("[data-journal-record]").textContent, /LONG\+0\.00ENTRY 0 → EXIT 0 :: --/);
  assert.match(root.querySelector("[data-webhook-embed]").textContent, /CONFLUENCES: none/);
  assert.deepEqual(copied, ["http://localhost/journal/legacy-1"]);
  assert.match(root.querySelector("[data-toast]").textContent, /LINK COPIED/);
});
