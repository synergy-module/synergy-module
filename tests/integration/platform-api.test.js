import assert from "node:assert/strict";
import test from "node:test";
import express, { Router } from "express";
import session from "express-session";
import request from "supertest";
import { createPlatformTokenService } from "../../src/platform-api/token-service.js";
import { createPlatformApiGateway } from "../../src/platform-api/gateway.js";
import { createPlatformApiRoutes } from "../../src/platform-api/routes.js";
import { createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createInMemoryUserRepository } from "../../src/repositories/in-memory-user-repository.js";
import { createInMemoryJournalRepository } from "../../src/repositories/in-memory-journal-repository.js";
import { createWorkspaceSettingsService } from "../../src/settings/workspace-settings-service.js";
import { createSettingsRoutes } from "../../src/routes/settings-routes.js";
import { createJournalRoutes } from "../../src/routes/journal-routes.js";
import { createPracticeFeedService } from "../../src/practice/feed-service.js";
import { createPracticeFeedRoutes } from "../../src/routes/practice-feed-routes.js";
import { requireAuth } from "../../src/middleware/require-auth.js";
import { ensureCsrfToken, requireCsrf } from "../../src/security/csrf.js";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

const secret = "platform-test-encryption-secret-32-characters";
function fixture({ encryptionSecret = secret, gatewayOptions = {} } = {}) {
  let clock = Date.now(), refreshCount = 0;
  const repository = createMemoryWorkspaceRepository(), users = createInMemoryUserRepository(), banned = new Set();
  const now = () => new Date(clock);
  const authService = {
    async assertOperatorAdmission(operator) { if (banned.has(operator.id) || operator.authMode !== "discord" || !operator.capabilities.includes("base")) throw new Error("Denied"); },
    async refreshOperator(operator) {
      assert.equal(operator.discordAuth.accessToken, "delegated-oauth-secret");
      refreshCount++;
      const refreshed = { ...operator, rolesSyncedAt: now().toISOString() };
      const { discordAuth: _, ...safe } = refreshed;
      await users.upsert(safe);
      return refreshed;
    },
  };
  const options = { repository, userRepository: users, banRepository: { isBanned: id => banned.has(id) }, authService, encryptionSecret, now };
  const tokenService = createPlatformTokenService(options);
  const shared = Router();
  shared.use(createPlatformApiRoutes({ tokenService, adminService: { getDashboard: () => ({ users: [] }) }, indicatorAccessService: { getMemberView: () => ({ catalog: [] }) } }));
  shared.use(createSettingsRoutes({ settingsService: createWorkspaceSettingsService({ repository, encryptionSecret: secret }) }));
  shared.use(createJournalRoutes({ journalRepository: createInMemoryJournalRepository() }));
  const feedService = createPracticeFeedService({ repository, encryptionSecret: secret, canOperate: async () => true, recorderFactory: () => {
    let status = "stopped";
    return { start: () => { status = "recording"; }, status: () => ({ status, dataOnly: true }), stop: () => { status = "stopped"; }, close: async () => { status = "stopped"; }, snapshot: () => ({ samples: [] }) };
  } });
  shared.use(createPracticeFeedRoutes({ service: feedService }));
  let liveCalls = 0;
  shared.post("/api/robinhood/actions", requireCsrf, (_req, res) => { liveCalls++; res.json({ ok: true }); });
  shared.post("/api/robinhood/future-execute", requireCsrf, (_req, res) => { liveCalls++; res.json({ ok: true }); });
  shared.post("/api/practice/books", requireCsrf, (req, res) => res.json({ owner: req.session.operator.id, simulated: true }));
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createPlatformApiGateway({ router: shared, tokenService, now: () => clock, ...gatewayOptions }));
  app.use(session({ secret, saveUninitialized: false, resave: false }));
  app.post("/test/login", async (req, res) => {
    const operator = { id: req.body.id, username: req.body.id, authMode: "discord", roles: ["OS"], capabilities: req.body.capabilities ?? ["base", "journal"],
      rolesSyncedAt: now().toISOString(), discordAuth: { accessToken: "delegated-oauth-secret", refreshToken: "refresh-secret" } };
    const { discordAuth: _, ...safe } = operator;
    await users.upsert(safe);
    req.session.operator = operator;
    res.json({ csrf: ensureCsrfToken(req) });
  });
  app.use(requireAuth, shared);
  return { app, tokenService, feedService, repository, users, banned, options, advance: ms => { clock += ms; }, refreshCount: () => refreshCount, liveCalls: () => liveCalls };
}
async function login(f, id, capabilities) {
  const browser = request.agent(f.app);
  const { body } = await browser.post("/test/login").send({ id, capabilities }).expect(200);
  return { browser, csrf: body.csrf };
}
async function issue(session, scopes, name = "Test agent") {
  return (await session.browser.post("/api/platform/tokens").set("X-CSRF-Token", session.csrf).send({ name, scopes }).expect(201)).body;
}
const bearer = token => ({ Authorization: `Bearer ${token}` });

