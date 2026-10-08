import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initializeAdminPage } from "../../public/js/admin/admin-controller.js";

function adminFixture() {
  const dom = new JSDOM(`
    <section data-admin-root data-current-user-id="7" aria-busy="false">
      <ol data-admin-users>
        <li data-admin-user-row data-user-id="42" data-user-banned="false" data-active-sessions="2"
          data-admin-ban-endpoint="/api/admin/users/42/ban"
          data-admin-unban-endpoint="/api/admin/users/42/unban">
          <output data-admin-ban-state>ALLOWED</output>
          <strong data-admin-session-count>2</strong>
          <form>
            <input name="_csrf" value="csrf-session-token">
            <input name="reason" value="Administrative action">
            <button type="submit" data-admin-action="ban"
              data-admin-action-endpoint="/api/admin/users/42/ban"
              data-admin-confirm="BAN MEMBER?">[ BAN ]</button>
          </form>
          <form>
            <input name="_csrf" value="csrf-session-token">
            <button type="submit" data-admin-action="sign-out"
              data-admin-action-endpoint="/api/admin/users/42/sign-out"
              data-admin-confirm="SIGN OUT MEMBER?">[ SIGN OUT ]</button>
          </form>
        </li>
        <li data-admin-user-row data-user-id="7" data-user-banned="false" data-active-sessions="1">
          <output data-admin-ban-state>ALLOWED</output>
          <strong data-admin-session-count>1</strong>
          <form>
            <input name="_csrf" value="csrf-session-token">
            <button type="submit" data-admin-action="sign-out"
              data-admin-action-endpoint="/api/admin/users/7/sign-out"
              data-admin-confirm="SIGN OUT SELF?">[ SIGN OUT ]</button>
          </form>
        </li>
      </ol>
      <ol data-admin-requests>
        <li data-admin-request-row data-user-id="42" data-request-status="PENDING">
          <output data-admin-request-status>PENDING</output>
          <span data-admin-decided-by hidden>DECIDED BY :: <span data-admin-decided-by-value></span></span>
          <span data-admin-decided-at hidden>DECIDED AT :: <time></time></span>
          <div data-admin-decision-controls>
            <form>
              <input name="_csrf" value="csrf-session-token">
              <input name="status" value="GRANTED">
              <button type="submit" data-admin-action="decision" data-admin-decision="GRANTED"
                data-admin-action-endpoint="/api/admin/indicator-requests/42/decision"
                data-admin-confirm="GRANT REQUEST?">[ GRANTED ]</button>
            </form>
          </div>
        </li>
      </ol>
      <output data-admin-feedback></output>
    </section>
  `, { url: "http://localhost/admin" });
  return { dom, root: dom.window.document.querySelector("[data-admin-root]") };
}

async function settle(dom) {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
}

test("confirmation cancellation leaves the fallback form untouched and sends no request", async () => {
  const { dom, root } = adminFixture();
  let calls = 0;
  const instance = initializeAdminPage(root, {
    fetchImpl: async () => { calls += 1; },
    showToast() {},
    windowRef: { confirm: () => false, location: { href: "" }, AbortController: dom.window.AbortController },
  });

  root.querySelector('[data-admin-action="ban"]').click();
  await settle(dom);

  assert.equal(calls, 0);
  assert.equal(root.getAttribute("aria-busy"), "false");
  instance.dispose();
  dom.window.close();
});

