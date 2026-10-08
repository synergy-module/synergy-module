function readValue(env, key) {
  return typeof env[key] === "string" ? env[key].trim() : "";
}

function boundedInteger(env, key, fallback, minimum, maximum) {
  const raw = readValue(env, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

export function readDatabaseConfig({ env = process.env, nodeEnvironment = process.env.NODE_ENV } = {}) {
  const connectionString = readValue(env, "DATABASE_URL");
  if (nodeEnvironment === "production" && !connectionString) {
    throw new Error("DATABASE_URL is required in production");
  }
  const sslMode = readValue(env, "DATABASE_SSL") || "disable";
  if (!new Set(["disable", "require"]).has(sslMode)) {
    throw new Error("DATABASE_SSL must be disable or require");
  }
  return {
    configured: Boolean(connectionString),
    connectionString,
    ssl: sslMode === "require",
    poolMax: boundedInteger(env, "DATABASE_POOL_MAX", 10, 1, 50),
    connectionTimeoutMs: boundedInteger(env, "DATABASE_CONNECT_TIMEOUT_MS", 5000, 100, 30000),
    statementTimeoutMs: boundedInteger(env, "DATABASE_STATEMENT_TIMEOUT_MS", 10000, 100, 120000),
    lockTimeoutMs: boundedInteger(env, "DATABASE_LOCK_TIMEOUT_MS", 3000, 100, 30000),
    applicationName: `synergy-module-${readValue(env, "APP_ENVIRONMENT") || "app"}`.slice(0, 63),
    toJSON() { return { configured: Boolean(connectionString), ssl: sslMode === "require" }; },
  };
}
