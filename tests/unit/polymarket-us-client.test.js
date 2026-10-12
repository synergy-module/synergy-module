import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { verify } from "node:crypto";
import { createPolymarketUsClient } from "../../src/polymarket/polymarket-us-client.js";
import { usFixture } from "../helpers/polymarket-us-test-helpers.js";

test("US reads sign the exact wire path with Ed25519 and project decimal contracts without bank details", async t => {
  const fixture = usFixture(), requests = [];
  const server = createServer((req, res) => {
    requests.push(req);
    const timestamp = req.headers["x-pm-timestamp"];
    assert.equal(req.method, "GET"); assert.equal(req.headers["x-pm-access-key"], fixture.credentials.keyId);
    assert.ok(verify(null, Buffer.from(timestamp + req.method + req.url), fixture.publicKey, Buffer.from(req.headers["x-pm-signature"], "base64")));
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(fixture.data[req.url]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createPolymarketUsClient({ fetchImpl: (input, options) => {
    const url = new URL(input); assert.equal(url.origin, "https://api.polymarket.us"); assert.equal(options.redirect, "error");
    return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, options);
  } });
  const [balances, positions, orders] = await Promise.all([client.balances(fixture.credentials), client.positions(fixture.credentials), client.orders(fixture.credentials)]);
  assert.equal(requests.length, 3); assert.equal(balances.items[0].buyingPower, 100);
  assert.ok(!JSON.stringify(balances).includes("private-bank-id"));
  assert.equal(positions.items[0].netPosition, 2.5); assert.equal(orders.items[0].price.value, 0.5);
});

test("US credential errors are validated before transport and upstream errors cannot echo secrets", async () => {
  const fixture = usFixture({ status: 401 });
  await assert.rejects(fixture.client.balances({ ...fixture.credentials, owner: "other" }), { code: "POLY_US_INPUT" });
  await assert.rejects(fixture.client.balances({ ...fixture.credentials, secretKey: "not-base64" }), { code: "POLY_US_INPUT" });
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(fixture.client.balances(fixture.credentials), error => error.code === "POLY_US_AUTH" && !error.message.includes(fixture.credentials.secretKey));
});

test("US partial position and order responses are labeled and oversized responses are rejected", async () => {
  const fixture = usFixture();
  fixture.data["/v1/portfolio/positions"].nextCursor = "next-page";
  fixture.data["/v1/orders/open"].orders = Array.from({ length: 101 }, () => fixture.data["/v1/orders/open"].orders[0]);
  assert.equal((await fixture.client.positions(fixture.credentials)).partial, true);
  const orders = await fixture.client.orders(fixture.credentials); assert.equal(orders.items.length, 100); assert.equal(orders.partial, true);
  const oversized = createPolymarketUsClient({ fetchImpl: async () => new Response("x".repeat(2_000_001)) });
  await assert.rejects(oversized.balances(fixture.credentials), { code: "POLY_US_DATA" });
});
