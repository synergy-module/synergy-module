import test from "node:test";
import assert from "node:assert/strict";
import {
  createMarketNewsService,
  getCalendarWeekRange,
} from "../../src/services/market-news-service.js";

test("week range is the containing Sunday through Saturday", () => {
  assert.deepEqual(getCalendarWeekRange(new Date("2026-09-02T12:00:00Z")), {
    from: "2026-08-30",
    to: "2026-09-05",
  });
});

test("service keeps supported medium and high events and normalizes missing values", async () => {
  const provider = {
    async fetchWeek() {
      return [
        { date: "2026-09-03", time: "12:30", title: "Non Farm Payrolls", country: "United States", impact: "high", type: "economic" },
        { date: "2026-09-02", time: "09:00", title: "CPI", country: "Euro Area", impact: "medium", type: "economic" },
        { date: "2026-09-01", time: "08:00", title: "Minor Survey", country: "United Kingdom", impact: "low", type: "economic" },
        { date: "2026-09-04", time: "08:00", title: "Unsupported Market", country: "Brazil", impact: "high", type: "economic" },
        { date: "2026-09-04", title: "Company earnings", country: "United States", impact: "high", type: "earnings" },
      ];
    },
  };
  const service = createMarketNewsService({
    provider,
    now: () => new Date("2026-09-02T12:00:00Z"),
  });

  const result = await service.getCurrentWeek();

  assert.equal(result.state, "live");
  assert.deepEqual(result.events.map((event) => [event.id, event.market, event.importance]), [
    ["2026-09-02|09:00|Euro Area|CPI", "EUR", "medium"],
    ["2026-09-03|12:30|United States|Non Farm Payrolls", "USD", "high"],
  ]);
  assert.equal(result.events[0].timestamp, "2026-09-02T09:00:00.000Z");
  assert.equal(result.events[1].actual, null);
  assert.equal(result.events[1].source, "ECONOMICIUM / OFFICIAL SCHEDULES");
});

test("default cache refreshes the public feed no more than once per day", async () => {
  let calls = 0;
  let currentTime = new Date("2026-09-02T12:00:00.000Z");
  const provider = {
    fetchWeek: async () => {
      calls += 1;
      return [{ date: "2026-09-03", time: "12:30", title: "Payrolls", country: "United States", impact: "high", type: "economic" }];
    },
  };
  const service = createMarketNewsService({ provider, now: () => currentTime });

  await service.getCurrentWeek();
  currentTime = new Date("2026-09-03T11:59:59.999Z");
  await service.getCurrentWeek();
  assert.equal(calls, 1);

  currentTime = new Date("2026-09-03T12:00:00.000Z");
  await service.getCurrentWeek();
  assert.equal(calls, 2);
});

test("service shares fresh results and force refresh bypasses the cache", async () => {
  let calls = 0;
  const provider = {
    fetchWeek: async () => [{ date: "2026-09-02", time: "12:00", country: "Japan", title: `BoJ Statement ${++calls}`, impact: "high", type: "economic" }],
  };
  const service = createMarketNewsService({ provider, now: () => new Date("2026-09-02T12:00:00Z") });

  const first = await service.getCurrentWeek();
  const cached = await service.getCurrentWeek();
  const refreshed = await service.getCurrentWeek({ force: true });

  assert.equal(first.events[0].id, "2026-09-02|12:00|Japan|BoJ Statement 1");
  assert.equal(cached.events[0].id, "2026-09-02|12:00|Japan|BoJ Statement 1");
  assert.equal(refreshed.events[0].id, "2026-09-02|12:00|Japan|BoJ Statement 2");
  assert.equal(calls, 2);
});

test("concurrent forced refreshes bypass a fresh cache once and share the provider request", async () => {
  let calls = 0;
  const refresh = Promise.withResolvers();
  const provider = {
    fetchWeek() {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([
          { date: "2026-09-02", time: "12:00", country: "Japan", title: "Initial", impact: "high", type: "economic" },
        ]);
      }
      return refresh.promise;
    },
  };
  const service = createMarketNewsService({ provider, now: () => new Date("2026-09-02T12:00:00.000Z") });

  await service.getCurrentWeek();
  const first = service.getCurrentWeek({ force: true });
  const second = service.getCurrentWeek({ force: true });

  assert.equal(calls, 2);
  refresh.resolve([
    { date: "2026-09-02", time: "12:00", country: "Japan", title: "Refreshed", impact: "high", type: "economic" },
  ]);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.events[0].id, "2026-09-02|12:00|Japan|Refreshed");
  assert.equal(secondResult.events[0].id, "2026-09-02|12:00|Japan|Refreshed");
});

