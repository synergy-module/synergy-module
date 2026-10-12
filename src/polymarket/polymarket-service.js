import { randomUUID } from "node:crypto";
import { createPolymarketClient, polyError, validAddress, validMarketId } from "./polymarket-client.js";
import { analyzeMarket, isFresh, round, simulateFill } from "./polymarket-analysis.js";

const DEFAULT_SETTINGS = Object.freeze({ positionUsd: 50, maxExposureUsd: 1000, maxPositions: 10,
  dailyLossUsd: 300, maxDrawdownPercent: 10, slippageBps: 100, cycleSeconds: 120 });
const initial = () => ({ watchlist: [], addresses: [], notes: [], research: [], paper: {
  initialCapital: 10000, cash: 10000, realizedPnl: 0, positions: [], trades: [], settings: { ...DEFAULT_SETTINGS },
  peakEquity: 10000, daily: null, bot: { enabled: false, worker: null, leaseUntil: null, cycle: null, lastCycleAt: null, lastError: null },
} });
const ownerId = owner => {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 200) throw polyError("POLY_AUTH", "Sign in to use Polymarket.", 401);
  return owner;
};
const object = (body, keys) => {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw polyError("POLY_INPUT", "Check the submitted fields.");
};
const dayKey = date => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const equity = paper => round(paper.cash + paper.positions.reduce((sum, pos) => sum + pos.shares * pos.markPrice, 0));
const exposure = paper => round(paper.positions.reduce((sum, pos) => sum + pos.cost, 0));
const isRunning = (bot, now) => bot.enabled && Date.parse(bot.leaseUntil) > now.valueOf();

