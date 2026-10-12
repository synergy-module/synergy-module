import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatformTokenService } from "../../src/platform-api/token-service.js";
import { createMemoryWorkspaceRepository, createSqliteWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createInMemoryUserRepository } from "../../src/repositories/in-memory-user-repository.js";
import { createPlatformSessionDelegation } from "../../src/platform-api/session-delegation.js";

function identity() { return { id: "alice", authMode: "discord", capabilities: ["base"], roles: ["OS"], rolesSyncedAt: new Date().toISOString() }; }
function options(repository, users) {
  return { repository, userRepository: users, banRepository: { isBanned: () => false }, authService: { assertOperatorAdmission: async () => {} }, encryptionSecret: "test-platform-secret-longer-than-16" };
}

test("tokens survive SQLite reopening and only their hash is persisted", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "synergy-api-test-")), filename = path.join(directory, "workspace.sqlite");
  let repository;
  try {
    const users = createInMemoryUserRepository(), operator = identity();
    await users.upsert(operator);
    repository = createSqliteWorkspaceRepository(filename);
    const service = createPlatformTokenService(options(repository, users));
    const issued = await service.issue(operator, { name: "Persistent", scopes: ["workspace:read"] });
    const data = await repository.read(operator.id);
    assert.match(data.platformApi.tokens[0].hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(data).includes(issued.token), false);
    await repository.close(); repository = createSqliteWorkspaceRepository(filename);
    const reopened = createPlatformTokenService(options(repository, users));
    assert.equal((await reopened.authenticate(issued.token)).operator.id, operator.id);
    await reopened.revoke(operator.id, issued.record.id);
    await assert.rejects(() => reopened.authenticate(issued.token), error => error.code === "API_TOKEN_INVALID");
  } finally {
    await repository?.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
    rmdirSync(directory);
  }
});

test("token input is bounded and unsupported scope or administrator grant fails", async () => {
  const repository = createMemoryWorkspaceRepository(), users = createInMemoryUserRepository(), operator = identity();
  await users.upsert(operator);
  const service = createPlatformTokenService(options(repository, users));
  for (const input of [
    { name: "", scopes: ["workspace:read"] }, { name: "Test", scopes: [] }, { name: "Test", scopes: ["*"] },
    { name: "Test", scopes: ["workspace:read"], expiresInDays: 0 }, { name: "Test", scopes: ["workspace:read"], expiresInDays: 91 },
    { name: "Test", scopes: ["workspace:read"], ownerId: "bob" },
  ]) await assert.rejects(() => service.issue(operator, input), error => error.code === "API_TOKEN_INPUT_INVALID");
  await assert.rejects(() => service.issue(operator, { name: "Escalate", scopes: ["admin:write"] }), error => error.code === "API_SCOPE_FORBIDDEN");
});

test("OAuth account authorization is owner-bound, encrypted and consumed once", async () => {
  const repository = createMemoryWorkspaceRepository(), users = createInMemoryUserRepository();
  const service = createPlatformTokenService(options(repository, users));
  await service.saveAuthorization("alice", { state: "secret-state", verifier: "private-pkce-verifier" });
  assert.equal(JSON.stringify(await repository.read("alice")).includes("private-pkce-verifier"), false);
  await assert.rejects(() => service.takeAuthorization("bob", "secret-state"), error => error.code === "API_AUTHORIZATION_EXPIRED");
  await assert.rejects(() => service.takeAuthorization("alice", "wrong-state"), error => error.code === "API_AUTHORIZATION_INVALID");
  assert.equal((await service.takeAuthorization("alice", "secret-state")).verifier, "private-pkce-verifier");
  await assert.rejects(() => service.takeAuthorization("alice", "secret-state"), error => error.code === "API_AUTHORIZATION_EXPIRED");
});

test("rotated delegated Discord credentials synchronize only to the original browser login", async () => {
  const repository = createMemoryWorkspaceRepository(), users = createInMemoryUserRepository(), operator = identity();
  operator.lastSignedInAt = new Date().toISOString();
  operator.discordAuth = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const { discordAuth: _, ...safe } = operator;
  await users.upsert(safe);
  const service = createPlatformTokenService(options(repository, users));
  await service.issue(operator, { name: "Delegated", scopes: ["workspace:read"] });
  const rotated = { accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresAt: new Date(Date.now() + 7_200_000).toISOString() };
  await service.rememberBrowserAuthorization({ ...operator, discordAuth: rotated });
  assert.deepEqual(await service.browserAuthorization(operator), rotated);
  await service.issue(operator, { name: "Another token from the older request", scopes: ["workspace:read"] });
  assert.deepEqual(await service.browserAuthorization(operator), rotated, "issuance cannot overwrite a concurrent credential rotation");
  assert.equal(await service.browserAuthorization({ ...operator, lastSignedInAt: "another-login" }), null);
  const req = { session: { operator: structuredClone(operator) } };
  let calls = 0;
  await createPlatformSessionDelegation({ tokenService: service, refreshRoles: async (request, _res, next) => {
    assert.equal(request.session.operator.id, operator.id);
    assert.equal(request.session.operator.discordAuth.refreshToken, "rotated-refresh");
    return next();
  } })(req, {}, () => { calls++; });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(await repository.read(operator.id)).includes("rotated-refresh"), false);
});
