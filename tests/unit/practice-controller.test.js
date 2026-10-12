import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { initializePractice } from "../../public/js/practice-controller.js";
import { createPracticeService } from "../../src/practice/practice-service.js";
import { createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";
const filename = fileURLToPath(new URL("../../views/pages/practice.ejs", import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
async function fixture(t, { intercept = () => undefined } = {}) {
  let time = Date.now(), quoteCalls = 0;
  const service = createPracticeService({ repository: createMemoryWorkspaceRepository(), now: () => new Date(time), setTimer: () => ({ unref() {} }), clearTimer() {}, marketData: { quote: async () => { quoteCalls++; time += 1000; return { instrument: "BINANCE:BTCUSDT", timestamp: new Date(time).toISOString(), observedAt: new Date(time).toISOString(), price: 100, bid: 99.9, ask: 100.1, liquidity: 100000 }; } } });
  const html = ejs.render(readFileSync(filename, "utf8"), {}, { filename });
  const dom = new JSDOM(`<meta name="csrf-token" content="test-csrf">${html}`, { url: "https://synergy.test/practice" });
  const root = dom.window.document.querySelector("[data-route-view]"), calls = [];
  const instance = initializePractice(root, { fetchImpl: async (url, options) => {
    calls.push({ url, options }); const custom = await intercept(url, options); if (custom) return custom;
    const body = options.body ? JSON.parse(options.body) : {};
    try {
      if (url === "/api/practice") return response(await service.state("alice"));
      if (url === "/api/practice/books") return response(await service.createBook("alice", body), 201);
      const match = url.match(/^\/api\/practice\/books\/([^/]+)(?:\/(orders|refresh|start|pause))?$/);
      if (match) { const [, id, action] = match; if (action === "orders") return response(await service.placeOrder("alice", id, body)); if (action === "refresh") return response(await service.refreshBook("alice", id)); if (action === "start") return response(await service.start("alice", id, body)); if (action === "pause") return response(await service.pause("alice", id)); return response(await service.book("alice", id)); }
      throw new Error(`Unexpected URL ${url}`);
    } catch (error) { return response({ message: error.message }, error.status || 500); }
  } });
  t.after(async () => { instance.dispose(); dom.window.close(); await service.close(); }); await tick();
  return { root, dom, service, calls, instance, quoteCalls: () => quoteCalls, q: name => root.querySelector(`[data-practice-${name}]`), submit: form => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) };
}
test("paper workspace offers only forward testing and creates source-linked virtual accounts", async t => {
  const app = await fixture(t), form = app.q("strategy-form");
  assert.equal(form.elements.strategyId.value, "manual"); assert.doesNotMatch(app.root.textContent, /backtest|replay|synthetic|dataset/i);
  form.elements.name.value = "My paper account"; app.submit(form); await tick();
  const book = (await app.service.state("alice")).books[0]; assert.equal(book.mode, "PAPER"); assert.equal(book.feed.source, "binance"); assert.equal(book.feed.instrument, "BINANCE:BTCUSDT"); assert.equal(book.observationCount, 0); assert.equal(app.quoteCalls(), 0);
  assert.match(app.q("books").textContent, /My paper account/); assert.match(app.q("report-note").textContent, /Virtual USD only/);
  assert.ok(app.calls.every(call => call.url.startsWith("/api/practice")));
});
test("paper buy and sell fetch fresh server quotes, show the ledger, and never send prices", async t => {
  const app = await fixture(t); app.submit(app.q("strategy-form")); await tick();
  const buy = app.root.querySelector('[data-practice-order]'); buy.elements.budgetUsd.value = "20"; app.submit(buy); await tick();
  assert.equal(app.quoteCalls(), 1); assert.match(app.q("ledger").textContent, /BUY/);
  const call = app.calls.find(c => c.url.endsWith("/orders")), payload = JSON.parse(call.options.body);
  assert.equal(payload.side, "BUY"); assert.equal(payload.budgetUsd, 20); assert.equal(payload.price, undefined); assert.equal(payload.quote, undefined); assert.ok(payload.requestId); assert.equal(call.options.headers["X-CSRF-Token"], "test-csrf");
  const sell = app.root.querySelector('[data-practice-action="sell"]'); assert.equal(sell.disabled, false); sell.click(); await tick();
  assert.equal(app.quoteCalls(), 2); assert.match(app.q("ledger").textContent, /SELL/); assert.match(app.q("positions").textContent, /No open/); assert.ok(app.q("chart").querySelector('svg[role="img"]'));
});
test("feed start, pause and price refresh update state while preserving entered order budget", async t => {
  const app = await fixture(t); app.submit(app.q("strategy-form")); await tick();
  app.root.querySelector('[data-practice-action="start"]').click(); await tick(); assert.match(app.q("books").textContent, /FEED RUNNING/);
  app.root.querySelector('[data-practice-order]').elements.budgetUsd.value = "17"; await app.instance.refresh(); assert.equal(app.root.querySelector('[data-practice-order]').elements.budgetUsd.value, "17");
  app.root.querySelector('[data-practice-action="pause"]').click(); await tick(); assert.match(app.q("books").textContent, /FEED PAUSED/);
  app.root.querySelector('[data-practice-action="mark"]').click(); await tick(); assert.equal(app.quoteCalls(), 1); assert.match(app.q("feedback").textContent, /current market quotes/);
});
test("current quote sources render text safely and can configure the paper account feed", async t => {
  const hostile = '<img src=x onerror="alert(1)">'; const app = await fixture(t, { intercept: url => url === "/api/practice/data/quote" ? response({ instrument: "BINANCE:BTCUSDT", timestamp: new Date().toISOString(), bid: 100, ask: 101, provenance: { source: "binance", fetchedAt: new Date().toISOString(), caveats: [hostile] } }) : undefined });
  app.root.querySelector('[data-practice-tab="data"]').click(); app.submit(app.q("data-form")); await tick(); assert.equal(app.root.querySelector("img"), null); assert.match(app.q("data-summary").textContent, /<img/);
  app.root.querySelector('[data-practice-action="use-feed"]').click(); assert.equal(app.q("strategy-form").elements.feedInstrument.value, "BINANCE:BTCUSDT"); assert.equal(app.root.querySelector('[data-practice-tab="paper"]').getAttribute("aria-selected"), "true");
});
test("keyboard tabs work and disposed pages ignore later refreshes", async t => {
  const app = await fixture(t); app.root.querySelector('[data-practice-tab="paper"]').dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); assert.equal(app.root.querySelector('[data-practice-tab="data"]').getAttribute("aria-selected"), "true");
  app.instance.dispose(); const before = app.root.outerHTML; await app.instance.refresh(); assert.equal(app.root.outerHTML, before);
});

test('discovery selects the exact Polymarket outcome and verified crypto window without copying identifiers',async t=>{
 const opened=Date.parse('2026-10-12T15:30:00Z');const app=await fixture(t,{intercept:url=>url==='/api/practice/data/discover'?response({source:'polymarket',fetchedAt:new Date().toISOString(),markets:[{id:'market-42',question:'Bitcoin up or down',slug:`btc-updown-5m-${opened/1000}`,endDate:new Date(opened+300000).toISOString(),outcomes:[{label:'Up',tokenId:'token-up'},{label:'Down',tokenId:'token-down'}]}]}):undefined});
 const form=app.q('data-form');form.elements.method.value='discover';form.elements.source.value='polymarket';form.elements.method.dispatchEvent(new app.dom.window.Event('change'));app.submit(form);await tick();app.root.querySelector('[data-practice-outcome="1"]').click();const builder=app.q('strategy-form');assert.equal(builder.elements.feedInstrument.value,'token-down');assert.equal(builder.elements.feedMarketId.value,'market-42');assert.equal(builder.elements.feedOutcome.value,'1');builder.elements.strategyId.value='crypto-directional';builder.elements.strategyId.dispatchEvent(new app.dom.window.Event('change'));assert.equal(app.root.querySelector('[data-forward-field="asset"]').value,'BTC');assert.equal(app.root.querySelector('[data-forward-field="windowOpenedAt"]').value,new Date(opened).toISOString());assert.equal(builder.elements.feedSource.value,'polymarket');assert.equal(builder.querySelector('[name=feedInstrument]').value,'token-down');
});

test('prediction strategy switches to a compatible source and current crypto discovery fills its contract',async t=>{
 const opened=new Date().toISOString(),ends=new Date(Date.now()+300000).toISOString();const app=await fixture(t,{intercept:url=>url==='/api/practice/data/cryptoWindow'?response({source:'polymarket',instrument:'POLY:current-up',marketId:'current-id',outcomeIndex:0,windowOpenedAt:opened,windowEndsAt:ends,direction:'Up'}):undefined});const form=app.q('strategy-form');form.elements.strategyId.value='crypto-directional';form.elements.strategyId.dispatchEvent(new app.dom.window.Event('change'));assert.equal(form.elements.feedSource.value,'polymarket');assert.equal(form.elements.feedInstrument.value,'');assert.equal(form.elements.feedMarketId.required,true);assert.equal(form.elements.feedSource.querySelector('[value=binance]').disabled,true);
 app.root.querySelector('[data-practice-action=find-window]').click();await tick();assert.equal(form.elements.feedInstrument.value,'POLY:current-up');assert.equal(form.elements.feedMarketId.value,'current-id');assert.equal(app.root.querySelector('[data-forward-field=windowOpenedAt]').value,opened);assert.equal(app.root.querySelector('[data-forward-field=windowEndsAt]').value,ends);
 form.elements.strategyId.value='paired-outcomes';form.elements.strategyId.dispatchEvent(new app.dom.window.Event('change'));assert.equal(form.elements.feedInstrument.value,'POLY:current-up');app.root.querySelector('[data-practice-action=discover]').click();assert.equal(app.q('data-form').elements.source.value,'polymarket');assert.equal(app.q('data-form').elements.method.value,'discover');
});
