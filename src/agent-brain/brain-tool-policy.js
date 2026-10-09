export const BRAIN_SECTIONS = Object.freeze([
  ...["planner", "researcher", "strategist", "critic"].map(id => ({ id: `agent:${id}`, name: id[0].toUpperCase() + id.slice(1), kind: "agent", role: id })),
  ...["risk", "retrieval", "memory", "robinhood"].map(id => ({ id: `module:${id}`, name: id[0].toUpperCase() + id.slice(1), kind: "module" })),
]);
export const BRAIN_TOOL_CATALOG = Object.freeze([
  { id: "synergy-mcp", name: "Synergy MCP", module: "module:retrieval", actions: ["synergy.search", "synergy.read"], description: "Search shared archive names and read cited text excerpts. Read-only database access." },
  { id: "context", name: "Market context", module: "module:retrieval", actions: ["context.read"], description: "Read the operator's supplied market snapshot and risk settings." },
  { id: "calendar", name: "Economic calendar", module: "module:retrieval", actions: ["calendar.read"], description: "Read dated economic schedules and report missing or stale coverage." },
  { id: "knowledge", name: "Knowledge library", module: "module:retrieval", actions: ["knowledge.search"], description: "Search the current operator's saved sources." },
  { id: "journal", name: "Trading journal", module: "module:retrieval", actions: ["journal.search"], description: "Search the current operator's journal, subject to journal permissions." },
  { id: "memory", name: "Approved memory", module: "module:memory", actions: ["memory.search"], description: "Retrieve research previously approved by the current operator." },
  { id: "risk", name: "Risk calculator", module: "module:risk", actions: ["risk.check"], roles: ["strategist", "critic"], description: "Check position sizing and risk limits. Disabling access cannot bypass the final safety checks." },
  { id: "robinhood", name: "Robinhood", module: "module:robinhood", actions: ["robinhood.tools", "robinhood.read", "robinhood.propose"], description: "Discover broker tools and read permitted account data. Only the strategist can propose an action; execution still requires separate approval." },
]);
const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === "object" && !Array.isArray(value);
export function defaultBrainToolPolicy() {
  return { version: 0, updatedAt: null, updatedBy: null, history: [], assignments: {
    "agent:planner": ["context", "knowledge", "memory", "robinhood"],
    "agent:researcher": ["context", "knowledge", "memory", "journal", "calendar", "robinhood"],
    "agent:strategist": ["context", "knowledge", "memory", "journal", "calendar", "risk", "robinhood"],
    "agent:critic": ["context", "knowledge", "memory", "journal", "calendar", "risk", "robinhood"],
    "module:retrieval": ["context", "knowledge", "journal", "calendar"],
    "module:memory": ["memory"], "module:risk": ["risk"], "module:robinhood": ["robinhood"],
  } };
}
export function toolAssignable(section, tool) {
  return section.kind === "module" ? tool.module === section.id : !tool.roles || tool.roles.includes(section.role);
}
export function policyAllows(policy, role, name) {
  const section = BRAIN_SECTIONS.find(item => item.role === role);
  const tool = BRAIN_TOOL_CATALOG.find(item => item.actions.includes(name));
  return Boolean(section && tool && toolAssignable(section, tool)
    && (name !== "robinhood.propose" || role === "strategist")
    && policy.assignments[section.id]?.includes(tool.id) && policy.assignments[tool.module]?.includes(tool.id));
}
export function createBrainToolPolicy({ repository, now = () => new Date() }) {
  return {
    async read() { return await repository.read() ?? defaultBrainToolPolicy(); },
    async update(sectionId, input, actorId) {
      const section = BRAIN_SECTIONS.find(item => item.id === sectionId);
      if (!section || !plain(input) || Object.keys(input).some(key => !["version", "tools"].includes(key))
        || !Number.isSafeInteger(input.version) || input.version < 0 || !Array.isArray(input.tools)
        || input.tools.length > BRAIN_TOOL_CATALOG.length || new Set(input.tools).size !== input.tools.length
        || input.tools.some(id => !BRAIN_TOOL_CATALOG.some(tool => tool.id === id && toolAssignable(section, tool)))) {
        throw failure("BRAIN_TOOL_POLICY_INPUT", "Choose valid tools for this section and include the current version.", 400);
      }
      if (typeof actorId !== "string" || !actorId.trim()) throw failure("BRAIN_AUTH_REQUIRED", "Sign in to manage tools.", 401);
      return repository.update(previous => {
        const state = previous ?? defaultBrainToolPolicy();
        if (state.version !== input.version) throw failure("BRAIN_TOOL_POLICY_CONFLICT", "Tool access changed in another session. Reload assignments before saving.", 409);
        const before = state.assignments[sectionId], after = [...input.tools].sort();
        if ([...before].sort().join(",") === after.join(",")) return state;
        const updatedAt = now().toISOString();
        return { ...state, version: state.version + 1, updatedAt, updatedBy: actorId,
          assignments: { ...state.assignments, [sectionId]: after },
          history: [...state.history, { version: state.version + 1, section: sectionId, before, after, actorId, at: updatedAt }].slice(-100) };
      });
    },
  };
}
