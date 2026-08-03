-- GENERATED — do not edit by hand.
--
-- The projection of the DEPLOYED bounded-systems/front-desk-mirror schema, as
-- read from the public DoltHub SQL API. Regenerate with:
--
--     node scripts/schema-export.ts
--
-- CI fails when this file and the live database disagree, so a change to the
-- deployed schema cannot land without a diff here for its owner to review.
-- Hand-written intent (with the rationale) lives in schema/mirror.sql.

CREATE TABLE `api_spend` (
  `id` int NOT NULL AUTO_INCREMENT,
  `at` datetime NOT NULL,
  `verb` varchar(64) NOT NULL,
  `points` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `claims` (
  `id` int NOT NULL AUTO_INCREMENT,
  `item_id` varchar(64) NOT NULL,
  `agent` varchar(128) NOT NULL,
  `decided_at_commit` varchar(32),
  `claimed_at` datetime NOT NULL,
  `ttl_sec` int NOT NULL,
  `released_at` datetime,
  `status` enum('active','released','completed','expired','reaped') NOT NULL DEFAULT '1',
  `fencing` int,
  PRIMARY KEY (`id`),
  KEY `idx_claim_item` (`item_id`,`status`),
  UNIQUE KEY `uq_claim_item_fencing` (`item_id`,`fencing`),
  CONSTRAINT `fk_claim_item` FOREIGN KEY (`item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `commit_attestations` (
  `dolt_commit` varchar(32) NOT NULL,
  `attested_at` datetime NOT NULL,
  `jwt_sha256` varchar(64) NOT NULL,
  `iss` varchar(255) NOT NULL,
  `sub` varchar(255) NOT NULL,
  `aud` varchar(255) NOT NULL,
  `repository` varchar(255) NOT NULL,
  `repository_owner` varchar(255) NOT NULL,
  `job_workflow_ref` varchar(512) NOT NULL,
  `run_id` varchar(32) NOT NULL,
  `run_attempt` varchar(8) NOT NULL,
  `jti` varchar(64),
  `issued_at` datetime NOT NULL,
  `expires_at` datetime NOT NULL,
  `receipt` text,
  PRIMARY KEY (`dolt_commit`),
  KEY `idx_attest_workflow` (`job_workflow_ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `item_deps` (
  `item_id` varchar(64) NOT NULL,
  `dep_item_id` varchar(64) NOT NULL,
  `edge_type` enum('blocks','parent-child','closes') NOT NULL DEFAULT '1',
  PRIMARY KEY (`item_id`,`dep_item_id`),
  KEY `fk_dep_dst` (`dep_item_id`),
  CONSTRAINT `fk_dep_dst` FOREIGN KEY (`dep_item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dep_src` FOREIGN KEY (`item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `chk_no_self_dep` CHECK ((NOT((`item_id` = `dep_item_id`))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `items` (
  `item_id` varchar(64) NOT NULL,
  `number` int,
  `title` varchar(1024) NOT NULL,
  `repository` varchar(255) NOT NULL,
  `status` enum('Todo','In Progress','Blocked','Done') NOT NULL,
  `kind` enum('epic','room','door','task') NOT NULL,
  `effort` double NOT NULL DEFAULT '0',
  `value` double NOT NULL DEFAULT '0',
  `depends_on` varchar(512) NOT NULL DEFAULT '',
  `needs` varchar(255) NOT NULL DEFAULT '',
  `created_at` datetime,
  `closed_at` datetime,
  `origin` enum('github','dolt') NOT NULL DEFAULT '1',
  `sync_state` enum('synced','dolt-dirty','hidden') NOT NULL DEFAULT '1',
  PRIMARY KEY (`item_id`),
  CONSTRAINT `chk_effort` CHECK (((`effort` >= 0) AND (`effort` <= 10))),
  CONSTRAINT `chk_value` CHECK (((`value` >= 0) AND (`value` <= 100))),
  CONSTRAINT `chk_number` CHECK ((`number` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `leases` (
  `item_id` varchar(64) NOT NULL,
  `agent` varchar(128) NOT NULL,
  `claimed_at` datetime NOT NULL,
  `ttl_sec` int NOT NULL,
  PRIMARY KEY (`item_id`),
  KEY `idx_lease_agent` (`agent`),
  CONSTRAINT `fk_lease_item` FOREIGN KEY (`item_id`) REFERENCES `items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `chk_ttl` CHECK ((`ttl_sec` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `schema_migrations` (
  `filename` varchar(255) NOT NULL,
  `applied_at` datetime NOT NULL,
  PRIMARY KEY (`filename`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sync_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `synced_at` datetime NOT NULL,
  `items_count` int NOT NULL,
  `graphql_cost_points` int NOT NULL,
  `graphql_remaining` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
