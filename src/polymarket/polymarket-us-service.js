import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { createPolymarketUsClient, usError, validateUsCredentials } from "./polymarket-us-client.js";

const CONTEXT = "synergy-polymarket-us-v1";
const DEVELOPMENT_SECRETS = new Set(["synergy-module-local-development-secret", "omensite-local-development-secret"]);
const validOwner = owner => {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 200) throw usError("POLY_US_AUTH", "Sign in to connect Polymarket US.", 401);
  return owner;
};

export function createPolymarketUsService({ repository, encryptionSecret, client = createPolymarketUsClient(), now = () => new Date() } = {}) {
  const key = typeof encryptionSecret === "string" && encryptionSecret.length >= 16 && !DEVELOPMENT_SECRETS.has(encryptionSecret)
    ? Buffer.from(hkdfSync("sha256", encryptionSecret, CONTEXT, "account-credentials", 32)) : null;
  const active = new Set();
  const configured = () => Boolean(key && repository.getStorageStatus().persistent);
  const requireConfigured = () => {
    if (!configured()) throw usError("POLY_US_CONFIG", "Account connections need persistent storage and a stable integration encryption key on the server.", 503);
  };
  const seal = (owner, credentials) => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([CONTEXT, owner])));
    return { version: 1, iv: iv.toString("base64"), ciphertext: Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]).toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  };
  const open = (owner, sealed) => {
    requireConfigured();
    try {
      if (sealed?.version !== 1) throw new Error("Unknown version");
      const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      cipher.setAAD(Buffer.from(JSON.stringify([CONTEXT, owner]))); cipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      return validateUsCredentials(JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext, "base64")), cipher.final()]).toString("utf8")));
    } catch { throw usError("POLY_US_CREDENTIAL", "Saved credentials cannot be read. Restore the server encryption key or replace the connection.", 409); }
  };
  const read = async owner => (await repository.read(validOwner(owner))).polymarketUs ?? {};
  const update = async (owner, work) => {
    try { return await repository.update(validOwner(owner), workspace => { workspace.polymarketUs ??= {}; return work(workspace.polymarketUs); }); }
    catch (error) {
      if (error.message === "Workspace storage limit reached") throw usError("POLY_US_CAPACITY", "Account storage is full. Remove old research or notes before connecting or syncing.", 409);
      throw error;
    }
  };
  async function bounded(owner, work) {
    validOwner(owner); requireConfigured();
    if (active.has(owner) || active.size >= 12) throw usError("POLY_US_BUSY", "An account request is already running. Try again shortly.", 429);
    active.add(owner);
    try { return await work(); } finally { active.delete(owner); }
  }
  async function snapshot(credentials, previous = {}) {
    const names = ["balances", "positions", "orders"];
    const results = await Promise.allSettled(names.map(name => client[name](credentials)));
    // Balances verifies account access; a partial portfolio read is clearly dated.
    if (results[0].status === "rejected") throw results[0].reason;
    const observedAt = now().toISOString(), value = { ...previous, syncedAt: observedAt, warnings: [] };
    results.forEach((result, index) => {
      const name = names[index];
      if (result.status === "fulfilled") value[name] = { ...result.value, observedAt };
      else value.warnings.push(`Could not refresh ${name}. Any displayed ${name} remain from the previous sync.`);
    });
    return value;
  }
  const service = {
    async state(owner) {
      const value = await read(owner); let needsReplacement = false;
      if (value.connection) { try { open(owner, value.connection.sealed); } catch { needsReplacement = true; } }
      return { service: "polymarket-us", configured: configured(), storage: repository.getStorageStatus(), connected: Boolean(value.connection),
        needsReplacement, connectedAt: value.connection?.connectedAt ?? null, snapshot: value.connection?.snapshot ?? null,
        liveTradingAvailable: false };
    },
    async connect(owner, body) {
      return bounded(owner, async () => {
        const credentials = validateUsCredentials(body), operation = randomUUID();
        await update(owner, state => { state.operation = operation; });
        try {
          const value = await snapshot(credentials);
          await update(owner, state => {
            if (state.operation !== operation) throw usError("POLY_US_CONFLICT", "The connection changed during verification. Try connecting again.", 409);
            state.connection = { id: randomUUID(), connectedAt: now().toISOString(), sealed: seal(owner, credentials), snapshot: value };
            delete state.operation;
          });
          return service.state(owner);
        } catch (error) {
          await update(owner, state => { if (state.operation === operation) delete state.operation; }).catch(() => {});
          throw error;
        }
      });
    },
    async sync(owner) {
      return bounded(owner, async () => {
        const state = await read(owner), connection = state.connection;
        if (!connection) throw usError("POLY_US_NOT_CONNECTED", "Connect your Polymarket US account first.", 409);
        const value = await snapshot(open(owner, connection.sealed), connection.snapshot);
        await update(owner, current => {
          if (current.connection?.id !== connection.id) throw usError("POLY_US_CONFLICT", "The connection changed during sync. Refresh the page.", 409);
          // Do not overwrite a newer snapshot from another application instance.
          if (!current.connection.snapshot || current.connection.snapshot.syncedAt <= value.syncedAt) current.connection.snapshot = value;
        });
        return service.state(owner);
      });
    },
    async disconnect(owner) {
      await update(owner, state => { delete state.connection; delete state.operation; });
      return service.state(owner);
    },
  };
  return service;
}
