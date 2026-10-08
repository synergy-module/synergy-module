# Database upgrade validation — 2026-09-24

The live PostgreSQL 16.15 database was backed up and restored in isolation before
migrations 005–007 were applied. Migrations 001–004 were adopted into the checksum
ledger. All seven files report applied; repeating the runner makes no schema
changes. Broker storage was switched from compatibility mode to normalized mode
only after the current writer was upgraded. The older production site has no
Brain/broker repository and remains compatible with its session tables.

The beta app was rebuilt and deployed with existing database/authentication
credentials, redirects, encryption secrets and paid/trading switches preserved.
Both public `/health` endpoints returned 200 after deployment. Existing user and
session counts were unchanged. A uniquely scoped verification owner confirmed
settings, research, indexed retrieval and normalized broker events after closing
and reopening the database connection; all verification rows were then removed.
No model-provider or broker calls were made.

The database container has 2 GiB RAM and 2 CPUs. Its shared buffers are now 512 MB;
the planner's effective cache estimate is 1 GB. `fsync` and synchronous commits
remain enabled. Settings and restored records survived a restart in the isolated
persistent-volume rehearsal; the live database's existing volume was retained.
Warm SELECT 1 checks from the deployed app were sub-millisecond at the median;
these ten-query samples are not a capacity or trade-execution benchmark.

## Automated and interface checks

- Full default suite: 621 passed, zero failures, 11 optional external-database
  checks skipped. The corresponding PostgreSQL checks were run explicitly on
  disposable PostgreSQL 16.15 databases, including migration rollback/checksum
  drift, concurrent migrations, owner isolation, cache eviction, history
  retention, competing order claims, and storage-mode cutover/reversal.
- Seven broker concurrency/cutover tests passed after the final query optimization.
- Final targeted broker/migration rerun: 13 passed, zero failures.
- Four benchmark checks passed against real isolated PostgreSQL, including
  target refusal, fixture bounds and cleanup verification.
- Research/source pagination was checked at 1440px and 390px. Loading the next
  page retained all 28 fixture sources; no horizontal page overflow. Mobile
  source forms/cards now stack correctly. Fixture sources were removed.

## Synthetic workload comparison

Same database engine, additive schema and fixture sizes for the immutable prior
repository and the final repository. Eight owners, eight concurrent workers,
200 operations per stage; about 528 KB per broker workspace. Times include the
benchmark harness and Node JSON work. All 4,800 measured operations across the
final small/large before/after comparisons completed without error.

| Operation, p95 milliseconds | Prior repository | Final repository |
|---|---:|---:|
| Brain history read | 162 | 88 |
| Brain write, multiple owners | 218 | 19 |
| Brain write, same owner | 401 | 45 |
| Broker read | 109 | 133 |
| Broker update, multiple owners | 175 | 103 |
| Broker update, same owner | 492 | 242 |

These are local synthetic measurements, not production latency guarantees. Broker
reads remain slower because they reconstruct the bounded workspace from individual
records; small workspaces also incur normalization overhead. The chosen design
improves history durability and larger-workspace writes. It does not establish
streaming tick capacity, broker execution speed or future workload limits.

Raw fixture reports remain local under ignored `data/database-benchmark-*.json`.
See [database operations](database-operations.md) for deployment, rollback and
benchmark commands. Ongoing backup, maintenance and growth monitoring are still
required.
