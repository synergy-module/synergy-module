import { randomUUID } from "node:crypto";
import { createPolymarketClient, decimal, validAddress, validMarketId, normalizeMarket } from "../polymarket/polymarket-client.js";
import { createSolanaEvidenceClient } from "./solana-evidence.js";
import { qualifyWalletHistory, realizedVolatility, timeWeightedAverage, twapProbability } from "./evidence.js";

const ORIGINS = Object.freeze({ binance: "https://data-api.binance.vision", polymarket: "https://data-api.polymarket.com", gamma: "https://gamma-api.polymarket.com", clob: "https://clob.polymarket.com", weather: "https://api.open-meteo.com", ensemble: "https://ensemble-api.open-meteo.com", solana: "https://api.dexscreener.com" });
const finite = value => typeof value === "number" && Number.isFinite(value);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => new Date(value).toISOString();
const fail = (message, status = 422) => Object.assign(new Error(message), { code: status === 422 ? "PRACTICE_INVALID" : "PRACTICE_DATA_UNAVAILABLE", status });
const text = (value, length = 160) => typeof value === "string" ? value.slice(0, length) : "";
const symbol = value => typeof value === "string" && /^[A-Z0-9]{5,20}$/.test(value);
const address = value => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export const practiceDataSources = Object.freeze([
  { id: "binance", label: "Crypto prices · Binance public data", quote: true, credentialsRequired: false, description: "Current spot bid/ask and closed observations for the forward probability model." },
  { id: "polymarket", label: "Prediction markets · Polymarket", quote: true, credentialsRequired: false, description: "Current outcome order books, public activity, market rules and explicit winning outcome records." },
  { id: "solana", label: "Solana pools · DEX Screener", history: false, quote: true, credentialsRequired: false, description: "Pool discovery and current indicative prices. Token authority and deployer safety checks require separately captured evidence." },
  { id: "weather", label: "Weather forecasts · Open-Meteo", history: false, quote: false, credentialsRequired: false, description: "Current model forecasts for station coordinates. Save dated forecasts and measured station error before testing a weather rule." },
]);

