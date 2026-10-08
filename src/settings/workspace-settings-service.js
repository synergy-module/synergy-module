import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createMemoryWorkspaceRepository } from "./workspace-repository.js";

const PROVIDERS = Object.freeze({ gemini: "Gemini", openai: "OpenAI", claude: "Claude" });
const ROLES = ["planner", "researcher", "strategist", "critic"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];
const CREDENTIAL_VERSION = 2;
const CREDENTIAL_CONTEXTS = Object.freeze({
  // Persisted v1 records must keep their original key derivation and authenticated data.
  1: "omensite-workspace-v1",
  2: "synergy-module-workspace-v2",
});
const DEVELOPMENT_SECRETS = new Set(["synergy-module-local-development-secret", "omensite-local-development-secret"]);
const DEFAULTS = Object.freeze({
  provider: "gemini", symbol: "SPY", timeframe: "15m", accountSize: 50000, riskPercent: 0.5, pointValue: 1, minRewardRisk: 2,
  routes: {}, limits: { maxSteps: 12, maxModelCalls: 10, maxTokens: 64000, maxDurationMs: 120000, maxCostUsd: null },
});
const DRAFT_FIELDS = Object.freeze({
  research: { objective: 1200, provider: 20, symbol: 24, timeframe: 10, context: 12000, accountSize: 30, riskPercent: 30, pointValue: 30,
    minRewardRisk: 30, route_planner: 20, route_researcher: 20, route_strategist: 20, route_critic: 20,
    maxSteps: 10, maxModelCalls: 10, maxTokens: 10, durationSeconds: 10, maxCostUsd: 30, approvalNote: 1000, approvalRunId: 200 },
  journal: { direction: 10, entryTime: 100, entryPrice: 40, exitPrice: 40, notes: 12000, confluences: 30 },
  knowledge: { title: 200, text: 50000 },
});
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validOwner = (owner) => {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 200) throw failure("SETTINGS_AUTH_REQUIRED", 401, "Sign in to manage your workspace.");
  return owner;
};
function failure(code = "SETTINGS_INVALID", status = 422, message = "Check the settings fields and try again.") {
  return Object.assign(new Error(message), { code, status });
}
function objectKeys(value, allowed) {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw failure();
}
function bounded(value, minimum, maximum, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) throw failure();
}
function validatePreferences(value) {
  objectKeys(value, Object.keys(DEFAULTS));
  if (value.provider !== undefined && !Object.hasOwn(PROVIDERS, value.provider)) throw failure();
  if (value.symbol !== undefined && (typeof value.symbol !== "string" || !/^[A-Za-z0-9./:_-]{1,24}$/.test(value.symbol))) throw failure();
  if (value.timeframe !== undefined && !TIMEFRAMES.includes(value.timeframe)) throw failure();
  for (const [key, minimum, maximum] of [["accountSize", 0.01, 1e9], ["riskPercent", 0.01, 5], ["pointValue", 0.000001, 1e6], ["minRewardRisk", 1, 20]]) {
    if (value[key] !== undefined) bounded(value[key], minimum, maximum);
  }
  if (value.routes !== undefined) {
    objectKeys(value.routes, ROLES);
    if (Object.values(value.routes).some((id) => id !== "" && !Object.hasOwn(PROVIDERS, id))) throw failure();
  }
  if (value.limits !== undefined) {
    objectKeys(value.limits, Object.keys(DEFAULTS.limits));
    for (const [key, minimum, maximum] of [["maxSteps", 1, 24], ["maxModelCalls", 1, 16], ["maxTokens", 1, 128000], ["maxDurationMs", 10, 180000]]) {
      if (value.limits[key] !== undefined) bounded(value.limits[key], minimum, maximum, true);
    }
    if (value.limits.maxCostUsd !== undefined && value.limits.maxCostUsd !== null) bounded(value.limits.maxCostUsd, 0, 10);
  }
  return structuredClone(value);
}
function validateDraft(name, fields) {
  if (!Object.hasOwn(DRAFT_FIELDS, name)) throw failure();
  objectKeys(fields, Object.keys(DRAFT_FIELDS[name]));
  for (const [key, value] of Object.entries(fields)) {
    if (name === "journal" && key === "confluences") {
      if (!Array.isArray(value) || value.length > 30 || value.some((item) => typeof item !== "string" || item.length > 120)) throw failure();
    } else if (typeof value !== "string" || value.length > DRAFT_FIELDS[name][key] || /\u0000/.test(value)) throw failure();
  }
  return structuredClone(fields);
}

