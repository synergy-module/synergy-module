import { parentPort, workerData } from "node:worker_threads";
import { validateTraderThesis, evaluateTraderRisk } from "../services/trader-service.js";

// This worker runs one reviewed handler. It never evaluates model-supplied code.
try {
  if (workerData.name !== "risk.check") throw new Error("Unknown handler");
  const thesis = validateTraderThesis(workerData.thesis);
  parentPort.postMessage({ type: "brain:risk-result", result: { risk: evaluateTraderRisk(workerData.input, thesis), verified: true } });
} catch {
  parentPort.postMessage({ type: "brain:risk-result", error: "BRAIN_TOOL_INVALID" });
}
