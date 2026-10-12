# Robinhood Third Brain

Open `/robinhood-brain` from the sidebar or the main Brain's **Robinhood Third Brain** link. This is a separate domain workspace with its own policy, cycles, lessons, research memories, simulated portfolio, order reservations, and audit ledger. It does not use the Polymarket brain's records or merge these memories into the original research Brain.

## FriesTrader Assessment

Reviewed [YizhiSong/FriesTrader](https://github.com/YizhiSong/FriesTrader) at revision `f993bdb9546b84e1c0b66646daf757c0f5e4484c` on October 12, 2026. The repository is a Claude-oriented task template and deterministic Python scripts, not a standalone brokerage server. Its model tasks depend on a separately authenticated Robinhood MCP connection and an Agentic account. Its MIT attribution is retained in [the third-party notice](third-party/friestrader-LICENSE.txt).

| Reference pattern | Synergy implementation |
| --- | --- |
| Research separated from execution | Phase A has read-only observations, screening, cited theses and an independent critic. Phase B retrieves evidence again before risk and execution. |
| Universe and signal gates | Price, volume, capitalization, verified product type, 200-day trend, 60-day move, volume spike and 52-week proximity. Held positions remain eligible for research. |
| Deterministic entry checks | Verified regular session, current account and quotes, cash buffer, spread, entry gap, 20-day extension, earnings blackout and linked-account loss-history completeness. |
| Ranked conviction sizing | High/medium/low conviction, fewer risk flags, a fixed order budget, position percentage cap, and compounded cash reservations. |
| Risk exits before buys | Fixed stop loss, cascading 15%/30%/50% profit tiers, and dated new-fact exits. Sells are not credited as cash until filled. |
| Durable cycle and decision logs | Per-operator persistent broker metadata, ten cycle records, twenty lessons, twenty research memories, and up to 200 ledger records with unresolved orders retained. |
| Explicit live activation after dry runs | Ten distinct, verified broker-data paper days under the current policy, deployment activation switches, and an operator's account/symbol/budget consent. Demo runs do not qualify. |
| Provider-independent reasoning | Claude, Gemini, Grok and OpenAI API routing, separately selectable for research and critique. |

The Python scripts are not launched by the web server, and the repository's task prompts are not run as privileged instructions. The application ports the relevant deterministic workflow into Node.js and preserves the existing broker preview, connection identity, schema validation and single-dispatch controls. Git commits/pushes from the original task templates are replaced by the app's database transactions.

The initial engine uses fixed stops and new entries. Volatility-scaled/trailing stops, conviction trims, top-ups, external news-search automation, tax-lot classification, full trading-calendar computation, and options/crypto automation are not included. Existing manual options and crypto tools remain in Accounts. The source's example allocation percentages are not copied as recommendations; the initial policy uses a $100 maximum order budget, 5% position ceiling and 20% cash buffer.

## Providers

Users choose **Claude**, **Gemini**, **Grok**, or **ChatGPT / Codex (OpenAI API)** under **Policy & providers**. Research and critique may use different providers or the same provider in separate calls. Credentials are configured in **Settings > Connections**, encrypted per operator, and resolved at request time. Keys from another account cannot be used. Saving a key does not call or validate the provider.

Grok uses xAI's published [Responses API structured-output contract](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) at the fixed `https://api.x.ai/v1/responses` endpoint. `XAI_API_KEY` and `XAI_MODEL` are optional server settings, with `grok-4.7` as the initial default. Existing Gemini, OpenAI and Claude server model settings are preserved. Grok is also available in the shared research defaults and role routing.

ChatGPT / Codex is the user-facing OpenAI choice in this website. It uses the configured OpenAI API model and API credentials; it does not borrow the desktop Codex session, ChatGPT login, or subscription. [OpenAI's billing guide](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) explains the separate API account and billing. The application never runs a local CLI agent with brokerage privileges.

The server's `TRADER_PAID_AI_ENABLED` switch applies to all four providers, including personal saved keys. It stays false by default. A broker cycle issues at most two model requests: a batch research call and an independent critique, with validated structured output, bounded output tokens and an overall three-minute cycle deadline. Missing/invalid citations or critic results stop the cycle. Provider failures are not automatically retried within a cycle. Usage is reported as returned by the provider; missing usage is not invented. There is no dollar-budget guarantee for this two-call engine.

## Execution Modes

- **Offline demo:** uses the `DEMO` symbol and explicitly synthetic observations. It does not call a model or broker, change the live portfolio, initialize the broker-data paper portfolio, or count toward readiness. Its memories are excluded from later real-data research.
- **Paper:** research uses connected broker observations and the selected paid providers. Phase B simulates fills at verified bid/ask limit prices in an independent virtual portfolio. No broker order is submitted.
- **Per-order review:** the worker prepares a broker preview and a saved request. The operator approves each request in Accounts. Previewing does not authorize a trade.
- **Autonomous live:** the worker can dispatch a long-equity limit order after its risk plan and the real broker preview pass, under an explicit stored operator policy. There is no per-order confirmation in this mode.

For autonomous mode all of these are required:

1. A connected, funded Robinhood Agentic account, with the selected account number verified in fresh account data.
2. Verified response mappings, including the broker preview's explicit approval, warnings and estimated cost.
3. Configured research/critic providers and paid AI enabled by the deployment.
4. `ROBINHOOD_LIVE_TRADING_ENABLED=true` and `ROBINHOOD_AUTONOMOUS_TRADING_ENABLED=true`, plus unpaused broker submissions in Accounts.
5. At least ten distinct dates of successful broker-data paper cycles under the current policy version.
6. The operator selects Autonomous live and accepts the displayed account, symbol allowlist and maximum budget authorization before starting.

Models cannot activate these switches, alter the policy, accept consent, or call the submission endpoint. Policy saves revoke consent, invalidate mapping verification, and reset dry-run dates. Saves are blocked during active work or unresolved reservations. A policy authorization proof is checked inside the broker's atomic submission claim and again just before dispatch, including the exact order arguments, source, run, policy version, quote/account freshness, and current worker lease.

Automatic order construction is deliberately narrow: recognized account, symbol, side, share quantity, limit price, limit order type and day time-in-force fields in the authenticated tool schema. Unknown required fields, unsupported enums or missing contract fields require an adapter change. The app never guesses a broker schema or treats a fixture as the production contract.

## Broker Evidence Mappings

The official tools publish their input schemas only after authentication. Financial output structures can differ across tools, so the Policy editor saves verified JSON-pointer mappings against actual responses. **Sync tool schemas** retrieves the current authenticated contracts; **Verify broker evidence** reads the saved bindings and displays their normalized result. This requires operator setup against the real account; the defaults intentionally contain no fabricated bindings.

Each binding has `kind`, `tool`, `arguments`, `root`, and `fields`. Supported kinds are `account`, `positions`, `markets`, `orders`, and `preview`. `root` and field paths are JSON pointers relative to the broker's structured result, excluding the MCP envelope. `{account}` and `{symbols}` substitute the policy's account and symbol list into read arguments. Holdings are read before market requests, and held symbols are included. An array field may use `{ "path": "/actual-array", "column": "/actual-field" }` to select a numeric column from real rows.

The normalized contract is:

| Kind | Fields |
| --- | --- |
| Account | `number`, `cash`, `equity`, `dailyPnl`, `weeklyPnl`, `isAgentic`, `observedAt`, `marketOpen`, `ordersClear` |
| Positions | `symbol`, `quantity`, `averageCost`, `value`, `openedAt`, `holdingId` |
| Markets | `symbol`, `bid`, `ask`, `quoteAt`, `tradable`, `isLeveraged`, `isInverse`, `avgVolume`, `marketCap`, `closes`, `volume`, `high52`, `low52`, `earningsDays`, `earningsKnown`, `lossSaleDays`, `lossHistoryComplete` |
| Orders | `requestId`, `status`, `filledQuantity`, `averagePrice`, `symbol`, `side`, `number` |
| Preview | `valid`, `warnings`, `cost` |

Use actual documented response fields and confirm their meanings, units, account coverage, completeness and observation times. Do not point fields to unrelated data to manufacture passing checks. In particular, linked-account tax history cannot be replaced with a single-account number, receipt time cannot replace quote observation time, and absence of an earnings result does not establish a clear calendar. The mappings cannot create constants or run arbitrary code. If the current broker responses do not expose a necessary fact, that fact needs a reviewed derivation/adapter implementation; execution stays blocked until then.

Account and quote observations must be at most ninety seconds old, with bounded future-clock tolerance. Type, timestamp, account, symbol, and mathematical checks run before execution. Unknown tax history or earnings status blocks buys; missing data does not override stops or create prices. Held positions without a fresh executable quote halt new entries and preserve their existing shares for manual review.

Autonomous preview verification requires explicit `valid: true`, an empty warnings array, and a numeric buy cost within order/position/cash budgets. Unknown preview output or any warning stops automatic submission and leaves the prepared request visible in Accounts.

## Orders, Pause And Reconciliation

At most one broker order is prepared or submitted per cycle. A preview/acknowledgement creates a reservation; it never creates a filled position. Further cycles stop while a reservation remains unresolved. No expected sale proceeds are used to fund a buy. The broker's own schema, connection identity, expiry, paused state and unresolved-request checks remain in force.

**Pause immediately** aborts research, clears the worker's standing consent and stops later automatic actions, including a cycle currently waiting on a model or data. It cannot recall an already dispatched request or cancel a working order. Accounts retains its separate broker pause and order-management controls.

**Reconcile orders** retrieves real order history through verified mappings. A matching account, request ID, symbol, side, full filled quantity and average fill price confirms a fill. A zero-fill cancellation/rejection clears a reservation. Verified evidence can resolve a previously unknown agentic action in the broker store. Unmatched orders and partial fills remain reserved for review. The app does not replay a request after timeout, reconnect or restart, or clear uncertainty merely because a retry might succeed.

Workers run at the configured interval while the server is online, with per-process admission bounds, per-owner cycle claims, stored leases and rechecks of Discord admission. Closed/unverified sessions skip scheduled model work. A failed or cancelled cycle stops its worker. A deployment/restart does not silently restore standing execution; after lease expiry the worker appears paused, and the operator can pause a stale lease and start again explicitly. The scheduler is an application timer, not a separate cloud scheduling service.

## Limits And Verification

The paper model uses displayed bid/ask quotes, without order-book depth, latency, execution competition, commissions, regulatory fees, corporate actions, dividend adjustments or partial-fill simulation. Its initial cash is taken from the verified account when the broker-data virtual portfolio is first initialized; holdings are independent. Stop-loss orders are attempted on a scheduled cycle, not continuously working exchange stops. The fixed loss gates use available marked P&L divided by current equity. These limitations mean paper outcomes are not proof of live execution performance or profitability.

Authenticated Robinhood connection, actual response compatibility, real provider calls and real-money submission were not tested in this development task. The current custom-host callback approval issue described in [Robinhood setup](robinhood.md) still applies until a successful connection establishes otherwise. Robinhood's [current external-agent guidance](https://robinhood.com/us/en/support/articles/agentic-trading-overview/) confirms that external agents can trade only in the dedicated Agentic account and that other/custom hosted platforms may need Support.

Automated fixtures cover both phases, provider routing, owner isolation, persistence, deterministic gates, cascading profit tiers, cancellation, consent revocation, single dispatch, uncertain outcomes and verified reconciliation. Browser QA covers four-provider selection, retained routing, the offline demonstration, memory persistence, setup locks, fragment navigation and desktop/mobile layout. Production PostgreSQL verification remains opt-in through `TEST_DATABASE_URL`.

Brain records live in the existing broker workspace's `agentic` metadata. SQLite and both legacy/normalized PostgreSQL repository modes retain this metadata under the existing three-megabyte workspace bound. No new migration is required. Credentials remain in the original encrypted broker/provider stores and are not exposed by the third brain's state API.
