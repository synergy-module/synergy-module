# Agent Brain

Open `/brain` from the terminal sidebar. The brain connects a planner, researcher, strategist and critic to the existing trader's provider adapters, risk engine, calendar and journal. Gemini is the default. Each role can route to Gemini, OpenAI or Claude independently.

The control panel opens on an interactive network view inspired by the supplied AI operating-system reference. Select agents, tools, sources or saved missions to inspect their actual configuration and recorded activity. Filters, zoom, view reset and motion controls affect only the visualization. The glowing connections illustrate the application's architecture; they do not expose model weights or claim a neuron count. Mission, Knowledge and Checks tabs retain the run composer, approval workflow, source library, readiness checklist and offline evaluations. The Robinhood tab adds brokerage connection, dated research, previews, separate action review, and audit history for stocks, options, and crypto; see [Robinhood setup and limits](robinhood.md).

The network continuously animates locally while visible, including between missions: Matrix-style glyph streams, traveling synapse pulses, a rotating core and terminal scan effects. Its motion does not start missions or provider requests. Pause freezes the scene; reduced-motion preferences start it paused, and hidden views stop rendering. Expand **How the brain works** below the network for the mission-to-review flow. Recorded mission activity remains separate from the decorative animation.

## Implemented capabilities

| Capability | Working implementation |
| --- | --- |
| ReAct loop | `brain-service.js` repeatedly obtains a validated action, executes a permitted tool, records its observation, and chooses the next action. Tool failures become observations for corrective actions within the remaining budget. |
| Tool calling | `brain-tools.js` exposes typed context, knowledge, memory, journal, calendar, and risk tools, plus `robinhood.tools`, `robinhood.read`, and strategist-only `robinhood.propose`. The model returns a structured envelope; the server dispatches permitted tools. Models cannot approve broker actions. |
| Planning and decomposition | The planner creates a validated three-task dependency graph for research, strategy and critique. Invalid or cyclic plans stop before execution. |
| Reflection and self critique | The separate critic receives the proposal and sources, returns pass/revise/wait, and can request one revision followed by another risk check and critique. |
| Structured outputs | Provider JSON schemas and server validation cover plans, action envelopes, tool arguments, theses and critiques. Invalid output fails closed. |
| Context compaction | `brain-context.js` bounds each run's working context, extracts short summaries from older observations, and retains the objective, risk constraints and citation IDs. Truncation is explicit. |
| Agentic RAG | Agents choose search queries and may refine them. `brain-knowledge.js` chunks documents and ranks lexical matches with BM25-style scoring. Each returned excerpt has a stable citation. |
| Memory persistence | SQLite locally and PostgreSQL when configured store runs, traces, documents, approval checkpoints and caches. Accepted proposals become idempotent memory records. |
| Prompt caching | The gateway supplies stable provider prefix hints, Claude ephemeral cache control, and Gemini's implicit caching structure. It separately supports an owner-scoped exact-response cache with a maximum 60-second TTL. Actual cache usage is reported when the provider supplies it. |
| Tool sandbox | The capability boundary denies unknown tools, role violations, extra arguments and owner overrides. Time and output bounds apply. Risk checking runs in a separate worker with memory limits and termination. No model-generated code is evaluated. |
| Multi-agent system | Four role-specific agents have separate working histories, shared cited evidence, assigned tasks and individual provider routes. Execution is sequential within a mission. |
| Routing and handoffs | Research and strategy can hand off work using validated target roles. Handoffs and provider selection are recorded; repeated handoffs are bounded. |
| Workflow graphs | The persisted dependency graph records task status and edges; the control panel renders it as the mission progresses. |
| Guardrails and verification | Source IDs must have been observed; snapshot and calendar context are required. Missing/stale/incomplete context gates the proposal. Exact decimal risk sizing and whole-unit limits are authoritative. |
| Agent evals | `npm run eval:brain` and the control panel execute isolated deterministic scenarios against real components, including the runtime and tools. No paid model calls are made. |
| Human in the loop | Runs pause for approve/reject with the displayed version and a hash of the proposal. Acceptance saves research memory. Retried approval cannot duplicate it. |
| Tracing and observability | Durable timestamped traces capture plans, action summaries, tool calls/results, handoffs, critiques, compaction, budget events and human decisions. The UI shows usage, latency and cost availability. Private chain-of-thought is never requested. |
| Cost and latency control | Before each provider request the runtime reserves conservative input/output tokens and, when configured, cost. Calls, steps, tokens, duration, handoffs, revisions and concurrent work are bounded; cancellation aborts requests. |

## Build and verify offline

Paid model requests are disabled by default. Keep `TRADER_PAID_AI_ENABLED=false` in the server configuration. An API key alone cannot start charges: the run services, model gateway and final provider adapter enforce the lock. A direct analysis request returns `423 TRADER_PAID_AI_LOCKED`. Provider selection and request fields cannot unlock it. The lock covers Gemini, OpenAI and Claude in both `/brain` and `/trader`.

Open `/brain` and use **Run demo** and **Run offline evals**. Add strategy documents, inspect retrieval and traces, and accept or reject illustrative research. These operations do not invoke a paid model. The readiness panel reads current account records and configuration; it does not make provider or market-feed requests. Offline evaluation results apply to the current server instance and reset on restart, preventing an earlier build's results from being presented as a new verification.

