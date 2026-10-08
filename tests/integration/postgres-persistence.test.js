import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { migrate } from "../../scripts/migrate.js";
import { createPostgresRuntime } from "../../src/runtime/postgres-runtime.js";
import { createTestApp, beginTestDiscordLogin, readCsrfToken } from "../helpers/auth-test-helpers.js";

// Opt in with a disposable PostgreSQL database, never the application's DATABASE_URL.
test("PostgreSQL retains application records, admission policy, and session revocations across runtimes", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const config = { configured: true, connectionString: process.env.TEST_DATABASE_URL, ssl: false };
  await migrate({ DATABASE_URL: config.connectionString, APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true" });
  // Re-running the supported migration command must preserve existing tables.
  await migrate({ DATABASE_URL: config.connectionString, APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true" });
  const username = `persistence-${randomUUID()}`;
  const ownerId = `discord:${username}`;
  const memberId = `${ownerId}-member`;
  const staleSid = `stale-${randomUUID()}`;
  const expiredSid = `expired-${randomUUID()}`;
  const provider = {
    getStatus: () => ({ defaultProvider: "gemini", paidCallsEnabled: false, providers: [{ id: "gemini", model: "gemini-test", configured: false }] }),
    generate: () => { throw new Error("Persistence verification must not call a model"); },
  };
  let runtime = createPostgresRuntime(config);
  const apps = [];
  const makeApp = () => {
    const app = createTestApp({ ...runtime, integrationsEncryptionKey: "postgres-workspace-fixture-encryption-key", traderAIProvider: provider, logger: { error() {} } });
    apps.push(app);
    return app;
  };
  t.after(async () => {
    for (const app of apps) await app.locals.brainService.close();
    await runtime.pool.query("DELETE FROM revoked_user_sessions WHERE sid IN (SELECT sid FROM user_sessions WHERE sess->'operator'->>'id'=ANY($1::text[])) OR sid=ANY($2::text[])", [[ownerId, memberId], [staleSid, expiredSid]]);
    await runtime.pool.query("DELETE FROM user_sessions WHERE sess->'operator'->>'id'=ANY($1::text[])", [[ownerId, memberId]]);
    for (const table of ["app_users", "app_bans", "indicator_requests"]) {
      await runtime.pool.query(`DELETE FROM ${table} WHERE user_id=ANY($1::text[])`, [[ownerId, memberId]]);
    }
    for (const table of ["journal_entries", "agent_brain_runs", "agent_brain_documents", "agent_brain_cache", "broker_workspaces", "user_workspaces"]) {
      await runtime.pool.query(`DELETE FROM ${table} WHERE owner_id=ANY($1::text[])`, [[ownerId, memberId]]);
    }
    await runtime.close();
  });

  assert.equal(await runtime.readinessCheck(), true);
  let app = makeApp();
  const { agent, callbackPath } = await beginTestDiscordLogin(app, { username });
  const login = await agent.get(callbackPath).expect(302);
  const cookie = login.headers["set-cookie"].map((value) => value.split(";")[0]).join("; ");
  await agent.get("/admin").expect(200).expect(/POSTGRESQL CONNECTED/);
  const firstIdentity = await runtime.userRepository.findById(ownerId);
  assert.equal(firstIdentity.username, username);
  assert.equal(Object.hasOwn(firstIdentity, "discordAuth"), false);
  assert.equal(await runtime.sessionRegistry.activeCount(ownerId), 1);

  const csrf = await readCsrfToken(agent, "/brain");
  const fixtureKey = "postgres-persistence-fixture-provider-key";
  await agent.put("/api/settings/providers/gemini").set("X-CSRF-Token", csrf).send({ apiKey: fixtureKey }).expect(200);
  await agent.put("/api/settings/drafts/research").set("X-CSRF-Token", csrf).send({ fields: { context: "Retain this unfinished research across restart" } }).expect(200);
  assert.equal(JSON.stringify(await runtime.workspaceRepository.read(ownerId)).includes(fixtureKey), false);
  const document = await agent.post("/api/brain/documents").set("X-CSRF-Token", csrf)
    .send({ title: "Persistence check", text: "Test fixture, not trading guidance.", kind: "knowledge" }).expect(201);
  const documentId = document.body.document.id;
  const entry = { id: randomUUID(), direction: "long", entryTime: "2026-09-21T12:00", entryPrice: "100", exitPrice: "101",
    pl: "+1", notes: "Persistence fixture", confluences: [], screenshotCount: 0, createdAt: new Date().toISOString() };
  await runtime.journalRepository.create(ownerId, entry);
  const run = await runtime.brainRepository.saveRun(ownerId, { id: randomUUID(), status: "completed", mode: "demo" });
  await runtime.brainRepository.putCache(ownerId, "fixture", { value: { text: "Cached fixture" }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  // Competing processes must serialize changes to a broker workspace without losing decisions.
  await runtime.brokerRepository.update(ownerId, (state) => { state.counter = 0; });
  await Promise.all(Array.from({ length: 8 }, () => runtime.brokerRepository.update(ownerId, (state) => { state.counter += 1; })));
  await assert.rejects(runtime.brokerRepository.update(ownerId, (state) => { state.counter = 999; throw new Error("rollback fixture"); }), /rollback fixture/);
  await runtime.brokerRepository.update(ownerId, (state) => {
    state.actions.push({ id: "fixture-approval", status: "awaiting_approval", version: 1, tool: "place_equity_order" });
    state.events.push({ event: "fixture_persistence_check" });
  });

  await runtime.userRepository.upsert({ id: memberId, username: "fixture-member", roles: ["OS"], capabilities: ["base"], discordAuth: { accessToken: "must-not-persist" } });
  await runtime.banRepository.ban({ userId: memberId, actorId: ownerId, reason: "Persistence fixture" });
  await runtime.indicatorRequestRepository.upsertPending({ userId: memberId, discordUsername: "fixture-member", tradingViewUsername: "fixture_tv", indicatorIds: ["demo-market-structure"] });
  const decisions = await Promise.allSettled(["GRANTED", "DENIED"].map((status) => runtime.indicatorRequestRepository.decide({ userId: memberId, actorId: ownerId, status })));
  assert.equal(decisions.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(decisions.find((result) => result.status === "rejected").reason.code, "INDICATOR_REQUEST_NOT_PENDING");
  const decided = decisions.find((result) => result.status === "fulfilled").value;
  const insertSession = (sid, hours) => runtime.pool.query("INSERT INTO user_sessions(sid,sess,expire) VALUES($1,$2,now()+$3*interval '1 hour') ON CONFLICT(sid) DO UPDATE SET sess=EXCLUDED.sess,expire=EXCLUDED.expire", [sid, { operator: { id: memberId } }, hours]);
  await insertSession(staleSid, 1);
  await insertSession(expiredSid, -1);
  assert.equal(await runtime.sessionRegistry.activeCount(memberId), 1);
  await runtime.sessionRegistry.markRevoked(staleSid);
  await runtime.sessionRegistry.unregister(memberId, staleSid);
  await insertSession(staleSid, 1); // A concurrent request can write an old session after revocation.

  await app.locals.brainService.close();
  await runtime.close();
  runtime = createPostgresRuntime(config);
  app = makeApp();
  const resumed = request.agent(app);
  const adminPage = await resumed.get("/admin").set("Cookie", cookie).expect(200).expect(/POSTGRESQL CONNECTED/);
  assert.doesNotMatch(adminPage.text, /TEMPORARY MEMORY MODE|must-not-persist/);
  assert.match(adminPage.text, /fixture-member/);
  assert.equal((await runtime.userRepository.findById(ownerId)).firstSeenAt, firstIdentity.firstSeenAt);
  assert.equal(await runtime.banRepository.isBanned(memberId), true);
  await assert.rejects(() => app.locals.authService.assertOperatorAdmission({ id: memberId, authMode: "discord", capabilities: ["base"] }), { code: "ACCOUNT_BANNED" });
  assert.deepEqual(await runtime.indicatorRequestRepository.findByUserId(memberId), decided);
  assert.equal(await runtime.sessionRegistry.isRevoked(staleSid), true);
  assert.equal(await runtime.sessionRegistry.activeCount(memberId), 0);
  assert.deepEqual(await runtime.sessionRegistry.listSessionIds(memberId), [staleSid]);
  assert.equal((await runtime.journalRepository.find(ownerId, entry.id)).notes, entry.notes);
  assert.equal(await runtime.journalRepository.find(memberId, entry.id), undefined);
  assert.equal((await runtime.brainRepository.getRun(ownerId, run.id)).version, 1);
  assert.equal(await runtime.brainRepository.getRun(memberId, run.id), null);
  assert.equal((await runtime.brainRepository.getCache(ownerId, "fixture")).value.text, "Cached fixture");
  const brokerState = await runtime.brokerRepository.read(ownerId);
  assert.equal(brokerState.counter, 8);
  assert.equal(brokerState.actions[0].id, "fixture-approval");
  assert.equal(brokerState.paused, true);
  assert.deepEqual((await runtime.brokerRepository.read(memberId)).actions, []);
  const brokerResponse = await resumed.get("/api/robinhood/state").set("Cookie", cookie).expect(200);
  assert.equal(brokerResponse.body.storage.kind, "postgres");
  assert.equal(brokerResponse.body.actions[0].id, "fixture-approval");
  const state = await resumed.get("/api/brain/state").set("Cookie", cookie).expect(200);
  assert.ok(state.body.documents.some((item) => item.id === documentId));
  assert.ok(state.body.runs.some((item) => item.id === run.id));
  assert.equal(state.body.paidCallsEnabled, false);
  assert.equal(state.body.providers[0].configured, true);
  const settings = await resumed.get("/api/settings").set("Cookie", cookie).expect(200);
  assert.equal(settings.body.storage.kind, "postgres");
  assert.equal(settings.body.drafts.research.fields.context, "Retain this unfinished research across restart");
  assert.equal(settings.body.providers[0].source, "account");
  assert.equal(settings.text.includes(fixtureKey), false);
  assert.equal(await app.locals.workspaceSettingsService.getProviderCredential(ownerId, "gemini"), fixtureKey);

  // Old signed-in users are backfilled when a durable identity snapshot is missing.
  await runtime.pool.query("DELETE FROM app_users WHERE user_id=$1", [ownerId]);
  await resumed.get("/admin").set("Cookie", cookie).expect(200);
  assert.equal((await runtime.userRepository.findById(ownerId)).username, username);
  await runtime.banRepository.unban({ userId: memberId });
  assert.equal(await runtime.banRepository.isBanned(memberId), false);
  await assert.rejects(() => runtime.banRepository.unban(memberId), { code: "BAN_NOT_FOUND" });
  await assert.rejects(() => runtime.indicatorRequestRepository.decide({ userId: memberId, status: "PENDING" }), { code: "INVALID_DECISION" });
  const reopened = await runtime.indicatorRequestRepository.upsertPending({ userId: memberId, discordUsername: "fixture-member", tradingViewUsername: "corrected_tv", indicatorIds: [] });
  assert.equal(reopened.status, "PENDING");
  assert.equal(reopened.decidedAt, null);
  await runtime.sessionRegistry.clearUser(memberId);
  assert.deepEqual(await runtime.sessionRegistry.listSessionIds(memberId), []);
  assert.equal(await runtime.sessionRegistry.isRevoked(staleSid), true);

  // The saved revocation must also be enforced on an actual protected HTTP request.
  const [sid] = await runtime.sessionRegistry.listSessionIds(ownerId);
  await runtime.sessionRegistry.markRevoked(sid);
  await resumed.get("/home").set("Cookie", cookie).expect(302).expect("Location", "/login?error=access_revoked");
  await runtime.pool.query("DELETE FROM revoked_user_sessions WHERE sid=$1", [sid]);
});
