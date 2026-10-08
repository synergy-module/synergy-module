import { MAX_ROLE_SNAPSHOT_AGE_MS, ROLES } from "../models/access.js";

const DISCORD_KEYS = Object.freeze([
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "DISCORD_GUILD_ID",
]);
const DISCORD_ROLE_KEYS = Object.freeze([
  "DISCORD_ROLE_DEVELOPER_ID",
  "DISCORD_ROLE_ADMIN_ID",
  "DISCORD_ROLE_OS_ID",
  "DISCORD_ROLE_INDICATORS_ID",
  "DISCORD_ROLE_JOURNAL_ID",
]);

function readValue(env, key) {
  return typeof env[key] === "string" ? env[key].trim() : "";
}

function readRoleRefreshMs(env) {
  const minutes = Number(readValue(env, "DISCORD_ROLE_REFRESH_MINUTES") || "5");
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("DISCORD_ROLE_REFRESH_MINUTES must be a positive number");
  }
  return Math.min(minutes * 60_000, MAX_ROLE_SNAPSHOT_AGE_MS);
}

function readDiscordConfig(env) {
  const accessPolicy = readValue(env, "DISCORD_ACCESS_POLICY") || "roles";
  if (!["roles", "beta-guild"].includes(accessPolicy)) {
    throw new Error("DISCORD_ACCESS_POLICY must be roles or beta-guild");
  }
  if (accessPolicy === "beta-guild" && readValue(env, "APP_ENVIRONMENT") !== "beta") {
    throw new Error("DISCORD_ACCESS_POLICY=beta-guild is only allowed with APP_ENVIRONMENT=beta");
  }
  const requiredKeys = accessPolicy === "roles" ? [...DISCORD_KEYS, ...DISCORD_ROLE_KEYS] : DISCORD_KEYS;
  const missingKeys = requiredKeys.filter((key) => !readValue(env, key));
  if (missingKeys.length > 0) {
    throw new Error(`Missing required Discord configuration: ${missingKeys.join(", ")}`);
  }

  return {
    accessPolicy,
    clientId: readValue(env, "DISCORD_CLIENT_ID"),
    clientSecret: readValue(env, "DISCORD_CLIENT_SECRET"),
    redirectUri: readValue(env, "DISCORD_REDIRECT_URI"),
    guildId: readValue(env, "DISCORD_GUILD_ID"),
    roleIds: {
      [ROLES.DEVELOPER]: readValue(env, "DISCORD_ROLE_DEVELOPER_ID"),
      [ROLES.ADMIN]: readValue(env, "DISCORD_ROLE_ADMIN_ID"),
      [ROLES.OS]: readValue(env, "DISCORD_ROLE_OS_ID"),
      [ROLES.INDICATORS]: readValue(env, "DISCORD_ROLE_INDICATORS_ID"),
      [ROLES.JOURNAL]: readValue(env, "DISCORD_ROLE_JOURNAL_ID"),
    },
  };
}

export function readAuthConfig({ env = process.env, nodeEnvironment = process.env.NODE_ENV } = {}) {
  const mode = readValue(env, "AUTH_MODE") || "discord";
  if (mode !== "discord") {
    throw new Error("Discord authentication is required; AUTH_MODE must be discord");
  }

  const sessionSecret = readValue(env, "SESSION_SECRET");
  if (nodeEnvironment === "production" && !sessionSecret) {
    throw new Error("SESSION_SECRET is required in production");
  }

  return {
    mode,
    sessionSecret,
    roleRefreshMs: readRoleRefreshMs(env),
    discord: readDiscordConfig(env),
  };
}

// Programmatic application configuration follows the same admission policy and
// required credentials as environment-based startup.
export function normalizeAuthConfig(config, {
  nodeEnvironment = process.env.NODE_ENV,
  appEnvironment = process.env.APP_ENVIRONMENT,
  sessionSecret = config?.sessionSecret,
} = {}) {
  if (config?.mode !== "discord") {
    throw new Error("Discord authentication is required; AUTH_MODE must be discord");
  }
  if (config.roleRefreshMs !== undefined
    && (!Number.isFinite(config.roleRefreshMs) || config.roleRefreshMs <= 0)) {
    throw new Error("roleRefreshMs must be a positive number");
  }
  const discord = config.discord ?? {};
  return readAuthConfig({
    nodeEnvironment,
    env: {
      AUTH_MODE: config.mode,
      APP_ENVIRONMENT: appEnvironment,
      SESSION_SECRET: sessionSecret,
      DISCORD_ROLE_REFRESH_MINUTES: config.roleRefreshMs === undefined ? undefined : String(config.roleRefreshMs / 60_000),
      DISCORD_ACCESS_POLICY: discord.accessPolicy,
      DISCORD_CLIENT_ID: discord.clientId,
      DISCORD_CLIENT_SECRET: discord.clientSecret,
      DISCORD_REDIRECT_URI: discord.redirectUri,
      DISCORD_GUILD_ID: discord.guildId,
      DISCORD_ROLE_DEVELOPER_ID: discord.roleIds?.[ROLES.DEVELOPER],
      DISCORD_ROLE_ADMIN_ID: discord.roleIds?.[ROLES.ADMIN],
      DISCORD_ROLE_OS_ID: discord.roleIds?.[ROLES.OS],
      DISCORD_ROLE_INDICATORS_ID: discord.roleIds?.[ROLES.INDICATORS],
      DISCORD_ROLE_JOURNAL_ID: discord.roleIds?.[ROLES.JOURNAL],
    },
  });
}
