import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CAPABILITIES, MAX_ROLE_SNAPSHOT_AGE_MS } from "../models/access.js";

export const PLATFORM_SCOPES = Object.freeze([
  { id: "workspace:read", label: "Read workspace", description: "Read your profile, settings, connections, research, journal and testing results." },
  { id: "workspace:write", label: "Edit workspace", description: "Update your profile, preferences, setup, journal, drafts and notes." },
  { id: "connections:write", label: "Manage connections", description: "Connect or disconnect providers and accounts, and save encrypted API credentials." },
  { id: "research:write", label: "Run research", description: "Start AI research, manage knowledge and review research decisions. Provider charges may apply." },
  { id: "testing:write", label: "Paper trade live markets", description: "Configure virtual accounts and paper trade current market prices using simulated funds." },
  { id: "live:trade", label: "Manage live trading", description: "Configure live automation and propose or approve real broker actions. Existing server trading limits still apply." },
  { id: "admin:read", label: "Read administration", description: "Read administrator dashboards and tool policy. Requires the administrator role." },
  { id: "admin:write", label: "Edit administration", description: "Manage members and shared tool policy. Requires the administrator role." },
].map(Object.freeze));
const scopeIds = new Set(PLATFORM_SCOPES.map(scope => scope.id));
const tokenPattern = /^syg_([A-Za-z0-9_-]{1,267})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/;
const publicRecord = ({ hash: _hash, ...record }) => structuredClone(record);
const digest = value => createHash("sha256").update(value).digest();
const failure = (code, status, message) => Object.assign(new Error(message), { code, status });
const invalidToken = () => failure("API_TOKEN_INVALID", 401, "The API token is invalid, expired or revoked.");
const validOwner = owner => {
  if (typeof owner !== "string" || !owner || owner.length > 200) throw invalidToken();
  return owner;
};