/** Credentials are only decrypted for a provider request, never for the client state. */
export function createWorkspaceSettingsService({ repository = createMemoryWorkspaceRepository(), aiProvider, encryptionSecret, now = () => new Date() } = {}) {
  // The caller must supply a stable deployment secret. Refuse the application's
  // public development fallback instead of creating secrets nobody can retain.
  const credentialKeys = typeof encryptionSecret === "string" && encryptionSecret.length >= 16 && !DEVELOPMENT_SECRETS.has(encryptionSecret)
    ? Object.fromEntries(Object.entries(CREDENTIAL_CONTEXTS).map(([version, context]) =>
      [version, Buffer.from(hkdfSync("sha256", encryptionSecret, context, "provider-api-credentials", 32))])) : null;
  const baseStatus = () => aiProvider?.getStatus?.() ?? { defaultProvider: "gemini", paidCallsEnabled: false, providers: [] };
  const seal = (owner, provider, apiKey) => {
    if (!credentialKeys) throw failure("SETTINGS_ENCRYPTION_UNAVAILABLE", 503, "Configure a stable integration encryption key before saving API credentials.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", credentialKeys[CREDENTIAL_VERSION], iv);
    cipher.setAAD(Buffer.from(JSON.stringify([CREDENTIAL_CONTEXTS[CREDENTIAL_VERSION], owner, provider])));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return { version: CREDENTIAL_VERSION, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  };
  const open = (owner, provider, sealed) => {
    if (!credentialKeys) throw failure("SETTINGS_ENCRYPTION_UNAVAILABLE", 503, "Saved API credentials are unavailable. Check the integration encryption key.");
    try {
      if (![1, CREDENTIAL_VERSION].includes(sealed?.version)) throw new Error("Unsupported credential version");
      const decipher = createDecipheriv("aes-256-gcm", credentialKeys[sealed.version], Buffer.from(sealed.iv, "base64url"));
      decipher.setAAD(Buffer.from(JSON.stringify([CREDENTIAL_CONTEXTS[sealed.version], owner, provider])));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    } catch { throw failure("SETTINGS_CREDENTIAL_UNAVAILABLE", 503, "A saved API credential could not be read. Restore the integration encryption key or replace this credential."); }
  };
  const preferences = (state) => ({ ...structuredClone(DEFAULTS), provider: baseStatus().defaultProvider || "gemini", ...state.preferences,
    routes: { ...(state.preferences?.routes ?? {}) }, limits: { ...DEFAULTS.limits, ...state.preferences?.limits } });

  const api = {
    async getState(owner) {
      const state = await repository.read(validOwner(owner));
      const status = baseStatus();
      return {
        storage: repository.getStorageStatus(), credentialStorageAvailable: Boolean(credentialKeys), paidCallsEnabled: status.paidCallsEnabled === true,
        providers: Object.entries(PROVIDERS).map(([id, label]) => {
          const server = status.providers?.find((entry) => entry.id === id);
          const saved = state.providers[id];
          let available = false;
          if (saved) { try { available = Boolean(open(owner, id, saved.sealed)); } catch {} }
          return { id, label, model: server?.model ?? "", configured: saved ? available : server?.configured === true,
            source: saved ? "account" : server?.configured ? "server" : "none", updatedAt: saved?.updatedAt ?? null,
            needsReplacement: Boolean(saved && !available) };
        }),
        preferences: preferences(state), drafts: Object.fromEntries(Object.keys(DRAFT_FIELDS).map((name) => [name, state.drafts[name] ?? null])),
        updatedAt: state.updatedAt,
      };
    },
    async saveProvider(owner, provider, value) {
      validOwner(owner);
      if (!Object.hasOwn(PROVIDERS, provider)) throw failure();
      objectKeys(value, ["apiKey"]);
      const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
      if (apiKey.length < 8 || apiKey.length > 8192 || /\s|[\u0000-\u001f\u007f]/.test(apiKey)) throw failure();
      const sealed = seal(owner, provider, apiKey);
      await repository.update(owner, (state) => {
        state.updatedAt = now().toISOString();
        state.providers[provider] = { sealed, updatedAt: state.updatedAt };
      });
      return api.getState(owner);
    },
    async removeProvider(owner, provider) {
      validOwner(owner);
      if (!Object.hasOwn(PROVIDERS, provider)) throw failure();
      await repository.update(owner, (state) => { delete state.providers[provider]; state.updatedAt = now().toISOString(); });
      return api.getState(owner);
    },
    async savePreferences(owner, value) {
      validOwner(owner);
      const patch = validatePreferences(value);
      await repository.update(owner, (state) => {
        const before = preferences(state);
        state.preferences = { ...before, ...patch, routes: { ...before.routes, ...patch.routes }, limits: { ...before.limits, ...patch.limits } };
        for (const role of ROLES) if (state.preferences.routes[role] === "") delete state.preferences.routes[role];
        state.updatedAt = now().toISOString();
      });
      return api.getState(owner);
    },
    async saveDraft(owner, name, fields) {
      validOwner(owner);
      const normalized = validateDraft(name, fields);
      await repository.update(owner, (state) => {
        state.updatedAt = now().toISOString();
        state.drafts[name] = { fields: normalized, updatedAt: state.updatedAt };
      });
      return api.getState(owner);
    },
    async removeDraft(owner, name) {
      validOwner(owner);
      if (!Object.hasOwn(DRAFT_FIELDS, name)) throw failure();
      await repository.update(owner, (state) => { delete state.drafts[name]; state.updatedAt = now().toISOString(); });
      return api.getState(owner);
    },
    async getProviderCredential(owner, provider) {
      validOwner(owner);
      if (!Object.hasOwn(PROVIDERS, provider)) throw failure();
      const state = await repository.read(owner);
      const saved = state.providers[provider];
      return saved ? open(owner, provider, saved.sealed) : null;
    },
  };
  return api;
}