test("external bearer shares real settings/journal handlers and cannot switch owner using cookies or input", async () => {
  const f = fixture(), alice = await login(f, "alice"), bob = await login(f, "bob");
  const { token } = await issue(alice, ["workspace:read", "workspace:write"]);
  await request(f.app).patch("/api/v1/settings/preferences").set(bearer(token)).send({ theme: "light", density: "compact" }).expect(200);
  assert.equal((await alice.browser.get("/api/settings")).body.preferences.theme, "light");
  assert.equal((await bob.browser.get("/api/settings")).body.preferences.theme, "system");
  const created = await request(f.app).post("/api/v1/journal").set(bearer(token)).send({ direction: "long", notes: "private", ownerId: "bob" }).expect(201);
  await bob.browser.get(`/api/journal/${created.body.entry.id}`).expect(404);
  const asAlice = await bob.browser.get("/api/v1/platform/me").set(bearer(token)).expect(200);
  assert.equal(asAlice.body.id, "alice");
  assert.equal(asAlice.headers["set-cookie"], undefined);
  assert.equal((await bob.browser.get("/api/platform/me")).body.id, "bob");
  await request(f.app).get("/api/platform/me").expect(401);
});

test("browser token management requires CSRF, keeps secret one-time, and isolates revocation by owner", async () => {
  const f = fixture(), alice = await login(f, "alice"), bob = await login(f, "bob");
  await alice.browser.post("/api/platform/tokens").send({ name: "unsafe", scopes: ["workspace:read"] }).expect(403);
  const issued = await issue(alice, ["workspace:read"]);
  const listed = (await alice.browser.get("/api/platform/tokens").expect(200)).body;
  assert.equal(listed.tokens.length, 1);
  assert.equal(JSON.stringify(listed).includes(issued.token), false);
  assert.equal(JSON.stringify(listed).includes("hash"), false);
  assert.equal(JSON.stringify(await f.repository.read("alice")).includes(issued.token), false);
  assert.equal(JSON.stringify(await f.repository.read("alice")).includes("delegated-oauth-secret"), false);
  await bob.browser.delete(`/api/platform/tokens/${issued.record.id}`).set("X-CSRF-Token", bob.csrf).expect(404);
  await alice.browser.delete(`/api/platform/tokens/${issued.record.id}`).expect(403);
  await request(f.app).post("/api/v1/platform/tokens").set(bearer(issued.token)).send({ name: "escalated", scopes: ["live:trade"] }).expect(403);
  await alice.browser.patch("/api/settings/preferences").set(bearer(issued.token)).send({ theme: "dark" }).expect(403);
  await alice.browser.delete(`/api/platform/tokens/${issued.record.id}`).set("X-CSRF-Token", alice.csrf).expect(200);
  await request(f.app).get("/api/v1/platform/me").set(bearer(issued.token)).expect(401);
});

test("expired and modified bearer tokens fail closed", async () => {
  const f = fixture(), alice = await login(f, "alice"), { token } = await issue(alice, ["workspace:read"]);
  await request(f.app).get("/api/v1/settings").set(bearer(`${token.slice(0, -3)}xyz`)).expect(401);
  await request(f.app).get("/api/v1/settings").set(bearer(token.replace("YWxpY2U", "Ym9i"))).expect(401);
  f.advance(31 * 86_400_000);
  await request(f.app).get("/api/v1/settings").set(bearer(token)).expect(401);
});

