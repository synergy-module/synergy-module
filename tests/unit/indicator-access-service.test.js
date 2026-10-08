import test from "node:test";
import assert from "node:assert/strict";
import { createIndicatorCatalog } from "../../src/config/indicator-catalog.js";
import { createInMemoryIndicatorRequestRepository } from "../../src/repositories/in-memory-indicator-request-repository.js";
import { createIndicatorAccessService } from "../../src/services/indicator-access-service.js";

function createIndicatorHarness({ catalog: catalogOverride } = {}) {
  const now = () => "2026-09-02T12:00:00.000Z";
  const catalog = catalogOverride ?? createIndicatorCatalog({ authMode: "demo" });
  const requestRepository = createInMemoryIndicatorRequestRepository({ now });
  const operator = { id: "42", username: "omen", displayName: "Omen" };
  const service = createIndicatorAccessService({ catalog, requestRepository, now });
  return { catalog, requestRepository, operator, service };
}

test("demo catalog entries are explicitly labeled and deeply immutable", () => {
  const { catalog } = createIndicatorHarness();

  assert.ok(catalog.length >= 2);
  assert.ok(catalog.every((indicator) => indicator.demo === true && indicator.name.startsWith("DEMO ::")));
  assert.throws(() => { catalog[0].name = "changed"; }, TypeError);
  assert.throws(() => { catalog.push({ id: "changed" }); }, TypeError);
});

test("Discord mode starts with an empty immutable catalog", () => {
  const catalog = createIndicatorCatalog({ authMode: "discord" });

  assert.deepEqual(catalog, []);
  assert.throws(() => { catalog.push({ id: "changed" }); }, TypeError);
});

test("configured catalogs reject links outside HTTPS TradingView hosts", () => {
  const record = {
    id: "private-one",
    name: "PRIVATE ONE",
    description: "Configured script",
    version: "1.0.0",
    active: true,
    demo: false,
  };

  for (const tradingViewUrl of [
    "javascript:alert(1)",
    "https://example.com/script/private-one/",
    "http://www.tradingview.com/script/private-one/",
    "https://tradingview.com.example.com/script/private-one/",
  ]) {
    assert.throws(
      () => createIndicatorCatalog({
        authMode: "discord",
        configuredIndicators: [{ ...record, tradingViewUrl }],
      }),
      { code: "INDICATOR_TRADINGVIEW_URL_INVALID" },
    );
  }

  const catalog = createIndicatorCatalog({
    authMode: "discord",
    configuredIndicators: [{
      ...record,
      tradingViewUrl: "https://www.tradingview.com/script/private-one/",
    }],
  });
  assert.equal(catalog[0].tradingViewUrl, "https://www.tradingview.com/script/private-one/");
  assert.throws(() => { catalog[0].tradingViewUrl = "https://example.com"; }, TypeError);
});

test("request all validates consent and stores every active indicator", () => {
  const { service, catalog, operator } = createIndicatorHarness();

  assert.throws(
    () => service.requestAll({ operator, tradingViewUsername: "valid_user", consent: false }),
    { code: "CONSENT_REQUIRED" },
  );
  const request = service.requestAll({ operator, tradingViewUsername: "valid_user", consent: true });

  assert.equal(request.status, "PENDING");
  assert.deepEqual(request.indicatorIds, catalog.filter((item) => item.active).map((item) => item.id));
  assert.equal(request.discordUsername, "omen");
});

test("request all accepts exact username boundaries and rejects malformed values", () => {
  const { service, operator } = createIndicatorHarness();

  for (const username of ["abc", "A_b-9", "a".repeat(64)]) {
    assert.equal(service.requestAll({ operator, tradingViewUsername: username, consent: true }).tradingViewUsername, username);
  }
  for (const username of ["ab", "a".repeat(65), "bad name", "bad.name", "<script>", null]) {
    assert.throws(
      () => service.requestAll({ operator, tradingViewUsername: username, consent: true }),
      { code: "TRADINGVIEW_USERNAME_INVALID" },
    );
  }
});

test("request all rejects a catalog without active indicators", () => {
  const { service, operator } = createIndicatorHarness({
    catalog: Object.freeze([Object.freeze({
      id: "inactive", name: "INACTIVE", description: "not requestable",
      tradingViewUrl: null, version: "demo", active: false, demo: true,
    })]),
  });

  assert.throws(
    () => service.requestAll({ operator, tradingViewUsername: "valid_user", consent: true }),
    { code: "INDICATORS_UNAVAILABLE" },
  );
});

test("member view reports not requested without inventing a repository record", async () => {
  const { service, requestRepository } = createIndicatorHarness();

  const view = await service.getMemberView("42");

  assert.equal(view.status, "NOT_REQUESTED");
  assert.equal(view.request, null);
  assert.equal(view.catalog.length, 2);
  assert.equal(requestRepository.list().length, 0);
});

test("resubmission corrects the username and returns a decided request to pending", () => {
  const { service, requestRepository, operator } = createIndicatorHarness();
  service.requestAll({ operator, tradingViewUsername: "first_user", consent: true });
  requestRepository.decide({ userId: operator.id, status: "DENIED", actorId: "admin" });

  const request = service.requestAll({ operator, tradingViewUsername: "second_user", consent: true });

  assert.equal(request.tradingViewUsername, "second_user");
  assert.equal(request.status, "PENDING");
  assert.equal(request.decidedBy, null);
  assert.equal(request.decidedAt, null);
});
