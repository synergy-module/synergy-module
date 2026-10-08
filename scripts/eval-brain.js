import { runBrainEvaluations } from "../src/agent-brain/brain-evals.js";

try {
  const result = await runBrainEvaluations();
  console.log(`Agent brain offline evaluations: ${result.passed}/${result.total} passed (${Math.round(result.durationMs)} ms)`);
  for (const scenario of result.cases) {
    console.log(`${scenario.passed ? "PASS" : "FAIL"} ${scenario.id} — ${scenario.name}`);
    if (!scenario.passed) console.log(`  ${scenario.detail}`);
  }
  process.exitCode = result.failed ? 1 : 0;
} catch {
  console.error("Agent brain offline evaluations could not complete.");
  process.exitCode = 1;
}