test("testing and workspace tokens cannot trade; live scope and account capabilities are independent", async () => {
  const f = fixture(), alice = await login(f, "alice"), { token } = await issue(alice, ["workspace:read", "workspace:write", "testing:write"]);
  await request(f.app).post("/api/v1/practice/books").set(bearer(token)).send({}).expect(200);
  await request(f.app).post("/api/v1/robinhood/actions").set(bearer(token)).send({}).expect(403);
  assert.equal(f.liveCalls(), 0);
  const live = await issue(alice, ["live:trade"]);
  await request(f.app).post("/api/v1/robinhood/actions").set(bearer(live.token)).send({}).expect(200);
  assert.equal(f.liveCalls(), 1);
  await request(f.app).post("/api/v1/robinhood/future-execute").set(bearer(live.token)).send({}).expect(403);
  assert.equal(f.liveCalls(), 1);
  const current = await f.users.findById("alice");
  await f.users.upsert({ ...current, capabilities: ["base"] });
  await request(f.app).get("/api/v1/journal").set(bearer(token)).expect(403);
  await f.users.upsert({ ...current, capabilities: [] });
  await request(f.app).get("/api/v1/settings").set(bearer(token)).expect(401);
});

test("admin scope requires present admin role, and bans/admission changes invalidate existing tokens", async () => {
  const f = fixture(), alice = await login(f, "alice");
  await alice.browser.post("/api/platform/tokens").set("X-CSRF-Token", alice.csrf).send({ name: "Admin", scopes: ["admin:read"] }).expect(403);
  const admin = await login(f, "admin", ["base", "admin"]), { token } = await issue(admin, ["admin:read", "workspace:read"]);
  await request(f.app).get("/api/v1/admin").set(bearer(token)).expect(200);
  const current = await f.users.findById("admin");
  await f.users.upsert({ ...current, capabilities: ["base"] });
  await request(f.app).get("/api/v1/admin").set(bearer(token)).expect(403);
  f.banned.add("admin");
  await request(f.app).get("/api/v1/platform/me").set(bearer(token)).expect(401);
  f.banned.delete("admin");
  await f.users.upsert({ ...current, authMode: "other" });
  await request(f.app).get("/api/v1/platform/me").set(bearer(token)).expect(401);
});

test("read scopes cannot mutate and an API token can revoke itself without browser session", async () => {
  const f = fixture(), alice = await login(f, "alice"), readOnly = await issue(alice, ["workspace:read"]);
  await request(f.app).patch("/api/v1/settings/preferences").set(bearer(readOnly.token)).send({ theme: "light" }).expect(403);
  const writable = await issue(alice, ["workspace:read", "workspace:write"]);
  await request(f.app).post("/api/v1/platform/disconnect").set(bearer(writable.token)).send({}).expect(200);
  await request(f.app).get("/api/v1/platform/me").set(bearer(writable.token)).expect(401);
});

test("delegated permission refresh is encrypted, serialized and fails closed without a delegation", async () => {
  const f = fixture(), alice = await login(f, "alice"), { token } = await issue(alice, ["workspace:read"]);
  f.advance(301_000);
  await Promise.all([1, 2].map(() => request(f.app).get("/api/v1/platform/me").set(bearer(token)).expect(200)));
  assert.equal(f.refreshCount(), 1);
  const noEncryption = fixture({ encryptionSecret: "short" }), other = await login(noEncryption, "other"), otherToken = await issue(other, ["workspace:read"]);
  noEncryption.advance(301_000);
  const result = await request(noEncryption.app).get("/api/v1/platform/me").set(bearer(otherToken.token)).expect(401);
  assert.equal(result.body.error, "API_REAUTHENTICATION_REQUIRED");
});

