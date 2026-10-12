# Synergy Poly assessment and forward paper integration

Reference reviewed: [`synergy-module/synergy-poly`](https://github.com/synergy-module/synergy-poly), commit `da677e1c7b9efcaecb91f1b6ca60e24eec49f9b2`, on October 12, 2026. The reference checkout is separate from this application. Its executable desk code is Python; this application remains Node/Express. No Python, private trade ledgers, operator chats, scratch repositories, credentials, or process supervisors were copied into the web application. There is no top-level license in the inspected reference; the JavaScript implementations are independent implementations of the described rules.

The requested product is **forward paper trading against current markets**, with simulated money and a separate live account area. Historical observations in the evidence helpers support volatility estimates and forecast calibration. They do not constitute a historical replay product or a profitability claim.

## Capability comparison

| Capability | Reference implementation | Before this change | New application implementation |
| --- | --- | --- | --- |
| Independent paper accounts | `polymarket_pair_bot/books.py`, individual strategy folders | One convergence paper portfolio in `src/polymarket/polymarket-service.js` | Practice service owns separate accounts, cash, positions, ledgers and frozen strategy options. No live broker adapter is provided to strategy evaluators. |
| Crypto direction | `polymarket_pair_bot/strategies/antsaslyku_15m.py`, `models.py` | Not present | `crypto-directional` checks current model probability, fees, timing, asset and ask band. Additional entries enforce spacing/fill counts; opposite hedges are bounded by held quantity. Optional advance discovers the next current contract after old positions are gone. |
| Two outcome pair | `strategies/xmoney_5m.py` and `xmoney_15m.py` | Not present | `paired-outcomes` requires one condition and snapshot, checks both asks/depth and combined fees, and proposes an atomic equal-share pair. |
| Passive maker | `strategies/maker_099.py` and variants | Not present | `maker-resting` requires an earlier nonmarketable bid and a later public sell strictly through it; fill quantity cannot exceed the observed trade. Queue priority remains unknown. |
| Wallet qualification and copying | `copy_trade/gate.py`, `engine.py`, `rpc_watch.py` | Public wallet watchlist and radar only | `wallet-copy` requires positive dated results, enough closed positions, delayed execution, price and expiry limits. Fast wallets need a full day of closed results. Optional whole-wallet mode chooses a new eligible public buy across verified markets while old positions retain their market identity. |
| Solana market discovery | `rug_scanner/scan.py`, `helius_checks.py` | Not present | DEX Screener discovery/current pool evidence and public Solana RPC authority/holder inspection, with explicit pass/block/unavailable checks. A pure scalp rule exists, but automatic execution is unavailable without verified swap prices and deployer evidence. |
| Weather lab | `weather_lab/lab.py`, `b96.py`, `b104.py`, `sameday.py` | Not present | Current Open-Meteo multi-model forecasts and 51-member ECMWF ensemble, dated station/lead calibration CSV, bias-corrected blending, and day-ahead, same-day and resting-bid rule variants. The worker records dated forecasts and resting-bid evidence. |
| Oracle/reference recording | `polymarket_pair_bot/models.py`, `chainlink_recorder` | Not present | Authenticated current PolyBolt spot/TWAP recorder with bounded duration/buffer, exact decimal retention, sequence-gap detection and per-owner persistence callback. |
| TWAP and probability evidence | `polymarket_pair_bot/models.py` | Not present | `evidence.js` computes covered historical TWAP, closed-return volatility and a final-window probability estimate using only observations available at the cutoff. |
| Strategy variants | Individual frozen experiment files | One fixed convergence rule | A catalog of bounded configuration fields and named current presets. A changed rule belongs in a separate paper account. Archived experiments and their claimed performance are not imported. |
| Sizing models | Five account models A–E in `books.py` | Fixed dollar convergence size | Fixed 1%, fixed 2%, half Kelly, quarter Kelly and fixed dollar sizing helpers; every account still obeys its own exposure/cash/risk limits. |
| QA and promotion review | `qa/run_checks.py`, `governance.py`, `MONEY.md` | Equity/cash and a few risk gates | Grouped completed/settled results, taint exclusions, drawdown and cash checks, 20/40/100/200-trade review milestones, and a separate paper-size promotion check. Results never switch on live trading. |
| Human operation | Shell scripts, pidfiles and JSON files | Existing single paper worker buttons | Authenticated web controls and the shared platform API. Starting/stopping a paper worker is an explicit per-account operation. |
| Outcome settlement | Resolution polling and per-book payout ledgers | No independent strategy lifecycle | Current resolution-state endpoint supplies explicit micro-USDC payouts for the matching resolved condition, including fractional outcomes. Both held outcomes settle independently. Legacy CLOB winning-token evidence is used only when the current endpoint has no matching row. |

## Source-specific behavior and limits

`src/practice/strategies.js` exports the catalog, field descriptions, validated presets and pure decisions. A decision may request a buy, close or hold. There are no network clients, user secrets or broker submission methods inside this module. The practice service executes the proposal only after its own cash, depth, fee, exposure and drawdown checks.

Pair orders require equal **shares**, not equal dollar amounts. Their legs include a common condition, source snapshot and group. Both legs must pass execution limits before either is recorded. A crypto hedge references an existing lean position and cannot exceed its unhedged quantity. Repeated wallet transactions and maker evidence identifiers must be consumed only once per account.

Model-driven rules deliberately wait when evidence is missing. A market quote is not a fair-value forecast, a wallet leaderboard is not a complete closed-trade record, a current weather forecast is not a calibrated historical forecast, and DEX Screener liquidity is not an executable order book. These missing values are represented as unavailable. The application does not substitute favorable readings.

The source reference has many historical experiments with operator-specific caps and claims. The application provides configurable families and named presets, rather than asserting that its rules and execution reproduce every historical experiment exactly. Each preset requires a new forward sample. The original reference's realized results and personal approvals do not transfer to another user.

## Current data contracts

`createPracticeMarketData()` in `src/practice/market-data.js` provides the following bounded reads:

| Method | Required inputs | Result |
| --- | --- | --- |
| `discover` | `source`, optional `query` | Current prediction-market, crypto or Solana pool choices |
| `quote` | `source`, `instrument`; Polymarket additionally needs `marketId` and optional `outcomeIndex` | Current prices, available depth, source time and structured evidence |
| `cryptoModel` | `asset`, `windowOpenedAt`, `windowEndsAt` | Fresh proxy probability estimate with dated inputs; the public API rejects caller-supplied reference ticks |
| `cryptoWindow` | `asset`, `windowMinutes` (5 or 15), `outcome` (Up or Down) | Exact current active provider contract, IDs, opening and end |
| `wallet` | Public `address` | Recent public buys and a dated wallet performance gate |
| `weather` | `latitude`, `longitude`, `date`, `station`, optional `timezone` | Current station-coordinate forecasts from GFS, ECMWF and ICON |
| `weatherEnsemble` | Weather inputs above, optional `metric` (high or low) | Dated daily temperature members from the ECMWF ensemble |
| `solana` | Token `address` | Current pool observation; no fabricated executable quote |
| `tokenEvidence` | Token mint `address` | Public mint/freeze authority and sampled holder concentration checks |
| `scanSolana` | Token mint `address`, optional `profile` (strict or smaller-pools) | Combined pool/authority screen with explicit unavailable checks and `executionReady: false` |

Use JSON POST requests where numeric inputs are needed. Public data is requested only from fixed provider origins with bounded response sizes, deadlines and disabled redirects. Credentials are never required for these public methods. Source snapshots record retrieval times and limitations.

`quote.liquidity` is **available dollar depth at the supplied execution levels**. Total prediction market/pool liquidity is stored separately in `signals.marketLiquidity`/`signals.poolLiquidity`. A large pool must not turn into an unlimited simulated fill. The Polymarket adapter retains both book observation time and retrieval time.

The `cryptoModel` method derives volatility from closed one-minute returns. Without oracle recordings it labels its Binance USDt price as a proxy. That proxy is not the contract's Chainlink USD reference, and the final 60-second window refuses to proceed without covered oracle observations. Recorded mode obtains samples only from the signed-in owner's recorder, requires the exact opening 60-second TWAP plus fresh spot prices, and preserves that opening sample within the paper account. Supplied timestamps cannot masquerade as owner recordings through the public model API.

`forward-quotes.js` gathers supporting model/wallet/weather evidence before fetching the execution quote. The execution timestamp must be at or after evidence availability; stale books remain unavailable. It matches the asset, opening, duration and market end against the provider's exact crypto slug. The optional `feed.autoAdvance` setting selects another current contract only after no old positions remain and preserves the selected asset, duration and Up/Down direction. Virtual funds and strategy rules remain in the same account.

Prediction settlement uses the documented `/v2/resolutions?condition=...` record. It requires the exact condition, `status: resolved`, a past resolution time, no active extended review, and two nonnegative integer micro-USDC payouts totaling 1,000,000. Each payout is divided by 1,000,000; an explicit 500,000/500,000 record settles both outcomes at $0.50. Missing, future, disputed or malformed records remain pending. If the endpoint has no matching row, the compatibility path requires a closed CLOB market, disabled orders, matching condition/token labels, and exactly one explicit winning token. Settlement observations have zero executable depth and are used for payout accounting, not market orders. Live verification found legacy CLOB metadata lagging a resolved market, which is why the current resolution endpoint is primary.

Whole-wallet following is opt-in through `feed.followAllMarkets`. It screens the wallet first, considers at most five newest eligible unconsumed buys per cycle, excludes already-held instruments, and resolves condition plus token identity through a fixed Gamma lookup. Current quote identity, price chase, expiration and variant exclusions must pass. Old positions keep their own market IDs for marking and settlement even as the selected market changes. This follows a public polling sample; it does not promise to copy every trade.

Public Solana RPC does not establish the creator's launch history or whether a wallet is a serial deployer. Its largest-account sample can underestimate a split wallet's concentration. Those fields remain unavailable until independently recorded evidence is supplied. Token-2022 extension behavior, launch bundling, full creator/funder history and paid Helius/Birdeye pipelines require additional provider integration; the current adapter does not claim those checks have passed.

## Reference price recording

The reference repository uses the former public RTDS endpoint. Current official documentation has moved reference-price channels to **PolyBolt with authentication**. This application uses `wss://ws-live-v2.polymarket.com/ws`, authenticates before subscribing, and only sends `auth`/`subscribe` frames. International CLOB API key, secret and passphrase are distinct from the Polymarket US account credentials.

`createReferenceRecorder({ onSamples })` creates one recorder for one owner. `start` accepts supported USD symbols, the spot/TWAP channels and a duration of 10–3,600 seconds. `status` and `snapshot` never return credentials. `onSamples` receives dated evidence for owner-scoped storage; its failure stops recording. `stop`/`close` cancel timers and the connection. The recorder also stops on oversized frames, dropped events or a sequence gap. A server drain allows one bounded reconnect. It never attempts to derive credentials from a signing key or submit an order.

Server snapshots of historical reference ticks retain their actual receipt time in `availableAt`. A timestamp from an earlier market window is not evidence that this application had the tick at that earlier time.

## Calibration and research review

Weather calibration records use `station`, `model`, `targetAt`, `issuedAt`, `availableAt`, `predicted`, `actual` and `actualObservedAt`. Only forecasts available before the configured lead and actuals observed before the assessment cutoff count. Targets are deduplicated. Station/model/lead calibration must have at least seven observations before blending. Current forecasts from up to four calibrated models are bias-corrected and weighted by measured error.

The account builder accepts a CSV with those columns and 7–200 rows. The file is frozen with the account's station and rule settings; values are user-supplied measurements, not independently verified station history. Temperatures and half-open bucket bounds are Celsius. The worker saves an initial forecast and compares later reads, retaining the baseline for at least 30 minutes. Ensemble makers require seven matching ECMWF calibration rows, apply the measured bias to current ECMWF members, store a genuinely nonmarketable paper bid, and require a later matching public sell through it. Same-day rules require same-day calibration; day-ahead rules require a 24/48 hour calibration lead. The selected No outcome uses the complement of the bucket probability.

## Remaining capability boundaries

- Solana is a research scanner. Creator/funder history, bundle detection, full owner concentration and executable swap quotes are not implemented, so its scalp presets are not offered as ready automatic trading.
- Source-specific frozen experiments, old ledgers and reported profits are not reproduced. Configurable family rules need a new forward sample in this app.
- Public polling observes a sample, not every exchange event. Passive fills model later trade-through evidence and disclose that queue priority is unknown.
- Oracle recordings have bounded leases and buffers. The user must run the relevant recording for recorded-reference strategies; missing intervals cannot be reconstructed as if they were observed.

Readiness operates on complete trade groups. A two-leg pair counts as one result. Open groups and tainted records are excluded. Prediction groups require actual settlement entries; a manually closed position is reported as a close and does not become an oracle settlement. Spot strategies use completed exits. Fees are already included in ledger P&L and are not deducted twice.

The research milestones retain the source's intent: collect before changing rules, review an unsuccessful first 40 settled trades, require at least 100 before describing an edge candidate, and evaluate 200 clean outcomes over at least 48 hours before a live-readiness discussion. No readiness calculation changes the app's execution permissions. A missing current QA record or measured break-even result remains an unmet check.

## Verification

Automated tests cover model inputs from the future, missing forecast/holder evidence, completed-candle selection, atomic pair evidence, equal-share sizing directives, accumulation spacing, bounded hedges, maker trade-through proof, complete-group reporting, TWAP gaps, point-in-time weather calibration, public-origin restrictions, recorder authentication ordering, credential redaction, sequence gaps and recording expiry.

Public read smoke checks were performed for a Binance crypto quote, a 100-market Polymarket discovery sample, an exact current BTC five-minute contract and executable book, three Open-Meteo models for EGLC, a 51-member ECMWF daily ensemble, a public wallet's current screening/trades, and both explicit payout sides of a resolved BTC market. Worker tests run current crypto, wallet, maker, calibrated forecast and ensemble-maker decisions through real paper accounting, then verify pause and settlement. Tests of authenticated PolyBolt use protocol fixtures; no live user CLOB credentials were used. Public Solana parsing uses RPC response fixtures. No real order or paid AI call was made.

## Provider documentation

- [Polymarket real-time data and current authentication](https://docs.polymarket.com/market-data/realtime-data)
- [RTDS to PolyBolt migration](https://docs.polymarket.com/migrate/rtds-to-polybolt)
- [Polymarket Data API V2 contract](https://data-api.polymarket.com/v2/docs)
- [Binance public market data endpoints](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market)
- [Open-Meteo forecast API](https://open-meteo.com/en/docs)
- [Open-Meteo ensemble API](https://open-meteo.com/en/docs/ensemble-api)
- [Open-Meteo historical forecast distinctions](https://open-meteo.com/en/docs/historical-forecast-api)
- [Polymarket resolution and opening TWAP definition](https://docs.polymarket.com/concepts/resolution)
- [Polymarket resolution-state endpoint and explicit payouts](https://docs.polymarket.com/api-reference/markets/get-resolution-state)
- [DEX Screener API](https://docs.dexscreener.com/api/reference)
- [Solana RPC methods](https://solana.com/docs/rpc/http)
