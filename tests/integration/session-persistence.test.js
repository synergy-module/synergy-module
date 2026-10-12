import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { createSqliteRuntime } from "../../src/runtime/sqlite-runtime.js";
import { createSqliteWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { beginTestDiscordLogin, createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";

test("a saved journal and Discord login survive an application and database restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-module-login-persistence-"));
  const filename = path.join(directory, "workspace.sqlite");
  const runtimes = [];
  const apps = [];
  const workspaces = new Set();
  function start() {
    const runtime = createSqliteRuntime({ filename });
    const workspaceRepository = createSqliteWorkspaceRepository(filename);
    workspaces.add(workspaceRepository);
    const app = createTestApp({ ...runtime, workspaceRepository });
    runtimes.push(runtime);
    apps.push(app);
    return { runtime, app, workspaceRepository };
  }
  t.after(async () => {
    for (const app of apps) { await app.locals.brainService?.close?.(); await app.locals.robinhoodService?.close?.(); }
    for (const runtime of runtimes) await runtime.close();
    for (const workspace of workspaces) await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = start();
  const { agent, callbackPath } = await beginTestDiscordLogin(first.app, { username: "persistent-trader" });
  const login = await agent.get(callbackPath).expect(302);
  const rawCookie = login.headers["set-cookie"].find((value) => value.startsWith("connect.sid="));
  assert.match(rawCookie, /Expires=/, "login cookie should survive closing the browser");
  const cookie = rawCookie.split(";")[0];
  await agent.get("/journal").expect(302).expect("Location", "/setup");
  const setupCsrf = await readCsrfToken(agent, "/setup");
  await agent.patch("/api/settings/profile").set("X-CSRF-Token", setupCsrf).send({ displayName: "Persistent Trader" }).expect(200);
  await agent.post("/api/settings/onboarding/complete").set("X-CSRF-Token", setupCsrf).send({ acknowledgedPracticeIsolation: true }).expect(200);
  const csrf = await readCsrfToken(agent, "/journal");
  const saved = await agent.post("/api/journal").set("X-CSRF-Token", csrf).send({
    direction: "long", entryTime: "", entryPrice: "100", exitPrice: "102", notes: "Retain this thesis",
    confluences: [], screenshotCount: 0,
  }).expect(201);
  await first.runtime.close();
  await first.workspaceRepository.close(); workspaces.delete(first.workspaceRepository);

  const second = start();
  await request(second.app).get("/journal").set("Cookie", cookie).expect(200);
  assert.equal((await second.workspaceRepository.read("discord:persistent-trader")).profile.displayName, "Persistent Trader");
  const restored = await request(second.app).get("/api/journal").set("Cookie", cookie).expect(200);
  assert.equal(restored.body.entries[0].id, saved.body.entry.id);
  assert.equal(restored.body.entries[0].notes, "Retain this thesis");
  const differentUser = await loginTestOperator(second.app, { username: "another-trader" });
  assert.deepEqual((await differentUser.get("/api/journal").expect(200)).body.entries, []);
  await second.runtime.sessionRegistry.clearUser("discord:persistent-trader");
  await request(second.app).get("/api/journal").set("Cookie", cookie).expect(401);
});
