/**
 * front-desk hidden — write HIDDEN work (the dolt-without-gh surface).
 *
 * Creates a Dolt-born item that has no GitHub counterpart: planning/scratch work
 * that whats-next can rank against but that never touches GitHub — until you
 * `capture` it. Shared via DoltHub, invisible to the GitHub board.
 *
 *   node scripts/hidden.ts --repo prx --title "spike: X" [--kind task --effort 3 --value 50]
 *   node scripts/hidden.ts --capture <dolt:id>   # promote to a real GitHub issue on next push
 */

import { captureHidden, insertHiddenItem } from "../src/mirror.ts";

const argv = process.argv.slice(2);
const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);

if (argv.includes("--capture")) {
  const id = arg("--capture")!;
  await captureHidden(id);
  console.log(`${id} marked for capture — run scripts/push.ts to create the GitHub issue.`);
} else {
  const title = arg("--title");
  const repo = arg("--repo");
  if (!title || !repo) {
    console.error("usage: hidden.ts --repo <name> --title <text> [--kind K --effort N --value N]");
    process.exit(2);
  }
  const localId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const id = await insertHiddenItem(
    {
      title,
      repository: repo,
      kind: arg("--kind"),
      effort: arg("--effort") ? Number(arg("--effort")) : undefined,
      value: arg("--value") ? Number(arg("--value")) : undefined,
    },
    localId,
  );
  console.log(`hidden item created: ${id} (repo ${repo}) — visible to whats-next, not on GitHub.`);
}
