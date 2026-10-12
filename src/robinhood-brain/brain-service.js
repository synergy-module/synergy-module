import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_POLICY, brainError, fresh, planTrades, round, validatePolicy } from "./risk-policy.js";
import { buildEquityOrder, fetchBrokerEvidence, validateBindings, verifyOrderPreview } from "./broker-evidence.js";
import { demoEvidence, researchEquities } from "./research.js";

const empty = () => ({ version: 1, policy: structuredClone(DEFAULT_POLICY), bindings: [], verifiedAt: null, mode: "paper", consent: null,
  runs: [], notes: [], memories: [], ledger: [], dryDays: [], proofs: {}, worker: { enabled: false, id: null, leaseUntil: null },
  paper: { cash: 10000, positions: [], realizedPnl: 0, initialized: false, daily: null, weekly: null } });
const day = date => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const running = (state, now) => state.worker.enabled && Date.parse(state.worker.leaseUntil) > now.valueOf();
const pendingOrder = row => ["awaiting_approval", "submitting", "submitted", "unknown", "partial"].includes(row.status);
const keys = (body, allowed) => {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw brainError("INPUT", "Check the request fields.");
};

// This runs inside the broker's atomic claim and again just before dispatch.
export function authorizeRobinhoodBrain(workspace, action, at, enabled = false) {
  const state = workspace.agentic, proof = state?.proofs?.[action.requestId], now = new Date(at);
  if (!enabled || !state || state.mode !== "autonomous" || state.consent?.version !== state.version || !running(state, now)
    || action.source !== "robinhood-brain" || action.tool !== "place_equity_order" || !proof
    || proof.policyVersion !== state.version || proof.expiresAt <= at || proof.source !== "robinhood" || proof.previewChecked !== true
    || !fresh(proof.quoteAt, now) || !fresh(proof.accountAt, now) || !isDeepStrictEqual(proof.arguments, action.arguments)
    || state.runs[0]?.id !== proof.runId || state.runs[0]?.status !== "running"
    || state.ledger.some(row => row.requestId !== action.requestId && pendingOrder(row))) {
    throw brainError("AUTHORITY", "This order lacks current, policy-bound autonomous authorization.", 423);
  }
}