/** Public market reads only. Every destination and path is selected in this module. */
export function createPracticeMarketData({ fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 10000,
  polymarketClient = createPolymarketClient({ fetchImpl, now }) } = {}) {
  async function read(source, path, params = {}) {
    const url = new URL(path, ORIGINS[source]);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    try {
      const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw fail(response.status === 429 ? "This public data source is busy. Wait before refreshing." : "This public data source is unavailable. Retry later.", 503);
      const reader = response.body?.getReader();
      if (!reader) throw fail("The data source returned no response body.", 502);
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 3000000) { await reader.cancel(); throw fail("The public data response exceeded the import limit.", 502); }
        chunks.push(Buffer.from(value));
      }
      return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")), url: url.toString(), fetchedAt: now().toISOString() };
    } catch (error) {
      if (error.code?.startsWith("PRACTICE_")) throw error;
      throw fail("The public data feed could not be read. Retry later.", 503);
    }
  }
  const provenance = (source, responses, caveats = []) => ({ source, fetchedAt: now().toISOString(), sources: responses.map(response => ({ url: response.url, fetchedAt: response.fetchedAt })), caveats });
  async function resolvedQuote(market, outcomeIndex) {
    if (market.active !== false && (date(market.endDate) === null || date(market.endDate) > now().valueOf())) return null;
    if (!/^0x[\da-f]{64}$/i.test(market.conditionId ?? "")) throw fail("The market's resolution condition is unavailable.", 502);
    const outcome = market.outcomes[outcomeIndex];
    const resolution = await read("polymarket", "/v2/resolutions", { condition: market.conditionId });
    if (!Array.isArray(resolution.data?.data)) throw fail("The provider's final resolution record could not be verified.", 502);
    const rows = resolution.data.data.filter(row => row.condition_id === market.conditionId);
    if (rows.length > 1) throw fail("The provider returned conflicting resolution rows for this condition.", 502);
    if (rows.length) {
      const row = rows[0], payouts = row.payouts, resolvedAt = date(row.resolved_at);
      // The documented vector is micro-USDC PER SHARE, not a trading price or an arbitrary ratio.
      if (row.status !== "resolved" || row.extended_review === true || resolvedAt === null || resolvedAt > now().valueOf()
        || !Array.isArray(payouts) || payouts.length !== 2 || payouts.some(value => !Number.isSafeInteger(value) || value < 0 || value > 1000000)
        || payouts[0] + payouts[1] !== 1000000) return null;
      const payout = payouts[outcomeIndex] / 1000000, timestamp = resolution.fetchedAt;
      return { instrument: `POLY:${outcome.tokenId}`, timestamp, observedAt: timestamp, price: payout, bid: payout, ask: payout || Number.EPSILON, liquidity: 0,
        settlement: { payout, source: resolution.url }, signals: { marketId: market.id, conditionId: market.conditionId, endDate: market.endDate, outcome: outcome.label, resolved: true, feeRate: 0, feeExponent: 1,
          resolution: { status: row.status, resolvedAt: row.resolved_at, payoutsMicro: payouts, transaction: /^0x[\da-f]{64}$/i.test(row.transaction_hash ?? "") ? row.transaction_hash : null,
            block: Number.isSafeInteger(row.resolved_block) ? row.resolved_block : null, source: text(row.resolution_source, 30), ruleChanged: row.new_version_q === true } },
        provenance: provenance("polymarket", [resolution], ["The resolved condition supplies explicit per-outcome micro-USDC payouts. No live redemption is submitted."]) };
    }
    const response = await read("clob", `/markets/${market.conditionId}`), data = response.data;
    if (data?.condition_id !== market.conditionId || data.closed !== true || data.accepting_orders !== false || !Array.isArray(data.tokens) || data.tokens.length !== 2) return null;
    // An explicit winning token is resolution evidence. A terminal trading price is not.
    const tokens = data.tokens;
    if (tokens.some(row => typeof row.winner !== "boolean") || tokens.filter(row => row.winner).length !== 1 || data.is_50_50_outcome === true
      || market.outcomes.some(outcome => !tokens.some(row => row.token_id === outcome.tokenId && row.outcome === outcome.label))) return null;
    const token = tokens.find(row => row.token_id === outcome.tokenId), payout = token.winner ? 1 : 0, timestamp = response.fetchedAt;
    return { instrument: `POLY:${outcome.tokenId}`, timestamp, observedAt: timestamp, price: payout, bid: payout, ask: payout || Number.EPSILON, liquidity: 0,
      settlement: { payout, source: response.url }, signals: { marketId: market.id, conditionId: market.conditionId, endDate: market.endDate, outcome: outcome.label, resolved: true, feeRate: 0, feeExponent: 1 },
      provenance: provenance("polymarket", [response], ["The closed CLOB market explicitly identifies one winning token. No live redemption is submitted."]) };
  }
  const api = {
    sources: () => structuredClone(practiceDataSources),
    tokenEvidence: input => createSolanaEvidenceClient({ fetchImpl, now, timeoutMs }).inspect(input),
    async marketForOutcome({ conditionId, instrument } = {}) {
      const token = instrument?.replace(/^POLY:/, "");
      if (!/^0x[\da-f]{64}$/i.test(conditionId ?? "") || typeof token !== "string" || !/^\d{1,100}$/.test(token)) throw fail("A valid condition and outcome token are needed to follow this wallet buy.");
      const response = await read("gamma", "/markets", { condition_ids: conditionId, limit: 2 });
      if (!Array.isArray(response.data)) throw fail("The copied market metadata could not be verified.", 502);
      const markets = response.data.map(row => normalizeMarket(row, response.fetchedAt)).filter(row => row?.conditionId === conditionId && row.active && date(row.endDate) > now().valueOf());
      const market = markets.find(row => row.outcomes.some(outcome => outcome.tokenId === token));
      if (!market) throw fail("No active market matches this wallet transaction's condition and outcome.", 404);
      const outcomeIndex = market.outcomes.findIndex(row => row.tokenId === token);
      return { source: "polymarket", marketId: market.id, instrument: `POLY:${token}`, outcomeIndex, conditionId, outcome: market.outcomes[outcomeIndex].label, endDate: market.endDate, slug: market.slug };
    },
    async cryptoWindow({ asset, windowMinutes = 5, outcome = "Up" } = {}) {
      if (!["BTC", "ETH", "SOL", "XRP"].includes(asset) || ![5, 15].includes(windowMinutes) || !["Up", "Down"].includes(outcome)) throw fail("Choose an asset, a 5 or 15 minute window, and Up or Down.");
      const duration = windowMinutes * 60000, open = Math.floor(now().valueOf() / duration) * duration, end = open + duration;
      const slug = `${asset.toLowerCase()}-updown-${windowMinutes}m-${open / 1000}`, response = await read("gamma", "/markets", { slug, limit: 2 });
      if (!Array.isArray(response.data)) throw fail("The current crypto contract could not be verified.", 502);
      const market = response.data.map(row => normalizeMarket(row, response.fetchedAt)).find(row => row?.slug === slug && row.active && date(row.endDate) === end);
      const outcomeIndex = market?.outcomes.findIndex(row => row.label === outcome) ?? -1;
      if (!market || outcomeIndex < 0) throw fail("The current crypto window is not open at the provider yet. This paper account will wait.", 503);
      return { source: "polymarket", instrument: `POLY:${market.outcomes[outcomeIndex].tokenId}`, marketId: market.id, outcomeIndex, direction: outcome, asset,
        windowOpenedAt: iso(open), windowEndsAt: iso(end), slug };
    },
    async settlement({ source = "polymarket", marketId, instrument, outcomeIndex = 0 } = {}) {
      if (source !== "polymarket" || !validMarketId(marketId) || ![0, 1].includes(outcomeIndex)) throw fail("Choose a prediction market and outcome for resolution.");
      const market = await polymarketClient.market(marketId);
      if (instrument) { outcomeIndex = market.outcomes.findIndex(row => row.tokenId === instrument.replace(/^POLY:/, "")); if (outcomeIndex < 0) throw fail("The selected outcome token does not belong to this market."); }
      return resolvedQuote(market, outcomeIndex);
    },
    async cryptoModel({ asset, windowOpenedAt, windowEndsAt, referenceTicks = [] } = {}) {
      if (!["BTC", "ETH", "SOL", "XRP"].includes(asset) || !Array.isArray(referenceTicks) || referenceTicks.length > 2000) throw fail("Choose BTC, ETH, SOL or XRP and a bounded reference sample.");
      const open = date(windowOpenedAt), end = date(windowEndsAt), current = now().valueOf();
      if (open === null || end === null || ![300000, 900000].includes(end - open) || open > current || end <= current) throw fail("Choose a currently open 5 or 15 minute crypto window.");
      const marketSymbol = `${asset}USDT`;
      const [currentQuote, candles, opening] = await Promise.all([api.quote({ source: "binance", instrument: marketSymbol }),
        read("binance", "/api/v3/klines", { symbol: marketSymbol, interval: "1m", startTime: current - 35 * 60000, endTime: current, limit: 40 }),
        read("binance", "/api/v3/klines", { symbol: marketSymbol, interval: "1m", startTime: open, endTime: open + 60000, limit: 1 })]);
      if (!Array.isArray(candles.data) || !Array.isArray(opening.data) || !Array.isArray(opening.data[0]) || opening.data[0][0] !== open || !(decimal(opening.data[0][1]) > 0)) throw fail("The crypto window's opening price could not be verified.", 502);
      const observations = candles.data.filter(row => Array.isArray(row) && finite(row[6]) && row[6] <= current && decimal(row[4]) > 0).map(row => ({ price: Number(row[4]), timestamp: iso(row[6]) }));
      const volatility = realizedVolatility({ observations, asOf: now().toISOString(), intervalSeconds: 60 });
      if (!volatility.available || volatility.volatilityPerSecond <= 0) throw fail("At least 20 closed one-minute returns are needed for the crypto model.", 503);
      let spotPrice = currentQuote.price, openPrice = Number(opening.data[0][1]), modelObservedAt = currentQuote.timestamp, referenceSource = "Binance USDt proxy", openingReference = null;
      const ticks = referenceTicks.filter(row => row?.symbol === `${asset.toLowerCase()}usd` && row.channel === "price.crypto" && date(row.timestamp) !== null && date(row.timestamp) <= current && finite(row.value) && row.value > 0
        && date(row.availableAt ?? row.receivedAt) <= current && date(row.availableAt ?? row.receivedAt) !== null);
      if (referenceTicks.length) {
        const latest = [...ticks].sort((a, b) => date(a.timestamp) - date(b.timestamp)).at(-1);
        openingReference = referenceTicks.find(row => row?.symbol === `${asset.toLowerCase()}usd` && row.channel === "price.crypto.twap" && row.windowSeconds === 60
          && date(row.timestamp) === open && date(row.availableAt ?? row.receivedAt) !== null && date(row.availableAt ?? row.receivedAt) <= current && finite(row.value) && row.value > 0);
        if (!latest || current - date(latest.timestamp) > 10000 || !openingReference) throw fail("The reference recording needs the exact opening 60-second TWAP and a fresh spot observation. Start both reference channels before this window opens.", 503);
        spotPrice = latest.value; openPrice = openingReference.value; modelObservedAt = latest.timestamp; referenceSource = "Polymarket Chainlink spot and opening 60-second TWAP";
      }
      const secondsLeft = (end - current) / 1000;
      let observedMean;
      if (secondsLeft < 60) {
        if (!ticks.length) throw fail("The final TWAP window needs recorded oracle ticks; a spot-price proxy cannot complete it.", 503);
        const partial = timeWeightedAverage({ ticks, start: end - 60000, end: current, asOf: current, maxGapMs: 10000 });
        if (!partial.available) throw fail("The final TWAP window has a missing reference interval.", 503);
        observedMean = partial.value;
      }
      const fairProbability = twapProbability({ openPrice, spotPrice, volatilityPerSecond: volatility.volatilityPerSecond, secondsLeft, observedMean });
      return { asset, windowOpenedAt, windowEndsAt, fairProbability, spotPrice, openPrice, volatilityPerSecond: volatility.volatilityPerSecond, modelObservedAt,
        referenceSource, referenceIsProxy: !referenceTicks.length, openingReference, forecastModel: "Gaussian approximation of final 60-second TWAP", sourceCount: observations.length,
        caveats: [referenceTicks.length ? "The opening level is a recorded 60-second TWAP at the contract opening; final-window estimates still depend on complete subsequent spot evidence." : "Binance USDt spot is a proxy and does not reproduce the contract's Chainlink USD opening reference.", "The Gaussian probability is a model estimate, not an observed event probability."] };
    },
    async discover({ source = "polymarket", query = "" } = {}) {
      if (typeof query !== "string" || query.length > 100) throw fail("Keep your market search under 100 characters.");
      if (source === "polymarket") {
        const result = await polymarketClient.markets();
        const markets = result.markets.filter(row => !query || row.question.toLowerCase().includes(query.toLowerCase()));
        return { source, markets, fetchedAt: result.fetchedAt, sampled: true, caveats: ["Search covers the provider's current volume-ranked sample."] };
      }
      if (source === "solana") {
        const response = await read("solana", "/latest/dex/search", { q: query || "SOL" });
        if (!Array.isArray(response.data?.pairs)) throw fail("The pool search returned an unexpected format.", 502);
        return { ...provenance(source, [response]), markets: response.data.pairs.filter(row => row.chainId === "solana").slice(0, 30).map(row => ({
          instrument: `DEX:${text(row.baseToken?.address, 44)}`, address: text(row.baseToken?.address, 44), pairAddress: text(row.pairAddress, 44),
          label: `${text(row.baseToken?.symbol, 30)}/${text(row.quoteToken?.symbol, 30)}`, price: decimal(row.priceUsd), liquidity: decimal(row.liquidity?.usd), url: /^https:\/\/dexscreener\.com\//.test(row.url ?? "") ? row.url : null })) };
      }
      if (source === "binance") return { source, fetchedAt: now().toISOString(), markets: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"].filter(id => !query || id.includes(query.toUpperCase())).map(id => ({ instrument: `BINANCE:${id}`, label: id })) };
      throw fail("Choose crypto, prediction markets or Solana for discovery.");
    },
    async quote({ source, instrument, marketId, outcomeIndex = 0 } = {}) {
      if (source === "binance") {
        const id = instrument?.replace(/^BINANCE:/, ""); if (!symbol(id)) throw fail("Choose a valid crypto symbol, such as BTCUSDT.");
        const response = await read("binance", "/api/v3/ticker/bookTicker", { symbol: id }), value = response.data;
        const bid = decimal(value?.bidPrice), ask = decimal(value?.askPrice), bidQty = decimal(value?.bidQty), askQty = decimal(value?.askQty);
        if (value?.symbol !== id || !(bid > 0 && ask >= bid && bidQty >= 0 && askQty >= 0)) throw fail("The crypto quote could not be verified.", 502);
        return { instrument: `BINANCE:${id}`, timestamp: response.fetchedAt, observedAt: response.fetchedAt, price: (bid + ask) / 2, bid, ask,
          liquidity: Math.min(bid * bidQty, ask * askQty), signals: { bidSize: bidQty, askSize: askQty }, provenance: provenance(source, [response], ["Bid and ask are current best levels; the provider does not include an exchange timestamp in this response."]) };
      }
      if (source === "polymarket") {
        if (!validMarketId(marketId) || ![0, 1].includes(outcomeIndex)) throw fail("Choose a prediction market and outcome.");
        const market = await polymarketClient.market(marketId);
        if (instrument) {
          const selected = market.outcomes.findIndex(row => row.tokenId === instrument.replace(/^POLY:/, ""));
          if (selected < 0) throw fail("The selected outcome token does not belong to this market.");
          outcomeIndex = selected;
        }
        const resolution = await resolvedQuote(market, outcomeIndex);
        if (resolution) return resolution;
        const books = await Promise.all(market.outcomes.map(row => polymarketClient.book(row.tokenId)));
        const book = books[outcomeIndex], outcome = market.outcomes[outcomeIndex], bid = book.bids[0]?.price, ask = book.asks[0]?.price;
        const current = now().valueOf(), ages = books.map(row => date(row.timestamp) === null ? NaN : current - date(row.timestamp));
        if (ages.some(age => !finite(age) || age < -5000 || age > 120000) || !(bid >= 0 && ask > bid)) throw fail("Fresh, uncrossed outcome books are unavailable.", 503);
        const snapshotId = randomUUID(), timestamp = now().toISOString();
        const pair = books.map((row, i) => ({ instrument: `POLY:${market.outcomes[i].tokenId}`, timestamp, observedAt: row.timestamp, snapshotId, conditionId: market.conditionId,
          outcome: market.outcomes[i].label, price: market.outcomes[i].price, bid: row.bids[0]?.price, ask: row.asks[0]?.price,
          liquidity: row.asks[0] ? row.asks[0].price * row.asks[0].size : 0, asks: row.asks.slice(0, 5), bids: row.bids.slice(0, 5) }));
        let netFlowUsd = null, publicTrades = [];
        if (market.conditionId) {
          try {
            const activity = await polymarketClient.trades({ conditionId: market.conditionId });
            publicTrades = activity.trades.filter(row => row.tokenId === outcome.tokenId && date(row.timestamp) <= current && current - date(row.timestamp) <= 120000).slice(0, 30);
            netFlowUsd = activity.trades.filter(row => row.tokenId === outcome.tokenId && date(row.timestamp) <= current && current - date(row.timestamp) <= 3600000).reduce((sum, row) => sum + (row.side === "BUY" ? 1 : -1) * row.notional, 0);
          } catch { /* Missing flow remains unavailable; convergence must wait. */ }
        }
        return { instrument: `POLY:${outcome.tokenId}`, timestamp, observedAt: book.timestamp, price: outcome.price, bid, ask, liquidity: Math.min(ask * book.asks[0].size, bid * book.bids[0].size),
          publicTrades,
          signals: { marketId, conditionId: market.conditionId, marketSlug: market.slug, outcome: outcome.label, endDate: market.endDate, change24h: market.change24h, netFlowUsd,
            feeRate: market.fee?.rate ?? null, feeExponent: market.fee?.exponent ?? null, marketLiquidity: market.liquidity, pair, askSize: book.asks[0]?.size, bidSize: book.bids[0]?.size,
            asks: book.asks.slice(0, 10), bids: book.bids.slice(0, 10), minOrderSize: book.minOrderSize },
          provenance: { source, fetchedAt: timestamp, sources: [{ url: `https://gamma-api.polymarket.com/markets/${marketId}`, fetchedAt: market.fetchedAt },
            ...books.map(row => ({ url: `https://clob.polymarket.com/book?token_id=${row.tokenId}`, fetchedAt: row.fetchedAt }))], caveats: ["Public books and taker activity are a sample. Pair execution is simulated atomically; real simultaneous fills are not guaranteed."] } };
      }
      if (source === "solana") return api.solana({ address: instrument?.replace(/^DEX:/, "") });
      throw fail("Choose a public quote source.");
    },
    async solana({ address: mint } = {}) {
      if (!address(mint)) throw fail("Enter a valid Solana token address.");
      const response = await read("solana", `/token-pairs/v1/solana/${mint}`);
      if (!Array.isArray(response.data)) throw fail("The pool feed returned an unexpected format.", 502);
      const pool = response.data.filter(row => row.chainId === "solana" && row.baseToken?.address === mint && decimal(row.priceUsd) > 0)
        .sort((a, b) => (decimal(b.liquidity?.usd) ?? 0) - (decimal(a.liquidity?.usd) ?? 0))[0];
      if (!pool) throw fail("No priced Solana pool was found for this token.", 404);
      return { instrument: `DEX:${mint}`, timestamp: response.fetchedAt, price: Number(pool.priceUsd), bid: null, ask: null, liquidity: null,
        signals: { poolLiquidity: decimal(pool.liquidity?.usd), priceChange5m: decimal(pool.priceChange?.m5), buys5m: decimal(pool.txns?.m5?.buys), sells5m: decimal(pool.txns?.m5?.sells), poolCreatedAt: finite(pool.pairCreatedAt) ? iso(pool.pairCreatedAt) : null, marketCap: decimal(pool.marketCap), security: null },
        provenance: provenance("solana", [response], ["Pool prices are indicative, not executable quotes. Token authority, deployer and holder checks are unavailable from DEX Screener; import verified checks and execution quotes before a scalp can enter."]) };
    },
    async scanSolana({ address: mint, profile = "strict" } = {}) {
      if (!address(mint) || !["strict", "smaller-pools"].includes(profile)) throw fail("Choose a Solana token and the strict or smaller-pools screening profile.");
      const [poolResult, evidenceResult] = await Promise.allSettled([api.solana({ address: mint }), api.tokenEvidence({ address: mint })]);
      const pool = poolResult.status === "fulfilled" ? poolResult.value : null, evidence = evidenceResult.status === "fulfilled" ? evidenceResult.value : null;
      const signals = pool?.signals ?? {}, security = evidence?.security ?? {}, age = date(signals.poolCreatedAt) === null ? null : (now().valueOf() - date(signals.poolCreatedAt)) / 60000;
      const check = (id, label, value, passes, note = "") => ({ id, label, status: value == null ? "unavailable" : passes ? "pass" : "block", value: value ?? null, note });
      const liquidityMinimum = profile === "strict" ? 20000 : 15000;
      return { address: mint, profile, observedAt: now().toISOString(), executionReady: false, mode: "research-only", pool, evidence,
        checks: [check("liquidity", `Pool liquidity at least $${liquidityMinimum.toLocaleString("en-US")}`, signals.poolLiquidity, signals.poolLiquidity >= liquidityMinimum),
          check("age", "Pool age between 5 minutes and 24 hours", age, age >= 5 && age <= 1440),
          check("momentum", "5 minute price change between 2% and 30%", signals.priceChange5m, signals.priceChange5m >= 2 && signals.priceChange5m <= 30),
          check("activity", "At least 20 recent swaps and 1.2 buy/sell ratio", finite(signals.buys5m) && finite(signals.sells5m) ? signals.buys5m + signals.sells5m : null, signals.buys5m + signals.sells5m >= 20 && signals.buys5m / Math.max(1, signals.sells5m) >= 1.2),
          check("mint", "Mint authority revoked", security.mintAuthorityRevoked, security.mintAuthorityRevoked === true),
          check("freeze", "Freeze authority revoked", security.freezeAuthorityRevoked, security.freezeAuthorityRevoked === true),
          check("holders", "Full owner concentration verified below 20%", security.topHolderPercent > 20 ? security.topHolderPercent : null, false, `Sampled lower bound: ${finite(security.topHolderPercent) ? `${security.topHolderPercent}%` : "unavailable"}. Split accounts outside the sample remain unknown.`),
          check("deployer", "Creator and funder launch history checked", null, false, "Public RPC does not establish serial-deployer or bundling history."),
          check("execution", "Executable swap prices and depth available", null, false, "Pool value and indicative price cannot fill a simulated swap.")],
        messages: [poolResult.status === "rejected" ? "The public pool feed could not be read." : null, evidenceResult.status === "rejected" ? "The public Solana RPC is unavailable or rate limited; authority checks remain unknown." : null].filter(Boolean) };
    },
    async weather({ latitude, longitude, date: targetDate, station, timezone = "UTC" } = {}) {
      if (!finite(latitude) || latitude < -90 || latitude > 90 || !finite(longitude) || longitude < -180 || longitude > 180
        || typeof targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || date(targetDate) === null
        || typeof station !== "string" || !/^[A-Z0-9_-]{3,20}$/.test(station)) throw fail("Provide station coordinates, its identifier and a valid forecast date.");
      try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw fail("Choose a valid station timezone."); }
      const response = await read("weather", "/v1/forecast", { latitude, longitude, start_date: targetDate, end_date: targetDate, daily: "temperature_2m_max,temperature_2m_min", temperature_unit: "celsius", timezone, models: "gfs_seamless,ecmwf_ifs025,icon_seamless" });
      const daily = response.data?.daily;
      if (!daily || !Array.isArray(daily.time) || daily.time[0] !== targetDate) throw fail("The selected forecast date is unavailable.", 502);
      const models = ["gfs_seamless", "ecmwf_ifs025", "icon_seamless"].map(model => ({ model,
        high: decimal(daily[`temperature_2m_max_${model}`]?.[0]), low: decimal(daily[`temperature_2m_min_${model}`]?.[0]) })).filter(row => row.high !== null || row.low !== null);
      return { ...provenance("weather", [response], ["Coordinates must match the market's settlement station. A current forecast is not historical point-in-time evidence or a calibrated probability. Error measurements and prior saved forecasts are required."]), station, latitude, longitude, date: targetDate, timezone, models, observedAt: response.fetchedAt, units: "celsius" };
    },
    async weatherEnsemble({ latitude, longitude, date: targetDate, station, timezone = "UTC", metric = "high" } = {}) {
      if (!finite(latitude) || Math.abs(latitude) > 90 || !finite(longitude) || Math.abs(longitude) > 180
        || typeof targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || date(targetDate) === null
        || typeof station !== "string" || !/^[A-Z0-9_-]{3,20}$/.test(station) || !["high", "low"].includes(metric)) throw fail("Choose valid station coordinates, a weather date and high or low temperatures.");
      try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw fail("Choose a valid station timezone."); }
      const variable = metric === "high" ? "temperature_2m_max" : "temperature_2m_min";
      const response = await read("ensemble", "/v1/ensemble", { latitude, longitude, start_date: targetDate, end_date: targetDate, daily: variable, models: "ecmwf_ifs025", temperature_unit: "celsius", timezone });
      const daily = response.data?.daily;
      if (!daily || daily.time?.[0] !== targetDate) throw fail("The ensemble for this date is unavailable.", 502);
      const names = Object.keys(daily).filter(name => name === variable || new RegExp(`^${variable}_member\\d{2}$`).test(name));
      const members = names.map(name => decimal(daily[name]?.[0])).filter(finite);
      if (members.length < 10 || members.length > 100) throw fail("At least ten complete ensemble members are needed.", 503);
      return { ...provenance("ensemble", [response], ["Ensemble members are gridded model estimates, not measured settlement temperatures. Match coordinates and calibrate station bias."]), station, date: targetDate,
        metric, units: "celsius", model: "ecmwf_ifs025", observedAt: response.fetchedAt, members };
    },
    async wallet({ address: wallet } = {}) {
      if (!validAddress(wallet)) throw fail("Enter a public Polymarket wallet address.");
      const [stats, closed, trades] = await Promise.all([read("polymarket", "/v2/user-stats", { user: wallet }),
        read("polymarket", "/v2/positions", { user: wallet, status: "CLOSED", sort_by: "TIMESTAMP", sort_direction: "DESC", limit: 100 }),
        polymarketClient.trades({ address: wallet })]);
      if (!Array.isArray(closed.data?.data)) throw fail("Closed wallet positions could not be read.", 502);
      const raw = stats.data?.data, pnl = raw?.all_time_pnl, allTimePnl = decimal(pnl?.settled_pnl ?? pnl?.realized_pnl);
      const pages = [closed]; let response = closed;
      const normalized = () => pages.flatMap(page => page.data.data).filter(row => row.proxy_wallet?.toLowerCase() === wallet.toLowerCase() && row.status === "CLOSED" && decimal(row.realized_pnl) !== null)
        .map(row => { const value = row.last_event_at, timestamp = finite(value) ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value); return { pnl: Number(row.realized_pnl), timestamp }; });
      const inspect = () => qualifyWalletHistory({ allTimePnl: raw?.proxy_wallet?.toLowerCase() === wallet.toLowerCase() ? allTimePnl : null, closed: normalized(), asOf: now().toISOString() });
      let gate = inspect();
      while (gate.highFrequency && gate.observedSpanHours < 24 && response.data.pagination?.next_cursor && pages.length < 5) {
        response = await read("polymarket", "/v2/positions", { user: wallet, status: "CLOSED", sort_by: "TIMESTAMP", sort_direction: "DESC", cursor: response.data.pagination.next_cursor });
        if (!Array.isArray(response.data?.data)) throw fail("Closed wallet positions could not be read.", 502);
        pages.push(response); gate = inspect();
      }
      return { ...provenance("polymarket", [stats, ...pages], ["The gate uses reported settled/realized all-time P&L and recent closed positions. Fast-trading wallets need at least 24 hours of history; at most five pages are read.", "A screening result does not establish future profitability."]),
        address: wallet.toLowerCase(), checkedAt: now().toISOString(), ...gate, trades: trades.trades };
    },
  };
  return api;
}
