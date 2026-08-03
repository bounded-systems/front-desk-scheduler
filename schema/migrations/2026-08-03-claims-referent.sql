-- claims.referent — WHAT the grant was pinned to, carried through the
-- projection (#119).
--
-- The DO's history has recorded the referent since #107 (`historyStep` lands
-- it on the interval at bind), but `claims` had no column and the upsert wrote
-- none — so the projected row could not answer "which PR was this lease pinned
-- to". The consequence #113 hit: claims cannot distinguish a REFERENT-LESS
-- lapse (ordinary — a session died before opening a PR) from a BOUND lease
-- reaching its backstop (the "GC is down" alarm). The only claims-side proxy
-- was ttl_sec — bind-ticket.yml's 86400 default vs a shorter claim ttl — a
-- convention nothing enforces, misclassifying silently the moment someone
-- binds with a short ttl.
--
-- Rendering is `kind:id` (e.g. 'pr:bounded-systems/front-desk-scheduler#111'),
-- the same one reap-leases and expiry-watch print. NULL = never bound, which
-- stays information: the ordinary end of a session that died before pushing.
--
-- The backfill below is the projection catch-up the watermark fix cannot do
-- by itself: these rows' fencing is already AT the watermark, so the fixed
-- projector never re-reads them. Values were read from the live DO /history
-- on 2026-08-03 (open GET, no credential). Of the three projected rows, only
-- one has a referent to carry:
--
--   PVTI_…zg002eM f1  expired  — never bound; predates #107. Stays NULL.
--   PVTI_…zg0s_BQ f1  expired  — never bound; predates #107. Stays NULL.
--   PVTI_…zg0s_G4 f1  reaped   — bound to pr:…#111. Backfilled here.
--
-- (The fourth live interval, PVTI_…zg1IWIU → pr:…#117, is not yet projected —
-- its row lands complete via the fixed projector, no backfill needed.)
--
-- NOT idempotent as a file — Dolt has no conditional DDL. Idempotency is the
-- schema_migrations ledger's job; the runner skips an applied file.
--
-- Apply:  gh workflow run mirror-migrate.yml \
--           -f migration=2026-08-03-claims-referent.sql -f dry_run=false

ALTER TABLE `claims` ADD COLUMN `referent` varchar(255);

UPDATE `claims` SET `referent` = 'pr:bounded-systems/front-desk-scheduler#111'
  WHERE `item_id` = 'PVTI_lADOESuYO84BawOLzg0s_G4' AND `fencing` = 1;