export function createPolymarketService({ repository, client = createPolymarketClient(), now = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout, canOperate = async () => true } = {}) {
  const workerId = randomUUID(), timers = new Map(), operations = new Set(), inFlight = new Set();
  let closed = false;
  const read = async owner => (await repository.read(ownerId(owner))).polymarket ?? initial();
  const update = async (owner, change) => {
    if (closed) throw polyError("POLY_UNAVAILABLE", "The Polymarket workspace is restarting.", 503);
    try {
      return await repository.update(ownerId(owner), workspace => {
        workspace.polymarket ??= initial();
        return change(workspace.polymarket);
      });
    } catch (error) {
      if (error.message === "Workspace storage limit reached") throw polyError("POLY_CAPACITY", "Account storage is full. Remove old notes or research before continuing.", 409);
      throw error;
    }
  };
  function schedule(owner, seconds) {
    clearTimer(timers.get(owner));
    if (closed) return;
    const timer = setTimer(() => {
      timers.delete(owner);
      const task = cycle(owner).catch(() => {}).finally(() => operations.delete(task));
      operations.add(task);
      return task;
    }, seconds * 1000);
    timer?.unref?.(); timers.set(owner, timer);
  }
  async function detail(id, notes = []) {
    const market = await client.market(id);
    const results = await Promise.allSettled([...market.outcomes.map(outcome => client.book(outcome.tokenId)),
      market.conditionId ? client.trades({ conditionId: market.conditionId }) : Promise.reject(new Error("No condition ID"))]);
    const books = results.slice(0, 2).map(result => result.status === "fulfilled" ? result.value : null);
    const activity = results[2].status === "fulfilled" ? results[2].value : null;
    const warnings = results.some(result => result.status === "rejected") ? ["Some book or activity data could not be loaded. Missing evidence blocks the corresponding screening checks."] : [];
    return { market, books, activity, warnings, analysis: analyzeMarket(market, books, activity, notes, now()) };
  }
  function riskReason(paper, amount, market, { buying = true } = {}) {
    const current = equity(paper);
    if (buying && paper.daily && current <= paper.daily.startEquity - paper.settings.dailyLossUsd) return "Daily equity loss limit reached.";
    if (buying && current <= paper.peakEquity * (1 - paper.settings.maxDrawdownPercent / 100)) return "Peak-equity drawdown limit reached.";
    if (buying && paper.positions.length >= paper.settings.maxPositions) return "Maximum open positions reached.";
    if (buying && exposure(paper) + amount > paper.settings.maxExposureUsd) return "Maximum cost exposure reached.";
    if (buying && amount > paper.cash) return "Insufficient paper cash.";
    if (buying && paper.positions.some(pos => pos.marketId === market.id)) return "This market already has a paper position.";
    if (buying && paper.positions.filter(pos => pos.eventId === market.eventId).reduce((sum, pos) => sum + pos.cost, 0) + amount > paper.initialCapital * 0.05) return "Related-event cost exposure exceeds 5% of initial capital.";
    return null;
  }
  function trade(paper, position, fill, side, reason) {
    paper.cash = round(paper.cash + fill.cashChange);
    const realizedPnl = side === "SELL" ? round(fill.cashChange - position.cost) : 0;
    paper.realizedPnl = round(paper.realizedPnl + realizedPnl);
    paper.trades.unshift({ id: randomUUID(), marketId: position.marketId, title: position.title,
      outcome: position.outcome, side, shares: fill.shares, price: fill.price, fee: fill.fee,
      notional: fill.notional, partial: fill.partial, realizedPnl, reason, timestamp: now().toISOString() });
    paper.trades = paper.trades.slice(0, 50);
  }
  async function cycle(owner) {
    if (closed || inFlight.has(owner)) return;
    inFlight.add(owner);
    const cycleId = randomUUID();
    let admitted = false;
    try {
      if (!await canOperate(owner)) {
        await update(owner, state => { state.paper.bot.enabled = false; state.paper.bot.lastError = "Operator access is no longer available."; });
        return;
      }
      admitted = await update(owner, state => {
        const { bot, settings } = state.paper;
        if (!bot.enabled || bot.worker !== workerId || (bot.cycle && Date.parse(bot.leaseUntil) > now().valueOf())) return false;
        bot.cycle = cycleId; bot.leaseUntil = new Date(now().valueOf() + Math.max(120, settings.cycleSeconds * 2) * 1000).toISOString();
        return true;
      });
      if (!admitted) return;
      const saved = await read(owner);
      const snapshot = await client.markets();
      // Refresh held markets independently of the discovery page so positions
      // that leave the top-volume list can still be marked and closed.
      const candidates = saved.watchlist.length ? saved.watchlist.slice(0, 6)
        : snapshot.markets.filter(market => market.liquidity >= 10000).slice(0, 6).map(market => market.id);
      const ids = [...new Set([...saved.paper.positions.map(pos => pos.marketId), ...candidates])].slice(0, 16);
      const evidence = [];
      for (let index = 0; index < ids.length; index += 4) {
        const batch = await Promise.allSettled(ids.slice(index, index + 4).map(id => detail(id, saved.notes)));
        for (const result of batch) if (result.status === "fulfilled") evidence.push(result.value);
      }
      if (!await canOperate(owner)) { await api.pause(owner); return; }
      await update(owner, state => {
        const { paper } = state, { bot } = paper;
        if (!bot.enabled || bot.worker !== workerId || bot.cycle !== cycleId) return;
        if (!isRunning(bot, now())) { bot.enabled = false; bot.cycle = null; bot.lastError = "Scan exceeded the worker lease. Start again to retry."; return; }
        for (const pos of paper.positions) {
          const observed = evidence.find(item => item.market.id === pos.marketId), book = observed?.books[pos.outcomeIndex];
          if (book?.bids[0] && isFresh(book, now())) { pos.markPrice = book.bids[0].price; pos.markedAt = now().toISOString(); }
        }
        const date = dayKey(now());
        // Roll the baseline before applying this cycle's mark movement.
        if (paper.daily?.day !== date) paper.daily = { day: date, startEquity: equity(saved.paper) };
        paper.peakEquity = Math.max(paper.peakEquity, equity(paper));
        const halt = riskReason(paper, 0, { id: "", eventId: "" });
        if (halt?.includes("loss limit") || halt?.includes("drawdown")) { bot.enabled = false; bot.lastError = halt; }
        for (const pos of [...paper.positions]) {
          const observed = evidence.find(item => item.market.id === pos.marketId);
          if (!observed) continue;
          const change = pos.markPrice - pos.entryPrice;
          if (change < 0.02 && change > -0.03) continue;
          try {
            const fill = simulateFill({ book: observed.books[pos.outcomeIndex], fee: observed.market.fee, side: "SELL", shares: pos.shares, slippageBps: paper.settings.slippageBps, now: now() });
            trade(paper, pos, fill, "SELL", change >= 0.02 ? "take_profit" : "stop_loss");
            paper.positions = paper.positions.filter(row => row.id !== pos.id);
          } catch { /* Preserve the position when a full close cannot be simulated. */ }
        }
        const eligible = evidence.filter(item => item.analysis.eligible && candidates.includes(item.market.id)).slice(0, 2);
        for (const observed of eligible) {
          if (!bot.enabled) break;
          const { market, analysis, books } = observed, amount = paper.settings.positionUsd;
          if (riskReason(paper, amount, market)) continue;
          try {
            const fill = simulateFill({ book: books[analysis.outcomeIndex], fee: market.fee, side: "BUY", budget: amount, slippageBps: paper.settings.slippageBps, now: now() });
            const pos = { id: randomUUID(), marketId: market.id, eventId: market.eventId, title: market.question, outcome: analysis.outcome,
              outcomeIndex: analysis.outcomeIndex, shares: fill.shares, cost: round(-fill.cashChange), entryPrice: fill.price,
              markPrice: books[analysis.outcomeIndex].bids[0].price, markedAt: now().toISOString(), openedAt: now().toISOString() };
            trade(paper, pos, fill, "BUY", "filtered_convergence"); paper.positions.push(pos);
          } catch { /* No depth, no fill. */ }
        }
        paper.peakEquity = Math.max(paper.peakEquity, equity(paper));
        bot.lastCycleAt = now().toISOString(); bot.scanned = evidence.length; bot.eligible = eligible.length;
        if (bot.enabled) bot.lastError = evidence.length ? null : "No verified market evidence was available; no trades were simulated.";
        bot.cycle = null;
      });
    } catch (error) {
      if (admitted && !closed) await update(owner, state => {
        const { bot } = state.paper;
        if (bot.worker === workerId && bot.cycle === cycleId) { bot.cycle = null; bot.lastError = "Cycle could not retrieve verified market data. No new fills were recorded."; }
      }).catch(() => {});
    } finally {
      inFlight.delete(owner);
      if (admitted && !closed) {
        const saved = await read(owner);
        if (saved.paper.bot.enabled && saved.paper.bot.worker === workerId) schedule(owner, saved.paper.settings.cycleSeconds);
      }
    }
  }
  const api = {
    async state(owner) {
      const state = await read(owner), { paper } = state;
      return { ...state, storage: repository.getStorageStatus(), mode: "PAPER", liveEnabled: false,
        paper: { ...paper, bot: { running: isRunning(paper.bot, now()), lastCycleAt: paper.bot.lastCycleAt,
          lastError: paper.bot.enabled && !isRunning(paper.bot, now()) ? "Worker stopped. Start the paper bot to resume." : paper.bot.lastError,
          scanned: paper.bot.scanned ?? 0, eligible: paper.bot.eligible ?? 0 },
          equity: equity(paper), exposureUsd: exposure(paper), unrealizedPnl: round(equity(paper) - paper.cash - exposure(paper)),
          dailyPnl: paper.daily?.day === dayKey(now()) ? round(equity(paper) - paper.daily.startEquity) : 0 } };
    },
    markets: () => client.markets(),
    async market(owner, id) { return detail(id, (await read(owner)).notes); },
    async research(owner, body) {
      object(body, ["marketId"]);
      const observed = await api.market(owner, body.marketId);
      const report = { id: randomUUID(), marketId: observed.market.id, title: observed.market.question,
        market: { question: observed.market.question, outcomes: observed.market.outcomes.map(({ label, price }) => ({ label, price })),
          endDate: observed.market.endDate, url: observed.market.url, resolutionSource: observed.market.resolutionSource },
        analysis: { ...observed.analysis, relatedNotes: observed.analysis.relatedNotes.map(note => ({ id: note.id, text: note.text.slice(0, 600) })) },
        sources: [{ name: "Gamma market metadata", url: `https://gamma-api.polymarket.com/markets/${observed.market.id}`, fetchedAt: observed.market.fetchedAt },
          ...observed.books.filter(Boolean).map(book => ({ name: "CLOB order book", url: `https://clob.polymarket.com/book?token_id=${book.tokenId}`, fetchedAt: book.fetchedAt })),
          ...(observed.activity ? [{ name: "Sampled taker trades", url: `https://data-api.polymarket.com/v2/trades?condition=${observed.market.conditionId}&limit=100`, fetchedAt: observed.activity.fetchedAt }] : [])],
        createdAt: now().toISOString() };
      await update(owner, state => { state.research.unshift(report); state.research = state.research.slice(0, 10); });
      return report;
    },
    async note(owner, body) {
      object(body, ["text", "marketId"]);
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 1500 || /\u0000/.test(body.text)
        || (body.marketId !== undefined && body.marketId !== null && body.marketId !== "" && !validMarketId(body.marketId))) throw polyError("POLY_INPUT", "Write a lesson of 1 to 1,500 characters and choose a valid market.");
      return update(owner, state => {
        if (state.notes.length >= 20) throw polyError("POLY_CAPACITY", "The memory holds 20 lessons. Remove an old lesson first.", 409);
        const note = { id: randomUUID(), text: body.text.trim(), marketId: body.marketId || null, createdAt: now().toISOString() };
        state.notes.unshift(note); return note;
      });
    },
    async remove(owner, collection, id) {
      return update(owner, state => {
        if (!["notes", "research"].includes(collection)) throw polyError("POLY_INPUT", "Invalid collection.");
        const previous = state[collection].length;
        state[collection] = state[collection].filter(row => row.id !== id);
        if (previous === state[collection].length) throw polyError("POLY_NOT_FOUND", "This record is unavailable for your account.", 404);
      });
    },
    async watch(owner, body) {
      object(body, ["marketId", "watching"]);
      if (!validMarketId(body.marketId) || typeof body.watching !== "boolean") throw polyError("POLY_INPUT", "Choose a valid watchlist change.");
      return update(owner, state => {
        state.watchlist = state.watchlist.filter(id => id !== body.marketId);
        if (body.watching) {
          if (state.watchlist.length >= 30) throw polyError("POLY_CAPACITY", "The watchlist holds 30 markets.", 409);
          state.watchlist.push(body.marketId);
        }
        return state.watchlist;
      });
    },
    async address(owner, body) {
      object(body, ["address", "following"]);
      if (!validAddress(body.address) || typeof body.following !== "boolean") throw polyError("POLY_INPUT", "Enter a valid public wallet address.");
      return update(owner, state => {
        const address = body.address.toLowerCase(); state.addresses = state.addresses.filter(row => row !== address);
        if (body.following) {
          if (state.addresses.length >= 5) throw polyError("POLY_CAPACITY", "The radar follows up to five public wallets.", 409);
          state.addresses.push(address);
        }
        return state.addresses;
      });
    },
    async radar(owner) {
      const state = await read(owner);
      const board = await client.leaderboard();
      const activity = [];
      for (const address of state.addresses) {
        try { activity.push({ address, ...await client.trades({ address }) }); }
        catch { activity.push({ address, trades: [], error: "This wallet's activity could not be loaded." }); }
      }
      return { ...board, activity };
    },
    async settings(owner, body) {
      object(body, Object.keys(DEFAULT_SETTINGS));
      const ranges = { positionUsd: [1, 500], maxExposureUsd: [1, 10000], maxPositions: [1, 10], dailyLossUsd: [1, 10000],
        maxDrawdownPercent: [1, 50], slippageBps: [0, 500], cycleSeconds: [60, 3600] };
      for (const [key, value] of Object.entries(body)) if (typeof value !== "number" || !Number.isFinite(value) || value < ranges[key][0]
        || value > ranges[key][1] || (["maxPositions", "cycleSeconds"].includes(key) && !Number.isInteger(value))) throw polyError("POLY_INPUT", "Risk settings are outside the supported limits.");
      await update(owner, state => {
        if (isRunning(state.paper.bot, now())) throw polyError("POLY_CONFLICT", "Pause the paper bot before changing its limits.", 409);
        const settings = { ...state.paper.settings, ...body };
        if (settings.positionUsd > settings.maxExposureUsd) throw polyError("POLY_INPUT", "Position budget must be within the total exposure limit.");
        state.paper.settings = settings;
      });
      return api.state(owner);
    },
    async start(owner, body) {
      object(body, []);
      if (timers.size + inFlight.size >= 20) throw polyError("POLY_BUSY", "The paper worker is at capacity. Retry later.", 503);
      if (!await canOperate(owner)) throw polyError("POLY_AUTH", "Operator access is unavailable.", 403);
      await update(owner, state => {
        if (isRunning(state.paper.bot, now())) throw polyError("POLY_CONFLICT", "The paper bot is already running.", 409);
        const paper = state.paper;
        if (paper.daily?.day !== dayKey(now())) paper.daily = { day: dayKey(now()), startEquity: equity(paper) };
        const reason = riskReason(paper, 0, { id: "", eventId: "" });
        if (reason?.includes("loss limit") || reason?.includes("drawdown")) throw polyError("POLY_RISK", reason, 409);
        paper.bot = { ...paper.bot, enabled: true, worker: workerId, cycle: null, lastError: null,
          leaseUntil: new Date(now().valueOf() + Math.max(120, paper.settings.cycleSeconds * 2) * 1000).toISOString() };
      });
      schedule(owner, 0);
      return api.state(owner);
    },
    async pause(owner) {
      clearTimer(timers.get(owner)); timers.delete(owner);
      await update(owner, state => { state.paper.bot.enabled = false; state.paper.bot.cycle = null; });
      return api.state(owner);
    },
    async closePosition(owner, id) {
      const saved = await read(owner), pos = saved.paper.positions.find(row => row.id === id);
      if (!pos) throw polyError("POLY_NOT_FOUND", "This position is unavailable for your account.", 404);
      if (isRunning(saved.paper.bot, now())) throw polyError("POLY_CONFLICT", "Pause the paper bot before closing a position manually.", 409);
      const observed = await detail(pos.marketId);
      let fill;
      try { fill = simulateFill({ book: observed.books[pos.outcomeIndex], fee: observed.market.fee, side: "SELL", shares: pos.shares, slippageBps: saved.paper.settings.slippageBps, now: now() }); }
      catch (error) { throw polyError("POLY_RISK", error.message, 409); }
      await update(owner, state => {
        const paper = state.paper, current = paper.positions.find(row => row.id === id);
        if (!current || isRunning(paper.bot, now()) || paper.settings.slippageBps !== saved.paper.settings.slippageBps) throw polyError("POLY_CONFLICT", "The paper position changed. Refresh before closing it.", 409);
        if (!isFresh(observed.books[pos.outcomeIndex], now())) throw polyError("POLY_RISK", "The close quote expired. Retry.", 409);
        trade(paper, current, fill, "SELL", "manual_close"); paper.positions = paper.positions.filter(row => row.id !== id);
      });
      return api.state(owner);
    },
    async close() {
      closed = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear(); await Promise.allSettled([...operations]);
    },
  };
  return api;
}
