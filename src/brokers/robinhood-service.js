import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { createBrokerCipher, createRobinhoodClient, readRobinhoodConfig } from "./robinhood-client.js";
import { createMemoryBrokerRepository } from "./broker-repository.js";
import { ROBINHOOD_GROUPS, ROBINHOOD_READ_TOOLS, ROBINHOOD_WRITES, ROBINHOOD_PREVIEWS, robinhoodToolKind, brokerError } from "./robinhood-catalog.js";

const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false, ownProperties: true });
const ajv2020 = new Ajv2020({ strict: false, allErrors: false, validateFormats: false, ownProperties: true });
function validate(schema, args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 16000) throw brokerError("ROBINHOOD_INPUT", "Check the request fields and size.", 422);
  if (schema?.$async) throw brokerError("ROBINHOOD_SCHEMA", "This broker input schema needs a compatibility update.", 422);
  let validator;
  try {
    const compiler = schema?.$schema?.includes("2020-12") ? ajv2020 : ajv;
    validator = compiler.compile(schema);
    compiler.removeSchema(schema); // Repeated remote discovery must not grow the compiler's schema cache.
  }
  catch { throw brokerError("ROBINHOOD_SCHEMA", "This broker input schema needs a compatibility update.", 422); }
  if (!validator(args)) throw brokerError("ROBINHOOD_INPUT", "The request does not match Robinhood's current fields. Check required values and types.", 422);
  return structuredClone(args);
}
function knownTools(tools) {
  return tools.filter((tool) => robinhoodToolKind(tool.name) !== "blocked" && tool.inputSchema?.type === "object")
    .map((tool) => ({ name: tool.name, title: tool.name.replaceAll("_", " "), kind: robinhoodToolKind(tool.name), inputSchema: tool.inputSchema,
      group: Object.entries(ROBINHOOD_GROUPS).find(([, names]) => names.includes(tool.name))?.[0] ?? "Actions" }));
}
function findTool(tools, name) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw brokerError("ROBINHOOD_TOOL_UNAVAILABLE", "This tool is unavailable for your Robinhood connection. Refresh the connection.", 422);
  return tool;
}
export function createRobinhoodService({ repository = createMemoryBrokerRepository(), config = readRobinhoodConfig(), client = createRobinhoodClient(), now = () => Date.now() } = {}) {
  const cipher = config.configured ? createBrokerCipher(config.encryptionKey) : null;
  const active = new Map();
  const audit = (state, event, detail = {}) => {
    state.events.unshift({ id: randomUUID(), at: new Date(now()).toISOString(), event, ...detail });
    state.events = state.events.slice(0, 200);
  };
  const configured = () => {
    if (!config.configured || !repository.getStorageStatus().persistent) throw brokerError("ROBINHOOD_CONFIG", "Robinhood connection needs persistent storage and its server settings before sign-in is available.", 503);
  };
  async function connection(owner) {
    configured();
    const state = await repository.read(owner);
    if (!state.connection) throw brokerError("ROBINHOOD_NOT_CONNECTED", "Connect your Robinhood account first.", 409);
    let credentials = cipher.open(owner, state.connection.sealed);
    if (credentials.expiresAt <= now() + 30000) {
      const claim = randomUUID();
      await repository.update(owner, (current) => {
        if (current.connection?.id !== state.connection.id) throw brokerError("ROBINHOOD_RECONNECT", "The connection changed. Refresh and try again.");
        if (current.connection.refreshUntil > now()) throw brokerError("ROBINHOOD_BUSY", "Robinhood authorization is refreshing. Try again shortly.", 429);
        current.connection.refreshClaim = claim; current.connection.refreshUntil = now() + 30000;
      });
      try {
        const refreshed = await client.refresh(credentials);
        await repository.update(owner, (current) => {
          if (current.connection?.id !== state.connection.id || current.connection.refreshClaim !== claim) throw brokerError("ROBINHOOD_RECONNECT", "The connection changed. Reconnect Robinhood.");
          current.connection.sealed = cipher.seal(owner, refreshed);
          delete current.connection.refreshClaim; delete current.connection.refreshUntil;
        });
        credentials = refreshed;
      } catch (error) {
        await repository.update(owner, (current) => {
          if (current.connection?.refreshClaim === claim) { delete current.connection.refreshClaim; delete current.connection.refreshUntil; }
        });
        throw error;
      }
    }
    return { id: state.connection.id, credentials };
  }
  async function guardConnection(owner, id) {
    if ((await repository.read(owner)).connection?.id !== id) throw brokerError("ROBINHOOD_RECONNECT", "Your Robinhood connection changed. Refresh and try again.");
  }
  async function bounded(owner, work) {
    if ((active.get(owner) ?? 0) >= 2 || [...active.values()].reduce((a, b) => a + b, 0) >= 12) throw brokerError("ROBINHOOD_BUSY", "Robinhood requests are busy. Try again shortly.", 429);
    active.set(owner, (active.get(owner) ?? 0) + 1);
    try { return await work(); }
    finally { const count = active.get(owner) - 1; count ? active.set(owner, count) : active.delete(owner); }
  }
  const service = {
    async state(owner) {
      const state = await repository.read(owner);
      const actions = state.actions.map((action) => ({ ...action,
        status: action.status === "awaiting_approval" && action.expiresAt <= now() ? "expired"
          : action.status === "submitting" && action.submittedAt + 30000 < now() ? "unknown" : action.status }));
      return { broker: "robinhood", configured: config.configured && repository.getStorageStatus().persistent,
        missing: config.missing ?? [], connected: Boolean(state.connection), connectedAt: state.connection?.connectedAt ?? null,
        storage: repository.getStorageStatus(), liveEnabled: config.liveEnabled === true, paused: state.paused,
        tools: state.tools, snapshots: state.snapshots, actions, events: state.events, discoveryAt: state.discoveryAt ?? null,
        groups: Object.keys(ROBINHOOD_GROUPS), approvalMode: "every_action", unattendedTrading: false };
    },
    async begin(owner) {
      configured();
      return { ...await client.begin(config.redirectUri, config.clientId), ownerId: owner };
    },
    async complete(owner, pending, code) {
      configured();
      if (pending.ownerId !== owner || pending.createdAt + 600000 < now() || typeof code !== "string" || code.length > 4096) throw brokerError("ROBINHOOD_AUTH_STATE", "The Robinhood sign-in request expired. Start again.", 400);
      const credentials = await client.complete(pending, code);
      await repository.update(owner, (state) => {
        state.connection = { id: randomUUID(), connectedAt: new Date(now()).toISOString(), sealed: cipher.seal(owner, credentials) };
        state.tools = []; state.snapshots = []; state.paused = true;
        for (const action of state.actions) if (action.status === "awaiting_approval") action.status = "expired";
        audit(state, "connected");
      });
      await service.discover(owner);
    },
    async disconnect(owner) {
      await repository.update(owner, (state) => {
        state.connection = null; state.tools = []; state.snapshots = []; state.paused = true;
        for (const action of state.actions) if (action.status === "awaiting_approval") action.status = "expired";
        audit(state, "disconnected");
      });
      // Removing local authorization stops new calls. Remote consent is managed in Robinhood.
    },
    async pause(owner, paused) {
      if (typeof paused !== "boolean") throw brokerError("ROBINHOOD_INPUT", "Choose whether to pause submissions.", 422);
      if (!paused && !config.liveEnabled) throw brokerError("ROBINHOOD_LIVE_LOCKED", "Live submissions are locked on the server.", 423);
      await repository.update(owner, (state) => { state.paused = paused; audit(state, paused ? "submissions_paused" : "submissions_enabled"); });
    },
    async discover(owner) {
      return bounded(owner, async () => {
        const auth = await connection(owner);
        const tools = await client.withSession(auth.credentials, async (remote) => knownTools(await remote.listTools()));
        await repository.update(owner, (state) => {
          if (state.connection?.id !== auth.id) throw brokerError("ROBINHOOD_RECONNECT", "The broker connection changed.");
          state.tools = tools; state.discoveryAt = new Date(now()).toISOString(); audit(state, "tools_discovered", { count: tools.length });
        });
        return tools;
      });
    },
    async catalog(owner, group) {
      const state = await repository.read(owner);
      if (!state.connection) throw brokerError("ROBINHOOD_NOT_CONNECTED", "Connect Robinhood before requesting its tools.");
      if (![...Object.keys(ROBINHOOD_GROUPS), "Actions"].includes(group)) throw brokerError("ROBINHOOD_INPUT", "Choose a supported tool group.", 422);
      return state.tools.filter((tool) => tool.group === group);
    },
    async read(owner, name, args = {}, { signal } = {}) {
      if (!ROBINHOOD_READ_TOOLS.has(name)) throw brokerError("ROBINHOOD_TOOL_DENIED", "This action is not an allowed account or market-data read.", 403);
      return bounded(owner, async () => {
        const auth = await connection(owner);
        const result = await client.withSession(auth.credentials, async (remote) => {
          const tool = findTool(knownTools(await remote.listTools()), name);
          const input = validate(tool.inputSchema, args);
          await guardConnection(owner, auth.id);
          return remote.call(name, input);
        }, { signal });
        const snapshot = { id: randomUUID(), tool: name, arguments: args, fetchedAt: new Date(now()).toISOString(), result };
        await repository.update(owner, (state) => {
          if (state.connection?.id !== auth.id) throw brokerError("ROBINHOOD_RECONNECT", "The broker connection changed.");
          state.snapshots = [snapshot, ...state.snapshots.filter((item) => hash([item.tool, item.arguments]) !== hash([name, args]))].slice(0, 12);
          audit(state, "data_read", { tool: name, snapshotId: snapshot.id });
        });
        return snapshot;
      });
    },
    async propose(owner, { tool: name, arguments: args = {}, reason = "", requestId, source = "operator" }, { signal } = {}) {
      if (!ROBINHOOD_WRITES.has(name)) throw brokerError("ROBINHOOD_TOOL_DENIED", "This broker action is not supported.", 403);
      if (typeof reason !== "string" || reason.trim().length < 5 || reason.length > 1000) throw brokerError("ROBINHOOD_INPUT", "Include a short reason for the requested change.", 422);
      if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId))) throw brokerError("ROBINHOOD_INPUT", "Invalid request identifier.", 422);
      return bounded(owner, async () => {
        const state = await repository.read(owner);
        const duplicate = requestId && state.actions.find((item) => item.requestId === requestId);
        if (duplicate) {
          if (hash([duplicate.tool, duplicate.arguments]) !== hash([name, args])) throw brokerError("ROBINHOOD_CONFLICT", "This request identifier was already used for different details.");
          return duplicate;
        }
        const auth = await connection(owner);
        const prepared = await client.withSession(auth.credentials, async (remote) => {
          const tools = knownTools(await remote.listTools()), tool = findTool(tools, name);
          const input = validate(tool.inputSchema, args);
          let preview = null;
          if (ROBINHOOD_PREVIEWS[name]) {
            const previewTool = findTool(tools, ROBINHOOD_PREVIEWS[name]);
            const omitted = Object.keys(input).filter((key) => !Object.hasOwn(previewTool.inputSchema.properties ?? {}, key));
            if (omitted.some((key) => !["ref_id", "client_order_id", "idempotency_key"].includes(key))) throw brokerError("ROBINHOOD_PREVIEW_SCHEMA", "Robinhood's preview does not cover every order field. This order needs an adapter update before submission.", 422);
            const previewInput = Object.fromEntries(Object.entries(input).filter(([key]) => Object.hasOwn(previewTool.inputSchema.properties ?? {}, key)));
            // An incompatible preview schema blocks submission instead of inventing parameter mappings.
            validate(previewTool.inputSchema, previewInput);
            await guardConnection(owner, auth.id);
            preview = await remote.call(previewTool.name, previewInput);
          }
          return { input, preview, schemaHash: hash(tool.inputSchema) };
        }, { signal });
        return repository.update(owner, (current) => {
          if (current.connection?.id !== auth.id) throw brokerError("ROBINHOOD_RECONNECT", "The broker connection changed.");
          const duplicate = current.actions.find((item) => (requestId && item.requestId === requestId)
            || (["awaiting_approval", "submitting", "unknown"].includes(item.status) && (item.status !== "awaiting_approval" || item.expiresAt > now()) && hash([item.tool, item.arguments]) === hash([name, args])));
          if (duplicate) return duplicate;
          if (current.actions.filter((item) => ["awaiting_approval", "submitting", "unknown"].includes(item.status) && (item.status !== "awaiting_approval" || item.expiresAt > now())).length >= 20) throw brokerError("ROBINHOOD_CAPACITY", "Resolve existing broker requests before adding more.");
          const action = { id: randomUUID(), requestId: requestId ?? randomUUID(), tool: name, kind: robinhoodToolKind(name), arguments: prepared.input,
            reason: reason.trim(), source, preview: prepared.preview, schemaHash: prepared.schemaHash, connectionId: auth.id,
            version: 1, status: "awaiting_approval", createdAt: new Date(now()).toISOString(), expiresAt: now() + (prepared.preview ? 60000 : 180000) };
          current.actions.unshift(action);
          const keep = current.actions.filter((item, index) => index < 100 || ["submitting", "unknown"].includes(item.status));
          current.actions = keep; audit(current, "approval_requested", { actionId: action.id, tool: name });
          return action;
        });
      });
    },
    async decide(owner, id, { decision, version }) {
      if (!["approve", "reject"].includes(decision) || !Number.isInteger(version)) throw brokerError("ROBINHOOD_INPUT", "Choose a decision for the current request version.", 422);
      if (decision === "reject") return repository.update(owner, (state) => {
        const action = state.actions.find((item) => item.id === id);
        if (!action) throw brokerError("ROBINHOOD_NOT_FOUND", "Broker request not found.", 404);
        if (action.status !== "awaiting_approval" || action.version !== version) throw brokerError("ROBINHOOD_CONFLICT", "This broker request changed. Refresh it.");
        action.status = "rejected"; action.version++; audit(state, "request_rejected", { actionId: id }); return action;
      });
      if (!config.liveEnabled) throw brokerError("ROBINHOOD_LIVE_LOCKED", "Live submissions are locked on the server. Previews do not place orders.", 423);
      return bounded(owner, async () => {
        const auth = await connection(owner);
        const action = await repository.update(owner, (state) => {
          const current = state.actions.find((item) => item.id === id);
          if (!current) throw brokerError("ROBINHOOD_NOT_FOUND", "Broker request not found.", 404);
          if (current.status !== "awaiting_approval" || current.version !== version) throw brokerError("ROBINHOOD_CONFLICT", "This request was already handled or changed. Refresh it.");
          if (state.paused) throw brokerError("ROBINHOOD_PAUSED", "Broker submissions are paused.", 423);
          if (current.connectionId !== auth.id || current.expiresAt <= now()) throw brokerError("ROBINHOOD_EXPIRED", "Preview expired or the account connection changed. Prepare a new request.");
          if (state.actions.some((item) => ["submitting", "unknown"].includes(item.status))) throw brokerError("ROBINHOOD_UNRESOLVED", "Check the unresolved request in Robinhood before submitting another.");
          current.status = "submitting"; current.version++; current.submittedAt = now(); audit(state, "submission_claimed", { actionId: id, tool: current.tool });
          return structuredClone(current);
        });
        let dispatched = false;
        try {
          const result = await client.withSession(auth.credentials, async (remote) => {
            const tool = findTool(knownTools(await remote.listTools()), action.tool);
            if (hash(tool.inputSchema) !== action.schemaHash) throw brokerError("ROBINHOOD_SCHEMA_CHANGED", "Robinhood changed its order fields. Prepare a new preview.");
            validate(tool.inputSchema, action.arguments);
            const state = await repository.read(owner);
            if (state.paused || state.connection?.id !== auth.id) throw brokerError("ROBINHOOD_PAUSED", "The connection was paused or removed before submission.", 423);
            dispatched = true;
            // Exactly one dispatch. A timeout is an unknown outcome and is never automatically retried.
            return remote.call(action.tool, action.arguments);
          });
          return await repository.update(owner, (state) => {
            const current = state.actions.find((item) => item.id === id);
            current.status = "submitted"; current.result = result; current.completedAt = new Date(now()).toISOString(); current.version++;
            audit(state, "broker_acknowledged", { actionId: id, tool: current.tool }); return current;
          });
        } catch (error) {
          await repository.update(owner, (state) => {
            const current = state.actions.find((item) => item.id === id);
            current.status = dispatched ? "unknown" : "failed"; current.version++;
            current.message = dispatched ? "Outcome unconfirmed. Check Robinhood Activity before taking another action. No automatic retry." : "The request stopped before broker dispatch. Prepare a fresh request.";
            audit(state, current.status, { actionId: id, tool: current.tool });
          });
          throw brokerError(dispatched ? "ROBINHOOD_OUTCOME_UNKNOWN" : "ROBINHOOD_SUBMISSION_STOPPED", dispatched
            ? "Robinhood did not confirm the outcome. Check Robinhood Activity. Automatic retry is blocked."
            : "The request stopped before broker dispatch. Prepare a new preview.", 502);
        }
      });
    },
    async close() { await repository.close(); },
  };
  return service;
}
