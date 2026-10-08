import assert from "node:assert/strict";
import request from "supertest";
import test from "node:test";
import { createTestApp, loginTestOperator } from "../helpers/auth-test-helpers.js";

const DENIED_MESSAGE = "ACCESS FAILED :: INSUFFICIENT PERMISSIONS";

test("Admin can open every module while OS receives structured 403 responses for modular fragments", async () => {
  const admin = await loginTestOperator(createTestApp({ roles: ["Admin"] }), { username: "admin" });
  const os = await loginTestOperator(createTestApp({ roles: ["OS"] }), { username: "member" });

  for (const path of ["/journal", "/admin"]) {
    await admin.get(path).expect(200);
    await os.get(path).set("X-Synergy-Module-Fragment", "1").expect(403).expect(({ body }) => {
      assert.deepEqual(body, { error: "INSUFFICIENT_PERMISSIONS", message: DENIED_MESSAGE });
    });
  }
});

test("OS full-page denial redirects home and exposes the notice exactly once", async () => {
  const os = await loginTestOperator(createTestApp({ roles: ["OS"] }), { username: "member" });

  await os.get("/admin").expect(302).expect("Location", "/home");
  await os.get("/home").expect(200).expect(new RegExp(DENIED_MESSAGE));
  await os.get("/home").expect(200).expect((response) => {
    assert.doesNotMatch(response.text, new RegExp(DENIED_MESSAGE));
  });
});

test("all primary module links remain visible to OS users with capability diagnostics", async () => {
  const os = await loginTestOperator(createTestApp({ roles: ["OS"] }), { username: "member" });
  const response = await os.get("/home").expect(200);

  for (const [path, capability] of [
    ["/home", "base"], ["/brain", "base"], ["/research", "base"],
    ["/accounts", "base"], ["/journal", "journal"], ["/settings", "base"],
  ]) {
    assert.match(response.text, new RegExp(`href="${path}"[^>]*data-required-capability="${capability}"`));
  }
});

test("stale Discord role revocation removes the registry entry and destroys the session", async () => {
  const unregisterCalls = [];
  const authService = {
    refreshOperator: async () => {
      throw Object.assign(new Error("revoked"), { code: "ACCESS_REVOKED" });
    },
  };
  const sessionRegistry = {
    register() {},
    unregister: (...values) => unregisterCalls.push(values),
  };
  const app = createTestApp({
    authMode: "discord",
    authService,
    sessionRegistry,
    configureRoutes(expressApp) {
      expressApp.get("/__test/session", (req, res) => {
        req.session.operator = {
          id: "42", username: "omen", authMode: "discord", roles: ["OS"], capabilities: ["base"],
          rolesSyncedAt: "2026-09-02T11:50:00.000Z", discordAuth: { accessToken: "access" },
        };
        sessionRegistry.register("42", req.sessionID);
        res.sendStatus(204);
      });
    },
  });
  const agent = request.agent(app);

  await agent.get("/__test/session").expect(204);
  await agent.get("/home").expect(302).expect("Location", "/login?error=access_revoked");
  assert.equal(unregisterCalls.length, 1);
  assert.equal(unregisterCalls[0][0], "42");
  await agent.get("/home").expect(302).expect("Location", "/login");
});