The panel distinguishes working offline components from pending setup: credentials and pricing, reviewed source material, live model-quality and usage validation, live market data, and broker execution. File-backed SQLite or PostgreSQL is reported as persistent only after account records can be read. This is not a backup or production recovery certification. Passing deterministic fixtures does not establish model accuracy or trading performance.

## Run a paid mission after setup is approved

1. After setup is reviewed and paid calls are explicitly authorized, configure the desired server-side key and `TRADER_PAID_AI_ENABLED=true`, then restart. Until then, leave the flag false. Gemini uses `GEMINI_API_KEY`; alternatives use `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Keys stay on the server.
2. Open `/brain`, supply an objective and dated market context, and check instrument-specific risk parameters.
3. Optionally choose a provider per role and change the run limits. A dollar cap requires configured pricing for every routed provider.
4. Start the mission. Inspect the workflow, action trace, cited sources, missing data, thesis and deterministic risk check.
5. Accept research to save it as memory, or reject it. A WAIT result may be saved as a reviewed lesson; acceptance does not make it a tradable setup.

`Run demo` uses fictional 100/98/106 prices and scripted decisions through the actual workflow, retrieval tools, risk worker, tracing and approval logic. It makes no AI or calendar requests. Demo memories explicitly retain their illustrative provenance.

## Configuration and storage

Local startup creates `data/agent-brain.sqlite`, including its parent directory. Override with `BRAIN_DB_PATH`. The database and its sidecars are ignored by Git. Automated tests use isolated in-memory or temporary repositories.

When `DATABASE_URL` is configured, startup uses PostgreSQL. The guarded migration runner includes `migrations/002_agent_brain.sql` alongside the session/journal and Admin migrations; apply all migrations through the production migration process after a verified backup and before deploying. Readiness checks require every application table. Set `TEST_DATABASE_URL` to a disposable database to run the real PostgreSQL integration test, which verifies saved Brain, journal, Admin, and session state across fresh app runtimes without paid AI calls.

Optional pricing variables use the prefixes `BRAIN_GEMINI`, `BRAIN_OPENAI`, and `BRAIN_CLAUDE`, followed by:

- `_INPUT_USD_PER_MILLION`
- `_OUTPUT_USD_PER_MILLION`
- `_CACHED_INPUT_USD_PER_MILLION`
- `_CACHE_CREATION_INPUT_USD_PER_MILLION` (optional override)

Use the rates for your configured model and provider account. Missing prices or usage remain unknown. No fabricated dollar estimate is shown. Conservative reservations can stop a mission before the provider's actual tokenizer would exhaust the budget. A provider's unexpectedly larger reported usage stops subsequent work; it cannot undo a charge already incurred.

Defaults are 12 steps, 10 model calls, 64,000 tokens, 120 seconds and no dollar cap. Absolute request limits are 24 steps, 16 calls, 128,000 tokens, 180 seconds and $10 when a dollar cap is supplied. The runtime permits one active mission per operator and up to four in one process. Exact-response cache freshness includes all supplied context, model, schema and output limits. Changing market context invalidates that cache. Identical planning requests can reuse a cached task plan; research, strategy and critique retain fresh analysis clocks. Provider prompt caching is threshold-dependent and not guaranteed.

Storage retains up to 100 runs per owner, preserving active approval checkpoints, and 100 knowledge/memory documents per owner. Each document is limited to 50,000 characters. Removing a source excludes it from future retrieval; already recorded run citations retain their snapshot. Browser storage contains no API keys or agent memory. Authenticated responses disable HTTP caching.

Admission is atomic across repository connections: finish or reject the outstanding mission before starting another. Each running mission has an execution owner and a fixed deadline. Another server instance can inspect it without declaring it interrupted. An expired execution is marked interrupted without replaying paid requests; approval checkpoints remain reviewable after restart. A cancellation on another process prevents subsequent work and discards the pending response when that worker observes the saved change, but cannot immediately abort an already sent provider request on that remote process.

Journal retrieval checks the operator's server-side Journal capability, admission and role freshness before querying journal storage. A denied journal tool is a failed observation that the agent can report; client-supplied role or permission fields cannot grant access.

## Scope and validation

This is a bounded research agent system with a separately authorized Robinhood workspace. Brokerage reads and order previews require account connection. Live submission is disabled by default and requires a separate confirmation for every action. There is no unattended trading, live price subscription, autonomous money movement, or arbitrary-code tool. The tool sandbox is an allowlisted capability boundary and an isolated trusted risk worker; it is not an operating-system sandbox for executing hostile programs. Product-specific broker risk enforcement and uncertain-order reconciliation remain prerequisites for unattended execution; the research risk calculator does not establish options exposure or validate the broker ticket.

RAG currently uses lexical retrieval, not embeddings. Citation verification proves that a source was observed; it does not independently prove that a model's statement follows from that source. Manual market context remains unverified. The separate critique and human review address those limits without claiming model accuracy or profitable trading.

The evaluation suite verifies orchestration and controls with deterministic fixtures. Provider payloads, usage accounting and caching have mocked transport tests. Real Gemini/OpenAI/Claude end-to-end calls and model-quality evaluations require configured credentials and remain separate from these offline checks.

Useful commands:

```sh
npm test
npm run eval:brain
npm run dev
```

Provider caching references: [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching), [Claude](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Gemini](https://ai.google.dev/gemini-api/docs/caching).

The risk worker uses an explicit result-message protocol and a clean environment, so development-server dependency reports cannot be mistaken for calculation results. Worker implementation reference: [Node.js worker threads](https://nodejs.org/api/worker_threads.html).