test("catalog exposes mounted operations and declares scopes/live effects; OpenAPI parses", async () => {
  const f = fixture();
  const { body } = await request(f.app).get("/api/v1/operations").expect(200);
  assert.ok(body.operations.some(row => row.path === "/api/v1/settings/profile" && row.method === "PATCH"));
  assert.equal(body.operations.find(row => row.path === "/api/v1/robinhood/actions").liveTrading, true);
  assert.equal(body.operations.find(row => row.path === "/api/v1/practice/books").simulation, true);
  assert.equal(body.operations.find(row => row.path === "/api/v1/platform/tokens").access, "browser-session");
  const spec = (await request(f.app).get("/api/v1/openapi.json").expect(200)).body;
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(spec.paths["/settings/preferences"].patch["x-required-scopes"], ["workspace:write"]);
  assert.equal(spec.paths["/platform/tokens"], undefined);
});

test("actual application gateway supports cookie-free API settings and operation discovery", async () => {
  const app = createTestApp({ integrationsEncryptionKey: secret });
  const browser = await loginTestOperator(app);
  const csrf = await readCsrfToken(browser, "/settings");
  const created = await browser.post("/api/platform/tokens").set("X-CSRF-Token", csrf).send({ name: "Integration", scopes: ["workspace:read", "workspace:write"] }).expect(201);
  await request(app).patch("/api/v1/settings/profile").set(bearer(created.body.token)).send({ displayName: "Agent setup" }).expect(200);
  const settings = await request(app).get("/api/v1/settings").set(bearer(created.body.token)).expect(200);
  assert.equal(settings.body.profile.displayName, "Agent setup");
  const operations = await request(app).get("/api/v1/operations").expect(200);
  assert.ok(operations.body.operations.length > 60);
  assert.deepEqual(operations.body.operations.filter(item => item.access === "unavailable"), []);
  assert.ok(operations.body.operations.some(item => item.path === "/api/v1/practice/feeds/polybolt"));
  assert.equal(operations.body.operations.some(item => /\/(observe|backtests|datasets)(\/|$)/.test(item.path)), false);
});

test("real equity paper routes preserve owner and environment separation and require independent live scope", async t => {
  const app = createTestApp({ integrationsEncryptionKey: secret, logger: { error() {} } });
  t.after(async () => { await app.locals.brainService.close(); await app.locals.robinhoodBrainService.close(); await app.locals.equityPaperService.close(); });
  const alice = await loginTestOperator(app, { username: "equity-alice" }), bob = await loginTestOperator(app, { username: "equity-bob" });
  const csrf = await readCsrfToken(alice, "/settings");
  const createToken = async scopes => (await alice.post("/api/platform/tokens").set("X-CSRF-Token", csrf).send({ name: "Equity tests", scopes }).expect(201)).body.token;
  const paper = await createToken(["workspace:read", "testing:write"]), reader = await createToken(["workspace:read"]), live = await createToken(["live:trade"]);
  await request(app).post("/api/v1/practice/equities/notes").set(bearer(reader)).send({ text: "Denied" }).expect(403);
  await request(app).post("/api/v1/practice/equities/notes").set(bearer(paper)).send({ text: "Private paper note", owner: "discord:equity-bob" }).expect(422);
  await request(app).post("/api/v1/practice/equities/notes").set(bearer(paper)).send({ text: "Private paper note" }).expect(200);
  const state = (await request(app).get("/api/v1/practice/equities/state").set(bearer(paper)).expect(200)).body;
  assert.equal(state.environment, "PAPER"); assert.equal(state.notes.length, 1);
  assert.equal((await bob.get("/api/practice/equities/state").expect(200)).body.notes.length, 0);
  assert.equal((await alice.get("/api/robinhood-brain/state").expect(200)).body.notes.length, 0);
  for (const mode of ["review", "autonomous"]) await request(app).post("/api/v1/practice/equities/start").set(bearer(paper)).send({ mode, version: 1, authorizeAutonomous: true }).expect(423);
  await request(app).post("/api/v1/robinhood-brain/pause").set(bearer(paper)).send({}).expect(403);
  await request(app).post("/api/v1/robinhood-brain/pause").set(bearer(live)).send({}).expect(200);
  const catalog = (await request(app).get("/api/v1/operations")).body.operations;
  assert.deepEqual(catalog.find(operation => operation.path === "/api/v1/practice/equities/start").scopes, ["testing:write"]);
  assert.deepEqual(catalog.find(operation => operation.path === "/api/v1/robinhood-brain/start").scopes, ["live:trade"]);
});

