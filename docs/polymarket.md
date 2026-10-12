# Polymarket Workspace

The `/polymarket` workspace contains research, lessons, watchlists and public-wallet tracking. The existing international paper worker is on `/practice/polymarket`; the new independent forward paper accounts are on `/practice`. Public research and paper fills require no trading-account credentials. The separate `/live/polymarket` page connects a Polymarket US account for balances, positions and open orders. All use existing Discord admission, capability checks, CSRF protection and account storage.

## Connect a Polymarket US account

1. Complete identity verification in your existing Polymarket US account.
2. Open [polymarket.us/developer](https://polymarket.us/developer). Use the same sign-in method and identity as the account: if you signed up with Google, choose Google again rather than the email option.
3. Create an API key and retain its **Key ID** and **Secret Key**. The portal shows the secret once.
4. In Synergy, open **Settings → Connections → Manage Polymarket US connection**, or **Live workspace → Polymarket US** (`/live/polymarket`). Enter the two credentials and click **Connect & verify**.
5. Use **Sync account** to refresh the account snapshot. Each section shows its retrieval date. **Disconnect** removes the saved credentials and snapshots from Synergy; revoke the key in Polymarket US if you also want to invalidate it there.

The account's Google password, email session, crypto wallet keys, and any AI provider key are not required by this connector. Signing in to Google alone does not authorize Synergy: the documented Polymarket US retail integration uses developer credentials. See [official US authentication](https://docs.polymarket.us/api-reference/authentication).

The connector uses fixed read-only `GET` requests to `https://api.polymarket.us/v1/account/balances`, `/v1/portfolio/positions`, and `/v1/orders/open`, signed with Ed25519 over timestamp + method + path. Responses and execution deadlines are bounded. The projection excludes bank/withdrawal details and other unneeded fields. It retains up to 20 currency balances and the first 100 positions and open orders, labeling partial results. Fractional contracts use `netPositionDecimal`, never the deprecated rounded quantity. Portfolio failures preserve the previous dated section with a warning; successful balance access is required to verify or replace a connection.

Credentials are AES-256-GCM encrypted with owner-bound authenticated data in a separate `polymarketUs` namespace within the existing workspace repository. Set a stable `INTEGRATIONS_ENCRYPTION_KEY`; the existing stable session secret is the fallback. Persistent SQLite or PostgreSQL is required; temporary previews cannot save credentials. No new migration or package is needed. Changing the encryption key without restoring it requires replacing saved credentials. Connection state and settings responses never return credentials. Concurrent disconnects invalidate pending verification and sync results so late work cannot restore the connection.

Authenticated API: `GET /api/polymarket/us/state`. CSRF-protected commands: `POST /api/polymarket/us/connect` with `{ keyId, secretKey }`, and `POST /api/polymarket/us/sync` or `/disconnect` with `{}`. Reads of saved state do not call Polymarket; sync is explicitly requested. Responses disable caching.

This connection does not enable real orders or attach the international paper worker to your US account. Polymarket US and international Polymarket have separate authentication and market APIs. A US trading adapter and strategy/data integration remain separate implementation work. Local tests verify signing with a loopback HTTP server and persistence with SQLite; real credential verification requires the account owner's keys and is not claimed by those tests.

## Repository Assessment

Reviewed [emmanuelwestra/Polymarket-Trading-Bot](https://github.com/emmanuelwestra/Polymarket-Trading-Bot) at revision `54e80a6b6ac6551db458380e14d10b14d777ce3c` on October 12, 2026, including the market fetcher, strategy implementations, risk engine, paper fill simulator, and wallet analytics.

| Reference concept | Synergy implementation |
| --- | --- |
| Gamma market scanner | Top 100 markets by 24-hour volume, normalized binary outcomes, search and saved watchlists |
| Convergence filters | Explicit market, book freshness, price band, depth, spread, end-date, anti-chasing, sampled-flow, and fee checks |
| Wallet discovery | Monthly public leaderboard and up to five followed wallets with sampled taker activity |
| Paper execution | Fresh CLOB depth, executable price levels, minimum share size, bounded slippage, and fee costs |
| Risk management | Cash, cost exposure, open-position cap, event exposure, daily equity loss, peak-equity drawdown, pause, and operator admission |
| Dashboard and history | Native authenticated EJS workspace, server worker status, positions, and the last 50 paper fills |
| Research and learning | Separate Polymarket Second Brain with dated source references, ten retained assessments, and twenty operator lessons |

The reference did not contain a LICENSE file. No source was copied or vendored; these features are independently implemented using the published Polymarket API contracts. Its README's AI forecast description exceeds what the inspected price-factor implementation establishes. Its arbitrage logic also assumes relationships between outcomes that require independent verification. Neither is imported as a validated forecasting or arbitrage engine. Endpoint rotation to bypass limits is not used.

## Public Data

- [Gamma discovery](https://docs.polymarket.com/market-data/discover-markets): active, open, accepting-order, order-book-enabled binary markets; `clobTokenIds` for CTF and `positionIds` for protocol V2, retaining named outcome alignment.
- [CLOB order books](https://docs.polymarket.com/market-data/prices-order-books): actual bids, asks, timestamps and minimum order sizes, sorted into execution order.
- [Data API V2](https://docs.polymarket.com/migrate/data-api-v1-to-v2): `/v2/trades` and `/v2/leaderboard`, snake-case fields and the `data` envelope. The reference's old Data API is scheduled for retirement on October 24, 2026.
- [Market fee schedules](https://docs.polymarket.com/market-data/market-details#trading-fees): published rate and exponent, or an explicitly fee-free market. Unknown fees block simulation.

Requests have eight-second deadlines and bounded responses. Discovery, leaderboard and activity reads share a one-minute cache with concurrent request deduplication. Details and execution books are refreshed independently. The scanner is a volume-ranked sample, not full-market coverage; search applies to that sample. Wallet feeds contain at most 100 taker fills and are not full trading histories. Monthly leaderboard P&L includes marked equity changes and volume is **shares**, not dollars. Shared buyer activity is not proof of coordination or profitable copying.

## Second Brain

This is **rules-based research**, not an LLM forecast. Observe reads public evidence, Screen runs deterministic quality checks, Challenge records missing inputs and resolution cautions, and Remember saves the dated assessment. The percentage shown is the fraction of screening checks passed, not an outcome probability or an expected return.

Operator lessons are retrieved by matching a market ID or shared words in the question. They are stored separately from the original Brain's sources and memories. A saved report contains metadata, screening results, relevant lesson excerpts, and the exact public source URLs with retrieval times. Source evidence is untrusted content and cannot authorize orders or alter worker settings. Research is bounded to ten reports; oldest reports roll off. Lessons are bounded to twenty, with explicit deletion. There is no paid model request, wallet credential storage, or cross-account memory retrieval.

## Paper Worker

The operator explicitly starts the worker. It scans at the saved interval, even after leaving the page. With a watchlist it inspects the first six watchlist markets, including markets outside the discovery page. Otherwise it inspects six liquid markets from the discovery sample. It also refreshes all held markets, with up to four concurrent market inspections. The worker simulates up to two new entries per cycle and one position per market.

All screening checks must pass before an entry. Execution then requires book and retrieval timestamps within two minutes, verified fees, and depth within the slippage limit. The default paper balance is $10,000; entry budget is $50 including estimated fees. Related-event cost exposure is capped at 5% of initial capital. The strategy attempts full exits at a two-cent gain or three-cent decline from entry. Missing depth or unknown fees preserve the position rather than inventing an exit. Pause blocks all subsequent automatic fills, including any scan already in flight. Manual closes require pause and fresh bid depth.

The paper model reserves fee costs in cash, rather than reproducing token-denominated settlement. It does not model latency, competing takers, token redemption, settlement, partial exits, rebates, maker queue priority, or gas. Orders at market resolution require a later settlement integration; closed positions with no bid depth remain visible until they can be closed. Buy fills may be partial. Positions mark to observed executable bids; missing or stale marks keep their last dated value, so displayed equity can be stale. Daily loss uses marked equity and resets on the America/Chicago calendar day. Drawdown uses the highest recorded marked equity. This is an experimental simulation, not evidence of a profitable strategy.

Pause before editing limits or manually closing positions. A bot lease and cycle ID make simultaneous starts and late commits across application instances safe; any instance can pause it. Workers belong to the process that starts them. After an abrupt restart or deployment, their leases expire and the operator must start again; reopening the workspace does not automatically resume trading. Graceful shutdown stops timers and waits for outstanding scans before closing storage. Stale Discord admission snapshots or revoked access halt the worker. At most twenty workers are admitted per process.

## Storage And APIs

Records use the `polymarket` namespace in `user_workspaces.payload`. Existing workspace transactions provide owner isolation and serialized writes in memory, SQLite, and PostgreSQL. No schema migration or new package is required. Production uses the existing PostgreSQL workspace repository; local `src/server.js` uses the existing SQLite workspace repository. In-memory test/preview runtimes are explicitly labeled temporary when applicable. The existing 250 KB per-account payload bound still applies.

Authenticated reads: `/api/polymarket/state`, `/markets`, `/markets/:id`, `/radar` under the same `/api/polymarket` prefix.

CSRF-protected writes: `POST /research`, `POST /notes`, `DELETE /research/:id`, `DELETE /notes/:id`, `PUT /watchlist`, `PUT /radar`, `PUT /paper/settings`, `POST /paper/start`, `POST /paper/pause`, and `POST /paper/positions/:id/close` under that prefix. All API responses disable caching. Secrets from other workspace namespaces are never projected into Polymarket responses.

## Future Integration

Live execution needs a separate implementation for the selected Polymarket service, with an authenticated order lifecycle, account reconciliation, operator authorization, and settlement handling. The US connector signs read-only API requests; it exposes no live-order route. International Polymarket has no connected trading wallet or order signer in this version. Changing request fields cannot activate live trading. Full wallet performance scoring, copy trading, verified multi-leg arbitrage, independent forecasts, and SSE streaming remain future work.