test("a forced caller joins an older same-week load so a would-be newer failure cannot discard its success", async () => {
  let calls = 0;
  const older = Promise.withResolvers();
  const wouldBeNewer = Promise.withResolvers();
  const provider = {
    fetchWeek() {
      calls += 1;
      return calls === 1 ? older.promise : wouldBeNewer.promise;
    },
  };
  const service = createMarketNewsService({ provider, now: () => new Date("2026-09-02T12:00:00.000Z") });

  const olderCall = service.getCurrentWeek();
  const forcedCall = service.getCurrentWeek({ force: true });
  const forcedOutcome = forcedCall.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  if (calls > 1) wouldBeNewer.reject(new Error("newer forced request failed"));
  older.resolve([
    { date: "2026-09-02", time: "12:00", country: "Canada", title: "Valid older load", impact: "high", type: "economic" },
  ]);

  const [olderResult, outcome] = await Promise.all([olderCall, forcedOutcome]);

  assert.equal(calls, 1);
  assert.equal(outcome.status, "fulfilled");
  assert.equal(olderResult.events[0].id, "2026-09-02|12:00|Canada|Valid older load");
  assert.equal(outcome.value.events[0].id, "2026-09-02|12:00|Canada|Valid older load");
  const cached = await service.getCurrentWeek();
  assert.equal(cached.events[0].id, "2026-09-02|12:00|Canada|Valid older load");
  assert.equal(calls, 1);
});

test("overlapping UTC week loads retain separate cache slots when the older week finishes last", async () => {
  let currentTime = new Date("2026-09-05T23:59:59.000Z");
  let calls = 0;
  const oldWeek = Promise.withResolvers();
  const newWeek = Promise.withResolvers();
  const provider = {
    fetchWeek() {
      calls += 1;
      if (calls === 1) return oldWeek.promise;
      if (calls === 2) return newWeek.promise;
      return Promise.resolve([
        { date: "2026-09-06", time: "12:00", country: "Japan", title: "Unexpected", impact: "high", type: "economic" },
      ]);
    },
  };
  const service = createMarketNewsService({ provider, now: () => currentTime });

  const oldWeekCall = service.getCurrentWeek();
  currentTime = new Date("2026-09-06T00:00:01.000Z");
  const newWeekCall = service.getCurrentWeek();
  newWeek.resolve([
    { date: "2026-09-06", time: "12:00", country: "Japan", title: "New week", impact: "high", type: "economic" },
  ]);
  const newWeekResult = await newWeekCall;
  oldWeek.resolve([
    { date: "2026-09-05", time: "12:00", country: "Japan", title: "Old week", impact: "high", type: "economic" },
  ]);
  await oldWeekCall;

  const cachedNewWeek = await service.getCurrentWeek();

  assert.equal(newWeekResult.events[0].id, "2026-09-06|12:00|Japan|New week");
  assert.equal(cachedNewWeek.events[0].id, "2026-09-06|12:00|Japan|New week");
  assert.deepEqual(cachedNewWeek.range, { from: "2026-09-06", to: "2026-09-12" });
  assert.equal(calls, 2);
});

test("service returns the last successful week as stale when revalidation fails", async () => {
  let fail = false;
  const provider = {
    async fetchWeek() {
      if (fail) throw new Error("offline");
      return [{ date: "2026-09-02", time: "12:00", country: "Canada", title: "Rate Decision", impact: "high", type: "economic" }];
    },
  };
  const service = createMarketNewsService({ provider, now: () => new Date("2026-09-02T12:00:00Z"), cacheTtlMs: 0 });
  await service.getCurrentWeek();
  fail = true;

  const result = await service.getCurrentWeek();

  assert.equal(result.state, "stale");
  assert.equal(result.events[0].id, "2026-09-02|12:00|Canada|Rate Decision");
});

test("simultaneous calls for one week share an in-flight provider request", async () => {
  let calls = 0;
  const resolveProviders = [];
  const provider = {
    fetchWeek() {
      calls += 1;
      return new Promise((resolve) => { resolveProviders.push(resolve); });
    },
  };
  const service = createMarketNewsService({ provider, now: () => new Date("2026-09-02T12:00:00Z") });

  const first = service.getCurrentWeek();
  const second = service.getCurrentWeek();
  for (const resolve of resolveProviders) {
    resolve([{ date: "2026-09-02", time: "12:00", country: "Australia", title: "GDP", impact: "medium", type: "economic" }]);
  }
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstResult.events[0].id, "2026-09-02|12:00|Australia|GDP");
  assert.equal(secondResult.events[0].id, "2026-09-02|12:00|Australia|GDP");
});

test("a new week does not reuse the prior week's cached result", async () => {
  let calls = 0;
  let currentTime = new Date("2026-09-05T12:00:00Z");
  const provider = {
    fetchWeek: async () => [{ date: "2026-09-05", time: "12:00", country: "Switzerland", title: `CPI ${++calls}`, impact: "medium", type: "economic" }],
  };
  const service = createMarketNewsService({ provider, now: () => currentTime });

  const first = await service.getCurrentWeek();
  currentTime = new Date("2026-09-06T12:00:00Z");
  const nextWeek = await service.getCurrentWeek();

  assert.equal(first.events[0].id, "2026-09-05|12:00|Switzerland|CPI 1");
  assert.equal(nextWeek.events[0].id, "2026-09-05|12:00|Switzerland|CPI 2");
  assert.deepEqual(nextWeek.range, { from: "2026-09-06", to: "2026-09-12" });
  assert.equal(calls, 2);
});
