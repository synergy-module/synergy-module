const initializedRoots = new WeakSet();

export function initializePageInteractions(root, { showToast = () => {} } = {}) {
  if (!root || initializedRoots.has(root)) return;
  initializedRoots.add(root);
  root.addEventListener("click", async (event) => {
    const target = event.target.closest?.("[data-alert-standby], [data-copy-target]");
    if (!target || !root.contains(target)) return;
    if (target.hasAttribute("data-alert-standby")) return showToast("ALERT ENGINE :: STANDBY :: MODULE PENDING");
    const text = root.querySelector(target.dataset.copyTarget)?.textContent?.trim() ?? "";
    try { await root.ownerDocument.defaultView?.navigator.clipboard?.writeText(text); } catch { /* optional permission */ }
    showToast(target.dataset.copyMessage || "COPIED");
  });
}
