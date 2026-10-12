# Set up and forward paper trade

## First sign-in

1. Sign in with the existing Discord membership flow. New accounts open **Set up your workspace**.
2. Choose a display name and the areas you want to use.
3. Add only the connections you need. Manual crypto and international prediction-market paper accounts use public feeds and need no trading-account credentials. AI research requires a provider key and the deployment's paid-call setting. Equity research additionally needs Robinhood authorization and verified read-tool mappings.
4. Choose a theme, timezone and starting page. Review the paper/live separation and finish setup. Revisit these choices in **Settings**.

The application uses the existing workspace repository. SQLite and PostgreSQL retain these settings and virtual ledgers; a memory-only deployment displays a temporary-storage notice. A stable integration encryption key is needed for credentials and agent authorization.

## Your first virtual order

1. Open **Practice → Practice lab**. Keep **Manual paper trading** selected.
2. Name the account, choose virtual starting cash and a maximum entry amount. The default public crypto symbol is `BTCUSDT`.
3. Create the paper account, enter a virtual amount and choose **Paper buy at current ask**. The server fetches a current quote, checks cash, exposure and market depth, and includes the configured simulation costs.
4. Open the account results to see positions, fees and the virtual ledger. **Paper sell at current bid** closes a position using a newly fetched quote.
5. **Start live feed** keeps observing and valuing the account. Manual accounts do not generate automatic orders. **Pause** stops new observations; positions remain open until sold or verified as settled.

Paper balances do not fund a brokerage account. There is no switch that converts a paper account into a live one. Real account controls are in **Live trading**.

## Strategy accounts

Choose a strategy or named template, set its explained rules, select a matching current market and create a separate account. Rules are fixed for that account so subsequent edits do not change the meaning of its earlier results. Start its worker explicitly. The results show both trades and reasons for waiting.

- **Price trend baseline:** builds its moving averages from forward observations. Allow enough observations for the slow average before expecting decisions.
- **Prediction convergence and complementary pairs:** require fresh outcome books, fees, depth and the strategy's other market evidence.
- **Crypto window edge:** use the window finder to select the current Up/Down contract, asset and 5 or 15 minute window. Optional automatic progression selects the next current contract after the previous positions settle. The Binance model is labeled as a proxy. Recorded-reference mode requires your own current PolyBolt recording; it does not borrow another user's ticks.
- **Verified wallet copy:** follows new public buys of the selected outcome after a current closed-results screen. Enable whole-wallet following to consider eligible buys in other verified active markets. Each position retains its own market for pricing and settlement. History checks, simulated delay and price-chase limits apply.
- **Resting bid:** records a nonmarketable bid and requires a later public sell through its price. Unknown queue priority remains a simulation limitation.
- **Weather:** use the settlement station, timezone and Celsius bucket boundaries. Upload dated forecast/actual calibration using the CSV template. The server gathers current forecasts and ensemble data; it waits when dated comparisons or calibration are insufficient.
- **Solana:** current pool discovery and public authority/holder evidence are research inputs. Automated scalp entries require additional executable swap and deployer evidence; indicative pool prices cannot become fills.

Prediction payouts use verified provider resolution. An outcome price near zero or one is not treated as a settlement. No paper result enables real trading automatically.

## Separate existing paper workspaces

- **Prediction paper bot** (`/practice/polymarket`) retains the existing convergence portfolio and its watchlist-driven workflow.
- **Equity paper trading** (`/practice/equities`) uses current Robinhood read data and selected AI research providers with a separate $10,000 virtual account, policies, memory and orders. Its adapter cannot propose or submit a brokerage order.
- **Live workspace** (`/live`) links to real account connections and broker execution. Existing consent, approval, paid-call and deployment gates continue to apply.

Existing mixed Robinhood records are not copied into a new virtual account. Matching paper qualification can be read by the live readiness check, but paper balances, positions and orders are never transferred.

## Connect an external assistant

In **Settings → AI access**, create a named token with the permissions and lifetime you want. Copy it once into the assistant's secret storage. The page shows your API base; `/api/v1/openapi.json` describes supported operations. See [examples and permission details](platform-api.md). Initial Discord sign-in and provider consent still use their normal human authorization screens.

Workers stop with the server and must be restarted explicitly after a deployment restart. Quotes depend on source availability and may be delayed or rate-limited. Paper fills model spread, fees and depth; they do not promise that a real order would fill the same way.
