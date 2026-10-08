import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initializeColorTheme } from "../../public/js/redline-theme.js";

function fixture(t) {
  const dom = new JSDOM('<button data-color-theme="core">Core</button><button data-color-theme="daylight">Daylight</button>', { url: "https://synergy-module.test/brain" });
  t.after(() => dom.window.close());
  return { document: dom.window.document, window: dom.window, button: (theme) => dom.window.document.querySelector(`[data-color-theme="${theme}"]`) };
}

test("theme restores the saved preference and synchronizes accessible controls and change events", (t) => {
  const app = fixture(t), observed = [];
  app.window.localStorage.setItem("omensite-theme", "daylight");
  app.document.addEventListener("synergy-module:themechange", () => observed.push(app.document.documentElement.dataset.theme));
  const dispose = initializeColorTheme({ documentRef: app.document, windowRef: app.window });
  t.after(dispose);
  assert.equal(app.document.documentElement.dataset.theme, "daylight");
  assert.equal(app.button("daylight").getAttribute("aria-pressed"), "true");
  assert.equal(app.button("core").getAttribute("aria-pressed"), "false");
  app.button("core").click();
  assert.equal(app.window.localStorage.getItem("synergy-module-theme"), "core");
  assert.equal(app.window.localStorage.getItem("omensite-theme"), null);
  assert.equal(app.button("core").getAttribute("aria-pressed"), "true");
  assert.equal(app.button("daylight").getAttribute("aria-pressed"), "false");
  assert.deepEqual(observed, ["daylight", "core"]);
  assert.equal(app.window.localStorage.length, 1, "only a theme preference is stored");
});

test("unrecognized saved preferences fall back to the core palette", (t) => {
  const app = fixture(t);
  app.window.localStorage.setItem("synergy-module-theme", '<img src=x onerror="alert(1)">');
  const dispose = initializeColorTheme({ documentRef: app.document, windowRef: app.window });
  t.after(dispose);
  assert.equal(app.document.documentElement.dataset.theme, "core");
  assert.equal(app.button("core").getAttribute("aria-pressed"), "true");
  assert.equal(app.document.querySelector("img"), null);
});

test("blocked browser storage still permits theme selection and disposal", (t) => {
  const app = fixture(t), observed = [];
  Object.defineProperty(app.window, "localStorage", { configurable: true, get() { throw new Error("Storage unavailable"); } });
  app.document.addEventListener("synergy-module:themechange", () => observed.push(app.document.documentElement.dataset.theme));
  const dispose = initializeColorTheme({ documentRef: app.document, windowRef: app.window });
  app.button("daylight").click();
  assert.equal(app.document.documentElement.dataset.theme, "daylight");
  dispose();
  dispose();
  app.button("core").click();
  assert.equal(app.document.documentElement.dataset.theme, "daylight");
  assert.deepEqual(observed, ["core", "daylight"]);
});

test("a failed preference write applies the selected theme without altering unrelated stored data", (t) => {
  const app = fixture(t), writes = [];
  Object.defineProperty(app.window, "localStorage", { configurable: true, value: {
    getItem() { return "core"; },
    setItem(key, value) { writes.push([key, value]); throw new Error("Quota exceeded"); },
  } });
  const dispose = initializeColorTheme({ documentRef: app.document, windowRef: app.window });
  t.after(dispose);
  app.button("daylight").click();
  assert.equal(app.document.documentElement.dataset.theme, "daylight");
  assert.deepEqual(writes, [["synergy-module-theme", "daylight"]]);
});

test("current theme preferences take precedence over legacy values", (t) => {
  const app = fixture(t);
  app.window.localStorage.setItem("synergy-module-theme", "core");
  app.window.localStorage.setItem("omensite-theme", "daylight");
  const dispose = initializeColorTheme({ documentRef: app.document, windowRef: app.window });
  t.after(dispose);
  assert.equal(app.document.documentElement.dataset.theme, "core");
});

test("legacy preferences remain available when migration writes are blocked", (t) => {
  const app = fixture(t), removed = [];
  Object.defineProperty(app.window, "localStorage", { configurable: true, value: {
    getItem(key) { return key === "omensite-theme" ? "daylight" : null; },
    setItem() { throw new Error("Quota exceeded"); },
    removeItem(key) { removed.push(key); },
  } });
  const dispose = initializeColorTheme({ documentRef: app.document, windowRef: app.window });
  t.after(dispose);
  assert.equal(app.document.documentElement.dataset.theme, "daylight");
  assert.deepEqual(removed, []);
});
