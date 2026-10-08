import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JSDOM } from "jsdom";
import { createTestApp } from "../helpers/auth-test-helpers.js";
import { initializeLoginController } from "../../public/js/login-controller.js";

for (const reducedMotion of [false, true]) {
  test(`Cortex login preserves Discord access without an idle animation loop (reduced motion: ${reducedMotion})`, async (t) => {
    const app = createTestApp();
    const response = await request(app).get("/login").expect(200);
    const dom = new JSDOM(response.text, { url: "http://localhost/login" });
    t.after(() => dom.window.close());
    let intervals = 0, requests = 0;
    dom.window.matchMedia = () => ({ matches: reducedMotion });
    dom.window.setInterval = () => { intervals += 1; return 73; };
    const document = dom.window.document;
    const art = document.querySelector(".cortex-login-art");
    assert.ok(art);
    assert.equal(art.getAttribute("alt"), "");
    assert.match(art.getAttribute("src"), /\/assets\/redline-signal\.svg$/);
    await request(app).get(art.getAttribute("src")).expect(200).expect("Content-Type", /image\/svg\+xml/);
    assert.equal(document.querySelector("[data-sphere]"), null);
    assert.equal(document.querySelector('input[type="password"], [data-login-user], [data-login-passkey]'), null);
    assert.equal(document.querySelector("[data-discord-login]").getAttribute("href"), "/auth/discord");
    assert.ok(document.querySelector('[data-discord-status][role="status"]'));
    assert.ok(document.querySelector('[data-login-error][role="alert"]'));

    const controller = initializeLoginController({
      documentRef: document,
      windowRef: dom.window,
      fetchImpl: async () => { requests += 1; return new Response("{}", { status: 400 }); },
    });
    t.after(() => controller.dispose());

    assert.equal(intervals, 0);
    assert.equal(requests, 0, "opening the login page must not initiate authentication");
    assert.ok(document.querySelector("[data-discord-entry]"));
    assert.equal(document.querySelector(".auth-granted"), null);
    document.querySelector('[data-color-theme="daylight"]').click();
    assert.equal(document.documentElement.dataset.theme, "daylight");
    controller.dispose();
    document.querySelector('[data-color-theme="core"]').click();
    assert.equal(document.documentElement.dataset.theme, "daylight", "disposal removes theme controls");
  });
}