test("API research scope cannot grant broker proposal permission through user input", async () => {
  const calls = [];
  const app = createTestApp({ integrationsEncryptionKey: secret, brainService: { start: async (...args) => { calls.push(args); return { id: "run" }; } } });
  const alice = await loginTestOperator(app), csrf = await readCsrfToken(alice, "/settings");
  const createToken = async scopes => (await alice.post("/api/platform/tokens").set("X-CSRF-Token", csrf).send({ name: "Research", scopes }).expect(201)).body.token;
  const research = await createToken(["research:write"]), live = await createToken(["research:write", "live:trade"]);
  await request(app).post("/api/v1/brain/runs").set(bearer(research)).send({ allowBrokerProposals: true, scopes: ["live:trade"] }).expect(202);
  assert.deepEqual(calls[0][2], { allowBrokerProposals: false });
  await request(app).post("/api/v1/brain/runs").set(bearer(live)).send({}).expect(202);
  assert.deepEqual(calls[1][2], { allowBrokerProposals: true });
  await alice.post("/api/brain/runs").set("X-CSRF-Token", csrf).send({}).expect(202);
  assert.deepEqual(calls[2][2], { allowBrokerProposals: true });
  assert.equal(calls.length, 3, "each shared handler is executed once");
});

test("per-token and invalid-credential throttles reject before expensive authentication and recover after the window", async () => {
  const f = fixture({ gatewayOptions: { rateLimit: 2 } }), alice = await login(f, "alice"), { token } = await issue(alice, ["workspace:read"]);
  const original = f.tokenService.authenticate;
  let calls = 0;
  f.tokenService.authenticate = value => { calls++; return original(value); };
  await request(f.app).get("/api/v1/platform/me").set(bearer(token)).expect(200);
  await request(f.app).get("/api/v1/platform/me").set(bearer(token)).expect(200);
  const limited = await request(f.app).get("/api/v1/platform/me").set(bearer(token)).expect(429);
  assert.equal(calls, 2);
  assert.equal(limited.headers["retry-after"], "60");
  f.advance(61_000);
  await request(f.app).get("/api/v1/platform/me").set(bearer(token)).expect(200);
  const invalid = fixture();
  for (let index = 0; index < 30; index++) await request(invalid.app).get("/api/v1/settings").expect(401);
  await request(invalid.app).get("/api/v1/settings").expect(429);
});

test("feed credentials require connection scope, paper recorders require testing scope, and browser writes retain CSRF", async () => {
  const f = fixture(), alice = await login(f, "alice"), paper = await issue(alice, ["workspace:read", "testing:write"]), connection = await issue(alice, ["connections:write"]);
  const credentials = { apiKey: "international-key", secret: "feed-secret", passphrase: "feed-passphrase" };
  await alice.browser.put("/api/practice/feeds/polybolt").send(credentials).expect(403);
  await request(f.app).put("/api/v1/practice/feeds/polybolt").set(bearer(paper.token)).send(credentials).expect(403);
  const saved = await request(f.app).put("/api/v1/practice/feeds/polybolt").set(bearer(connection.token)).send(credentials).expect(200);
  assert.equal(saved.body.polybolt.configured, true);
  assert.equal(JSON.stringify(saved.body).includes(credentials.secret), false);
  await request(f.app).post("/api/v1/practice/feeds/polybolt/start").set(bearer(connection.token)).send({}).expect(403);
  await request(f.app).post("/api/v1/practice/feeds/polybolt/start").set(bearer(paper.token)).send({}).expect(200);
  await request(f.app).get("/api/v1/practice/feeds/polybolt/snapshot?limit=NaN").set(bearer(paper.token)).expect(422);
  await request(f.app).delete("/api/v1/practice/feeds/polybolt").set(bearer(connection.token)).expect(200);
  await f.feedService.close();
});
