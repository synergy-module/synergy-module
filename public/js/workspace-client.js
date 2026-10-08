export function createWorkspaceRequest(root, fetchImpl) {
  const csrf = root.ownerDocument.querySelector('meta[name="csrf-token"]')?.content ?? "";
  return async (url, body, method = body === undefined ? "GET" : "POST", options = {}) => {
    const response = await fetchImpl(url, { method, credentials: "same-origin", headers: { Accept: "application/json", ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value) throw new Error(value?.message || "The workspace is unavailable. Your changes have not been saved.");
    return value;
  };
}

// Serialize each draft's writes across route changes. A later read waits for the
// previous page's final write, so returning immediately cannot restore stale text.
const pending = new Map();
export async function waitForDrafts() { await Promise.allSettled([...pending.values()]); }
export function queueDraft(request, name, fields, options) {
  const previous = pending.get(name) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => request(`/api/settings/drafts/${name}`, fields === null ? {} : { fields }, fields === null ? "DELETE" : "PUT", options));
  pending.set(name, work);
  const cleanup = () => { if (pending.get(name) === work) pending.delete(name); };
  work.then(cleanup, cleanup);
  return work;
}

export function persistForm(form, { name, fields, request, status, readExtra = () => ({}), windowRef = form.ownerDocument.defaultView }) {
  let dirty = false, disposed = false, revision = 0, timer;
  const message = (text) => { if (!disposed && status) status.textContent = text; };
  const values = () => ({ ...Object.fromEntries(fields.map((key) => [key, form.elements.namedItem(key)?.value ?? ""])), ...readExtra() });
  async function flush(keepalive = false) {
    windowRef.clearTimeout(timer);
    if (!dirty) return;
    const version = revision;
    try {
      await queueDraft(request, name, values(), { keepalive });
      if (version === revision) { dirty = false; message("Draft saved to your account"); }
    } catch { message("Draft not saved. Check your connection; your text is still here."); }
  }
  const changed = () => { dirty = true; revision++; message("Saving draft…"); windowRef.clearTimeout(timer); timer = windowRef.setTimeout(() => void flush(), 450); };
  const leaving = () => { void flush(true); };
  form.addEventListener("input", changed); form.addEventListener("change", changed);
  windowRef.addEventListener?.("pagehide", leaving);
  return {
    changed, flush,
    async clear() { windowRef.clearTimeout(timer); dirty = false; revision++; await queueDraft(request, name, null); message("Saved to your account"); },
    restore(saved) { if (dirty) return; for (const key of fields) if (typeof saved?.[key] === "string" && form.elements.namedItem(key)) form.elements.namedItem(key).value = saved[key]; },
    dispose() { leaving(); disposed = true; windowRef.clearTimeout(timer); form.removeEventListener("input", changed); form.removeEventListener("change", changed); windowRef.removeEventListener?.("pagehide", leaving); },
  };
}