export function createRobinhoodBrainService({ broker, ai, now = () => new Date(), autonomousEnabled = false,
  canOperate = async () => true, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timers = new Map(), jobs = new Map(), instanceId = randomUUID();
  let closing = false;
  const read = async owner => (await broker.readBrainWorkspace(owner)) ?? empty();
  const update = (owner, change) => broker.updateBrainWorkspace(owner, workspace => {
    workspace.agentic ??= empty(); return change(workspace.agentic);
  });
  const event = (run, phase, message) => { run.events ??= []; run.events.push({ phase, message, at: now().toISOString() }); run.phase = phase; };
  function schedule(owner, seconds) {
    clearTimer(timers.get(owner));
    if (closing) return;
    const timer = setTimer(async () => {
      timers.delete(owner);
      try { await api.run(owner, { mode: "cycle" }, { scheduled: true }); } catch { /* The saved run carries the failure; no order replay. */ }
      if (!closing) { const state = await read(owner); if (state.worker.enabled && state.worker.id === instanceId) schedule(owner, state.policy.cycleSeconds); }
    }, seconds * 1000);
    timer?.unref?.(); timers.set(owner, timer);
  }
  async function checked(owner, controller, version) {
    if (closing || controller.signal.aborted || !await canOperate(owner)) throw brainError("STOPPED", "The cycle stopped before its next action.", 409);
    const state = await read(owner);
    if (state.version !== version || !state.worker.enabled || !running(state, now())) throw brainError("STOPPED", "Policy, pause state, or worker lease changed.", 409);
    return state;
  }
  function paperSnapshot(state, snapshot) {
    const account = structuredClone(state.paper);
    if (!account.initialized) { account.cash = snapshot.account.cash; account.initialized = true; }
    for (const pos of account.positions) {
      const market = snapshot.markets.find(row => row.symbol === pos.symbol);
      if (market && fresh(market.quoteAt, now())) { pos.value = pos.quantity * market.bid; pos.markPrice = market.bid; }
    }
    const value = account.cash + account.positions.reduce((sum, pos) => sum + pos.value, 0), today = day(now());
    if (account.daily?.date !== today) account.daily = { date: today, equity: value };
    const currentDay = new Date(`${today}T12:00:00Z`).getUTCDay();
    const monday = new Date(`${today}T12:00:00Z`); monday.setUTCDate(monday.getUTCDate() - (currentDay + 6) % 7);
    const week = monday.toISOString().slice(0, 10);
    if (account.weekly?.date !== week) account.weekly = { date: week, equity: value };
    return { paper: account, snapshot: { ...snapshot, positions: account.positions, account: { ...snapshot.account, cash: account.cash,
      equity: value, dailyPnl: value - account.daily.equity, weeklyPnl: value - account.weekly.equity } } };
  }
  function fillPaper(paper, order, runId) {
    const pos = paper.positions.find(row => row.symbol === order.symbol);
    if (order.side === "buy") {
      paper.cash = round(paper.cash - order.notional);
      paper.positions.push({ symbol: order.symbol, quantity: order.quantity, averageCost: order.limitPrice, value: order.notional,
        markPrice: order.limitPrice, openedAt: now().toISOString(), holdingId: randomUUID() });
    } else {
      if (!pos || order.quantity > pos.quantity) throw brainError("RISK", "A paper sell exceeds available shares.");
      paper.cash = round(paper.cash + order.notional); paper.realizedPnl = round(paper.realizedPnl + order.quantity * (order.limitPrice - pos.averageCost));
      pos.quantity = round(pos.quantity - order.quantity); pos.value = round(pos.quantity * order.limitPrice);
      paper.positions = paper.positions.filter(row => row.quantity > 0.000001);
    }
    return { ...order, id: randomUUID(), runId, mode: "paper", status: "filled", at: now().toISOString() };
  }
  async function reconcileEvidence(owner, snapshot) {
    if (!snapshot.ordersRead) return;
    await broker.updateBrainWorkspace(owner, workspace => {
      const state = workspace.agentic;
      if (!state) return;
      for (const entry of state.ledger.filter(row => row.mode !== "paper" && pendingOrder(row))) {
        const order = snapshot.orders.find(row => row.requestId === entry.requestId && row.number === state.policy.accountNumber
          && row.symbol === entry.symbol && row.side === entry.side);
        if (!order) continue;
        if (order.status === "filled" && typeof order.filledQuantity === "number" && Math.abs(order.filledQuantity - entry.quantity) <= 0.000001
          && typeof order.averagePrice === "number" && Number.isFinite(order.averagePrice) && order.averagePrice > 0) {
          entry.status = "filled"; entry.fillPrice = order.averagePrice; entry.at = now().toISOString();
        } else if (["cancelled", "rejected"].includes(order.status) && order.filledQuantity === 0) entry.status = order.status;
        else if (order.filledQuantity > 0) entry.status = "partial";
        if (["filled", "cancelled", "rejected"].includes(entry.status)) {
          const action = workspace.actions.find(row => row.id === entry.actionId && row.requestId === entry.requestId && row.source === "robinhood-brain");
          if (action && action.connectionId === workspace.connection?.id && ["unknown", "submitted", "submitting"].includes(action.status)) {
            action.status = "reconciled"; action.version++;
            action.reconciliation = { status: entry.status, filledQuantity: order.filledQuantity, averagePrice: order.averagePrice,
              observedAt: snapshot.account.observedAt, sources: snapshot.sources.map(source => source.id) };
          }
        }
      }
    });
  }
  const api = {
    async state(owner) {
      const state = await read(owner), brokerState = await broker.state(owner), providerState = await ai.getOwnerStatus(owner);
      return { ...state, proofs: undefined, worker: { running: running(state, now()), mode: state.mode },
        storage: broker.getStorageStatus(), providers: providerState.providers, paidCallsEnabled: providerState.paidCallsEnabled,
        broker: { configured: brokerState.configured, connected: brokerState.connected, liveEnabled: brokerState.liveEnabled, paused: brokerState.paused },
        autonomousEnabled, readiness: [
          { name: "Robinhood connected", pass: brokerState.connected }, { name: "Broker mappings verified", pass: Boolean(state.verifiedAt) },
          { name: "Research provider", pass: providerState.providers.some(row => row.id === state.policy.provider && row.configured) },
          { name: "Independent review provider", pass: providerState.providers.some(row => row.id === state.policy.criticProvider && row.configured) },
          { name: "Paid AI enabled", pass: providerState.paidCallsEnabled },
          { name: "Autonomous preview contract", pass: state.bindings.some(binding => binding.kind === "preview") },
          { name: "Ten dry-run days with current policy", pass: state.dryDays.length >= 10 },
          { name: "Live server switches", pass: brokerState.liveEnabled && autonomousEnabled },
        ] };
    },
    async configure(owner, body) {
      keys(body, ["version", "policy", "bindings"]);
      const policy = validatePolicy(body.policy), bindings = validateBindings(body.bindings ?? []);
      await update(owner, state => {
        if (!Number.isInteger(body.version) || body.version !== state.version || running(state, now()) || jobs.has(owner) || state.ledger.some(pendingOrder)) throw brainError("CONFLICT", "Pause the worker, reconcile pending orders, and reload its policy before saving.", 409);
        state.policy = policy; state.bindings = bindings; state.version++; state.consent = null; state.mode = "paper"; state.verifiedAt = null; state.dryDays = [];
      });
      return api.state(owner);
    },
    async verify(owner) {
      const state = await read(owner), snapshot = await fetchBrokerEvidence(broker, owner, state.policy, state.bindings);
      const check = planTrades({ snapshot, theses: [], policy: state.policy, now: now() });
      if (check.blocked.length) throw brainError("ADAPTER", check.blocked.join("; "), 409);
      await update(owner, current => { if (current.version !== state.version) throw brainError("CONFLICT", "The policy changed during verification.", 409); current.verifiedAt = now().toISOString(); });
      return { snapshot, verifiedAt: now().toISOString() };
    },
    async note(owner, body) {
      keys(body, ["text"]);
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 1500) throw brainError("INPUT", "Write a lesson of 1 to 1,500 characters.");
      await update(owner, state => { if (state.notes.length >= 20) throw brainError("CAPACITY", "Remove an old lesson before adding another.", 409);
        state.notes.unshift({ id: randomUUID(), text: body.text.trim(), at: now().toISOString() }); });
      return api.state(owner);
    },
    async removeNote(owner, id) { await update(owner, state => { const count = state.notes.length; state.notes = state.notes.filter(row => row.id !== id); if (count === state.notes.length) throw brainError("NOT_FOUND", "Lesson not found.", 404); }); return api.state(owner); },
    async pause(owner) {
      clearTimer(timers.get(owner)); timers.delete(owner); jobs.get(owner)?.abort();
      await update(owner, state => { state.worker.enabled = false; state.consent = null; state.proofs = {}; });
      return api.state(owner);
    },
    async start(owner, body) {
      keys(body, ["version", "mode", "authorizeAutonomous"]);
      if (!["paper", "review", "autonomous"].includes(body.mode)) throw brainError("INPUT", "Choose paper, reviewed broker orders, or autonomous execution.");
      const status = await api.state(owner);
      if (!await canOperate(owner) || !status.broker.connected || !status.verifiedAt || !status.paidCallsEnabled
        || !status.providers.some(row => row.id === status.policy.provider && row.configured)
        || !status.providers.some(row => row.id === status.policy.criticProvider && row.configured)) throw brainError("SETUP", "Complete Robinhood, response mapping, and AI provider setup first.", 409);
      if (body.mode === "autonomous" && (!autonomousEnabled || !status.broker.liveEnabled || status.broker.paused || status.dryDays.length < 10 || body.authorizeAutonomous !== true
        || !status.bindings.some(binding => binding.kind === "preview"))) throw brainError("AUTHORITY", "Autonomous execution requires both server switches, unpaused broker access, a verified preview mapping, ten verified dry-run days, and explicit policy authorization.", 423);
      if (timers.size + jobs.size >= 20) throw brainError("BUSY", "The worker queue is full.", 429);
      await update(owner, state => {
        if (body.version !== state.version || running(state, now()) || jobs.has(owner)) throw brainError("CONFLICT", "The policy or worker changed. Reload before starting.", 409);
        state.mode = body.mode; state.worker = { enabled: true, id: instanceId, leaseUntil: new Date(now().valueOf() + (state.policy.cycleSeconds + 180) * 1000).toISOString() };
        state.consent = body.mode === "autonomous" ? { version: state.version, at: now().toISOString(), accountNumber: state.policy.accountNumber, symbols: state.policy.symbols } : null;
      });
      schedule(owner, 0); return api.state(owner);
    },
    async enqueue(owner, body) {
      return new Promise((resolve, reject) => {
        api.run(owner, body, { onStarted: resolve }).then(run => resolve({ id: run.id, status: run.status }), reject);
      });
    },
    async run(owner, body, { scheduled = false, onStarted } = {}) {
      keys(body, ["mode"]);
      if (!["demo", "cycle"].includes(body.mode)) throw brainError("INPUT", "Choose a demo or broker-data cycle.");
      if (closing || jobs.has(owner) || !await canOperate(owner)) throw brainError("BUSY", "A cycle is already running or operator access is unavailable.", 409);
      if (jobs.has(owner)) throw brainError("BUSY", "A cycle is already running.", 409);
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 180000), runId = randomUUID();
      jobs.set(owner, controller);
      let initial, run, admitted = false;
      try {
        initial = await read(owner);
        await update(owner, state => {
          if (state.runs[0]?.status === "running" && Date.parse(state.runs[0].startedAt) + 180000 > now().valueOf()) throw brainError("BUSY", "Another worker owns the current cycle.", 409);
          if (state.ledger.filter(pendingOrder).length) throw brainError("RECONCILE", "Reconcile pending broker orders before another cycle.", 409);
          if (scheduled && (!state.worker.enabled || state.worker.id !== instanceId)) throw brainError("STOPPED", "The worker was paused.", 409);
          if (!scheduled && running(state, now())) throw brainError("BUSY", "Pause scheduled work before a manual cycle.", 409);
          if (!scheduled && body.mode !== "demo" && state.mode !== "paper") throw brainError("AUTHORITY", "Start the worker to authorize a broker execution mode.", 409);
          state.worker = { ...state.worker, enabled: true, id: instanceId, leaseUntil: new Date(now().valueOf() + (state.policy.cycleSeconds + 180) * 1000).toISOString() };
          if (!scheduled) state.mode = "paper";
          run = { id: runId, status: "running", mode: body.mode === "demo" ? "demo" : state.mode, policyVersion: state.version,
            startedAt: now().toISOString(), phase: "observe", events: [], executions: [] };
          state.runs.unshift(run); state.runs = state.runs.slice(0, 10); state.proofs = {};
        });
        admitted = true; onStarted?.({ id: runId, status: "running" });
        const saved = await checked(owner, controller, initial.version), demo = body.mode === "demo";
        const policy = demo ? { ...saved.policy, accountNumber: "DEMO_ACCOUNT", symbols: ["DEMO"] } : saved.policy;
        const source = demo ? demoEvidence(now(), policy) : await fetchBrokerEvidence(broker, owner, policy, saved.bindings, controller.signal);
        if (!demo && source.account.marketOpen !== true && scheduled) { event(run, "observe", "Market session is closed or unverified; no model call or order."); run.status = "waiting"; return run; }
        event(run, "research", "Phase A: universe and signal screening, sourced theses, independent critique.");
        await update(owner, state => { Object.assign(state.runs.find(row => row.id === runId), run); });
        const research = await researchEquities({ ai, owner, snapshot: source, policy, notes: [...saved.notes, ...saved.memories.filter(row => demo || row.source !== "demo")], signal: controller.signal, demo });
        Object.assign(run, research); run.sources = source.sources.map(({ id, tool, fetchedAt }) => ({ id, tool, fetchedAt }));
        await checked(owner, controller, initial.version);
        event(run, "risk", "Phase B: fresh evidence, sell-side checks, ranked entries and fixed risk rules.");
        await update(owner, state => { Object.assign(state.runs.find(row => row.id === runId), run); });
        const verified = demo ? demoEvidence(now(), policy) : await fetchBrokerEvidence(broker, owner, policy, saved.bindings, controller.signal);
        const latest = await checked(owner, controller, initial.version);
        let paper, valuation = verified;
        if (run.mode === "paper") { const result = paperSnapshot(latest, verified); paper = result.paper; valuation = result.snapshot; }
        run.plan = planTrades({ snapshot: valuation, theses: research.theses, policy,
          ledger: latest.ledger.filter(row => row.mode === (run.mode === "paper" ? "paper" : "broker")), now: now() });
        if (run.plan.blocked.length) throw brainError("RISK", run.plan.blocked.join("; "), 409);
        run.source = demo ? "demo" : "robinhood";
        for (const order of run.plan.orders) {
          await checked(owner, controller, initial.version);
          if (demo) run.executions.push({ ...order, status: "simulated", mode: "demo" });
          else if (run.mode === "paper") {
            const execution = fillPaper(paper, order, runId); run.executions.push(execution);
          } else {
            const brokerState = await broker.state(owner);
            if (brokerState.actions.some(action => ["unknown", "submitting"].includes(action.status))) throw brainError("RECONCILE", "Robinhood has an unresolved submission.", 409);
            const requestId = randomUUID(), args = buildEquityOrder(brokerState.tools.find(tool => tool.name === "place_equity_order"), order, policy.accountNumber, requestId);
            const action = await broker.propose(owner, { tool: "place_equity_order", arguments: args, reason: `Robinhood Brain ${runId}: ${order.reason}`, requestId, source: "robinhood-brain" }, { signal: controller.signal });
            const entry = { ...order, id: randomUUID(), runId, mode: "broker", actionId: action.id, requestId: action.requestId, status: action.status, at: now().toISOString() };
            await update(owner, state => {
              if (state.version !== initial.version || !running(state, now()) || controller.signal.aborted) throw brainError("STOPPED", "Authorization changed before execution.", 409);
              state.ledger.unshift(entry); state.ledger = state.ledger.filter((row, index) => index < 200 || pendingOrder(row));
              state.proofs[requestId] = { runId, policyVersion: state.version, source: "robinhood", arguments: args,
                expiresAt: now().valueOf() + 45000, quoteAt: order.quoteAt, accountAt: verified.account.observedAt, previewChecked: false };
            });
            if (run.mode === "autonomous") {
              verifyOrderPreview(action.preview, saved.bindings.find(binding => binding.kind === "preview"), order, verified.account, policy);
              await update(owner, state => { const proof = state.proofs[requestId]; if (!proof) throw brainError("STOPPED", "The order authorization was revoked.", 409); proof.previewChecked = true; });
              await checked(owner, controller, initial.version);
              try { const result = await broker.submitAgentic(owner, action.id, action.version); entry.status = result.status; }
              catch (error) { entry.status = (await broker.state(owner)).actions.find(row => row.id === action.id)?.status ?? "unknown"; throw error; }
              finally { await update(owner, state => { const row = state.ledger.find(row => row.id === entry.id); if (row) row.status = entry.status; }); }
            }
            run.executions.push(entry);
            // Acknowledgement is not a fill. Reconcile before releasing reservations.
            break;
          }
        }
        await checked(owner, controller, initial.version);
        await update(owner, state => {
          if (state.version !== initial.version || !running(state, now()) || controller.signal.aborted) throw brainError("STOPPED", "The cycle was paused before results were committed.", 409);
          if (paper) { state.paper = paper; state.ledger.unshift(...run.executions); state.ledger = state.ledger.filter((row, index) => index < 200 || pendingOrder(row)); }
          if (!demo && run.mode === "paper" && !state.dryDays.includes(day(now()))) state.dryDays = [...state.dryDays, day(now())].slice(-30);
          for (const thesis of run.theses.filter(row => row.critic === "pass")) state.memories.unshift({ id: randomUUID(), symbol: thesis.symbol, text: thesis.summary, at: now().toISOString(), source: demo ? "demo" : "model_reviewed" });
          state.memories = state.memories.slice(0, 20);
        });
        event(run, "remember", "Cycle results and reservations recorded. Broker acknowledgements remain distinct from fills."); run.status = "completed";
        return run;
      } catch (error) {
        if (!admitted) throw error;
        if (run) { run.status = controller.signal.aborted ? "cancelled" : "failed"; event(run, "stopped", "Cycle stopped; no automatic order retry."); run.error = error.code?.startsWith("RH_BRAIN_") || error.code?.startsWith("TRADER_") ? error.message : "Broker or model operation failed. Check saved broker activity before retrying."; }
        else throw error;
        return run;
      } finally {
        clearTimeout(timeout);
        try { if (run) await update(owner, state => {
          const current = state.runs.find(row => row.id === runId); if (current) Object.assign(current, run, { completedAt: now().toISOString() });
          if (state.runs[0]?.id === runId && state.worker.id === instanceId
            && (!scheduled || run.status === "failed" || run.status === "cancelled")) { state.worker.enabled = false; state.consent = null; }
          for (const [key, proof] of Object.entries(state.proofs)) if (proof.runId === runId) delete state.proofs[key];
        }); } finally { jobs.delete(owner); }
      }
    },
    async reconcile(owner) {
      const state = await read(owner), snapshot = await fetchBrokerEvidence(broker, owner, state.policy, state.bindings);
      if (snapshot.account.number !== state.policy.accountNumber || !fresh(snapshot.account.observedAt, now())) throw brainError("ADAPTER", "Reconciliation needs a fresh, account-bound broker observation.", 409);
      if (!snapshot.ordersRead) throw brainError("ADAPTER", "Configure broker order-history mappings before reconciling submissions.", 409);
      await reconcileEvidence(owner, snapshot);
      const actions = (await broker.state(owner)).actions;
      await update(owner, current => { for (const row of current.ledger.filter(pendingOrder)) {
        const action = actions.find(item => item.id === row.actionId);
        if (action && ["expired", "rejected", "failed"].includes(action.status)) row.status = action.status;
      } });
      return api.state(owner);
    },
    async close() { closing = true; for (const timer of timers.values()) clearTimer(timer); timers.clear(); for (const controller of jobs.values()) controller.abort();
      while (jobs.size) await new Promise(resolve => setTimeout(resolve, 10)); },
  };
  return api;
}
