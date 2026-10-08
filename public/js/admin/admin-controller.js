const instances = new WeakMap();
const FAILURE_MESSAGE = "ADMIN REQUEST FAILED :: STATE UNCHANGED";

function updateUserRow(row, user, actionButton) {
  if (!row || String(user?.id) !== row.dataset.userId) return;
  row.dataset.userBanned = String(Boolean(user.banned));
  row.dataset.activeSessions = String(user.activeSessions ?? 0);
  const state = row.querySelector("[data-admin-ban-state]");
  const sessions = row.querySelector("[data-admin-session-count]");
  if (state) {
    state.textContent = user.banned ? "BANNED" : "ALLOWED";
    state.classList.toggle("admin-state-danger", Boolean(user.banned));
    state.classList.toggle("admin-state-ok", !user.banned);
  }
  if (sessions) sessions.textContent = String(user.activeSessions ?? 0);

  if (actionButton?.dataset.adminAction === "ban" && user.banned && row.dataset.adminUnbanEndpoint) {
    actionButton.dataset.adminAction = "unban";
    actionButton.dataset.adminActionEndpoint = row.dataset.adminUnbanEndpoint;
    actionButton.dataset.adminConfirm = `RESTORE SITE ACCESS FOR ${row.dataset.userId}?`;
    actionButton.textContent = "[ UNBAN ]";
    actionButton.classList.remove("btn-danger");
    if (actionButton.form) actionButton.form.action = row.dataset.adminUnbanEndpoint;
  } else if (actionButton?.dataset.adminAction === "unban" && !user.banned && row.dataset.adminBanEndpoint) {
    actionButton.dataset.adminAction = "ban";
    actionButton.dataset.adminActionEndpoint = row.dataset.adminBanEndpoint;
    actionButton.dataset.adminConfirm = `BAN ${row.dataset.userId} AND TERMINATE ALL SESSIONS?`;
    actionButton.textContent = "[ BAN ]";
    actionButton.classList.add("btn-danger");
    if (actionButton.form) actionButton.form.action = row.dataset.adminBanEndpoint;
  }
}

function updateRequestRow(row, request) {
  if (!row || String(request?.userId) !== row.dataset.userId) return;
  row.dataset.requestStatus = request.status;
  const status = row.querySelector("[data-admin-request-status]");
  if (!status) return;
  status.textContent = request.status;
  for (const className of [...status.classList]) {
    if (className.startsWith("indicator-state-")) status.classList.remove(className);
  }
  status.classList.add(`indicator-state-${request.status.toLowerCase()}`);
  const decidedBy = row.querySelector("[data-admin-decided-by]");
  const decidedByValue = row.querySelector("[data-admin-decided-by-value]");
  if (decidedBy && decidedByValue && typeof request.decidedBy === "string") {
    decidedByValue.textContent = request.decidedBy;
    decidedBy.hidden = false;
  }
  const decidedAt = row.querySelector("[data-admin-decided-at]");
  const decidedAtTime = decidedAt?.querySelector("time");
  if (decidedAt && decidedAtTime && typeof request.decidedAt === "string") {
    decidedAtTime.textContent = request.decidedAt;
    decidedAtTime.dateTime = request.decidedAt;
    decidedAt.hidden = false;
  }
  if (request.status !== "PENDING") row.querySelector("[data-admin-decision-controls]")?.remove();
}

function requestBody(button) {
  const form = button.form;
  if (button.dataset.adminAction === "ban") {
    return { reason: form?.elements.namedItem("reason")?.value ?? "" };
  }
  if (button.dataset.adminAction === "decision") {
    return { status: form?.elements.namedItem("status")?.value ?? button.dataset.adminDecision ?? "" };
  }
  return {};
}

export function initializeAdminPage(root, {
  fetchImpl = root.ownerDocument.defaultView.fetch.bind(root.ownerDocument.defaultView),
  showToast = () => {},
  windowRef = root.ownerDocument.defaultView,
} = {}) {
  if (instances.has(root)) return instances.get(root);
  let disposed = false;
  let submitting = false;
  let activeRequest = null;
  const disabledBeforeRequest = new Map();

  function report(message, { error = false } = {}) {
    const feedback = root.querySelector("[data-admin-feedback]");
    if (feedback) {
      feedback.textContent = message;
      feedback.classList.toggle("admin-feedback-error", error);
    }
    showToast(message);
  }

  function setBusy(busy) {
    root.setAttribute("aria-busy", String(busy));
    for (const button of root.querySelectorAll("[data-admin-action]")) {
      if (busy) {
        disabledBeforeRequest.set(button, button.disabled);
        button.disabled = true;
      } else {
        button.disabled = disabledBeforeRequest.get(button) ?? false;
      }
    }
    if (!busy) disabledBeforeRequest.clear();
  }

  async function onAction(event) {
    const button = event.target.closest?.("[data-admin-action]");
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    if (disposed || submitting || button.disabled) return;
    const endpoint = button.dataset.adminActionEndpoint ?? "";
    if (!endpoint.startsWith("/api/admin/")) {
      report(FAILURE_MESSAGE, { error: true });
      return;
    }
    const confirmation = button.dataset.adminConfirm ?? "CONFIRM ADMINISTRATIVE ACTION?";
    if (!windowRef.confirm(confirmation)) return;

    submitting = true;
    activeRequest = new windowRef.AbortController();
    setBusy(true);
    const csrfToken = button.form?.elements.namedItem("_csrf")?.value ?? "";
    const userRow = button.closest("[data-admin-user-row]");
    const requestRow = button.closest("[data-admin-request-row]");

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(requestBody(button)),
        signal: activeRequest.signal,
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        report(typeof payload.message === "string" ? payload.message : FAILURE_MESSAGE, { error: true });
        return;
      }
      if (payload.user) updateUserRow(userRow, payload.user, button);
      if (payload.request) updateRequestRow(requestRow, payload.request);
      if (payload.selfSignedOut === true && root.dataset.currentUserId === userRow?.dataset.userId) {
        windowRef.location.href = "/login";
        return;
      }
      report("ADMIN STATE UPDATED");
    } catch (error) {
      if (error?.name !== "AbortError" && !disposed) report(FAILURE_MESSAGE, { error: true });
    } finally {
      submitting = false;
      activeRequest = null;
      if (!disposed) setBusy(false);
    }
  }

  root.addEventListener("click", onAction);
  const instance = {
    dispose() {
      disposed = true;
      activeRequest?.abort();
      root.removeEventListener("click", onAction);
      instances.delete(root);
    },
  };
  instances.set(root, instance);
  return instance;
}
