import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { createReferenceRecorder } from "./reference-recorder.js";

const fail = (message, status = 422) => Object.assign(new Error(message), { code: "PRACTICE_FEED_INVALID", status });
const ownerId = owner => {
  if (typeof owner !== "string" || !owner || owner.length > 200) throw fail("Sign in to manage reference data.", 401);
  return owner;
};
const evidenceKey = owner => `practice:${createHash("sha256").update(ownerId(owner)).digest("hex")}:reference`;
const idle = () => ({ status: "stopped", symbols: [], channels: [], expiresAt: null, lastError: null, bufferedSamples: 0, dataOnly: true });
const active = recorder => ["connecting", "authenticating", "subscribing", "recording", "reconnecting"].includes(recorder.status().status);
const plain = value => value && typeof value === "object" && !Array.isArray(value);

export function createPracticeFeedService({ repository, encryptionSecret, canOperate = async () => false,
  recorderFactory = createReferenceRecorder, WebSocketImpl, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!repository?.read || !repository?.update) throw new Error("Practice feed storage is required");
  const key = typeof encryptionSecret === "string" && encryptionSecret.length >= 16
    && !["synergy-module-local-development-secret", "omensite-local-development-secret"].includes(encryptionSecret)
    ? Buffer.from(hkdfSync("sha256", encryptionSecret, "synergy-practice-polybolt-v1", "credentials", 32)) : null;
  const recorders = new Map(), locks = new Map();
  let closed = false;
  const seal = (owner, credentials) => {
    if (!key) throw fail("A stable integration encryption key is required before saving feed credentials.", 503);
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(owner));
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
  };
  const open = (owner, value) => {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
      decipher.setAAD(Buffer.from(owner)); decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64url")), decipher.final()]).toString("utf8"));
    } catch { throw fail("Replace the saved feed credentials or restore the integration encryption key.", 503); }
  };
  async function locked(owner, work) {
    ownerId(owner);
    const previous = locks.get(owner) ?? Promise.resolve();
    let release;
    const wait = new Promise(resolve => { release = resolve; }); locks.set(owner, wait);
    await previous;
    try { if (closed) throw fail("The reference service is restarting.", 503); return await work(); }
    finally { release(); if (locks.get(owner) === wait) locks.delete(owner); }
  }
  async function stop(owner) {
    const entry = recorders.get(owner);
    if (!entry) return;
    clearTimer(entry.guard);
    entry.recorder.stop();
    await entry.recorder.close();
    if (recorders.get(owner) === entry) recorders.delete(owner);
  }
  function scheduleGuard(owner, entry) {
    clearTimer(entry.guard);
    if (closed || recorders.get(owner) !== entry) return;
    entry.guard = setTimer(async () => {
      if (closed || recorders.get(owner) !== entry) return;
      try {
        const admitted = await canOperate(owner);
        if (recorders.get(owner) !== entry) return;
        if (!active(entry.recorder) || !admitted) { await stop(owner); return; }
      } catch { if (recorders.get(owner) === entry) await stop(owner); return; }
      scheduleGuard(owner, entry);
    }, 30_000);
    entry.guard?.unref?.();
  }
  const api = {
    async state(owner) {
      const saved = (await repository.read(ownerId(owner))).practiceFeeds?.polybolt;
      let configured = false;
      if (saved?.sealed) { try { open(owner, saved.sealed); configured = true; } catch {} }
      return { storage: repository.getStorageStatus(), polybolt: { configured, credentialStorageAvailable: Boolean(key),
        connectedAt: saved?.connectedAt ?? null, needsReplacement: Boolean(saved?.sealed && !configured),
        recorder: recorders.get(owner)?.recorder.status() ?? idle() } };
    },
    async connect(owner, credentials) {
      if (!plain(credentials) || Object.keys(credentials).some(field => !["apiKey", "secret", "passphrase"].includes(field))
        || ["apiKey", "secret", "passphrase"].some(field => typeof credentials[field] !== "string" || !credentials[field] || credentials[field].length > 4096 || /[\x00-\x20\x7f]/.test(credentials[field]))) {
        throw fail("Enter the international Polymarket API key, secret and passphrase.");
      }
      return locked(owner, async () => {
        const sealed = seal(owner, credentials);
        await stop(owner);
        await repository.update(owner, state => { state.practiceFeeds ??= {}; state.practiceFeeds.polybolt = { sealed, connectedAt: now().toISOString() }; });
        return api.state(owner);
      });
    },
    async disconnect(owner) {
      return locked(owner, async () => {
        await stop(owner);
        await repository.update(owner, state => { if (state.practiceFeeds) delete state.practiceFeeds.polybolt; });
        return api.state(owner);
      });
    },
    async start(owner, input = {}) {
      if (!plain(input) || Object.keys(input).some(field => !["symbols", "channels", "durationSeconds"].includes(field))) throw fail("Choose reference symbols, channels and a duration.");
      return locked(owner, async () => {
        if (!await canOperate(owner)) throw fail("Your account needs a current sign-in to record reference prices.", 401);
        const saved = (await repository.read(owner)).practiceFeeds?.polybolt;
        if (!saved?.sealed) throw fail("Connect your international Polymarket data credentials first.", 409);
        const credentials = open(owner, saved.sealed);
        await stop(owner);
        for (const [id, entry] of recorders) if (!active(entry.recorder)) await stop(id);
        if (recorders.size >= 20) throw fail("The reference recorder is busy. Wait for another recording to finish.", 429);
        const entry = { recorder: null, guard: null };
        entry.recorder = recorderFactory({ ...(WebSocketImpl ? { WebSocketImpl } : {}), now, setTimer, clearTimer, maxSamples: 1000,
          onSamples: async rows => {
            if (closed || recorders.get(owner) !== entry || !await canOperate(owner)) { entry.recorder.stop(); return; }
            await repository.update(evidenceKey(owner), state => {
              const samples = [...(state.referenceSamples ?? []), ...rows].slice(-500);
              // Keep recorded evidence below the shared row limit even with long provider labels.
              while (samples.length && Buffer.byteLength(JSON.stringify(samples)) > 200_000) samples.shift();
              state.referenceSamples = samples;
              state.recordedAt = now().toISOString();
            });
          },
        });
        try { entry.recorder.start({ credentials, ...input }); }
        catch (error) { await entry.recorder.close(); throw error; }
        recorders.set(owner, entry);
        scheduleGuard(owner, entry);
        return api.state(owner);
      });
    },
    async stop(owner) { return locked(owner, async () => { await stop(owner); return api.state(owner); }); },
    async snapshot(owner, { symbol, channel, limit = 500 } = {}) {
      ownerId(owner);
      if (symbol !== undefined && !["btcusd", "ethusd", "solusd", "xrpusd"].includes(symbol)
        || channel !== undefined && !["price.crypto", "price.crypto.twap"].includes(channel)
        || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail("Choose a supported symbol, channel and sample limit from 1 to 1,000.");
      const state = await repository.read(evidenceKey(owner));
      const memory = recorders.get(owner)?.recorder.snapshot({ symbol, channel, limit });
      const saved = (state.referenceSamples ?? []).filter(sample => (!symbol || sample.symbol === symbol) && (!channel || sample.channel === channel));
      const samples = [...new Map([...saved, ...(memory?.samples ?? [])].map(sample => [`${sample.channel}:${sample.symbol}:${sample.timestamp}:${sample.receivedAt}`, sample])).values()]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit);
      return { ...(memory ?? idle()), samples, dataOnly: true, storage: repository.getStorageStatus(), retainedSampleLimit: 500, recordedAt: state.recordedAt ?? null };
    },
    async close() {
      closed = true;
      await Promise.allSettled([...locks.values()]);
      await Promise.allSettled([...recorders.keys()].map(stop));
    },
  };
  return api;
}
