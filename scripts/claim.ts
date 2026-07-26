/**
 * front-desk claim — lease the next item for an agent (SQS-style, S1-safe).
 *
 *   node scripts/claim.ts --agent alice [--repo prx] [--ttl 3600]
 *   node scripts/claim.ts --release <item_id> --agent alice [--complete]
 *
 * The claim is an atomic CAS in the mirror: two agents racing the same item
 * cannot both win (the scheduler's proven S1). A dead agent's lease expires
 * after ttl and the item returns to the queue — no sweep, no stuck work.
 */

import { claimNext, mirrorMeta, readMirrorScheduling, releaseClaim } from "../src/mirror.ts";
import { isEligible, prioritize } from "../src/policy.ts";

const argv = process.argv.slice(2);
const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const agent = arg("--agent");
if (!agent) {
  console.error("usage: claim.ts --agent <name> [--repo R --ttl N] | --release <id> --agent <name> [--complete]");
  process.exit(2);
}

if (argv.includes("--release")) {
  const id = arg("--release")!;
  await releaseClaim(id, agent, argv.includes("--complete") ? "completed" : "released");
  console.log(`${argv.includes("--complete") ? "completed" : "released"} ${id} (agent ${agent}).`);
} else {
  const meta = await mirrorMeta();
  if (!meta) {
    console.error("no mirror — run scripts/sync.ts");
    process.exit(1);
  }
  const board = (await readMirrorScheduling()).filter((i) => !i.leased);
  const repo = arg("--repo");
  const scoped = repo ? board.filter((i) => i.repository === repo) : board;
  const inputs = scoped.map((i) => ({
    number: i.number, title: i.title, kind: i.kind, state: i.status === "Done" ? "closed" as const : "open" as const,
    effort: i.effort, value: i.value, openBlockers: i.openBlockers, unblocks: i.unblocks, ageDays: i.ageDays,
  }));
  const ordered = prioritize(inputs, Number.MAX_SAFE_INTEGER)
    .filter((r) => r.eligible)
    .map((r) => scoped.find((i) => i.number === r.number)!.id);

  const res = await claimNext(agent, ordered, arg("--ttl") ? Number(arg("--ttl")) : 3600);
  if (res.won) {
    console.log(`${agent} claimed #${res.number} (${res.itemId}) — ${res.reason}`);
    console.log(`  ${res.title}`);
  } else {
    console.log(`${agent}: ${res.reason}`);
    process.exit(1);
  }
}

void isEligible; // (re-exported for callers; keeps the policy surface adjacent)
