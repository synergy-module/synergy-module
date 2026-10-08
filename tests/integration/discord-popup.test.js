import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createTestApp } from "../helpers/auth-test-helpers.js";

const attempt = "popup-attempt-1234567890";
const operator = {
  id: "42", username: "omen", displayName: "Omen", authMode: "discord",
  roles: ["OS"], capabilities: ["base"], rolesSyncedAt: new Date().toISOString(),
  discordAuth: { accessToken: "private-access", refreshToken: "private-refresh" },
};
function fixture(overrides = {}) {
  return createTestApp({
    authMode: "discord",
    authService: {
      beginDiscord: () => ({ state: "server-state", authorizationUrl: "/provider" }),
      completeDiscord: async () => operator,
      refreshOperator: async (identity) => identity,
      ...overrides,
    },
    logger: { warn() {}, error() {} },
  });
}

test("popup completion is bound to the browser session and attempt, without disclosing tokens", async () => {
  const app = fixture();
  const agent = request.agent(app);
  await agent.get(`/auth/discord/status?attempt=${attempt}`).expect(200).expect({ status: "pending" });
  const begin = await agent.get(`/auth/discord?popup=${attempt}`).expect(302);
  await agent.get(`/auth/discord/status?attempt=${attempt}`).expect({ status: "pending" });
  const complete = await agent.get("/auth/discord/callback?code=private-code&state=server-state")
    .expect(302).expect("Location", "/auth/discord/popup-complete");
  assert.notEqual(begin.headers["set-cookie"][0], complete.headers["set-cookie"][0]);
  await agent.get("/auth/discord/popup-complete").expect(200).expect(/data-discord-popup-result/)
    .expect((response) => assert.doesNotMatch(response.text, /private-access|private-refresh|private-code|data-auth-complete/));
  await agent.get(`/auth/discord/status?attempt=${attempt}`)
    .expect("Cache-Control", "no-store").expect({ status: "complete" });
  await agent.get("/auth/discord/status?attempt=another-attempt").expect({ status: "pending" });
  await request(app).get(`/auth/discord/status?attempt=${attempt}`).expect({ status: "pending" });
  await agent.get("/home").expect(200);
  // A callback cannot be replayed to create another successful attempt.
  await agent.get("/auth/discord/callback?code=private-code&state=server-state")
    .expect(302).expect("Location", "/login?error=invalid_oauth_state");
});

test("popup cancellation and invalid state never authenticate and report fixed errors", async () => {
  for (const [query, error] of [
    ["error=access_denied&state=server-state", "discord_cancelled"],
    ["code=x&state=wrong", "invalid_oauth_state"],
    ["state=server-state", "discord_auth_failed"],
  ]) {
    let calls = 0;
    const agent = request.agent(fixture({ completeDiscord: async () => { calls++; return operator; } }));
    await agent.get(`/auth/discord?popup=${attempt}`);
    await agent.get(`/auth/discord/callback?${query}`).expect(302).expect("Location", "/auth/discord/popup-complete");
    await agent.get(`/auth/discord/status?attempt=${attempt}`).expect({ status: "error", error });
    await agent.get("/home").expect(302).expect("Location", "/login");
    assert.equal(calls, 0);
  }
});

test("popup reports provider errors and post-regeneration admission failures to its original window", async () => {
  for (const lateAdmission of [false, true]) {
    const failure = () => { throw Object.assign(new Error("private-details"), { code: "ACCOUNT_BANNED" }); };
    const agent = request.agent(fixture(lateAdmission
      ? { assertOperatorAdmission: failure }
      : { completeDiscord: failure }));
    await agent.get(`/auth/discord?popup=${attempt}`);
    await agent.get("/auth/discord/callback?code=x&state=server-state")
      .expect(302).expect("Location", "/auth/discord/popup-complete");
    await agent.get(`/auth/discord/status?attempt=${attempt}`).expect({ status: "error", error: "account_banned" });
    await agent.get("/home").expect(302).expect("Location", "/login");
  }
});

test("popup completion without an attempt and malformed popup requests use the normal flow", async () => {
  const agent = request.agent(fixture());
  await agent.get("/auth/discord/popup-complete").expect(302).expect("Location", "/login");
  await agent.get("/auth/discord?popup=%3Cscript%3E");
  await agent.get("/auth/discord/callback?code=x&state=server-state")
    .expect(302).expect("Location", "/auth/complete");
});

test("expired popup attempts cannot exchange an authorization code", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const agent = request.agent(fixture({ completeDiscord: async () => { calls++; return operator; } }));
  await agent.get(`/auth/discord?popup=${attempt}`);
  now += 300_001;
  await agent.get(`/auth/discord/status?attempt=${attempt}`).expect({ status: "error", error: "invalid_oauth_state" });
  await agent.get("/auth/discord/callback?code=x&state=server-state")
    .expect(302).expect("Location", "/auth/discord/popup-complete");
  assert.equal(calls, 0);
  await agent.get("/home").expect(302).expect("Location", "/login");
});

test("forwarded identities and sessions from former authentication modes cannot grant app access", async () => {
  for (const mode of ["proxy", "demo"]) {
    assert.throws(() => createApp({ authConfig: { mode } }), /AUTH_MODE must be discord/);
  }
  const app = createTestApp({
    authMode: "discord",
    configureRoutes(app) {
      app.get("/seed-old-session", (req, res) => {
        req.session.operator = { ...operator, authMode: req.query.mode, roles: ["Developer"], capabilities: ["base", "admin"] };
        res.sendStatus(204);
      });
    },
  });
  const agent = request.agent(app);
  await agent.get("/home").set({ "X-authentik-uid": "42", "X-authentik-username": "omen" })
    .expect(302).expect("Location", "/login");
  for (const mode of ["proxy", "demo", "local"]) {
    await agent.get(`/seed-old-session?mode=${mode}`);
    await agent.get("/admin").expect(302).expect("Location", "/login");
    await agent.get("/api/brain/state").expect(401).expect({ error: "AUTH_REQUIRED", loginUrl: "/login" });
    await agent.get("/login").expect(200).expect(/SIGN IN WITH DISCORD/);
  }
});
