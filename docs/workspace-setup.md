# Focused trading workspace

The primary navigation is Overview, Brain, Research, Accounts, Journal, and Settings. Indicators, ICT Alerts, and S&R Alerts are retired; their public pages and indicator request endpoints return 404. Historical database records remain intact. Administration is available to administrators from Settings → System checks. The previous `/trader` page redirects to Research.

## User setup

1. Sign in with Discord. Settings → Connections accepts personal Gemini, OpenAI, and Claude API keys. Saving a key encrypts it for that user; it never verifies the key by calling a model. Removing a personal key falls back to the server's key when one is configured, and the UI identifies that source.
2. Connect Robinhood from the same page after the deployment's Robinhood OAuth configuration is ready. Accounts contains stock, option, and crypto tools, saved snapshots, exact-request review, and broker history.
3. Set the default provider, risk parameters, role routing, and run budgets in Settings → Research defaults. Model IDs and pricing remain server configuration so budgets use the configured models' pricing assumptions.
4. Research contains mission input and review, saved knowledge, and a link to the economic calendar. Draft objectives, context, knowledge input, review notes associated with a specific run, and journal drafts save automatically. The interface reports incomplete saves and keeps current text after request failures. API keys require explicit Save.

Saving credentials does not enable paid AI. `TRADER_PAID_AI_ENABLED` and the separate Robinhood submission lock continue to apply. Offline demos and evaluations use no model tokens. An accepted research thesis becomes memory; it is not a broker-order approval.

## Persistence and deployment

See [database operations](database-operations.md) for migrations 006–007, tracked
upgrades, normalized broker storage, bounded history queries and rollback.

- Production still requires `DATABASE_URL`. Run the existing controlled migration job (`npm run migrate` with `APP_ENVIRONMENT=production`, `APP_ALLOW_MIGRATIONS=true`, and the target database configuration) before starting the new version. Migration `005_user_workspaces.sql` adds owner-scoped provider credentials, preferences, and drafts. The migration runner and readiness check include the new table. Existing migrations remain idempotent; beta application startup does not automatically run them.
- Without a configured database in development, sessions, users, revocations, journal entries, and workspace settings use `WORKSPACE_DB_PATH` (default `data/workspace.sqlite`). Brain research stays in `BRAIN_DB_PATH` (default `data/agent-brain.sqlite`); Robinhood state stays in `data/robinhood.sqlite`. Preserve the directory/volume across restarts and container replacement.
- Set a stable, private `SESSION_SECRET`. Login cookies are HTTP-only, SameSite=Lax, secure in production, and roll forward for 30 days. Discord admission/role refresh, bans, revocation, and sign-out can end access sooner.
- Set `INTEGRATIONS_ENCRYPTION_KEY` to a separate long random secret (at least 16 characters; 32+ recommended). A sufficiently long `SESSION_SECRET` is the fallback. AES-256-GCM encryption binds saved keys to their owner and provider. Keep the encryption secret with your deployment secrets and backups; changing it requires restoring that secret or replacing saved API keys. Neither stored nor decrypted keys appear in Settings responses.
- Keep the existing `ROBINHOOD_TOKEN_ENCRYPTION_KEY` stable separately. A real account connection also requires a valid `ROBINHOOD_REDIRECT_URI`. The OAuth callback now returns to Settings → Connections.
- Restart the application after deploying changed browser assets so the content-hashed asset manifest is updated.

Live PostgreSQL verification requires `TEST_DATABASE_URL`. SQLite reopen and authenticated session/revocation tests run without external services. A local isolated design preview is not proof of the deployed production database or a live broker connection.

## Brain interaction

The Brain is an explorable neural network with eight labeled regions. Select a region for a brief description and a link to its workspace. Drag or use arrow keys to rotate; choose Move, Shift-drag, or Shift-arrow to pan. Zoom, reset, and pause controls remain available. The camera persists through in-app navigation in the same document and resets on a full page refresh. Binary activity animates independently of the stationary network, respects reduced motion, pauses when hidden, and consumes no AI tokens.

## Design guidance

The local Omensite Harness design context, UI-library lookup, frontend implementation guidance, and review contract informed this pass. The existing Redline palette and typography remain in use. The harness and its private history are local development tools, not application runtime dependencies. Native host capture has not been verified or enabled by this task.
