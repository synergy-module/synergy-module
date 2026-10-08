import test from "node:test";
import assert from "node:assert/strict";
import { createAdminController } from "../../src/controllers/admin-controller.js";

function responseHarness() {
  return {
    statusCode: 200,
    body: null,
    rendered: null,
    redirectStatus: null,
    redirectPath: null,
    headers: {},
    set(headers) { Object.assign(this.headers, headers); return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    render(view, data) { this.rendered = { view, data }; return this; },
    redirect(status, path) { this.redirectStatus = status; this.redirectPath = path; return this; },
  };
}

function requestHarness(overrides = {}) {
  return {
    isSynergyModuleFragment: true,
    session: { operator: { id: "7", username: "admin", capabilities: ["admin"] } },
    params: { id: "42", userId: "42" },
    body: {},
    is: () => false,
    ...overrides,
  };
}

test("show renders the Admin dashboard through the MVC page model", async () => {
  const dashboard = { users: [{ id: "42" }], requests: [{ userId: "42" }] };
  const controller = createAdminController({ adminService: { getDashboard: () => dashboard } });
  const response = responseHarness();

  await controller.show(requestHarness(), response);

  assert.equal(response.rendered.view, "pages/admin");
  assert.equal(response.rendered.data.page.route.key, "admin");
  assert.equal(response.rendered.data.page.operator.username, "admin");
  assert.equal(response.rendered.data.page.data, dashboard);
});

test("successful mutations return refreshed safe user and request state", async () => {
  const calls = [];
  const dashboard = { users: [{ id: "42", banned: true, activeSessions: 0 }], requests: [] };
  const controller = createAdminController({
    adminService: {
      async banUser(input) { calls.push(input); },
      getDashboard: () => dashboard,
    },
  });
  const response = responseHarness();

  await controller.banUser(requestHarness({ body: { reason: "Policy violation" } }), response, assert.fail);

  assert.deepEqual(calls, [{
    userId: "42",
    actor: { id: "7", username: "admin", capabilities: ["admin"] },
    actorId: "7",
    reason: "Policy violation",
  }]);
  assert.deepEqual(response.body, { ok: true, user: dashboard.users[0], selfSignedOut: false });
});

test("known Admin failures return only safe public messages", async () => {
  const controller = createAdminController({
    adminService: {
      async signOutUser() {
        throw Object.assign(new Error("redis://private-store"), { code: "SESSION_INVALIDATION_FAILED" });
      },
    },
  });
  const response = responseHarness();

  await controller.signOutUser(requestHarness(), response, assert.fail);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    ok: false,
    error: "SESSION_INVALIDATION_FAILED",
    message: "SESSION CONTROL PARTIALLY FAILED :: REVIEW ACTIVE SESSIONS",
  });
  assert.doesNotMatch(JSON.stringify(response.body), /private-store/);
});

test("an already-decided indicator request returns a stable conflict", async () => {
  const controller = createAdminController({
    adminService: {
      decideIndicatorRequest() {
        throw Object.assign(new Error("private decision detail"), { code: "INDICATOR_REQUEST_NOT_PENDING" });
      },
    },
  });
  const response = responseHarness();

  await controller.decideIndicatorRequest(requestHarness({ body: { status: "DENIED" } }), response, assert.fail);

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    ok: false,
    error: "INDICATOR_REQUEST_NOT_PENDING",
    message: "INDICATOR REQUEST ALREADY DECIDED :: RESUBMIT TO REOPEN",
  });
  assert.doesNotMatch(JSON.stringify(response.body), /private decision detail/);
});

test("unknown Admin failures continue to the application error boundary", async () => {
  const failure = new Error("unexpected");
  const controller = createAdminController({
    adminService: { async unbanUser() { throw failure; } },
  });
  const response = responseHarness();
  let forwarded;

  await controller.unbanUser(requestHarness(), response, (error) => { forwarded = error; });

  assert.equal(forwarded, failure);
  assert.equal(response.body, null);
});

test("standard form mutations redirect back to Admin", async () => {
  const dashboard = { users: [{ id: "42", banned: false }], requests: [] };
  const controller = createAdminController({
    adminService: { unbanUser() {}, getDashboard: () => dashboard },
  });
  const response = responseHarness();

  await controller.unbanUser(requestHarness({ is: (type) => type === "application/x-www-form-urlencoded" }), response, assert.fail);

  assert.equal(response.redirectStatus, 303);
  assert.equal(response.redirectPath, "/admin");
});
