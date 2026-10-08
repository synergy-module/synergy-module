import assert from "node:assert/strict";
import test from "node:test";
import { readDatabaseConfig } from "../../src/config/database-config.js";

test("production database configuration is required and redacts its connection string", () => {
  assert.throws(() => readDatabaseConfig({ env: {}, nodeEnvironment: "production" }), /DATABASE_URL is required/);
  const config = readDatabaseConfig({
    env: { DATABASE_URL: "postgres://synergy:super-secret@synergy-module-postgres:5432/synergy-module" },
    nodeEnvironment: "production",
  });
  assert.equal(config.connectionString, "postgres://synergy:super-secret@synergy-module-postgres:5432/synergy-module");
  assert.equal(JSON.stringify(config), '{"configured":true,"ssl":false}');
});

test("database TLS is explicit and development may run without PostgreSQL", () => {
  const development = readDatabaseConfig({ env: {}, nodeEnvironment: "development" });
  assert.equal(development.configured, false);
  assert.equal(development.connectionString, "");
  assert.equal(development.ssl, false);
  assert.equal(readDatabaseConfig({ env: { DATABASE_URL: "postgres://db/app", DATABASE_SSL: "require" } }).ssl, true);
  assert.throws(() => readDatabaseConfig({ env: { DATABASE_URL: "postgres://db/app", DATABASE_SSL: "sometimes" } }), /DATABASE_SSL/);
});

test("database pool and time budgets reject unsafe or malformed configuration", () => {
  for (const [key, values] of Object.entries({ DATABASE_POOL_MAX: ["0", "51", "NaN", "2.5"],
    DATABASE_CONNECT_TIMEOUT_MS: ["0", "30001"], DATABASE_STATEMENT_TIMEOUT_MS: ["-1", "120001"],
    DATABASE_LOCK_TIMEOUT_MS: ["0", "30001"] })) {
    for (const value of values) assert.throws(() => readDatabaseConfig({ env: { [key]: value }, nodeEnvironment: "test" }), new RegExp(key));
  }
  const config = readDatabaseConfig({ env: { DATABASE_POOL_MAX: "4", DATABASE_LOCK_TIMEOUT_MS: "1000" }, nodeEnvironment: "test" });
  assert.equal(config.poolMax, 4);
  assert.equal(config.lockTimeoutMs, 1000);
  assert.equal(config.statementTimeoutMs, 10000);
});
