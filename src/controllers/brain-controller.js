import { runBrainEvaluations } from "../agent-brain/brain-evals.js";
import { buildBrainReadiness, summarizeOfflineEvaluation } from "../agent-brain/brain-readiness.js";
import { brainPage, readBrainPage } from "./brain-pagination.js";

let evaluating = false;

const ERRORS = Object.freeze({
  TRADER_PAID_AI_LOCKED: [423, "Paid AI calls are locked. Offline demos and evaluations remain available."],
  BRAIN_EVAL_BUSY: [429, "An evaluation is already running. Try again shortly."],
  BRAIN_INVALID_INPUT: [400, "Check the request fields and size, then try again."],
  BRAIN_INPUT_INVALID: [422, "Check the objective, market context, and run limits."],
  BRAIN_PRICING_REQUIRED: [422, "Configure provider pricing before using a dollar budget."],
  BRAIN_STEP_LIMIT: [422, "The run reached its step limit."],
  BRAIN_TOKEN_LIMIT: [422, "The run reached its token limit."],
  BRAIN_MODEL_CALL_LIMIT: [422, "The run reached its model call limit."],
  BRAIN_COST_LIMIT: [422, "The run reached its cost limit."],
  BRAIN_TOOL_REJECTED: [422, "A tool request was rejected by the run limits."],
  BRAIN_HANDOFF_INVALID: [422, "The run requested an invalid agent handoff."],
  BRAIN_TIME_LIMIT: [408, "The run reached its time limit."],
  BRAIN_OUTPUT_INVALID: [502, "An agent returned an incomplete response."],
  BRAIN_ACTION_INVALID: [502, "An agent returned an invalid action."],
  BRAIN_PROVIDER_ERROR: [502, "The selected provider could not complete its assigned step."],
  BRAIN_OPERATION_FAILED: [502, "The agent workflow could not complete this operation."],
  BRAIN_TOOL_OUTPUT_INVALID: [502, "A tool returned an invalid response."],
  BRAIN_AUTH_REQUIRED: [401, "Sign in to use the agent brain."],
  BRAIN_NOT_FOUND: [404, "This run is unavailable for your account."],
  BRAIN_RUN_NOT_FOUND: [404, "This run is unavailable for your account."],
  BRAIN_CONFLICT: [409, "This run changed. Refresh it before continuing."],
  BRAIN_RUN_IN_PROGRESS: [409, "A run is already active for your account."],
  BRAIN_APPROVAL_REQUIRED: [409, "This run is not ready for that decision."],
  BRAIN_DECISION_INVALID: [422, "Choose a valid decision and include the current run version."],
  BRAIN_CAPACITY: [409, "Storage is full. Remove a document or finish an active run."],
  BRAIN_CANCELLED: [409, "This run was cancelled."],
  BRAIN_BUSY: [503, "The agent queue is busy. Try again shortly."],
  BRAIN_PROVIDER_NOT_CONFIGURED: [503, "This provider needs an API key in the server configuration."],
  BRAIN_APPROVAL_RETRY: [503, "Approval could not finish. Refresh the run and try again."],
  BRAIN_RATE_LIMITED: [429, "Please wait before starting another run."],
  BRAIN_BUDGET_EXCEEDED: [422, "The run reached its configured budget."],
  BRAIN_CLOSED: [503, "The agent service is restarting. Try again shortly."],
  BRAIN_STORAGE_CONFIG: [503, "Agent storage is unavailable."],
  TRADER_INPUT_INVALID: [422, "Check the market context and risk settings."],
  TRADER_PROVIDER_NOT_CONFIGURED: [503, "This provider needs an API key in the server configuration."],
  TRADER_PROVIDER_ERROR: [502, "The AI provider could not complete the request."],
  TRADER_PROVIDER_TIMEOUT: [504, "The AI provider took too long. Try again."],
  TRADER_OUTPUT_INVALID: [502, "The AI returned an incomplete response."],
});

