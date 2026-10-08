import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import session from "express-session";
import pg from "pg";
import test from "node:test";
import { createPostgresRuntime } from "../../src/runtime/postgres-runtime.js";

test("PostgreSQL runtime supplies durable sessions, readiness, and clean shutdown", async (t) => {
  let closed = false;
  let ready = true;
  const pool = Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [{ ready }] }),
    connect: async () => { throw new Error("Readiness must use the shared pool query"); },
    end: async () => { closed = true; },
  });
  t.mock.method(pg, "Pool", function () { return pool; });
  const runtime = createPostgresRuntime(
    { configured: true, connectionString: "postgres://db/app", ssl: false },
  );
  t.after(async () => { if (!closed) await runtime.close(); });

  assert.ok(runtime.sessionStore instanceof session.Store);
  assert.equal(await runtime.readinessCheck(), true);
  ready = false;
  assert.equal(await runtime.readinessCheck(), false);
  await runtime.close();
  assert.equal(closed, true);
});

test("PostgreSQL runtime rejects missing configuration", () => {
  assert.throws(() => createPostgresRuntime({ configured: false }), /configured database/);
});