export function createPlatformTokenService({ repository, userRepository, banRepository, authService, authMode = "discord", encryptionSecret, now = () => new Date() }) {
  if (!repository?.read || !repository?.update || !userRepository?.findById || !banRepository?.isBanned || !authService) {
    throw new Error("Platform API requires workspace storage and authoritative account admission services");
  }
  const encryptionKey = typeof encryptionSecret === "string" && encryptionSecret.length >= 16
    && !["synergy-module-local-development-secret", "omensite-local-development-secret"].includes(encryptionSecret)
    ? Buffer.from(hkdfSync("sha256", encryptionSecret, "synergy-platform-api-v1", "delegated-oauth", 32)) : null;
  const timestamp = () => new Date(now()).toISOString();
  const time = () => new Date(now()).getTime();
  const refreshes = new Map();
  const authorizationLocks = new Map();
  async function withAuthorizationLock(owner, work) {
    validOwner(owner);
    const previous = authorizationLocks.get(owner) ?? Promise.resolve();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    authorizationLocks.set(owner, pending);
    await previous;
    try { return await work(); }
    finally { release(); if (authorizationLocks.get(owner) === pending) authorizationLocks.delete(owner); }
  }
  const seal = (owner, value) => {
    if (!encryptionKey) throw failure("API_ENCRYPTION_REQUIRED", 503, "Configure a stable integration encryption key before starting account authorization.");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(Buffer.from(owner));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  };
  const open = (owner, value) => {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(value.iv, "base64url"));
    decipher.setAAD(Buffer.from(owner));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
  };
  async function currentOperator(owner) {
    if (typeof authService.assertOperatorAdmission !== "function") throw failure("API_ACCOUNT_UNAVAILABLE", 401, "Authoritative account admission is unavailable.");
    const operator = await userRepository.findById(owner);
    if (!operator || operator.id !== owner || operator.authMode !== authMode || !operator.capabilities?.includes(CAPABILITIES.BASE)
      || await banRepository.isBanned(owner)) throw failure("API_ACCOUNT_UNAVAILABLE", 401, "This account is not currently permitted to use the platform.");
    try { await authService.assertOperatorAdmission(operator); }
    catch { throw failure("API_ACCOUNT_UNAVAILABLE", 401, "This account is not currently permitted to use the platform."); }
    return operator;
  }
  function fresh(operator) {
    const age = time() - new Date(operator.rolesSyncedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < MAX_ROLE_SNAPSHOT_AGE_MS;
  }
  async function refreshOperator(owner) {
    const current = await currentOperator(owner);
    if (fresh(current)) return current;
    const state = await repository.read(owner);
    if (!encryptionKey || !state.platformApi?.discordAuth || !authService.refreshOperator) {
      throw failure("API_REAUTHENTICATION_REQUIRED", 401, "Sign in again to refresh account permissions, then retry. Configure integration encryption for delegated permission refresh.");
    }
    try {
      const refreshed = await authService.refreshOperator({ ...current, discordAuth: open(owner, state.platformApi.discordAuth) });
      if (refreshed.id !== owner || !fresh(refreshed)) throw new Error("Invalid refreshed identity");
      await authService.assertOperatorAdmission(refreshed);
      await repository.update(owner, state => {
        // A revocation during refresh must not recreate a deleted delegation.
        if (state.platformApi?.tokens?.some(token => !token.revokedAt && new Date(token.expiresAt).getTime() > time())) {
          state.platformApi.discordAuth = seal(owner, refreshed.discordAuth);
        }
      });
      return currentOperator(owner);
    } catch (error) {
      if (error?.code?.startsWith("API_")) throw error;
      throw failure("API_REAUTHENTICATION_REQUIRED", 401, "Sign in and create a new API token to renew account authorization.");
    }
  }
  const api = {
    withAuthorizationLock,
    async list(owner) {
      const state = await repository.read(validOwner(owner));
      return { tokens: (state.platformApi?.tokens ?? []).map(publicRecord), scopes: PLATFORM_SCOPES,
        storage: repository.getStorageStatus(), delegatedPermissionRefresh: Boolean(encryptionKey),
        openapiUrl: "/api/v1/openapi.json", operationsUrl: "/api/v1/operations" };
    },
    async issue(operator, input = {}) {
      const owner = validOwner(operator?.id);
      const current = await currentOperator(owner);
      if (!fresh(current)) throw failure("API_REAUTHENTICATION_REQUIRED", 401, "Refresh your sign-in before creating an API token.");
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["name", "scopes", "expiresInDays"].includes(key))
        || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80
        || !Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some(scope => !scopeIds.has(scope))) {
        throw failure("API_TOKEN_INPUT_INVALID", 422, "Enter a name and select valid API permissions.");
      }
      const expiresInDays = input.expiresInDays ?? 30;
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) throw failure("API_TOKEN_INPUT_INVALID", 422, "Choose an expiration between 1 and 90 days.");
      if (input.scopes.some(scope => scope.startsWith("admin:")) && !current.capabilities.includes(CAPABILITIES.ADMIN)) {
        throw failure("API_SCOPE_FORBIDDEN", 403, "Only administrators can grant administrator permissions.");
      }
      const id = randomUUID(), token = `syg_${Buffer.from(owner).toString("base64url")}.${id}.${randomBytes(32).toString("base64url")}`;
      const record = { id, name: input.name.trim(), scopes: [...new Set(input.scopes)], createdAt: timestamp(),
        expiresAt: new Date(time() + expiresInDays * 86_400_000).toISOString(), lastUsedAt: null, revokedAt: null, hash: digest(token).toString("hex") };
      await withAuthorizationLock(owner, async () => {
        // A concurrent API permission refresh may rotate credentials after the
        // browser middleware ran. Never overwrite that rotation with old tokens.
        const delegated = await api.browserAuthorization(operator) ?? operator.discordAuth;
        await repository.update(owner, state => {
          state.platformApi ??= { tokens: [], audit: [] };
          const active = state.platformApi.tokens.filter(token => !token.revokedAt && new Date(token.expiresAt).getTime() > time());
          if (active.length >= 20) throw failure("API_TOKEN_LIMIT", 409, "Revoke an unused token before creating another. Up to 20 tokens can be active.");
          const inactive = state.platformApi.tokens.filter(token => !active.includes(token)).slice(-20);
          state.platformApi.tokens = [...inactive, ...active, record];
          if (encryptionKey && delegated?.accessToken) {
            state.platformApi.discordAuth = seal(owner, delegated);
            state.platformApi.delegationSignedInAt = operator.lastSignedInAt ?? null;
          }
        });
      });
      return { token, record: publicRecord(record), message: "Copy this token now. It is only shown once." };
    },
    async revoke(owner, id) {
      return repository.update(validOwner(owner), state => {
        const record = state.platformApi?.tokens?.find(token => token.id === id);
        if (!record) throw failure("API_TOKEN_NOT_FOUND", 404, "That API token does not belong to this account.");
        record.revokedAt ??= timestamp();
        if (!state.platformApi.tokens.some(token => !token.revokedAt && new Date(token.expiresAt).getTime() > time())) {
          delete state.platformApi.discordAuth;
          delete state.platformApi.delegationSignedInAt;
        }
        return { ok: true };
      });
    },
    async authenticate(token) {
      const match = typeof token === "string" && token.length < 600 && token.match(tokenPattern);
      if (!match) throw invalidToken();
      const owner = Buffer.from(match[1], "base64url").toString("utf8");
      validOwner(owner);
      const state = await repository.read(owner), record = state.platformApi?.tokens?.find(record => record.id === match[2]);
      const expected = Buffer.from(record?.hash ?? "", "hex"), actual = digest(token);
      if (!record || expected.length !== actual.length || !timingSafeEqual(expected, actual) || record.revokedAt
        || !Number.isFinite(new Date(record.expiresAt).getTime()) || new Date(record.expiresAt).getTime() <= time()) throw invalidToken();
      let operator = await currentOperator(owner);
      if (!fresh(operator)) {
        if (!refreshes.has(owner)) refreshes.set(owner, withAuthorizationLock(owner, () => refreshOperator(owner)).finally(() => refreshes.delete(owner)));
        operator = await refreshes.get(owner);
      }
      await repository.update(owner, state => {
        const latest = state.platformApi?.tokens?.find(entry => entry.id === record.id);
        if (!latest || latest.revokedAt || new Date(latest.expiresAt).getTime() <= time()) throw invalidToken();
        latest.lastUsedAt = timestamp();
      });
      const { discordAuth: _credentials, ...identity } = operator;
      return { operator: identity, token: publicRecord(record) };
    },
    async audit(owner, event) {
      await repository.update(owner, state => {
        state.platformApi ??= { tokens: [] };
        const safe = { at: timestamp(), tokenId: event.tokenId, method: event.method, operation: event.operation, status: event.status };
        state.platformApi.audit = [...(state.platformApi.audit ?? []), safe].slice(-100);
      });
    },
    async auditLog(owner) { return { events: (await repository.read(validOwner(owner))).platformApi?.audit ?? [] }; },
    async browserAuthorization(operator) {
      if (!encryptionKey || typeof operator?.lastSignedInAt !== "string") return null;
      const state = await repository.read(validOwner(operator.id));
      if (!state.platformApi?.discordAuth || state.platformApi.delegationSignedInAt !== operator.lastSignedInAt) return null;
      try {
        const latest = open(operator.id, state.platformApi.discordAuth);
        return Date.parse(latest.expiresAt) > Date.parse(operator.discordAuth?.expiresAt) ? latest : null;
      } catch { return null; }
    },
    async rememberBrowserAuthorization(operator) {
      if (!encryptionKey || typeof operator?.lastSignedInAt !== "string" || !operator.discordAuth?.accessToken) return;
      await repository.update(validOwner(operator.id), state => {
        if (!state.platformApi?.discordAuth || state.platformApi.delegationSignedInAt !== operator.lastSignedInAt) return;
        if (!state.platformApi.tokens?.some(token => !token.revokedAt && Date.parse(token.expiresAt) > time())) return;
        let stored;
        try { stored = open(operator.id, state.platformApi.discordAuth); } catch { return; }
        if (Date.parse(operator.discordAuth.expiresAt) > Date.parse(stored.expiresAt)) state.platformApi.discordAuth = seal(operator.id, operator.discordAuth);
      });
    },
    async saveAuthorization(owner, pending) {
      await repository.update(validOwner(owner), state => {
        state.platformApi ??= { tokens: [], audit: [] };
        state.platformApi.robinhoodAuthorization = { value: seal(owner, pending), createdAt: timestamp() };
      });
    },
    async takeAuthorization(owner, stateValue) {
      return repository.update(validOwner(owner), state => {
        const authorization = state.platformApi?.robinhoodAuthorization;
        if (!authorization || time() - new Date(authorization.createdAt).getTime() > 600_000) throw failure("API_AUTHORIZATION_EXPIRED", 409, "Start account authorization again.");
        let pending;
        try { pending = open(owner, authorization.value); } catch { throw failure("API_AUTHORIZATION_EXPIRED", 409, "Start account authorization again."); }
        if (typeof stateValue !== "string" || stateValue !== pending.state) throw failure("API_AUTHORIZATION_INVALID", 422, "The account authorization state does not match.");
        delete state.platformApi.robinhoodAuthorization;
        return pending;
      });
    },
  };
  return api;
}