export function createBrainController({ brainService, brainKnowledge, brainTools, brainEvaluator = runBrainEvaluations, robinhoodService, logger = console }) {
  // Fixture results contain no operator data and apply only to this server instance.
  // A restart requires a fresh check, so stale results never imply a new build passed.
  let lastEvaluation = null;
  function fail(res, error) {
    const known = Object.hasOwn(ERRORS, error?.code) ? ERRORS[error.code] : null;
    if (!known) logger.error?.("Brain request failed");
    const [status, message] = known ?? [500, "The agent brain is unavailable. Try again."];
    return res.status(status).json({ error: known ? error.code : "BRAIN_UNAVAILABLE", message });
  }
  const handle = (operation) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return await operation(req, res, req.session.operator.id); }
    catch (error) { return fail(res, error); }
  };
  return {
    evaluations: handle(async (req, res) => {
      if (evaluating) return fail(res, { code: "BRAIN_EVAL_BUSY" });
      evaluating = true;
      try {
        const report = await brainEvaluator();
        lastEvaluation = summarizeOfflineEvaluation(report);
        return res.json(report);
      }
      catch (error) { lastEvaluation = null; throw error; }
      finally { evaluating = false; }
    }),
    state: handle(async (req, res, ownerId) => {
      const state = await brainService.getState(ownerId, { runLimit: 21 });
      const runsPage = brainPage(state.runs, "runs", 20);
      const documentsPage = brainPage(await brainKnowledge.listDocuments(ownerId, { limit: 26 }), "documents", 25);
      const { documents } = documentsPage;
      const broker = await robinhoodService?.state(ownerId);
      // Cortex needs operational switches, never credentials, account snapshots,
      // order arguments or the broker action log. Keep this projection explicit.
      const robinhoodState = broker ? {
        configured: broker.configured === true,
        connected: broker.connected === true,
        liveEnabled: broker.liveEnabled === true,
        paused: broker.paused !== false,
        storage: {
          kind: ["memory", "sqlite", "postgres"].includes(broker.storage?.kind) ? broker.storage.kind : "unknown",
          persistent: broker.storage?.persistent === true,
        },
      } : null;
      return res.json({ ...state, runs: runsPage.runs, runsNextCursor: runsPage.nextCursor,
        documents, documentsNextCursor: documentsPage.nextCursor, toolDefinitions: brainTools?.definitions("strategist") ?? [],
        robinhoodState,
        readiness: buildBrainReadiness({ state, documents, lastEvaluation, broker }) });
    }),
    runs: handle(async (req, res, ownerId) => {
      const { limit, before } = readBrainPage(req.query, "runs", 20);
      return res.json(brainPage(await brainService.listRuns(ownerId, { limit: limit + 1, before }), "runs", limit));
    }),
    getRun: handle(async (req, res, ownerId) => {
      const run = await brainService.getRun(ownerId, req.params.id);
      if (!run) return fail(res, { code: "BRAIN_NOT_FOUND" });
      return res.json({ run });
    }),
    start: handle(async (req, res, ownerId) => {
      const run = await brainService.start(ownerId, req.body);
      return res.status(202).json({ run });
    }),
    decision: handle(async (req, res, ownerId) => {
      const { version, decision, note } = req.body ?? {};
      const run = await brainService.decide(ownerId, req.params.id, { version, decision, note });
      return res.json({ run });
    }),
    cancel: handle(async (req, res, ownerId) => {
      const run = await brainService.cancel(ownerId, req.params.id);
      return res.json({ run });
    }),
    documents: handle(async (req, res, ownerId) => {
      const { limit, before } = readBrainPage(req.query, "documents", 25);
      return res.json(brainPage(await brainKnowledge.listDocuments(ownerId, { limit: limit + 1, before }), "documents", limit));
    }),
    addDocument: handle(async (req, res, ownerId) => {
      const { title, text, kind } = req.body ?? {};
      if (kind !== undefined && kind !== "knowledge") return fail(res, { code: "BRAIN_INPUT_INVALID" });
      const document = await brainKnowledge.addDocument(ownerId, { title, text, kind: "knowledge" });
      return res.status(201).json({ document });
    }),
    removeDocument: handle(async (req, res, ownerId) => {
      await brainKnowledge.removeDocument(ownerId, req.params.id);
      return res.json({ ok: true });
    }),
  };
}
