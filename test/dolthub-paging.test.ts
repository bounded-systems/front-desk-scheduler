/**
 * #88 — the all-items read against the capped HTTP plane.
 *
 * These drive `readAllItems` over a stubbed `fetch`, so they assert the SQL that
 * actually goes on the wire. That is the level the bug lived at: the verb looked
 * correct, and `--repo` looked like it scoped, because the filter ran on the
 * rows AFTER the query that was already too big to return.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { query, readAllItems } from "../src/dolthub.ts";

const HEAD = "kga06dqt7p5iqt491r1gl393bagl1p7l"; // 32 chars — resolveHead's shape pin

type Handler = (sql: string) => { rows: unknown[]; status?: string; message?: string };

/** Install a fake DoltHub, capture every SQL string it is asked. */
function withFetch(handler: Handler): { sql: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const sql: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const q = decodeURIComponent(String(url).split("?q=")[1] ?? "");
    sql.push(q);
    const { rows, status, message } = handler(q);
    return {
      ok: true,
      json: async () => ({
        query_execution_status: status ?? "Success",
        query_execution_message: message,
        rows,
      }),
    } as unknown as Response;
  }) as typeof fetch;
  return { sql, restore: () => { globalThis.fetch = real; } };
}

const item = (id: string, repository = "prx") => ({
  item_id: id,
  number: 1,
  title: "t",
  repository,
  status: "Todo",
  kind: "task",
  effort: 1,
  value: 1,
  depends_on: "",
  age_days: 0,
});

/** `n` items with ascending, zero-padded ids — the keyset order. */
const page = (from: number, n: number, repository = "prx") =>
  Array.from({ length: n }, (_, i) => item(String(from + i).padStart(6, "0"), repository));

function headResponder(handler: Handler): Handler {
  return (sql) => (/FROM dolt_log/.test(sql) ? { rows: [{ commit_hash: HEAD }] } : handler(sql));
}

test("readAllItems: walks past the row cap in pages and returns every row", async () => {
  // 1531 rows — the real board on 2026-07-31, 531 over the cap.
  const all = page(1, 1531);
  const f = withFetch(headResponder((sql) => {
    const m = /item_id > '([^']*)'/.exec(sql);
    const after = m![1];
    return { rows: all.filter((r) => r.item_id > after).slice(0, 600) };
  }));
  try {
    const { items } = await readAllItems();
    assert.equal(items.length, 1531);
    assert.equal(new Set(items.map((i) => i.item_id)).size, 1531, "no duplicates across pages");
    const ids = items.map((i) => i.item_id);
    assert.ok(ids.every((v, i) => i === 0 || ids[i - 1]! < v), "strictly ascending");
    assert.equal(f.sql.filter((s) => /FROM items/.test(s)).length, 3, "1531 rows = 3 pages of 600");
  } finally {
    f.restore();
  }
});

test("readAllItems: keyset cursor advances, and never uses OFFSET", async () => {
  const all = page(1, 700);
  const f = withFetch(headResponder((sql) => {
    const after = /item_id > '([^']*)'/.exec(sql)![1];
    return { rows: all.filter((r) => r.item_id > after).slice(0, 600) };
  }));
  try {
    await readAllItems();
    const pages = f.sql.filter((s) => /FROM items/.test(s));
    assert.match(pages[0]!, /item_id > ''/, "first page starts at the empty cursor");
    assert.match(pages[1]!, /item_id > '000600'/, "second page resumes after the last id seen");
    // OFFSET windows shift under a concurrent sync; keyset windows cannot.
    assert.ok(pages.every((s) => !/OFFSET/i.test(s)), "no OFFSET anywhere");
    assert.ok(pages.every((s) => /ORDER BY item_id/.test(s)), "ordered by the primary key");
  } finally {
    f.restore();
  }
});

test("readAllItems: every page is pinned to ONE commit, and it is reported", async () => {
  const all = page(1, 700);
  const f = withFetch(headResponder((sql) => {
    const after = /item_id > '([^']*)'/.exec(sql)![1];
    return { rows: all.filter((r) => r.item_id > after).slice(0, 600) };
  }));
  try {
    const { at } = await readAllItems();
    assert.equal(at, HEAD);
    const pages = f.sql.filter((s) => /FROM items/.test(s));
    assert.equal(pages.length, 2);
    // Unpinned, page 2 could read a board page 1 never saw.
    assert.ok(pages.every((s) => s.includes(`FROM items AS OF '${HEAD}'`)), "same pin on every page");
  } finally {
    f.restore();
  }
});

test("readAllItems: --repo narrows the query, not the result set", async () => {
  const f = withFetch(headResponder(() => ({ rows: page(1, 3, "front-desk-scheduler") })));
  try {
    await readAllItems("main", { repo: "front-desk-scheduler" });
    const pages = f.sql.filter((s) => /FROM items/.test(s));
    assert.match(pages[0]!, /repository = 'front-desk-scheduler'/);
  } finally {
    f.restore();
  }
});

test("readAllItems: a repo name with a quote cannot break out of the literal", async () => {
  const f = withFetch(headResponder(() => ({ rows: [] })));
  try {
    await readAllItems("main", { repo: "o'brien" });
    assert.match(f.sql.find((s) => /FROM items/.test(s))!, /repository = 'o''brien'/);
  } finally {
    f.restore();
  }
});

test("readAllItems: falls back to the legacy shape when `needs` is absent", async () => {
  // A pin to a commit older than the 2026-07-31 migration. Permanent capability
  // of a versioned DB, not transitional scaffolding.
  let asked = 0;
  const f = withFetch(headResponder((sql) => {
    if (/needs/.test(sql)) {
      asked++;
      // Dolt reports this in the MESSAGE, with the status merely non-Success —
      // which is what the fallback regex actually matches against.
      return { rows: [], status: "Error", message: "column `needs` not found" };
    }
    return { rows: page(1, 2) };
  }));
  try {
    const { items } = await readAllItems();
    assert.equal(items.length, 2);
    assert.equal(asked, 1, "retried once, then stayed on the legacy shape");
  } finally {
    f.restore();
  }
});

// ── the guard that makes the NEXT cap crossing loud ─────────────────────────

test("query: an unpaginated read fails before it reaches the cap", async () => {
  const f = withFetch(() => ({ rows: page(1, 900) }));
  try {
    await assert.rejects(
      () => query("SELECT * FROM items"),
      // Must say what to do — "narrow it" was the old message, and it gave the
      // caller of `list` no available action at all.
      (e: Error) => /unpaginated/.test(e.message) && /paginate/i.test(e.message),
    );
  } finally {
    f.restore();
  }
});

test("query: a paginated read is exempt from the guard", async () => {
  const f = withFetch(() => ({ rows: page(1, 950) }));
  try {
    const rows = await query("SELECT * FROM items LIMIT 950", "main", { paginated: true });
    assert.equal(rows.length, 950);
  } finally {
    f.restore();
  }
});

test("query: an ordinary small read is unaffected", async () => {
  const f = withFetch(() => ({ rows: page(1, 233) })); // ~today's non-Done count
  try {
    assert.equal((await query("SELECT * FROM items")).length, 233);
  } finally {
    f.restore();
  }
});
