import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import request from "supertest";
import { createTestApp, loginTestOperator } from "../helpers/auth-test-helpers.js";

const marketNewsService = {
  getCurrentWeek: async () => ({
    state: "live",
    events: [],
    updatedAt: "2026-09-02T12:00:00.000Z",
    range: { from: "2026-08-30", to: "2026-09-05" },
  }),
};

test("protected clean routes render full documents and fragments", async () => {
  const agent = await loginTestOperator(createTestApp({ marketNewsService }));

  const response = await agent.get("/home").expect(200);
  assert.match(response.text, /data-statusbar/);
  assert.match(response.text, /data-sidebar/);
  assert.match(response.text, /data-main/);
  assert.match(response.text, /SYNERGY/);
  assert.match(response.text, /DISCORD SSO/);
  assert.doesNotMatch(response.text, /root@synergy-module:~\$|SESSION 01 \/ AUTHORIZED/);

  const cases = [
    ["/home", "home"],
    ["/brain", "brain"],
    ["/research", "research"],
    ["/accounts", "accounts"],
    ["/settings", "settings"],
    ["/market-news", "market-news"],
    ["/journal", "journal"],
    ["/journal/new", "journal-new"],
  ];

  for (const [path, identity] of cases) {
    await agent.get(path).expect(200).expect(/data-app-shell/).expect("X-Synergy-Module-Key", identity);
    await agent.get(path).set("X-Synergy-Module-Fragment", "1").expect(200)
      .expect(/data-route-view/).expect((response) => {
        assert.doesNotMatch(response.text, /data-app-shell/);
        assert.equal(response.headers["x-synergy-module-path"], path);
      });
  }
});

test("home quick-access links opt into fragment navigation", async () => {
  const agent = await loginTestOperator(createTestApp());

  const response = await agent.get("/home").expect(200);
  const dom = new JSDOM(response.text);
  for (const path of ["/brain", "/research", "/settings", "/accounts", "/journal"]) {
    assert.ok(dom.window.document.querySelector(`[data-route-view] a[href="${path}"][data-nav-link]`), `${path} uses fragment navigation`);
  }
  dom.window.close();
});

test("server-rendered Cortex shell exposes semantic navigation, page heading, and ordered theme styles", async () => {
  const app = createTestApp();
  const agent = await loginTestOperator(app);

  const response = await agent.get("/home").expect(200);
  const dom = new JSDOM(response.text);
  const document = dom.window.document;
  const navigation = document.querySelector('[data-sidebar] nav[aria-label="Workspace navigation"]');
  const activeLink = navigation.querySelector('[data-nav-key="home"]');
  assert.equal(activeLink.getAttribute("aria-current"), "page");
  assert.match(activeLink.textContent, /Overview/);
  assert.ok(navigation.querySelector('[href="/brain"][data-nav-link]'));
  assert.equal(document.querySelector(".workspace-welcome h1").tagName, "H1");
  assert.equal(document.querySelectorAll("[data-route-view] h1").length, 1);
  const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute("href"));
  const styleIndex = (name) => stylesheets.findIndex((href) => href.endsWith(`/css/${name}.css`));
  assert.ok(styleIndex("brain") >= 0);
  assert.ok(styleIndex("redline") > styleIndex("brain"));
  assert.ok(styleIndex("redline-surfaces") > styleIndex("redline"));
  assert.equal(document.querySelectorAll('[data-color-theme]').length, 2);
  dom.window.close();
});

test("public journal fragments expose the concrete request path", async () => {
  const agent = await loginTestOperator(createTestApp());

  await agent.get("/journal/entry-42").set("X-Synergy-Module-Fragment", "1")
    .expect(200)
    .expect("X-Synergy-Module-Path", "/journal/entry-42")
    .expect("X-Synergy-Module-Key", "journal-public");
});

test("tabs opened before the rename retain fragment navigation and authentication failures", async () => {
  const app = createTestApp();
  await request(app).get("/brain").set("X-Omensite-Fragment", "1").expect(401)
    .expect({ error: "AUTH_REQUIRED", loginUrl: "/login" });
  const agent = await loginTestOperator(app);
  await agent.get("/brain").set("X-Omensite-Fragment", "1").expect(200)
    .expect("X-Omensite-Key", "brain").expect("X-Omensite-Path", "/brain")
    .expect(({ text }) => assert.doesNotMatch(text, /data-app-shell/));
  await agent.get("/brain").set("X-Synergy-Module-Fragment", "1").expect(200)
    .expect("X-Synergy-Module-Key", "brain");
});
