export function readSynergyResearchConfig(env = process.env) {
  const connectionString = env.SYNERGY_RESEARCH_DATABASE_URL?.trim() || "";
  const ssl = env.SYNERGY_RESEARCH_DATABASE_SSL?.trim() || "disable";
  if (!["disable", "require"].includes(ssl)) throw new Error("SYNERGY_RESEARCH_DATABASE_SSL must be disable or require");
  if (connectionString) {
    let url;
    try { url = new URL(connectionString); } catch { throw new Error("SYNERGY_RESEARCH_DATABASE_URL must be a PostgreSQL URL"); }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("SYNERGY_RESEARCH_DATABASE_URL must be a PostgreSQL URL");
  }
  return { configured: Boolean(connectionString), connectionString, ssl: ssl === "require",
    toJSON() { return { configured: Boolean(connectionString), ssl: ssl === "require" }; } };
}
