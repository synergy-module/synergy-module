import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initializeIndicatorAccessPage } from "../../public/js/indicators/indicator-access-controller.js";

function indicatorFixture() {
  const dom = new JSDOM(`
    <section data-indicator-access-root data-request-status="NOT_REQUESTED" aria-busy="false">
      <output data-indicator-request-status>NOT REQUESTED</output>
      <form data-indicator-request-form>
        <input name="_csrf" value="csrf-session-token">
        <input name="tradingViewUsername" value="omen_tv">
        <input name="consent" type="checkbox" value="true" checked>
        <button type="submit" data-indicator-submit>[ REQUEST ACCESS TO ALL ]</button>
      </form>
      <output data-indicator-request-feedback></output>
    </section>
  `, { url: "http://localhost/indicators" });
  return { dom, root: dom.window.document.querySelector("[data-indicator-access-root]") };
}

function submit(root) {
  root.querySelector("form").dispatchEvent(new root.ownerDocument.defaultView.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
}

async function settle(dom) {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
}

test("submission sends JSON with the session CSRF header and renders pending as text", async () => {
  const { dom, root } = indicatorFixture();
  let called;
  const instance = initializeIndicatorAccessPage(root, {
    fetchImpl: async (url, options) => {
      called = { url, options };
      return new Response(JSON.stringify({
        ok: true,
        request: { status: "PENDING", tradingViewUsername: "omen_tv", indicatorIds: ["demo-one"] },
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    },
    showToast() {},
  });

  submit(root);
  await settle(dom);

  assert.equal(called.url, "/api/indicator-access/requests");
  assert.equal(called.options.method, "POST");
  assert.equal(called.options.headers["X-CSRF-Token"], "csrf-session-token");
  assert.deepEqual(JSON.parse(called.options.body), { tradingViewUsername: "omen_tv", consent: true });
  assert.equal(root.dataset.requestStatus, "PENDING");
  assert.equal(root.querySelector("[data-indicator-request-status]").textContent, "PENDING");
  assert.equal(root.getAttribute("aria-busy"), "false");
  assert.equal(root.querySelector("[data-indicator-submit]").disabled, false);
  instance.dispose();
  dom.window.close();
});

test("overlapping submissions are ignored while one request is active", async () => {
  const { dom, root } = indicatorFixture();
  let resolveRequest;
  let calls = 0;
  const pendingResponse = new Promise((resolve) => { resolveRequest = resolve; });
  const instance = initializeIndicatorAccessPage(root, {
    fetchImpl: async () => {
      calls += 1;
      return pendingResponse;
    },
    showToast() {},
  });

  submit(root);
  submit(root);

  assert.equal(calls, 1);
  assert.equal(root.getAttribute("aria-busy"), "true");
  assert.equal(root.querySelector("[data-indicator-submit]").disabled, true);
  resolveRequest(new Response(JSON.stringify({ ok: true, request: { status: "PENDING" } }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  }));
  await settle(dom);
  instance.dispose();
  dom.window.close();
});

test("validation failures remain on the route and render untrusted copy as text", async () => {
  const { dom, root } = indicatorFixture();
  const toasts = [];
  const instance = initializeIndicatorAccessPage(root, {
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      error: "TRADINGVIEW_USERNAME_INVALID",
      message: "<img src=x onerror=alert(1)>",
    }), { status: 422, headers: { "Content-Type": "application/json" } }),
    showToast: (message) => toasts.push(message),
  });

  submit(root);
  await settle(dom);

  const feedback = root.querySelector("[data-indicator-request-feedback]");
  assert.equal(feedback.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(feedback.querySelector("img"), null);
  assert.deepEqual(toasts, ["<img src=x onerror=alert(1)>"]);
  assert.equal(root.dataset.requestStatus, "NOT_REQUESTED");
  assert.equal(dom.window.location.pathname, "/indicators");
  instance.dispose();
  dom.window.close();
});

test("dispose removes submission handling and aborts an active request", () => {
  const { dom, root } = indicatorFixture();
  const signals = [];
  const instance = initializeIndicatorAccessPage(root, {
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    },
    showToast() {},
  });

  submit(root);
  instance.dispose();
  submit(root);

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  dom.window.close();
});
