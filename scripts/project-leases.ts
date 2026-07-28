#!/usr/bin/env node
/**
 * project-leases — pull grant history from the lease DOs, upsert into the
 * mirror clone's `claims` table.
 *
 *     FDS_CLAIM_ENDPOINT=https://… node scripts/project-leases.ts [--dir mirror]
 *
 * Run from the lease-projection workflow against a fresh clone of the mirror;
 * the workflow commits (attributed + attested) and pushes. This script only
 * READS the DOs and WRITES the clone — commit policy stays with the caller.
 *
 * The loop is the whole design (docs/queue-vs-log.md, "the log records
 * decisions rather than being the decision"):
 *
 *   1. enumerate items from the BOARD (the clone), not from a registry — the
 *      claim path ranks board items, so the board bounds the poll set, and an
 *      FK on claims would refuse orphans anyway;
 *   2. read each item's watermark FROM THE PROJECTION ITSELF (max projected
 *      fencing) — no separate cursor to lose, so a failed run is a catch-up;
 *   3. fetch history above the watermark, plan idempotent upserts, apply.
 *
 * REFUSES to run without FDS_CLAIM_ENDPOINT (exit 2) rather than exiting
 * green: the workflow gates that case itself, and a script that reports
 * success with no endpoint would be a green made of nothing — the claim-race
 * lesson. A missing `fencing` column is a named fix (the migration), not a
 * stack trace.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchLeaseHistory } from "../src/lease-client.ts";
import { ITEMS_SQL, planProjection, WATERMARK_SQL } from "../src/lease-projection.ts";

const pexecFile = promisify(execFile);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = arg("dir", "mirror");

if (!process.env.FDS_CLAIM_ENDPOINT?.trim()) {
  console.error(
    "project-leases: FDS_CLAIM_ENDPOINT is unset — there is no lease plane to project from.\n" +
      "  Refusing rather than reporting an empty success; the caller decides whether\n" +
      "  'no plane deployed' is a skip (the workflow does) or a failure.",
  );
  process.exit(2);
}

async function dsql(query: string): Promise<string> {
  const { stdout } = await pexecFile("dolt", ["sql", "-q", query, "-r", "json"], {
    cwd: DIR,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function dsqlRows<T>(query: string): Promise<T[]> {
  const parsed = JSON.parse((await dsql(query)) || "{}") as { rows?: T[] };
  return parsed.rows ?? [];
}

async function main(): Promise<void> {
  // Fail on the missing column BEFORE doing any network work, with the fix
  // named. There is always a window where merged code runs against an
  // unmigrated mirror; the window should say its own name.
  try {
    await dsqlRows(WATERMARK_SQL);
  } catch (e) {
    if (/Unknown column|could not find column/i.test(String(e))) {
      console.error(
        "project-leases: the mirror has no claims.fencing column — the projection's\n" +
          "  idempotency key does not exist yet. Apply the migration first:\n" +
          "    gh workflow run mirror-migrate.yml -f migration=2026-07-29-claims-fencing.sql -f dry_run=false",
      );
      process.exit(1);
    }
    throw e;
  }

  const items = (await dsqlRows<{ item_id: string }>(ITEMS_SQL)).map((r) => r.item_id);
  const marks = new Map(
    (await dsqlRows<{ item_id: string; max_fencing: number }>(WATERMARK_SQL)).map((r) => [
      r.item_id,
      Number(r.max_fencing),
    ]),
  );

  let polled = 0, projected = 0, failures = 0;
  const CONCURRENCY = 8;
  for (let at = 0; at < items.length; at += CONCURRENCY) {
    const batch = items.slice(at, at + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (itemId) => {
        const watermark = marks.get(itemId) ?? 0;
        const { records } = await fetchLeaseHistory(itemId, watermark);
        return { itemId, plan: planProjection(itemId, records, watermark) };
      }),
    );
    for (const r of results) {
      polled++;
      if (r.status === "rejected") {
        // One item's DO being unreachable must not silently shrink the
        // projection — count it, name it, fail the run at the end.
        failures++;
        console.error(`project-leases: ${String(r.reason)}`);
        continue;
      }
      for (const sql of r.value.plan) {
        await dsql(sql);
        projected++;
      }
    }
  }

  console.log(`project-leases: polled ${polled} item(s), projected ${projected} grant interval(s)`);
  if (failures > 0) {
    console.error(
      `project-leases: ${failures} item(s) could not be read — the projection is INCOMPLETE this run.\n` +
        "  Failing rather than committing silence: the missed grants are still in their DOs\n" +
        "  (retention is what replayability rests on) and the next successful run picks them up.",
    );
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`project-leases: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
