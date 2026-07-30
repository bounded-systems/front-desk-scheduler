/**
 * front-desk push — flush the Dolt write surface to GitHub (captured work).
 *
 *   - dolt-born capture-requested rows → new GitHub issues (fields in frontmatter)
 *   - dolt-dirty github rows → effort/value written up to the board project fields
 *
 * Budget-gated. Read-only surfaces (`next`) never call this; it's the one
 * place Dolt-side edits become GitHub-visible.
 */

import { syncPush } from "../src/mirror.ts";

const res = await syncPush();
if (res.gated) {
  console.error("push GATED by API budget — retry after reset.");
  process.exit(3);
}
console.log(`captured ${res.captured} hidden item(s) → GitHub issues; pushed ${res.pushed} field-edit(s) to the board.`);
if (res.captured > 0) console.log("(run scripts/sync.ts to re-absorb the new issues as github-origin rows.)");
