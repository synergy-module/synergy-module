import { createApp } from "./app.js";
import { readAuthConfig } from "./config/auth-config.js";
import { readDatabaseConfig } from "./config/database-config.js";
import { createPostgresRuntime } from "./runtime/postgres-runtime.js";
import { createSqliteRuntime } from "./runtime/sqlite-runtime.js";
import { createSqliteBrainRepository } from "./agent-brain/brain-repository.js";
import { createSqliteBrokerRepository } from "./brokers/broker-repository.js";
import { createSqliteWorkspaceRepository } from "./settings/workspace-repository.js";
import { readSynergyResearchConfig } from "./config/synergy-research-config.js";
import { createSynergyResearch } from "./agent-brain/synergy-research.js";
import { createSqliteBrainToolPolicyRepository } from "./agent-brain/brain-tool-policy-repository.js";

const port = process.env.PORT ?? 3000;
const host = process.env.HOST || "127.0.0.1";
const authConfig = readAuthConfig();
const databaseConfig = readDatabaseConfig();
const synergyResearch = createSynergyResearch({ config: readSynergyResearchConfig() });
const postgresRuntime = databaseConfig.configured ? createPostgresRuntime(databaseConfig) : null;
const workspaceFilename = process.env.WORKSPACE_DB_PATH?.trim() || "data/workspace.sqlite";
const runtime = postgresRuntime ?? createSqliteRuntime({
  filename: workspaceFilename,
});
const workspaceRepository = postgresRuntime?.workspaceRepository ?? createSqliteWorkspaceRepository(workspaceFilename);
const brainToolPolicyRepository = postgresRuntime?.brainToolPolicyRepository ?? createSqliteBrainToolPolicyRepository(workspaceFilename);
const brainRepository = postgresRuntime?.brainRepository ?? createSqliteBrainRepository({
  filename: process.env.BRAIN_DB_PATH?.trim() || "data/agent-brain.sqlite",
});
const app = createApp({
  authConfig,
  synergyResearch,
  brainToolPolicyRepository,
  brainRepository,
  workspaceRepository,
  brokerRepository: postgresRuntime?.brokerRepository ?? createSqliteBrokerRepository("data/robinhood.sqlite"),
  sessionStore: runtime.sessionStore,
  userRepository: runtime.userRepository,
  banRepository: runtime.banRepository,
  indicatorRequestRepository: runtime.indicatorRequestRepository,
  sessionRegistry: runtime.sessionRegistry,
  journalRepository: runtime.journalRepository,
  readinessCheck: runtime.readinessCheck,
});

const server = app.listen(port, host, () => {
  console.log(`Synergy Module listening on http://${host}:${port}`);
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    if (closing) return;
    closing = true;
    // Complete current HTTP writes before closing their durable stores.
    await new Promise((resolve) => server.close(resolve));
    await app.locals.brainService?.close?.();
    await synergyResearch?.close();
    await app.locals.robinhoodService?.close?.();
    await brainRepository.close();
    await workspaceRepository.close();
    await brainToolPolicyRepository.close();
    await runtime.close();
    process.exit(0);
  });
}
