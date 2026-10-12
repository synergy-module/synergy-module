// PolyBolt reference prices, documented at docs.polymarket.com/migrate/rtds-to-polybolt.
// This adapter sends only auth and subscribe frames. It has no order or wallet methods.
const ENDPOINT = "wss://ws-live-v2.polymarket.com/ws";
const SYMBOLS = new Set(["btcusd", "ethusd", "solusd", "xrpusd"]);
const CHANNELS = new Set(["price.crypto", "price.crypto.twap"]);
const finite = value => typeof value === "number" && Number.isFinite(value);
const time = value => finite(value) ? value : typeof value === "string" ? Date.parse(value) : NaN;
const failure = message => Object.assign(new Error(message), { code: "PRACTICE_REFERENCE_INVALID", status: 422 });

export function normalizeReferenceFrame(frame, { receivedAt = new Date().toISOString(), symbols = [...SYMBOLS] } = {}) {
  if (!frame || frame.v !== 1 || !CHANNELS.has(frame.channel) || !Number.isSafeInteger(frame.seq) || frame.seq < 0 || !finite(time(receivedAt))) return [];
  const payload = frame.payload;
  if (!payload || !symbols.includes(payload.symbol) || !SYMBOLS.has(payload.symbol) || payload.is_carried_forward === true) return [];
  const sourceRows = frame.snapshot === true && Array.isArray(payload.data) ? payload.data : [payload];
  if (sourceRows.length > 2000) return [];
  const windowSeconds = payload.window_seconds ?? payload.windowSeconds;
  if (frame.channel === "price.crypto.twap" && windowSeconds !== 60) return [];
  return sourceRows.map(row => {
    const valueText = row.full_accuracy_value ?? row.value, value = typeof valueText === "string" && /^\d+(?:\.\d+)?$/.test(valueText) ? Number(valueText) : valueText;
    const observed = time(row.timestamp);
    if (!finite(value) || value <= 0 || !finite(observed) || observed > time(receivedAt) + 5000 || observed < time(receivedAt) - 86400000) return null;
    return { symbol: payload.symbol, channel: frame.channel, timestamp: new Date(observed).toISOString(), value,
      exactValue: typeof valueText === "string" ? valueText.slice(0, 100) : String(value), receivedAt, availableAt: receivedAt,
      source: typeof payload.source === "string" ? payload.source.slice(0, 80) : "Polymarket PolyBolt", sequence: frame.seq,
      snapshot: frame.snapshot === true, windowSeconds: frame.channel === "price.crypto.twap" ? 60 : null };
  }).filter(Boolean);
}

