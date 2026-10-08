# StayLively deployment

StayLively builds this repository's Dockerfile. The image sets `NODE_ENV=production`,
and StayLively supplies the listening `HOST` and `PORT`. Configure the application's
secrets and database at runtime, before publishing it.

## Configure the server

1. Select the repository and branch. The included `staylively.json` declares
   application port `3000` and readiness path `/health`; use those values on
   existing servers too. The root URL redirects visitors to sign-in and
   does not check database readiness.
2. Populate the server's environment using
   [`environment.staylively.example`](../environment.staylively.example). Supply
   `SESSION_SECRET`, the Discord client ID and secret, guild ID, and exact HTTPS
   callback URI. The default `roles` admission policy also requires the five role
   IDs. Preserve an existing beta deployment's `beta-guild` policy only with
   `APP_ENVIRONMENT=beta`.
   The Synergy Module beta site now requires `DISCORD_ACCESS_POLICY=beta-role`,
   `DISCORD_GUILD_ID=1554634103997861889`,
   `DISCORD_REQUIRED_ROLE_ID=1554903899343814857`, and
   `DISCORD_ROLE_REFRESH_MINUTES=1`. This requires the SynergyModule role in the
   SynergyModule server before granting the existing beta workspace permissions.
   All existing sessions must verify the new gate by signing in again.
3. Register the exact `DISCORD_REDIRECT_URI` on the Discord OAuth application.
   For the beta domain, use
   `https://synergymodule.dev/auth/discord/callback`; production uses
   `https://synergymodule.app/auth/discord/callback`.
4. Connect the existing PostgreSQL database to this repository server using
   StayLively's database connection settings and variable name `DATABASE_URL`.
   Use the populated database from the former deployment when preserving saved
   records. A newly created repository server has no database connection.
5. Check schema readiness before publishing. Follow
   [database operations](database-operations.md) for migration status, backups,
   and controlled upgrades. The application requires migrations 001–007. A
   database that already has the current schema needs no migration during this
   hosting move. Leave `APP_ALLOW_MIGRATIONS=false` on the web server.
6. Redeploy and verify that `/health` returns HTTP `200` with
   `{"status":"ok"}`, and that `/login` displays Discord sign-in. Complete a
   Discord sign-in to verify the registered callback and guild access.

Keep the previous `SESSION_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`, and
`ROBINHOOD_TOKEN_ENCRYPTION_KEY` when restoring existing credentials. If the
integration encryption key was blank, preserving the session secret also
preserves decryption of provider keys that used that fallback. Never commit
populated environment files or copy them into the image.

## Diagnose a failed publication

`exporting layers done` is a normal Docker build message. Read the complete
deployment log, including the container's startup output after image import.

- `SESSION_SECRET is required in production`: the server is missing its session
  secret. Set it in the hosting environment.
- `Missing required Discord configuration`: populate the listed Discord settings
  and preserve the intended admission policy.
- `DATABASE_URL is required in production`: connect PostgreSQL or supply its
  private connection URL through the hosting environment.
- `/health` returns `503`: PostgreSQL is unavailable or a required table is
  missing. Check the database connection and migration status.

A successful image build does not validate runtime secrets, database access,
schema readiness, or Discord callback registration. New server configuration
must explicitly restore the former deployment's settings.
