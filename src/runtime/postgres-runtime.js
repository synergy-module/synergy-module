import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import { createPostgresBrokerRepository } from "../brokers/broker-repository.js";
import { createPostgresJournalRepository } from "../repositories/postgres-journal-repository.js";
import { createPostgresBrainRepository } from "../agent-brain/brain-repository.js";
import { createPostgresWorkspaceRepository } from "../settings/workspace-repository.js";
import { createPostgresBrainToolPolicyRepository } from "../agent-brain/brain-tool-policy-repository.js";
import { createPostgresUserRepository, createPostgresBanRepository, createPostgresIndicatorRequestRepository, createPostgresSessionRegistry } from "../repositories/postgres-admin-repositories.js";

export function createPostgresRuntime(databaseConfig) {
  if (!databaseConfig?.configured) throw new Error("PostgreSQL runtime requires a configured database");
  const pool = new pg.Pool({
    connectionString: databaseConfig.connectionString,
    max: databaseConfig.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: databaseConfig.connectionTimeoutMs ?? 5000,
    statement_timeout: databaseConfig.statementTimeoutMs ?? 10000,
    lock_timeout: databaseConfig.lockTimeoutMs ?? 3000,
    idle_in_transaction_session_timeout: 15000,
    application_name: databaseConfig.applicationName ?? "synergy-module-app",
    ssl: databaseConfig.ssl ? { rejectUnauthorized: true } : undefined,
  });
  // A disconnected idle client is removed by pg; do not crash or expose connection details.
  let lastPoolErrorAt = null;
  pool.on("error", () => { lastPoolErrorAt = new Date().toISOString(); console.error("PostgreSQL idle connection failed; the pool will reconnect."); });
  const PgSessionStore = connectPgSimple(session);
  const sessionStore = new PgSessionStore({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: false,
    pruneSessionInterval: 15 * 60,
  });
  return {
    pool,
    sessionStore,
    getPoolStatus: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, maximum: databaseConfig.poolMax ?? 10, lastErrorAt: lastPoolErrorAt }),
    userRepository: createPostgresUserRepository(pool),
    banRepository: createPostgresBanRepository(pool),
    indicatorRequestRepository: createPostgresIndicatorRequestRepository(pool),
    sessionRegistry: createPostgresSessionRegistry(pool),
    journalRepository: createPostgresJournalRepository(pool),
    brainRepository: createPostgresBrainRepository(pool),
    brokerRepository: createPostgresBrokerRepository(pool),
    workspaceRepository: createPostgresWorkspaceRepository(pool),
    brainToolPolicyRepository: createPostgresBrainToolPolicyRepository(pool),
    readinessCheck: async () => {
      const required = ["user_sessions", "journal_entries", "agent_brain_runs", "agent_brain_documents", "agent_brain_cache", "app_users", "app_bans", "indicator_requests", "revoked_user_sessions", "broker_workspaces", "user_workspaces", "app_schema_migrations", "broker_storage_control", "broker_account_states", "broker_tools", "broker_snapshots", "broker_actions", "broker_events"];
      const result = await pool.query("SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) AS ready FROM unnest($1::text[]) AS tables(name)", [[...required, "brain_tool_policy"]]);
      return result.rows[0]?.ready === true;
    },
    close: async () => {
      await sessionStore.close();
      await pool.end();
    },
  };
}
