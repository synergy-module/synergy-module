import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JSDOM } from "jsdom";
import { createInMemoryIndicatorRequestRepository } from "../../src/repositories/in-memory-indicator-request-repository.js";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

test("retired Indicators and alert destinations are unavailable to every signed-in role", async () => {
  for (const roles of [["OS"], ["OS", "Indicators"], ["Admin"]]) {
    const agent = await loginTestOperator(createTestApp({ roles }));
    for (const route of ["/indicators", "/alerts/ict", "/alerts/support-resistance"]) {
      await agent.get(route).expect(404);
      await agent.get(route).set("X-Synergy-Module-Fragment", "1").expect(404);
    }
    const home = await agent.get("/home").expect(200);
    const dom = new JSDOM(home.text);
    for (const route of ["/indicators", "/alerts/ict", "/alerts/support-resistance"]) {
      assert.equal(dom.window.document.querySelector(`a[href="${route}"]`), null);
    }
    dom.window.close();
  }
});

test("the retired indicator request API cannot accept new requests or erase existing history", async () => {
  const indicatorRequestRepository = createInMemoryIndicatorRequestRepository();
  indicatorRequestRepository.upsertPending({ userId: "discord:historical", discordUsername: "historical", tradingViewUsername: "saved_operator", indicatorIds: ["demo-market-structure"] });
  const before = structuredClone(indicatorRequestRepository.list());
  const app = createTestApp({ indicatorRequestRepository });
  const agent = await loginTestOperator(app);
  const csrf = await readCsrfToken(agent, "/home");
  await agent.post("/api/indicator-access/requests").set("X-CSRF-Token", csrf).send({ tradingViewUsername: "new_operator", consent: true }).expect(404);
  assert.deepEqual(indicatorRequestRepository.list(), before);
  await request(app).post("/api/indicator-access/requests").send({ tradingViewUsername: "new_operator", consent: true }).expect(401);
});
