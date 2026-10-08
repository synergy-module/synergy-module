import assert from "node:assert/strict";
import test from "node:test";
import { ensureCsrfToken, requireCsrf } from "../../src/security/csrf.js";
import { createJsonResponseHarness } from "../helpers/http-test-helpers.js";

test("ensureCsrfToken creates one 32-byte base64url token per session", () => {
  const request = { session: {} };
  const first = ensureCsrfToken(request);
  const second = ensureCsrfToken(request);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.equal(second, first);
  assert.equal(request.session.csrfToken, first);
});

test("requireCsrf accepts the session token only from body or header", () => {
  const token = "csrf-value";
  const accepted = [];
  requireCsrf({ session: { csrfToken: token }, body: {}, query: { _csrf: token }, get: (name) => name === "X-CSRF-Token" ? token : undefined }, {}, () => accepted.push(true));
  assert.deepEqual(accepted, [true]);

  const bodyAccepted = [];
  requireCsrf({ session: { csrfToken: token }, body: { _csrf: token }, query: {}, get: () => undefined }, {}, () => bodyAccepted.push(true));
  assert.deepEqual(bodyAccepted, [true]);

  const queryResponse = createJsonResponseHarness();
  requireCsrf({ session: { csrfToken: token }, body: {}, query: { _csrf: token }, get: () => undefined }, queryResponse, () => assert.fail("query token accepted"));
  assert.equal(queryResponse.statusCode, 403);
});

test("requireCsrf returns a stable 403 response for missing, mismatched, or differently sized tokens", () => {
  for (const supplied of [undefined, "wrong", "csrf-value-extra"]) {
    const response = createJsonResponseHarness();
    requireCsrf({ session: { csrfToken: "csrf-value" }, body: supplied === undefined ? {} : { _csrf: supplied }, get: () => undefined }, response, () => assert.fail("next called"));
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { error: "CSRF_INVALID", message: "REQUEST REJECTED :: SESSION TOKEN INVALID" });
  }
});
