# Synergy Module Agent API

Codex, Claude Code, Grok Build and other HTTP clients can act as the account owner through `/api/v1`. The API uses the same services, validation, account capabilities and trading controls as the website. An API token never creates or modifies a browser login session.

## Connect an agent

1. Sign in through Discord and open **Settings → AI access**.
2. Create a named token, select permissions and set its lifetime (1–90 days). Copy the token once and keep it in the client's secret storage.
3. Fetch `GET /api/v1/openapi.json` for the OpenAPI 3.1 document or `GET /api/v1/operations` for the complete mounted operation catalog. Both discovery endpoints are public and contain no user data.
4. Send `Authorization: Bearer <token>` and `Content-Type: application/json` to `/api/v1/...`.

The API path corresponds to the website API: `/api/settings` becomes `/api/v1/settings`. The catalog is built from the actual mounted routers, so onboarding, preferences, research, journal, practice, connected accounts and administration appear together. It marks operations requiring a browser session and supplies an agent alternative where one exists. Operations outside recognized domains are denied until their access policy is defined.

```js
// Node.js 24; store the token outside source control.
const base = process.env.SYNERGY_URL; // for example https://your-synergy-host.example
const headers = {
  Authorization: `Bearer ${process.env.SYNERGY_API_TOKEN}`,
  "Content-Type": "application/json",
};
async function synergy(path, method = "GET", body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.message ?? result.error}`);
  return result;
}
console.log(await synergy("/platform/me"));
console.log(await synergy("/platform/navigation"));
```

## Permissions

| Scope | Actions |
| --- | --- |
| `workspace:read` | Read your profile, preferences, account status, journal, research and practice results; read public market data. |
| `workspace:write` | Edit profile and preferences, finish setup, maintain drafts, journal entries, watchlists and notes. |
| `connections:write` | Save or delete provider credentials, start account authorization, connect/disconnect and synchronize accounts. |
| `research:write` | Run AI analysis, review research, manage documents and run evaluations. Existing paid provider gates remain active. Research runs cannot prepare broker proposals unless the token also has `live:trade`. |
| `testing:write` | Create virtual accounts, paper trade current market quotes, record reference data and control paper workers. |
| `live:trade` | Configure live broker automation and propose, approve or pause broker actions. Existing broker approval, risk, freshness and deployment controls still apply. |
| `admin:read` | Read member administration and shared tool policy. The current account must also be an administrator. |
| `admin:write` | Change member admission and shared tool policy. The current account must also be an administrator. |

Scopes are independent: a write scope does not imply a read scope. A usual research/setup client needs `workspace:read`, `workspace:write`, `research:write`, `testing:write`, and optionally `connections:write`. Enable live or administrative permissions only when the user wants those actions. Practice tokens cannot approve live broker orders. Research approval saves research memory and does not authorize a trade.

## Account setup and personalization

```js
await synergy("/settings/profile", "PATCH", { displayName: "Gage" });
await synergy("/settings/preferences", "PATCH", {
  theme: "system", density: "comfortable", timezone: "America/Chicago",
  currency: "USD", defaultLanding: "/practice", reducedMotion: false,
  notifications: { researchCompleted: true, orderUpdates: true, practiceResults: true },
});
await synergy("/settings/onboarding", "PATCH", {
  step: "connections", interests: ["research", "practice"],
});
// Requires connections:write. Provider keys are encrypted and never returned by GET.
await synergy("/settings/providers/openai", "PUT", { apiKey: process.env.OPENAI_API_KEY });
await synergy("/settings/onboarding/complete", "POST", { acknowledgedPracticeIsolation: true });
```

Account identity is always taken from the verified token. Supplying another owner or user ID in a body does not change the authenticated owner. Administrator endpoints are explicit exceptions for administrators acting on members; they require administrator scopes and the current administrator capability.

## Paper trading live markets

Use `/practice` to discover the strategy catalog, configuration fields and current practice accounts. Create a practice book with `POST /practice/books` and connect a supported live public market feed. `POST /practice/books/{id}/orders` accepts `{side:"BUY",budgetUsd:25}` or `{side:"SELL",positionId:"..."}` and fetches the current quote on the server. Clients cannot submit their own fill prices. These routes require `testing:write` for changes and use separate practice storage and virtual funds. GET requests use `workspace:read`.

```js
const catalog = await synergy("/practice");
// Inspect catalog strategy IDs and configuration fields before submitting.
const book = await synergy("/practice/books", "POST", {
  name: "My paper account", strategyId: "manual", initialCapital: 500,
  feed: { source: "binance", instrument: "BTCUSDT" },
});
await synergy(`/practice/books/${book.id}/orders`, "POST", {
  side: "BUY", budgetUsd: 25, requestId: crypto.randomUUID(),
});
```

Use the operation catalog for current fields and parameter names. Fill simulation includes configured fees, slippage and available depth. Paper results never enable live execution.

Refresh a book with `POST /practice/books/{id}/refresh`, start automated forward observation with `/start` and `{intervalSeconds:30}`, or stop it with `/pause` and `{}`. Closing `/practice/books/{id}/positions/{positionId}/close` accepts only an empty body and fetches the executable quote on the server. The public API does not accept client-submitted quotes or historical replay orders.

Equity paper automation has separate state at `/practice/equities/state`, policy at `/practice/equities/policy`, and start/pause/cycles routes under `/practice/equities`. It uses paper permissions and virtual account state; real broker automation uses the separate `/robinhood-brain` routes and requires `live:trade`. Inspect the latest policy version and read-only broker bindings before configuring either account.

For optional international Polymarket reference prices, save `{apiKey,secret,passphrase}` to `PUT /practice/feeds/polybolt` using `connections:write`, then start `POST /practice/feeds/polybolt/start` with `{symbols:["btcusd"],channels:["price.crypto","price.crypto.twap"],durationSeconds:900}` using `testing:write`. `GET /practice/feeds/polybolt/snapshot` reads collected evidence. The recorder only authenticates and subscribes to price channels. It can run for up to one hour, stops when account access expires, and retains a bounded sample history in account-isolated practice storage. These credentials are separate from Polymarket US account credentials. Disconnect with `DELETE /practice/feeds/polybolt`.

Current data reads are available at `/practice/data/{method}` using GET query fields or POST JSON: `discover`, `quote`, `weather`, `weatherEnsemble`, `wallet`, `solana`, `tokenEvidence`, `scanSolana`, `cryptoWindow`, and `cryptoModel`. Use `cryptoWindow` with `{asset:"BTC",windowMinutes:5,outcome:"Up"}` to discover the exact current contract. `scanSolana` accepts a mint `address` and profile `strict` or `smaller-pools`; it reports unavailable evidence explicitly and never authorizes token execution. The public crypto model uses a labeled spot-price proxy. A `crypto-directional` book with `feed.referenceMode:"recorded"` obtains its own owner-scoped reference prices in the server worker. Client-submitted reference ticks are rejected by the public data API. Weather books accept 7–200 dated calibration rows under `feed.weather.calibrationRecords`; these fit forecast errors for forward decisions. Inspect the OpenAPI feed schema for station, temperature bucket, timezone and observation fields.

## Research and knowledge

```js
await synergy("/brain/documents", "POST", {
  title: "My research process", text: "Record source timestamps and test each hypothesis before live use.", kind: "knowledge",
});
const result = await synergy("/brain/runs", "POST", {
  mode: "demo", provider: "gemini", symbol: "SPY", timeframe: "15m", context: "",
  objective: "Demonstrate the research and review process.",
  accountSize: 50000, riskPercent: 0.5, pointValue: 1, minRewardRisk: 2,
});
// Poll /brain/runs/{id}; decisions require the latest returned version.
```

For paid research, select `mode: "analysis"`, supply actual market context and configure the chosen provider. Server paid-call switches remain authoritative. Broker mutation APIs require a current proposal version and continue to apply the broker's own approval and execution checks; an API token does not override them.

## Connected accounts

Polymarket US: `POST /polymarket/us/connect` with `{ "keyId": "...", "secretKey": "..." }`; `/sync` and `/disconnect` take `{}`. These credentials grant the account access configured by Polymarket US; this integration currently reads balances, positions and open orders.

Robinhood: `POST /platform/connections/robinhood/begin` returns a provider authorization URL, a ten-minute lifetime and a completion URL. The owner must complete the provider's consent screen. Submit the resulting callback `code` and `state` to `POST /platform/connections/robinhood/complete`. Pending authorization is encrypted, bound to the account and consumed once. The standard website `/robinhood/connect` action requires a browser session; API discovery points agents to this separate authorization flow. Do not expose authorization codes or callback URLs in logs.

## Lifetime, revocation and storage

Tokens are generated with 256 bits of randomness. Only SHA-256 hashes and display metadata are saved in the workspace repository. SQLite/PostgreSQL deployments retain tokens after restarts; memory storage is explicitly reported as nonpersistent. Each user can keep 20 active tokens. Listing tokens never returns bearer secrets or hashes. `GET /platform/audit` returns the last 100 completed agent operations, recording route, token ID, time and status without request bodies, credential values or responses.

Every request reloads the current account, checks bans, authentication mode and admission, and checks the token's expiry and revocation. Discord membership is refreshed when its permission snapshot expires. The delegated Discord OAuth credentials needed for that refresh are encrypted under the stable integration encryption key and are never returned through the API. If encryption is unavailable or authorization has expired, the API fails with `API_REAUTHENTICATION_REQUIRED`; sign in and create a new token. Revoking the last active token removes the delegated refresh credential. Changing the integration encryption key requires issuing replacement tokens to restore delegated refresh.

Rotated Discord refresh credentials are synchronized with the browser login that created the delegation. API and browser refresh work is serialized per account within the server process. A separate, newer browser login retains its own authorization. Multi-process deployments still depend on the provider's refresh-token rotation behavior across separate sessions.

Token management is available only in a signed-in browser: `GET/POST /api/platform/tokens` and `DELETE /api/platform/tokens/{id}`. Mutations require the existing CSRF token. API clients cannot mint broader credentials or revoke other tokens. An agent can disconnect itself with `POST /api/v1/platform/disconnect` using `workspace:write`. Session sign-out ends browser sessions; revoke tokens separately to disconnect agents. Bans immediately stop token use.

## Errors and client behavior

Expect JSON with `error` and usually `message`. `401` means a missing/invalid/revoked token or expired account authorization. `403` means missing scope, current capability, or a session-only action. `404` includes resources belonging to another account. `409` means a state/version conflict. `422` is invalid input. `429` is capacity or rate limiting. Never blindly retry broker mutations: read the action state, verify its version/request ID and follow the returned operation result.

The gateway allows 120 requests per token per minute, 300 authenticated-endpoint requests per client IP per minute, and up to 30 invalid credential attempts per IP per minute. Limits are checked before expensive permission refresh and return `429` with `Retry-After` seconds. These counters are bounded and process-local; a reverse proxy should supply a shared deployment limit when multiple replicas are used. Public API discovery endpoints do not consume these counters.

Use HTTPS on hosted deployments. Browser cookies are ignored by the versioned gateway, and bearer authorization is accepted only on `/api/v1`. Normal browser API routes retain CSRF protection even if an Authorization header is present.
