-- claims.fencing — the projection's idempotency key.
--
-- Rows projected from the lease Durable Object carry the grant's fencing
-- ordinal; (item_id, fencing) under a UNIQUE key is what lets the projector
-- write with INSERT ... ON DUPLICATE KEY UPDATE, making a replayed projection
-- run identical to the first — the "idempotent" half of the named weakening in
-- docs/queue-vs-log.md. Rows written inline by the Dolt planes keep NULL
-- fencing, and multiple NULLs coexist under the unique key (verified against
-- Dolt 2.2.2 on 2026-07-29 before this file was written).
--
-- NOT idempotent as a file — Dolt has no conditional DDL. Idempotency is the
-- schema_migrations ledger's job; the runner skips an applied file.
--
-- Apply with:  gh workflow run mirror-migrate.yml -f migration=2026-07-29-claims-fencing.sql -f dry_run=false
-- STATUS: not yet applied.

ALTER TABLE `claims`
  ADD COLUMN `fencing` int,
  ADD UNIQUE KEY `uq_claim_item_fencing` (`item_id`, `fencing`);
