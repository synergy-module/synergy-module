# PostgreSQL storage and upgrades

PostgreSQL remains the authoritative store. The application uses indexed, bounded
queries and a connection pool; it does not require Redis, an embedding service,
or a second database for its current workload. No database design eliminates
future schema upgrades, capacity planning, backups, or PostgreSQL security updates.

## Storage contract

- Settings and encrypted provider credentials remain in `user_workspaces`.
- Brain runs and source documents are retained in PostgreSQL instead of being
  deleted after 100 records. Their HTTP lists use opaque keyset cursors. Pages
  contain at most 50 items; all requests remain scoped to the authenticated owner.
- PostgreSQL knowledge retrieval first selects up to 64 documents using a GIN
  full-text index and then ranks verbatim excerpts. Scores use that candidate
  corpus. This is lexical retrieval, not embeddings and not a model API call.
- Model-response cache entries expire and are evicted in SQL. Expired reads miss;
  the next write performs physical cleanup. The cache is bounded to 100 entries
  per owner and is never the authority for broker balances or order approval.
- Broker connections and working-set IDs reside in `broker_account_states`.
  Tools, snapshots, actions, and events have individual rows. Only changed
  payloads are written. Actions/events remain archived after leaving the UI's
  bounded working set; unresolved submissions cannot be evicted from that set.
- Unique broker request identifiers and owner transaction locks preserve the
  existing approval/dispatch invariant across app instances. Broker network
  requests run outside SQL transactions. A timeout is not proof an order failed.

This upgrade does not create a streaming market-data feed, an exchange connection,
or a tick-history warehouse. Those require a concrete provider/data contract and
measured ingestion/retention requirements. Generic workspace JSON must not be used
as an unlimited tick store.

## Controlled upgrade

1. Back up the target PostgreSQL database with its matching `pg_dump` tool. Keep
   deployment encryption secrets separately. Restore the backup into an isolated
   database and verify it before changing the live database.
2. Run `npm run db:status` using the target's `DATABASE_URL` and `DATABASE_SSL`.
3. Run `npm run migrate` in the controlled migration job, with
   `APP_ENVIRONMENT=production` and `APP_ALLOW_MIGRATIONS=true`. These are job
   guards, not a requirement to relabel the beta web app as production.
4. The runner obtains a migration lock, applies pending files in one transaction,
   and records their normalized SHA-256 checksums in `app_schema_migrations`.
   Existing untracked migrations 001–004 are idempotently adopted. Repeating the
   command skips recorded files. Never edit an applied SQL file; add a new one.
5. Migration 007 initially sets broker mode to `legacy`. Deploy the new broker
   repository to every instance that writes broker state. An older site that only
   uses sessions/journal does not need the broker code.
6. With the same job guards, run `node scripts/broker-storage-mode.js normalized`.
   It locks legacy writes, copies their latest state, and switches atomically.
   Old broker writers are then rejected instead of silently corrupting state.
7. Check `/health`, `npm run db:status`, and `npm run db:health`. Verify persistence
   with an isolated owner and real repositories; do not place an order to test SQL.

If an app rollback is needed, run `node scripts/broker-storage-mode.js legacy`
with the job guards **before** restarting old broker code. It rebuilds the bounded
legacy workspace from current records while keeping normalized archives. Reapply
normalized mode only after all writers are upgraded. Do not drop the new tables
or restore an old database over newer trading records as a routine rollback.

## Connection budgets and diagnostics

The default pool maximum is 10 **per app process**. Account for all replicas and
leave capacity for migrations, backups and administration. Defaults are a 5s
connection wait, 10s statement deadline, 3s lock wait and 15s idle transaction
deadline; broker mutations additionally use a 5s statement deadline. Configure
`DATABASE_POOL_MAX`, `DATABASE_CONNECT_TIMEOUT_MS`,
`DATABASE_STATEMENT_TIMEOUT_MS`, and `DATABASE_LOCK_TIMEOUT_MS` when measurement
justifies a change. Increasing the pool indiscriminately can increase contention.

`npm run db:health` reports settings, table sizes/estimated counts, connection
counts, migration records and ten warm round trips without credentials or stored
account content. Its latency numbers are connectivity checks, not trading or
throughput benchmarks. Retain `fsync=on` and durable commits for broker state.

Run `npm run db:benchmark` only with an explicitly configured disposable local
`BENCHMARK_DATABASE_URL` or `TEST_DATABASE_URL`. It refuses an application database
and cleans only its own fixture owners. Run real PostgreSQL integration tests
serially when they share a disposable database because broker-mode tests exercise
database-wide cutover. Keep test services private to loopback/Docker networks.

Keep the app and PostgreSQL on the same private network with persistent database
volumes. Tune memory to the container's actual allowance, not the physical host's
RAM. Automated backups and restore drills remain ongoing operational work; new
credentials require the same stable encryption keys after a restore.
