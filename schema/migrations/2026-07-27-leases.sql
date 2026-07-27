-- 2026-07-27 — make S1 structural: split `leases` (mechanism) from `claims` (record).
--
-- Before: `claims` was both. Mutual exclusion was attempted with
--   INSERT INTO claims ... SELECT ... WHERE NOT EXISTS (<live claim for item>)
-- over an append-only table whose only relevant index, `idx_claim_item`, is not
-- unique. Two concurrent claimants can both evaluate NOT EXISTS as true and both
-- insert; nothing in the schema rejects the second. The post-insert confirmation
-- in claimNext filtered by `agent`, so in a double-insert BOTH agents saw their
-- own row and BOTH returned won=true. S1 was unenforced and the failure was
-- silent.
--
-- After: `leases` holds at most one row per item, enforced by the PRIMARY KEY.
-- Claiming is reap-then-INSERT-IGNORE-then-read-back; the loser collides on the
-- key. `claims` keeps the history and is no longer load-bearing.
--
-- NOT YET APPLIED to bounded-systems/front-desk-mirror. Apply with:
--   cd mirror && dolt sql < ../schema/migrations/2026-07-27-leases.sql \
--     && dolt commit -am "schema: structural S1 via leases table"
--
-- Applied at most once: the runner records it in `schema_migrations` and skips
-- a file already listed there. See .github/workflows/mirror-migrate.yml.

CREATE TABLE IF NOT EXISTS `leases` (
  `item_id`    varchar(64)  NOT NULL,
  `agent`      varchar(128) NOT NULL,
  `claimed_at` datetime     NOT NULL,
  `ttl_sec`    int          NOT NULL,
  PRIMARY KEY (`item_id`),
  KEY `idx_lease_agent` (`agent`),
  CONSTRAINT `fk_lease_item` FOREIGN KEY (`item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `chk_ttl` CHECK (`ttl_sec` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- Close out the interval on the audit log so a row describes a complete hold.
-- NOTE: a bare ADD COLUMN, deliberately. Dolt cannot express a conditional
-- column add — `ADD COLUMN IF NOT EXISTS` is MariaDB-only syntax, `PREPARE`
-- silently refuses DDL, and `DATABASE()` is empty under `dolt sql`, so an
-- information_schema guard cannot work either. Re-applying therefore errors
-- with "Column already exists" and exits 1. That is fine BECAUSE the runner
-- now keeps a `schema_migrations` ledger and never applies a file twice; the
-- idempotency lives there rather than in every statement.
ALTER TABLE `claims` ADD COLUMN `released_at` datetime AFTER `ttl_sec`;

-- Backfill: carry any currently-live claim over to a lease. If the old bug had
-- already produced two live claims for one item, MAX(id) picks the later one —
-- an arbitrary but deterministic winner, which is the best available answer
-- after the fact. Rows this drops are visible in `dolt diff`.
INSERT IGNORE INTO `leases` (`item_id`, `agent`, `claimed_at`, `ttl_sec`)
SELECT c.`item_id`, c.`agent`, c.`claimed_at`, c.`ttl_sec`
FROM `claims` c
JOIN (
  SELECT `item_id`, MAX(`id`) AS id
  FROM `claims`
  WHERE `status` = 'active'
    AND TIMESTAMPADD(SECOND, `ttl_sec`, `claimed_at`) > UTC_TIMESTAMP()
  GROUP BY `item_id`
) latest ON latest.id = c.`id`;

-- Any 'active' claim that is already past its TTL is history, not a live hold.
UPDATE `claims`
SET `status` = 'expired',
    `released_at` = TIMESTAMPADD(SECOND, `ttl_sec`, `claimed_at`)
WHERE `status` = 'active'
  AND TIMESTAMPADD(SECOND, `ttl_sec`, `claimed_at`) <= UTC_TIMESTAMP();
