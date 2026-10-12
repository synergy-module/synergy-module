const observations = new WeakMap();
const timers = new WeakMap();

export function notifyWorkspace(root, kind, message) {
  const doc = root.ownerDocument;
  let preferences = {};
  try { preferences = JSON.parse(doc.documentElement.dataset.notifications || "{}"); } catch { /* Use the account defaults. */ }
  if (preferences[kind] === false || !root.isConnected) return;
  let output = doc.querySelector("[data-workspace-notification]");
  if (!output) {
    output = doc.createElement("output"); output.className = "workspace-notification";
    output.dataset.workspaceNotification = ""; output.setAttribute("role", "status");
    output.setAttribute("aria-live", "polite"); doc.body.append(output);
  }
  output.textContent = message; output.hidden = false;
  const win = doc.defaultView; win?.clearTimeout(timers.get(doc));
  timers.set(doc, win?.setTimeout(() => { output.hidden = true; }, 6500));
}

/** Notice state transitions during active-page polling, never announce old history on page load. */
export function observeWorkspaceUpdate(root, url, value) {
  let seen = observations.get(root); if (!seen) { seen = new Map(); observations.set(root, seen); }
  const change = (id, current, kind, message, qualifies = true) => {
    if (seen.has(id) && seen.get(id) !== current && qualifies) notifyWorkspace(root, kind, message);
    seen.set(id, current);
    if (seen.size > 500) seen.delete(seen.keys().next().value);
  };
  if (/^\/api\/practice(?:\/|$)/.test(url)) {
    const books = value.books ?? (value.mode === "PAPER" && value.id ? [value] : []);
    for (const book of books) change(`paper:${book.id}`, book.trades?.length ?? 0, "practiceResults", "Your paper account has new virtual fills. Open its results to review them.");
    if (value.environment === "PAPER") change("equity-paper", value.ledger?.[0]?.id ?? "", "practiceResults", "Your equity paper account has new virtual trades.");
  }
  if (url.startsWith("/api/robinhood/") || url.startsWith("/api/robinhood-brain/")) {
    for (const action of value.actions ?? value.ledger ?? (value.action ? [value.action] : [])) change(`order:${action.id}`, action.status, "orderUpdates", `A broker request is now ${String(action.status).replaceAll("_", " ")}. Review Accounts for details.`);
  }
  if (url.startsWith("/api/brain/")) {
    const runs = value.runs ?? (value.run ? [value.run] : value.id && value.status ? [value] : []);
    for (const run of runs) change(`research:${run.id}`, run.status, "researchCompleted", "Research has an update ready for your review.", ["completed", "awaiting_approval", "failed", "cancelled"].includes(run.status));
  }
}
