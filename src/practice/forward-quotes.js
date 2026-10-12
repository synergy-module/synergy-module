import { calibrateWeather, blendWeatherForecasts } from "./evidence.js";
import { weatherProbability } from "./strategies.js";

const fail = message => Object.assign(new Error(message), { code: "PRACTICE_INPUT", status: 422 });
const finite = value => typeof value === "number" && Number.isFinite(value);
const time = value => typeof value === "string" ? Date.parse(value) : NaN;
const plain = value => value && typeof value === "object" && !Array.isArray(value);

export function validateForwardFeed(feed, strategyId, config = {}) {
  if (feed == null) return;
  if (!plain(feed) || !["binance", "polymarket", "solana"].includes(feed.source) || typeof feed.instrument !== "string" || feed.instrument.length > 160 || JSON.stringify(feed).length > 80000) throw fail("Choose a supported current market feed.");
  if (strategyId === "crypto-directional") {
    if (feed.source !== "polymarket" || !["BTC", "ETH", "SOL", "XRP"].includes(feed.asset)
      || !["proxy", "recorded"].includes(feed.referenceMode ?? "proxy") || feed.autoAdvance !== undefined && typeof feed.autoAdvance !== "boolean"
      || feed.direction !== undefined && !["Up", "Down"].includes(feed.direction) || ![300000, 900000].includes(time(feed.windowEndsAt) - time(feed.windowOpenedAt))) throw fail("Choose a crypto asset, its 5 or 15 minute market window, and a reference source.");
  }
  if (strategyId === "wallet-copy" && (feed.source !== "polymarket" || !/^0x[\da-f]{40}$/i.test(feed.walletAddress ?? ""))) throw fail("Enter the public wallet to follow for this prediction outcome.");
  if (strategyId === "wallet-copy" && feed.followAllMarkets !== undefined && typeof feed.followAllMarkets !== "boolean") throw fail("Choose selected-outcome or whole-wallet following.");
  if (strategyId === "weather-forecast") {
    const w = feed.weather;
    if (feed.source !== "polymarket" || !plain(w) || !/^[A-Z0-9_-]{3,20}$/.test(w.station ?? "") || w.station !== w.settlementStation
      || !finite(w.latitude) || Math.abs(w.latitude) > 90 || !finite(w.longitude) || Math.abs(w.longitude) > 180
      || !/^\d{4}-\d{2}-\d{2}$/.test(w.date ?? "") || !finite(time(w.date)) || typeof w.timezone !== "string" || !w.timezone || w.timezone.length > 80 || !["high", "low"].includes(w.metric)
      || !(w.bucketLower === null || finite(w.bucketLower)) || !(w.bucketUpper === null || finite(w.bucketUpper))
      || w.bucketLower === null && w.bucketUpper === null || w.bucketLower !== null && w.bucketUpper !== null && w.bucketLower >= w.bucketUpper
      || !Array.isArray(w.calibrationRecords) || w.calibrationRecords.length < 7 || w.calibrationRecords.length > 200) throw fail("Weather tests need matching station details, a Celsius temperature bucket and 7 to 200 dated calibration rows.");
    try { new Intl.DateTimeFormat("en-US", { timeZone: w.timezone }); } catch { throw fail("Choose the settlement station's timezone."); }
    const calibration = calibrateWeather({ records: w.calibrationRecords, asOf: new Date().toISOString(), leadHours: w.leadHours ?? 24 });
    if (!calibration.models.some(model => model.station === w.station && model.ready)) throw fail("The CSV needs at least seven eligible prior observations for a matching station and model at this forecast lead.");
    if (config.sameDay === true ? (w.leadHours ?? 24) !== 0 : ![24, 48].includes(w.leadHours ?? 24)) throw fail("Use same-day calibration for the same-day rule, or 24/48 hour calibration for the day-ahead rule.");
    if (config.makerMode === true && !calibration.models.some(model => model.station === w.station && model.model === "ecmwf_ifs025" && model.ready)) throw fail("The ensemble maker needs at least seven dated ECMWF (ecmwf_ifs025) calibration rows for this station and lead.");
  }
}

