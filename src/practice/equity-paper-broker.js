import { createHash } from "node:crypto";
import { brainError } from "../robinhood-brain/risk-policy.js";

// An explicit read-only adapter: paper execution never receives brokerage write
// methods. Its policies, balances, workers and ledger live in a separate row.
export function createEquityPaperBroker({ broker, repository }) {
  const key = owner => {
    if (typeof owner !== "string" || !owner.trim() || owner.length > 200) throw brainError("INPUT", "Sign in to use equity paper trading.", 401);
    return `practice:${createHash("sha256").update(owner).digest("hex")}:equities`;
  };
  const deny = () => { throw brainError("AUTHORITY", "The paper workspace cannot prepare or submit real brokerage orders.", 423); };
  return {
    getStorageStatus: () => repository.getStorageStatus(),
    async readBrainWorkspace(owner) { return (await repository.read(key(owner))).agentic ?? null; },
    updateBrainWorkspace: (owner, change) => repository.update(key(owner), state => {
      state.actions ??= [];
      return change(state);
    }),
    async state(owner) {
      const state = await broker.state(owner);
      return { configured: state.configured, connected: state.connected, liveEnabled: false, paused: true, tools: state.tools, actions: [] };
    },
    read: (...args) => broker.read(...args),
    discover: (...args) => broker.discover(...args),
    propose: deny,
    submitAgentic: deny,
  };
}
