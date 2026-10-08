import { CAPABILITIES } from "./access.js";

const ROUTES = [
  { key: "research", title: "Research", path: "/research", uri: "research", description: "Give your agents an objective. Review the evidence, then decide what to keep.", view: "research", capability: CAPABILITIES.BASE },
  { key: "accounts", title: "Accounts", path: "/accounts", uri: "accounts", description: "Read your portfolio, prepare broker requests, and review every change.", view: "accounts", capability: CAPABILITIES.BASE },
  { key: "settings", title: "Settings", path: "/settings", uri: "settings", description: "Connect your providers and accounts. Set the defaults your agents work within.", view: "settings", capability: CAPABILITIES.BASE },

  { key: "home", title: "Overview", path: "/home", uri: "home", description: "Your command center for research, market evidence, and trade review.", view: "home", capability: CAPABILITIES.BASE },
  { key: "trader", title: "AGENTIC TRADER", path: "/trader", uri: "trader", description: "AI market analysis, independent risk checks, and reviewed trade plans with Gemini, OpenAI, or Claude.", view: "trader", capability: CAPABILITIES.BASE },
  { key: "brain", title: "Brain", path: "/brain", uri: "brain", description: "Plan, research, verify, and remember. An observable agent system with human review.", view: "brain", capability: CAPABILITIES.BASE },
  { key: "indicators", title: "INDICATORS", path: "/indicators", uri: "indicators", description: "TradingView indicator access, entitlement status, instructions, and related resources.", view: "indicators", capability: CAPABILITIES.INDICATORS },
  { key: "market-news", title: "MARKET NEWS", path: "/market-news", uri: "market-news", description: "Scheduled economic releases, filtered by market and expected impact.", view: "market-news", capability: CAPABILITIES.BASE },
  { key: "alerts-ict", title: "ALERTS :: ICT", path: "/alerts/ict", uri: "alerts/ict", description: "Alerts for ICT-based conditions, concepts, and future strategy-specific signals.", view: "alerts-ict", capability: CAPABILITIES.BASE },
  { key: "alerts-sr", title: "ALERTS :: S&R", path: "/alerts/support-resistance", uri: "alerts/support-resistance", description: "Plan the support, resistance, and price reactions you want to monitor.", view: "alerts-sr", capability: CAPABILITIES.BASE },
  { key: "journal", title: "JOURNAL", path: "/journal", uri: "journal", description: "Create, review, organize, and publicly share structured trade entries.", view: "journal-index", capability: CAPABILITIES.JOURNAL },
  { key: "admin", title: "ADMIN", path: "/admin", uri: "admin", description: "Administrative controls for users, access requests, sessions, and saved policy state.", view: "admin", capability: CAPABILITIES.ADMIN },
  { key: "journal-new", title: "NEW JOURNAL ENTRY", path: "/journal/new", uri: "journal/new", description: "Capture direction, timing, price, confluences, evidence and notes for one trade.", view: "journal-new", capability: CAPABILITIES.JOURNAL },
  { key: "journal-public", title: "PUBLIC JOURNAL ENTRY", path: "/journal/:id", uri: "journal/public", description: "The shareable public record and webhook embed generated on submission.", view: "journal-public", capability: CAPABILITIES.JOURNAL },
];

export const NAVIGATION = ["home", "brain", "research", "accounts", "journal", "settings"].map((key) => ROUTES.find((route) => route.key === key));

export const ROUTE_BY_KEY = Object.fromEntries(ROUTES.map((route) => [route.key, route]));

export function getRouteByPath(pathname) {
  return ROUTES.find((route) => route.path === pathname);
}
