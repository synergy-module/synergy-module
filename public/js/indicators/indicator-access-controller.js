const instances = new WeakMap();
const FAILURE_MESSAGE = "REQUEST FAILED :: TRY AGAIN";

function updateStatus(root, status) {
  const statusNode = root.querySelector("[data-indicator-request-status]");
  root.dataset.requestStatus = status;
  if (!statusNode) return;
  statusNode.textContent = status.replaceAll("_", " ");
  for (const className of [...statusNode.classList]) {
    if (className.startsWith("indicator-state-")) statusNode.classList.remove(className);
  }
  statusNode.classList.add(`indicator-state-${status.toLowerCase()}`);
}

export function initializeIndicatorAccessPage(root, {
  fetchImpl = root.ownerDocument.defaultView.fetch.bind(root.ownerDocument.defaultView),
  showToast = () => {},
} = {}) {
  if (instances.has(root)) return instances.get(root);
  const form = root.querySelector("[data-indicator-request-form]");
  const submitButton = root.querySelector("[data-indicator-submit]");
  const feedback = root.querySelector("[data-indicator-request-feedback]");
  const windowRef = root.ownerDocument.defaultView;
  let submitting = false;
  let disposed = false;
  let activeRequest = null;

  function setBusy(busy) {
    root.setAttribute("aria-busy", String(busy));
    if (submitButton) submitButton.disabled = busy || root.dataset.catalogAvailable === "false";
  }

  function report(message, { error = false } = {}) {
    if (feedback) {
      feedback.textContent = message;
      feedback.classList.toggle("indicator-feedback-error", error);
    }
    showToast(message);
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (disposed || submitting || !form) return;
    submitting = true;
    activeRequest = new windowRef.AbortController();
    setBusy(true);
    const username = form.elements.namedItem("tradingViewUsername")?.value ?? "";
    const consent = Boolean(form.elements.namedItem("consent")?.checked);
    const csrfToken = form.elements.namedItem("_csrf")?.value ?? "";

    try {
      const response = await fetchImpl("/api/indicator-access/requests", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ tradingViewUsername: username, consent }),
        signal: activeRequest.signal,
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok || payload.request?.status !== "PENDING") {
        report(typeof payload.message === "string" ? payload.message : FAILURE_MESSAGE, { error: true });
        return;
      }
      updateStatus(root, payload.request.status);
      const consentField = form.elements.namedItem("consent");
      if (consentField) consentField.checked = false;
      report("REQUEST LOGGED :: MANUAL AUTHOR REVIEW PENDING");
    } catch (error) {
      if (error?.name !== "AbortError" && !disposed) report(FAILURE_MESSAGE, { error: true });
    } finally {
      submitting = false;
      activeRequest = null;
      if (!disposed) setBusy(false);
    }
  }

  form?.addEventListener("submit", onSubmit);
  const instance = {
    dispose() {
      disposed = true;
      activeRequest?.abort();
      form?.removeEventListener("submit", onSubmit);
      instances.delete(root);
    },
  };
  instances.set(root, instance);
  return instance;
}
