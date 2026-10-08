import { createBrainNetwork } from "./brain-network.js";
import { createWorkspaceRequest } from "../workspace-client.js";

export function initializeBrainCanvas(root, { fetchImpl, windowRef = root.ownerDocument.defaultView, navigate = (url) => windowRef.location.assign(url) }) {
  const destinations = { mission: "/research", knowledge: "/research?view=knowledge", checks: "/settings?section=system", robinhood: "/accounts", network: "/brain" };
  const network = createBrainNetwork(root.querySelector("[data-brain-network]"), { onNavigate: (section) => navigate(destinations[section] ?? "/research") });
  const request = createWorkspaceRequest(root, fetchImpl), feedback = root.querySelector("[data-canvas-feedback]");
  let disposed = false, timer;
  async function refresh() {
    try {
      const state = await request("/api/brain/state");
      if (disposed) return;
      network.update({ ...state, brokerState: state.robinhoodState }); feedback.hidden = true;
      if (state.runs?.some((run) => run.status === "running")) timer = windowRef.setTimeout(refresh, 2000);
    } catch { if (!disposed) { feedback.hidden = false; feedback.textContent = "Network view available. Saved activity could not be loaded; refresh to retry."; } }
  }
  void refresh();
  return { dispose() { disposed = true; windowRef.clearTimeout(timer); network.dispose(); } };
}