test("user action sends JSON with CSRF and updates row state using text", async () => {
  const { dom, root } = adminFixture();
  let called;
  const instance = initializeAdminPage(root, {
    fetchImpl: async (url, options) => {
      called = { url, options };
      return new Response(JSON.stringify({
        ok: true,
        user: { id: "42", banned: true, activeSessions: 0 },
        selfSignedOut: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    showToast() {},
    windowRef: { confirm: () => true, location: { href: "" }, AbortController: dom.window.AbortController },
  });

  root.querySelector('[data-admin-action="ban"]').click();
  await settle(dom);

  assert.equal(called.url, "/api/admin/users/42/ban");
  assert.equal(called.options.method, "POST");
  assert.equal(called.options.headers["X-CSRF-Token"], "csrf-session-token");
  assert.deepEqual(JSON.parse(called.options.body), { reason: "Administrative action" });
  const row = root.querySelector('[data-admin-user-row][data-user-id="42"]');
  assert.equal(row.dataset.userBanned, "true");
  assert.equal(row.querySelector("[data-admin-ban-state]").textContent, "BANNED");
  assert.equal(row.querySelector("[data-admin-session-count]").textContent, "0");
  assert.equal(row.querySelector('[data-admin-action="unban"]').textContent, "[ UNBAN ]");
  assert.equal(row.querySelector('[data-admin-action="unban"]').dataset.adminActionEndpoint, "/api/admin/users/42/unban");
  assert.match(row.querySelector('[data-admin-action="unban"]').dataset.adminConfirm, /RESTORE SITE ACCESS/);
  instance.dispose();
  dom.window.close();
});

test("overlapping actions are ignored until the active request settles", async () => {
  const { dom, root } = adminFixture();
  let resolveRequest;
  let calls = 0;
  const response = new Promise((resolve) => { resolveRequest = resolve; });
  const instance = initializeAdminPage(root, {
    fetchImpl: async () => { calls += 1; return response; },
    showToast() {},
    windowRef: { confirm: () => true, location: { href: "" }, AbortController: dom.window.AbortController },
  });

  root.querySelector('[data-admin-action="ban"]').click();
  root.querySelector('[data-admin-action="sign-out"]').click();

  assert.equal(calls, 1);
  assert.equal(root.getAttribute("aria-busy"), "true");
  assert.ok([...root.querySelectorAll("[data-admin-action]")].every((button) => button.disabled));
  resolveRequest(new Response(JSON.stringify({ ok: true, user: { id: "42", banned: true, activeSessions: 0 } }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  await settle(dom);
  assert.equal(root.getAttribute("aria-busy"), "false");
  instance.dispose();
  dom.window.close();
});

test("indicator decisions update the request row without interpreting HTML", async () => {
  const { dom, root } = adminFixture();
  const instance = initializeAdminPage(root, {
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      request: {
        userId: "42",
        status: "GRANTED",
        decidedBy: "<img src=x onerror=privateFailure()>",
        decidedAt: "2026-09-02T14:30:00.000Z",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    showToast() {},
    windowRef: { confirm: () => true, location: { href: "" }, AbortController: dom.window.AbortController },
  });

  root.querySelector('[data-admin-action="decision"]').click();
  await settle(dom);

  const row = root.querySelector("[data-admin-request-row]");
  assert.equal(row.dataset.requestStatus, "GRANTED");
  assert.equal(row.querySelector("[data-admin-request-status]").textContent, "GRANTED");
  assert.equal(row.querySelector("[data-admin-request-status]").querySelector("script"), null);
  assert.equal(row.querySelector("[data-admin-decided-by]").hidden, false);
  assert.equal(row.querySelector("[data-admin-decided-by-value]").textContent, "<img src=x onerror=privateFailure()>");
  assert.equal(row.querySelector("[data-admin-decided-by-value] img"), null);
  assert.equal(row.querySelector("[data-admin-decided-at]").hidden, false);
  assert.equal(row.querySelector("[data-admin-decided-at] time").dateTime, "2026-09-02T14:30:00.000Z");
  assert.equal(row.querySelector("[data-admin-decision-controls]"), null);
  assert.equal(row.querySelectorAll('[data-admin-action="decision"]').length, 0);
  instance.dispose();
  dom.window.close();
});

test("safe API failures remain on the page and render feedback as text", async () => {
  const { dom, root } = adminFixture();
  const toasts = [];
  const instance = initializeAdminPage(root, {
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false, error: "SELF_BAN_FORBIDDEN", message: "<img src=x onerror=alert(1)>",
    }), { status: 409, headers: { "Content-Type": "application/json" } }),
    showToast: (message) => toasts.push(message),
    windowRef: { confirm: () => true, location: { href: "" }, AbortController: dom.window.AbortController },
  });

  root.querySelector('[data-admin-action="ban"]').click();
  await settle(dom);

  const feedback = root.querySelector("[data-admin-feedback]");
  assert.equal(feedback.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(feedback.querySelector("img"), null);
  assert.deepEqual(toasts, ["<img src=x onerror=alert(1)>"]);
  assert.equal(dom.window.location.pathname, "/admin");
  instance.dispose();
  dom.window.close();
});

test("self sign-out redirects to login after the server confirms invalidation", async () => {
  const { dom, root } = adminFixture();
  const location = { href: "" };
  const instance = initializeAdminPage(root, {
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true, user: { id: "7", banned: false, activeSessions: 0 }, selfSignedOut: true, redirectTo: "/login",
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    showToast() {},
    windowRef: { confirm: () => true, location, AbortController: dom.window.AbortController },
  });

  root.querySelector('[data-admin-user-row][data-user-id="7"] [data-admin-action="sign-out"]').click();
  await settle(dom);

  assert.equal(location.href, "/login");
  instance.dispose();
  dom.window.close();
});

test("dispose removes action handling and aborts an active request", () => {
  const { dom, root } = adminFixture();
  const signals = [];
  const instance = initializeAdminPage(root, {
    fetchImpl: async (_url, options) => { signals.push(options.signal); return new Promise(() => {}); },
    showToast() {},
    windowRef: { confirm: () => true, location: { href: "" }, AbortController: dom.window.AbortController },
  });

  root.querySelector('[data-admin-action="ban"]').click();
  instance.dispose();
  root.querySelector('[data-admin-action="sign-out"]').click();

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  dom.window.close();
});