/** Fetch supporting evidence first, then an executable quote. No caller supplied price can become a fill. */
export function createForwardQuoteReader({ marketData, referenceFeeds, now = () => new Date() }) {
  return async function forwardQuote(owner, book) {
    let feed = { ...book.feed }, state = structuredClone(book.forwardEvidence ?? {}); const signals = {};
    let wallet, forecast, ensemble, selectedValue, selectedCopy;
    if (book.strategyId === "wallet-copy") {
      wallet = await marketData.wallet({ address: feed.walletAddress });
      if (feed.followAllMarkets === true && wallet.eligible === true) {
        const candidates = wallet.trades.filter(trade => trade.side === "BUY" && time(trade.timestamp) <= now().valueOf()
          && now().valueOf() - time(trade.timestamp) >= book.config.latencyMs && now().valueOf() - time(trade.timestamp) <= book.config.maxDelaySeconds * 1000
          && trade.price >= book.config.minPrice && (!book.config.skipUp || trade.outcome !== "Up")
          && !book.consumedSignals.includes(trade.transaction) && !book.positions.some(position => position.instrument === `POLY:${trade.tokenId}`))
          .sort((a, b) => time(b.timestamp) - time(a.timestamp)).slice(0, 5);
        for (const candidate of candidates) {
          let next;
          try { next = await marketData.marketForOutcome({ conditionId: candidate.conditionId, instrument: `POLY:${candidate.tokenId}` }); }
          catch (error) { if (error.status === 404) continue; throw error; }
          if (next.instrument !== `POLY:${candidate.tokenId}` || next.conditionId !== candidate.conditionId) throw fail("The provider's copied market identity did not match the wallet transaction.");
          if (time(next.endDate) - now().valueOf() < book.config.minSecondsLeft * 1000 || book.config.skipFiveMinute && /-updown-5m-/.test(next.slug)
            || book.config.skipUp && next.outcome === "Up") continue;
          const value = await marketData.quote(next), candidateQuote = value.quote ?? value;
          if (candidateQuote.instrument !== next.instrument || candidateQuote.signals?.conditionId !== candidate.conditionId) throw fail("The copied quote does not belong to the verified wallet market.");
          if (candidateQuote.ask < book.config.minPrice || (candidateQuote.ask / candidate.price - 1) * 100 > book.config.maxChasePercent) continue;
          feed = { ...feed, ...next }; selectedValue = value; selectedCopy = candidate; break;
        }
      }
    }
    if (book.strategyId === "crypto-directional" && feed.autoAdvance === true && !book.positions.length && time(feed.windowEndsAt) <= now().valueOf()) {
      const next = await marketData.cryptoWindow({ asset: feed.asset, windowMinutes: (time(feed.windowEndsAt) - time(feed.windowOpenedAt)) / 60000, outcome: feed.direction ?? (feed.outcomeIndex === 1 ? "Down" : "Up") });
      feed = { ...feed, ...next }; state = {};
    }
    if (feed.source === "polymarket" && marketData.settlement && (book.positions?.length || time(feed.windowEndsAt) <= now().valueOf())) {
      const resolution = await marketData.settlement(feed);
      if (resolution) return { quote: resolution, forwardEvidence: state };
      if (book.strategyId === "crypto-directional" && time(feed.windowEndsAt) <= now().valueOf()) throw fail("The crypto window has ended. Waiting for the provider's final winning outcome before settling virtual positions.");
    }
    if (book.strategyId === "crypto-directional") {
      let referenceTicks = [];
      if (feed.referenceMode === "recorded") {
        if (!referenceFeeds?.snapshot) throw fail("Connect and start your reference recorder in Market data before using recorded prices.");
        referenceTicks = (await referenceFeeds.snapshot(owner, { symbol: `${feed.asset.toLowerCase()}usd`, limit: 1000 })).samples;
        if (state.cryptoOpening && time(state.cryptoOpening.timestamp) === time(feed.windowOpenedAt)) referenceTicks = [...referenceTicks, state.cryptoOpening];
        if (!referenceTicks?.length) throw fail("Record reference prices before the crypto window opens. This account requires recorded evidence.");
      }
      Object.assign(signals, await marketData.cryptoModel({ asset: feed.asset, windowOpenedAt: feed.windowOpenedAt, windowEndsAt: feed.windowEndsAt, referenceTicks }));
      if (signals.openingReference) state.cryptoOpening = signals.openingReference;
      signals.windowMinutes = (time(feed.windowEndsAt) - time(feed.windowOpenedAt)) / 60000;
    }
    if (book.strategyId === "weather-forecast") {
      const w = feed.weather;
      forecast = await marketData.weather({ latitude: w.latitude, longitude: w.longitude, date: w.date, station: w.station, timezone: w.timezone });
      if (book.config.makerMode) ensemble = await marketData.weatherEnsemble({ latitude: w.latitude, longitude: w.longitude, date: w.date, station: w.station, timezone: w.timezone, metric: w.metric });
    }
    const value = selectedValue ?? await marketData.quote(feed), quote = value.quote ?? value, clock = time(quote.timestamp);
    quote.signals = { ...quote.signals, ...signals };
    if (book.strategyId === "crypto-directional") {
      if (!["Up", "Down"].includes(quote.signals.outcome) || time(quote.signals.endDate) !== time(feed.windowEndsAt)) throw fail("The chosen outcome must be Up or Down and its provider end time must match this crypto window.");
      const match = /^(btc|eth|sol|xrp)-updown-(5|15)m-(\d{10})$/.exec(quote.signals.marketSlug ?? "");
      if (!match || match[1].toUpperCase() !== feed.asset || Number(match[3]) * 1000 !== time(feed.windowOpenedAt)
        || Number(match[2]) * 60000 !== time(feed.windowEndsAt) - time(feed.windowOpenedAt)) throw fail("The asset and window must match the provider's identified 5 or 15 minute crypto contract.");
      feed.direction = quote.signals.outcome;
    }
    if (wallet) {
      const token = quote.instrument.replace(/^POLY:/, ""), latest = selectedCopy ?? wallet.trades.filter(trade => trade.tokenId === token && trade.side === "BUY" && time(trade.timestamp) <= clock
        && clock - time(trade.timestamp) >= book.config.latencyMs && !book.consumedSignals.includes(trade.transaction)).sort((a, b) => time(b.timestamp) - time(a.timestamp))[0];
      if (latest) quote.signals.copy = { ...latest, address: wallet.address, checkedAt: wallet.checkedAt, allTimePnl: wallet.allTimePnl, recentClosedPnl: wallet.recentClosedPnl,
        recentClosedCount: wallet.recentClosedCount, highFrequency: wallet.highFrequency, observedSpanHours: wallet.observedSpanHours };
      quote.signals.walletScreen = { address: wallet.address, eligible: wallet.eligible, checkedAt: wallet.checkedAt, reasons: wallet.reasons };
      const match = /-updown-(5|15)m-/.exec(quote.signals.marketSlug ?? ""); if (match) quote.signals.windowMinutes = Number(match[1]);
    }
    if (book.strategyId === "maker-resting") {
      const old = state.maker, price = book.config.bidPrice;
      const resting = old?.instrument === quote.instrument && old.bidPrice === price && clock - time(old.placedAt) <= 86400000 ? old : null;
      if (resting) {
        const trade = (value.publicTrades ?? []).filter(row => row.side === "SELL" && row.price < price && time(row.timestamp) > time(resting.placedAt)
          && time(row.timestamp) <= clock && clock - time(row.timestamp) <= 120000 && !book.consumedSignals.includes(row.transaction)).sort((a, b) => time(a.timestamp) - time(b.timestamp))[0];
        quote.signals.maker = { ...resting, ...(trade ? { tradeAt: trade.timestamp, tradePrice: trade.price, tradeSide: trade.side, tradeId: trade.transaction, tradeSize: trade.shares } : {}) };
      } else if (quote.ask > price) state.maker = { instrument: quote.instrument, bidPrice: price, observedAsk: quote.ask, placedAt: quote.timestamp };
    }
    if (forecast) {
      const w = feed.weather, targetAt = quote.signals.endDate, leadHours = w.leadHours ?? 24;
      const calibration = calibrateWeather({ records: w.calibrationRecords, asOf: quote.timestamp, leadHours });
      const forecasts = forecast.models.filter(row => finite(row[w.metric])).map(row => ({ station: w.station, targetAt, model: row.model, predicted: row[w.metric], issuedAt: forecast.observedAt, availableAt: forecast.observedAt }));
      const blend = blendWeatherForecasts({ forecasts, calibration, station: w.station, targetAt, asOf: quote.timestamp, leadHours });
      if (!blend.available) throw fail(blend.reason);
      const previous = state.weather;
      const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: w.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(clock));
      const leadDays = Math.round((Date.parse(`${w.date}T00:00:00Z`) - Date.parse(`${localDate}T00:00:00Z`)) / 86400000);
      quote.signals.weather = { ...blend, station: w.station, settlementStation: w.settlementStation, bucketLower: w.bucketLower, bucketUpper: w.bucketUpper, leadDays,
        previousForecast: previous?.forecast, previousObservedAt: previous?.observedAt };
      // Hold the previous snapshot long enough to compare genuinely separate forecast reads.
      if (!previous || clock - time(previous.observedAt) >= 1800000) state.weather = { forecast: blend.forecast, observedAt: forecast.observedAt };
      if (ensemble) {
        const weather = quote.signals.weather;
        const measure = calibration.models.find(model => model.station === w.station && model.model === ensemble.model && model.ready);
        if (!measure) throw fail("The ensemble needs matching station/lead calibration before it can post a paper bid.");
        const members = ensemble.members.map(value => value - measure.bias);
        weather.ensembleMembers = members; weather.ensembleObservedAt = ensemble.observedAt; weather.ensembleBiasCorrection = measure.bias;
        const bucketProbability = weatherProbability(weather, book.config), memberProbability = members.filter(value => (w.bucketLower === null || value >= w.bucketLower) && (w.bucketUpper === null || value < w.bucketUpper)).length / members.length;
        const gaussian = bucketProbability === null ? null : quote.signals.outcome === "No" ? 1 - bucketProbability : bucketProbability, empirical = quote.signals.outcome === "No" ? 1 - memberProbability : memberProbability;
        const desiredBid = Math.min((quote.bid + quote.ask) / 2 - 0.01, (gaussian + empirical) / 2 - book.config.minEdge), resting = state.weatherMaker;
        if (resting?.instrument === quote.instrument && clock - time(resting.placedAt) <= 86400000 && resting.bidPrice <= desiredBid) {
          const trade = (value.publicTrades ?? []).filter(row => row.side === "SELL" && row.price < resting.bidPrice && time(row.timestamp) > time(resting.placedAt)
            && time(row.timestamp) <= clock && clock - time(row.timestamp) <= 120000 && !book.consumedSignals.includes(row.transaction)).sort((a, b) => time(a.timestamp) - time(b.timestamp))[0];
          quote.signals.maker = { ...resting, ...(trade ? { tradeAt: trade.timestamp, tradePrice: trade.price, tradeSide: trade.side, tradeId: trade.transaction, tradeSize: trade.shares } : {}) };
          weather.previousForecast = resting.previousForecast; weather.previousObservedAt = resting.previousObservedAt;
        } else {
          delete state.weatherMaker;
          if (gaussian !== null && desiredBid >= book.config.minPrice && desiredBid <= book.config.maxPrice && desiredBid < quote.ask && finite(previous?.forecast)
            && Math.abs(blend.forecast - previous.forecast) >= book.config.minForecastMove) state.weatherMaker = { instrument: quote.instrument, bidPrice: desiredBid, observedAsk: quote.ask,
              placedAt: quote.timestamp, previousForecast: previous.forecast, previousObservedAt: previous.observedAt };
        }
      }
    }
    return { quote, forwardEvidence: state, feed };
  };
}
