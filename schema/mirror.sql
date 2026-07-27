-- front-desk-mirror — the checked-in schema of record.
--
-- WHY BESPOKE, WHY DOLT
--
-- Front Desk needs a queue, and the queue needs to survive being read by
-- heterogeneous, unreliable, short-lived workers: GitHub Actions jobs, Cloudflare
-- Workers, and interactive agent sessions. GitHub Issues is the intake surface but
-- not a queue — it has no claim primitive, no lease, and every read costs GraphQL
-- rate-limit budget that the syncer is already metering. `bd` (beads) gave us the
-- dep-graph vocabulary but kept state in a local file, which is exactly the thing
-- three different runtimes cannot share.
--
-- Dolt is the substrate because the queue's state transitions ARE the audit trail.
-- Every claim, heartbeat, release, and field edit is a commit with an author, so
-- "who decided this, and against what version of the board" is answerable by
-- `dolt diff` instead of by a log pipeline we would otherwise have to build. That
-- is the same capability-seam argument the rest of this repo makes, applied to the
-- scheduler's own state: mutations flow through an attributable seam by
-- construction, not by convention. The public DoltHub SQL API then gives us a
-- zero-credential, zero-budget read plane (src/dolthub.ts) that no amount of
-- careful GitHub API use would have bought us.
--
-- The cost is that Dolt is MySQL-compatible but not MySQL, and its concurrency
-- semantics are the thing to be careful about — see LEASES below, which is where
-- being careless already cost us a real mutual-exclusion bug.
--
-- Apply to a fresh mirror:  dolt sql < schema/mirror.sql
-- Migrations against an existing mirror live in schema/migrations/.

-- ---------------------------------------------------------------------------
-- items — the board. One row per unit of intent, GitHub-born or Dolt-born.
-- Field authority (which surface may write which column) is src/authority.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `items` (
  `item_id`    varchar(64)  NOT NULL,
  `number`     int,
  `title`      varchar(1024) NOT NULL,
  `repository` varchar(255) NOT NULL,
  `status`     enum('Todo','In Progress','Blocked','Done') NOT NULL,
  `kind`       enum('epic','room','door','task') NOT NULL,
  `effort`     double NOT NULL DEFAULT 0,
  `value`      double NOT NULL DEFAULT 0,
  `depends_on` varchar(512) NOT NULL DEFAULT '',
  `created_at` datetime,
  `closed_at`  datetime,
  -- origin: where the item was born. sync_state: where it is in the push cycle.
  `origin`     enum('github','dolt') NOT NULL DEFAULT 'github',
  `sync_state` enum('synced','dolt-dirty','hidden') NOT NULL DEFAULT 'synced',
  PRIMARY KEY (`item_id`),
  CONSTRAINT `chk_effort` CHECK (`effort` >= 0 AND `effort` <= 10),
  CONSTRAINT `chk_value`  CHECK (`value`  >= 0 AND `value`  <= 100),
  CONSTRAINT `chk_number` CHECK (`number` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- ---------------------------------------------------------------------------
-- item_deps — the dependency DAG. `item_id` depends on / is blocked by `dep_item_id`.
-- D1 (acyclicity) is checked in SQL, not declarable here; it is the data
-- precondition for the scheduler's proven L1 (no deadlock).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `item_deps` (
  `item_id`     varchar(64) NOT NULL,
  `dep_item_id` varchar(64) NOT NULL,
  `edge_type`   enum('blocks','parent-child','closes') NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (`item_id`, `dep_item_id`),
  KEY `fk_dep_dst` (`dep_item_id`),
  CONSTRAINT `fk_dep_src` FOREIGN KEY (`item_id`)     REFERENCES `items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dep_dst` FOREIGN KEY (`dep_item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `chk_no_self_dep` CHECK (NOT (`item_id` = `dep_item_id`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- ---------------------------------------------------------------------------
-- leases — MUTUAL EXCLUSION (the scheduler's S1), enforced by the engine.
--
-- At most one agent may hold an item at a time. That invariant is carried by the
-- PRIMARY KEY on `item_id`: exactly one row per held item, so a second claimant
-- collides on the key and loses. There is no check-then-act window to race,
-- and no isolation-level assumption to get wrong.
--
-- This is deliberately NOT expressed as a predicate over the `claims` log. The
-- invariant we need is "at most one LIVE claim per item", and liveness is
-- time-dependent (claimed_at + ttl_sec > now), so it cannot be written as a
-- UNIQUE index — SQL uniqueness cannot be conditional on the clock. An
-- append-only log with a non-unique (item_id, status) index therefore enforces
-- nothing: two concurrent `INSERT ... WHERE NOT EXISTS` statements can both
-- observe the absence and both insert. That was the pre-2026-07-27 design and it
-- did not implement the atomic CAS that specs/tla and specs/rust prove safe; the
-- models discharge S1 only if the implementation supplies the atomicity, and the
-- schema is where that atomicity has to come from.
--
-- Expiry stays a lease TTL rather than a lock: a worker that dies holding a lease
-- lets it lapse, and the reap in claimNext frees it. No sweeper, no stuck work,
-- no priority inversion — a lapsed lease is a requeue, not a held lock.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `leases` (
  `item_id`    varchar(64)  NOT NULL,
  `agent`      varchar(128) NOT NULL,
  `claimed_at` datetime     NOT NULL,  -- renewed by heartbeat; expiry is relative to this
  `ttl_sec`    int          NOT NULL,
  PRIMARY KEY (`item_id`),             -- ← S1. The whole mechanism.
  KEY `idx_lease_agent` (`agent`),
  CONSTRAINT `fk_lease_item` FOREIGN KEY (`item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `chk_ttl` CHECK (`ttl_sec` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- ---------------------------------------------------------------------------
-- claims — the append-only claim history (audit, calibration, forensics).
--
-- Demoted from mechanism to record on 2026-07-27. It is written after a lease is
-- successfully latched and is NOT load-bearing for S1; a lost audit row costs
-- history, not correctness. Keep it append-only — `released_at`/`status` are set
-- on the way out so a row is a complete interval, which is what effort
-- calibration (scripts/estimate.ts) wants to read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `claims` (
  `id`          int NOT NULL AUTO_INCREMENT,
  `item_id`     varchar(64)  NOT NULL,
  `agent`       varchar(128) NOT NULL,
  `claimed_at`  datetime     NOT NULL,
  `ttl_sec`     int          NOT NULL,
  `released_at` datetime,
  `status`      enum('active','released','completed','expired') NOT NULL DEFAULT 'active',
  PRIMARY KEY (`id`),
  KEY `idx_claim_item` (`item_id`, `status`),
  CONSTRAINT `fk_claim_item` FOREIGN KEY (`item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- ---------------------------------------------------------------------------
-- sync_log — one row per completed gh→dolt sync; the mirror's freshness pin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sync_log` (
  `id`                  int NOT NULL AUTO_INCREMENT,
  `synced_at`           datetime NOT NULL,
  `items_count`         int NOT NULL,
  `graphql_cost_points` int NOT NULL,
  `graphql_remaining`   int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- ---------------------------------------------------------------------------
-- api_spend — metered GitHub API cost, per verb. The budget gate reads this.
-- Spend is MEASURED (rate-limit diffed around the call), never estimated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `api_spend` (
  `id`     int NOT NULL AUTO_INCREMENT,
  `at`     datetime NOT NULL,
  `verb`   varchar(64) NOT NULL,
  `points` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
