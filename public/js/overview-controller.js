import { createWorkspaceRequest } from "./workspace-client.js";
export function initializeOverview(root, { fetchImpl }) {
  let disposed = false;
  const request = createWorkspaceRequest(root, fetchImpl);
  const set = (name, text) => { if (!disposed) { const node = root.querySelector(`[data-overview-${name}]`); if (node) node.textContent = text; } };
  void Promise.allSettled([request("/api/settings"), request("/api/brain/state"), request("/api/robinhood/state")]).then(([settings, brain, broker]) => {
    const configured = settings.value?.providers?.filter((provider) => provider.configured).length;
    set("providers", settings.status === "fulfilled" ? `${configured} of 3 providers configured · ${settings.value.storage.persistent ? "saved to your account" : "temporary storage"}` : "Provider status unavailable");
    set("research", brain.status === "fulfilled" ? `${brain.value.runs?.length ?? 0} saved missions · ${brain.value.documents?.length ?? 0} knowledge sources` : "Research status unavailable");
    set("broker", broker.status === "fulfilled" ? broker.value.connected ? "Robinhood connected" : "Robinhood is not connected yet" : "Connection status unavailable");
    set("status", [settings, brain, broker].every((result) => result.status === "fulfilled") ? "YOUR SAVED WORKSPACE" : "SOME STATUS CHECKS UNAVAILABLE");
    set("lock", settings.value?.paidCallsEnabled ? "Starting AI research can incur provider charges. Broker changes require your separate approval." : "Paid AI calls are locked. You can explore the brain and run an offline research demo.");
  });
  return { dispose() { disposed = true; } };
}