/** Create one instance per owner. Persist onSamples in that owner's practice evidence store. */
export function createReferenceRecorder({ WebSocketImpl = globalThis.WebSocket, now = () => new Date(), onSamples = async () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, maxSamples = 2000 } = {}) {
  if (!Number.isInteger(maxSamples) || maxSamples < 10 || maxSamples > 20000) throw failure("Choose a reference buffer limit between 10 and 20,000 samples.");
  let socket = null, authTimer = null, leaseTimer = null, reconnectTimer = null, credentials = null, selected = [], channels = [], expiresAt = null;
  let state = "stopped", lastError = null, lastReceivedAt = null, reconnects = 0, generation = 0, pendingCount = 0, persistence = Promise.resolve();
  const samples = [], sequence = new Map();
  const status = () => ({ status: state, endpoint: ENDPOINT, symbols: [...selected], channels: [...channels], expiresAt, lastError, lastReceivedAt,
    bufferedSamples: samples.length, reconnects, dataOnly: true, storage: "memory-until-evidence-save" });
  function clearTimers() { for (const timer of [authTimer, leaseTimer, reconnectTimer]) clearTimer(timer); authTimer = leaseTimer = reconnectTimer = null; }
  function stop(reason = null) {
    generation++; clearTimers(); const previous = socket; socket = null; credentials = null;
    state = reason ? "error" : "stopped"; lastError = reason; expiresAt = null;
    try { previous?.close(1000, "Reference collection stopped"); } catch { /* Already closed. */ }
    return status();
  }
  function connect(currentGeneration) {
    if (!credentials || generation !== currentGeneration || time(expiresAt) <= now().valueOf()) return;
    state = "connecting"; sequence.clear();
    let connection;
    try { connection = new WebSocketImpl(ENDPOINT); socket = connection; }
    catch { stop("The reference feed connection could not be opened."); return; }
    authTimer = setTimer(() => { if (socket === connection) stop("Reference feed authentication timed out. Check your connection and credentials."); }, 15000); authTimer?.unref?.();
    connection.addEventListener("open", () => {
      if (socket !== connection || generation !== currentGeneration || !credentials) return;
      state = "authenticating";
      try { connection.send(JSON.stringify({ op: "auth", rid: "practice-auth", auth: credentials })); }
      catch { stop("Reference feed authentication could not be sent."); }
    });
    connection.addEventListener("message", event => {
      if (socket !== connection || generation !== currentGeneration) return;
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 65536) { stop("The reference feed returned an unsupported or oversized message."); return; }
      let frame; try { frame = JSON.parse(event.data); } catch { stop("The reference feed returned an invalid message."); return; }
      if (frame.op === "authed" && state === "authenticating") {
        clearTimer(authTimer); authTimer = null; state = "subscribing";
        try { connection.send(JSON.stringify({ op: "subscribe", rid: "practice-prices", subscriptions: channels.flatMap(channel => selected.map(symbol => ({ channel, filter: { symbol, ...(channel === "price.crypto.twap" ? { window_seconds: 60 } : {}) } }))) })); }
        catch { stop("The reference price subscription could not be sent."); return; }
        authTimer = setTimer(() => { if (socket === connection && state === "subscribing") stop("The reference feed did not confirm its subscription."); }, 15000); authTimer?.unref?.();
        return;
      }
      if (frame.op === "error" || frame.error) { stop("The reference feed rejected the request. Check your account credentials and selected symbols."); return; }
      if (frame.op === "subscribed" && state === "subscribing") { clearTimer(authTimer); authTimer = null; state = "recording"; return; }
      if (frame.op) return;
      if (!channels.includes(frame.channel) || !["subscribing", "recording"].includes(state)) return;
      if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || (finite(frame.dropped) && frame.dropped > 0)) { stop("Reference price messages were dropped. Start a new recording to keep the evidence gap visible."); return; }
      const prior = sequence.get(frame.channel);
      if (prior !== undefined && frame.seq <= prior) return;
      if (prior !== undefined && frame.seq !== prior + 1) { stop("The reference feed has a sequence gap. Save this evidence segment and restart."); return; }
      sequence.set(frame.channel, frame.seq);
      const receivedAt = now().toISOString(), rows = normalizeReferenceFrame(frame, { receivedAt, symbols: selected });
      if (frame.snapshot === true || rows.length) { clearTimer(authTimer); authTimer = null; state = "recording"; lastReceivedAt = receivedAt; }
      if (!rows.length) return;
      samples.push(...rows); if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
      if (++pendingCount > 20) { stop("Evidence storage is too slow. Recording stopped before losing price samples."); pendingCount--; return; }
      persistence = persistence.then(() => onSamples(structuredClone(rows))).catch(() => { if (generation === currentGeneration) stop("Reference evidence could not be saved. Check storage before recording again."); }).finally(() => { pendingCount--; });
    });
    connection.addEventListener("error", () => { if (socket === connection) lastError = "The reference feed connection was interrupted."; });
    connection.addEventListener("close", event => {
      if (socket !== connection || generation !== currentGeneration) return;
      socket = null; clearTimer(authTimer); authTimer = null;
      if (event.code === 4003 && reconnects === 0 && credentials && time(expiresAt) > now().valueOf() + 3000) {
        reconnects++; state = "reconnecting";
        reconnectTimer = setTimer(() => connect(currentGeneration), 1000 + Math.floor(random() * 1000)); reconnectTimer?.unref?.();
      } else stop(event.code === 4001 ? "The reference feed could not authenticate these credentials."
        : event.code === 4008 ? "The reference feed rejected its subscription policy. Review the configuration." : "The reference feed closed. Save your evidence and start a new recording.");
    });
  }
  return {
    start({ credentials: supplied, symbols = ["btcusd"], channels: requested = ["price.crypto", "price.crypto.twap"], durationSeconds = 900 } = {}) {
      if (typeof WebSocketImpl !== "function") throw failure("This runtime does not support reference price streaming.");
      if (!supplied || typeof supplied !== "object" || Object.keys(supplied).some(key => !["apiKey", "secret", "passphrase"].includes(key))
        || ["apiKey", "secret", "passphrase"].some(key => typeof supplied[key] !== "string" || supplied[key].length < 1 || supplied[key].length > 4096 || /[\x00-\x20\x7f]/.test(supplied[key]))) throw failure("Provide the international Polymarket CLOB API key, secret and passphrase.");
      if (!Array.isArray(symbols) || !symbols.length || symbols.length > 4 || symbols.some(value => !SYMBOLS.has(value)) || new Set(symbols).size !== symbols.length
        || !Array.isArray(requested) || !requested.length || requested.length > 2 || requested.some(value => !CHANNELS.has(value)) || new Set(requested).size !== requested.length
        || !Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) throw failure("Choose up to four supported USD symbols, reference channels, and a recording duration from 10 to 3,600 seconds.");
      stop(); samples.length = 0; credentials = { apiKey: supplied.apiKey, secret: supplied.secret, passphrase: supplied.passphrase }; selected = [...symbols]; channels = [...requested];
      expiresAt = new Date(now().valueOf() + durationSeconds * 1000).toISOString(); lastError = null; lastReceivedAt = null; reconnects = 0;
      const currentGeneration = generation;
      leaseTimer = setTimer(() => { if (generation === currentGeneration) stop(); }, durationSeconds * 1000); leaseTimer?.unref?.(); connect(currentGeneration); return status();
    },
    status,
    snapshot({ symbol, channel, limit = 500 } = {}) {
      if (symbol !== undefined && !SYMBOLS.has(symbol) || channel !== undefined && !CHANNELS.has(channel) || !Number.isInteger(limit) || limit < 1 || limit > maxSamples) throw failure("Choose a supported reference symbol and bounded sample count.");
      return { ...status(), samples: structuredClone(samples.filter(row => (!symbol || row.symbol === symbol) && (!channel || row.channel === channel)).slice(-limit)) };
    },
    stop: () => stop(),
    async close() { stop(); await persistence; },
  };
}
