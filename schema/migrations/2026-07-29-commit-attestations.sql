-- commit_attestations — record WHICH workflow identity produced a Dolt commit.
--
-- `dolt commit --author` is self-asserted. This table carries the GitHub-signed
-- OIDC claims (repository, repository_owner, job_workflow_ref) alongside the
-- commit, so the queue's audit trail names a pinned workflow rather than a
-- string the writer chose. Rationale, and a precise statement of what it does
-- and does NOT prove, is in schema/mirror.sql and src/attest.ts.
--
-- NOT idempotent, and it cannot be made so. Dolt has no `CREATE TABLE ... ` with
-- conditional columns and no `ADD COLUMN IF NOT EXISTS` (MariaDB-only; `PREPARE`
-- silently refuses DDL; `DATABASE()` is empty under `dolt sql`). `CREATE TABLE
-- IF NOT EXISTS` IS supported, so this particular file happens to be re-runnable
-- — but do not read that as a pattern. Idempotency is the `schema_migrations`
-- ledger's job, and the runner in .github/workflows/mirror-migrate.yml skips a
-- file already recorded there.
--
-- Apply with:  gh workflow run mirror-migrate.yml -f migration=2026-07-29-commit-attestations.sql -f dry_run=false
-- STATUS: not yet applied.

CREATE TABLE IF NOT EXISTS `commit_attestations` (
  `dolt_commit`      varchar(32)  NOT NULL,
  `attested_at`      datetime     NOT NULL,
  `jwt_sha256`       varchar(64)  NOT NULL,
  `iss`              varchar(255) NOT NULL,
  `sub`              varchar(255) NOT NULL,
  `aud`              varchar(255) NOT NULL,
  `repository`       varchar(255) NOT NULL,
  `repository_owner` varchar(255) NOT NULL,
  `job_workflow_ref` varchar(512) NOT NULL,
  `run_id`           varchar(32)  NOT NULL,
  `run_attempt`      varchar(8)   NOT NULL,
  `jti`              varchar(64),
  `issued_at`        datetime     NOT NULL,
  `expires_at`       datetime     NOT NULL,
  `receipt`          text,
  PRIMARY KEY (`dolt_commit`),
  KEY `idx_attest_workflow` (`job_workflow_ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
