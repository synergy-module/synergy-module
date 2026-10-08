// Only known application errors cross the API boundary. Provider responses may contain secrets.
const ERRORS = {
  TRADER_PAID_AI_LOCKED: [423, "Paid AI calls are locked. Offline demos and evaluations remain available."],
  TRADER_INPUT_INVALID: [422, "Check the market context and risk settings, then try again."],
  TRADER_PROVIDER_NOT_CONFIGURED: [503, "This provider needs an API key in the server configuration."],
  TRADER_PROVIDER_ERROR: [502, "The AI provider could not complete the analysis. Try again."],
  TRADER_PROVIDER_TIMEOUT: [504, "The AI provider took too long. Try again."],
  TRADER_RUN_IN_PROGRESS: [409, "An analysis is already running for your account."],
  TRADER_OUTPUT_INVALID: [502, "The AI returned an incomplete plan. No plan was approved."],
  TRADER_BUSY: [503, "The analysis queue is busy. Try again shortly."],
  TRADER_RATE_LIMITED: [429, "Please wait a few seconds before starting another analysis."],
  TRADER_AUTH_REQUIRED: [401, "Sign in to run an analysis."],
};

export function createTraderController({ traderService, logger = console }) {
  function fail(res, error) {
    const known = Object.hasOwn(ERRORS, error?.code) ? ERRORS[error.code] : null;
    if (!known) logger.error?.("Trader request failed");
    const [status, message] = known ?? [500, "Analysis is unavailable. Try again."];
    return res.status(status).json({ error: known ? error.code : "TRADER_UNAVAILABLE", message });
  }
  return {
    async state(req, res) {
      res.set("Cache-Control", "no-store");
      try { return res.json(await traderService.getState(req.session.operator.id)); }
      catch (error) { return fail(res, error); }
    },
    async run(req, res) {
      res.set("Cache-Control", "no-store");
      try {
        const run = await traderService.run(req.session.operator.id, req.body);
        return res.status(201).json({ run });
      } catch (error) { return fail(res, error); }
    },
  };
}
