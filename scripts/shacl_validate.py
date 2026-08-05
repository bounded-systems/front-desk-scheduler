#!/usr/bin/env python3
"""Render the Dolt mirror as RDF and validate it against the SHACL shapes.

The declarative twin of the SQL shape checks (D1-D6): the SAME item/edge data,
rendered as one fd:Item per row + fd:dependsOn edges, validated by pyshacl
against specs/shacl/front-desk-shapes.ttl. This is the org-conformance path
(#3) — the shapes here can move to conformance-kit's runner unchanged.

Usage: .venv/bin/python scripts/shacl_validate.py [--live] [--print-graph]
       .venv/bin/python scripts/shacl_validate.py --fixtures

  --live   read the board over the public DoltHub HTTP plane (no dolt binary, no
           clone, no credential) instead of `dolt sql` against ./mirror.

Exit 0 = conforms, 1 = violations, 2 = error.
"""
import json
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR = ROOT / "mirror"
SHAPES = ROOT / "specs" / "shacl" / "front-desk-shapes.ttl"
NS = "https://bounded.tools/ns/front-desk#"

# ── the read plane, over HTTP ────────────────────────────────────────────────
# Mirrors src/dolthub.ts. Deliberately a SECOND implementation rather than a
# shared one: this is Python and that is TypeScript, and the alternative (shell
# out to the CLI) is exactly the dolt-binary dependency `--live` exists to
# remove. The constants below are the ones that must not drift — they are
# properties of DoltHub's API, not of either client.
DB = "bounded-systems/front-desk-mirror"
API = f"https://www.dolthub.com/api/v1alpha1/{DB}"
ROW_CAP = 1000   # DoltHub's hard per-query cap; crossing it is a status, not rows
CAP_GUARD = 900  # where an UNPAGINATED read is made to fail, with headroom (#88)
PAGE_ROWS = 600


def dsql(query: str):
    out = subprocess.run(
        ["dolt", "sql", "-q", query, "-r", "json"],
        cwd=MIRROR, capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out or "{}").get("rows", [])


def dhub(sql: str, ref: str = "main", paginated: bool = False):
    """Query the DoltHub read plane.

    CHECK THE STATUS, NOT JUST THE ROWS. An over-cap query returns
    `query_execution_status: "RowLimit"` **with 1000 rows in the body** — a
    client that reads `rows` and ignores the status gets a silently truncated
    board and no error. Measured on this mirror, 2026-08-04: `SELECT item_id
    FROM items` → RowLimit, 1000 rows, against a table of 1782. SHACL over that
    prefix would report CONFORMS on 56% of the board and look like a pass.
    """
    url = f"{API}/{ref}?q={urllib.parse.quote(sql)}"
    with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310
        body = json.load(r)
    status = body.get("query_execution_status")
    if status == "RowLimit":
        raise RuntimeError(
            f"DoltHub query exceeded the {ROW_CAP}-row cap and was TRUNCATED — paginate it: {sql[:120]}"
        )
    if status != "Success":
        raise RuntimeError(f"DoltHub query failed: {body.get('query_execution_message') or status}")
    rows = body.get("rows", [])
    if not paginated and len(rows) >= CAP_GUARD:
        raise RuntimeError(
            f"DoltHub query returned {len(rows)} rows, within {ROW_CAP - len(rows)} of the {ROW_CAP}-row cap — "
            f"this read is unpaginated and is about to break. Paginate it (keyset on the primary key, "
            f"pinned with AS OF). Failing now, with headroom, is the point."
        )
    return rows


def sql_quote(v: str) -> str:
    return "'" + v.replace("\\", "\\\\").replace("'", "''") + "'"


def read_live():
    """The whole board over HTTP, paginated and snapshot-consistent.

    KEYSET, NOT OFFSET, and PINNED — the same two constraints `list` is built on
    (#88). Each page is an independent HTTP request, so an unpinned walk races
    the syncer and silently drops or repeats rows; `AS OF` the resolved head
    makes every page read one immutable snapshot. `items` was 1782 rows on
    2026-08-04, so this is not a precaution against future growth — an
    unpaginated read of it fails today.

    `item_deps` has a COMPOSITE primary key, so its keyset is a row-value
    comparison over the pair. It was only 86 rows when this was written and
    would have fit in one request; it is paged anyway because "it fits today" is
    the assumption #88 was filed about.
    """
    head = dhub("SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1")[0]["commit_hash"]

    items, last = [], ""
    while True:
        page = dhub(
            f"SELECT item_id, number, repository, status, kind, effort, value, origin FROM items AS OF {sql_quote(head)} "
            f"WHERE item_id > {sql_quote(last)} ORDER BY item_id LIMIT {PAGE_ROWS}",
            paginated=True,
        )
        if not page:
            break
        items += page
        last = page[-1]["item_id"]

    edges, last_i, last_d = [], "", ""
    while True:
        page = dhub(
            f"SELECT item_id, dep_item_id, edge_type FROM item_deps AS OF {sql_quote(head)} "
            f"WHERE (item_id, dep_item_id) > ({sql_quote(last_i)}, {sql_quote(last_d)}) "
            f"ORDER BY item_id, dep_item_id LIMIT {PAGE_ROWS}",
            paginated=True,
        )
        if not page:
            break
        edges += page
        last_i, last_d = page[-1]["item_id"], page[-1]["dep_item_id"]

    return items, edges, head


def uri(item_id: str) -> str:
    # item_id is a project-item id (PVTI_...) or dolt:<local> — keep URI-safe.
    return f"<{NS}item/{item_id.replace(':', '_')}>"


def read_dolt():
    """The whole board from a local dolt clone. Needs the binary and ./mirror."""
    return (
        dsql("SELECT item_id, number, repository, status, kind, effort, value, origin FROM items"),
        dsql("SELECT item_id, dep_item_id, edge_type FROM item_deps"),
        None,
    )


def render_turtle(items, edges) -> str:
    lines = [f"@prefix fd: <{NS}> .",
             "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .", ""]
    for it in items:
        u = uri(it["item_id"])
        parts = [f"{u} a fd:Item",
                 f'fd:self {u}',
                 f'fd:status "{it["status"]}"',
                 f'fd:kind "{it["kind"]}"',
                 f'fd:effort "{it["effort"]}"^^xsd:double',
                 f'fd:value "{it["value"]}"^^xsd:double',
                 f'fd:origin "{it["origin"]}"']
        if it["number"] is not None:
            parts.append(f'fd:number "{it["number"]}"^^xsd:integer')
        lines.append(" ;\n  ".join(parts) + " .")
    for e in edges:
        # RENDERER REQUIREMENT 4 (#156): the predicate is decided by edge kind.
        # `fd:dependsOn` is a GATING dependency (blocks / parent-child — the
        # scheduler's BLOCKER_KINDS); `closes` is mined PR→issue provenance and
        # renders as `fd:closes`. Flattening both onto fd:dependsOn makes D2/D3
        # disagree with the scheduler and the writeback derivation: a Todo with
        # an open closing PR would warn "should be Blocked" — the exact
        # inversion #155 removed from the ranking (an open closing PR means the
        # item is in DELIVERY, not mis-statused).
        pred = "fd:closes" if e["edge_type"] == "closes" else "fd:dependsOn"
        lines.append(f'{uri(e["item_id"])} {pred} {uri(e["dep_item_id"])} .')
    return "\n".join(lines) + "\n"


def validate_ttl(ttl_or_path: str, allow_warnings: bool = False):
    """Run pyshacl over a Turtle string or file path.

    Returns (conforms, report_text, results_graph). With `allow_warnings`,
    `conforms` reflects VIOLATIONS ONLY — sh:Warning and sh:Info results are
    still produced and still in the graph, they just do not flip the verdict.
    """
    from pyshacl import validate
    conforms, graph, report = validate(
        ttl_or_path, shacl_graph=str(SHAPES), data_graph_format="turtle",
        shacl_graph_format="turtle", inference="none", advanced=True,
        allow_warnings=allow_warnings,
    )
    return conforms, report, graph


SH = "http://www.w3.org/ns/shacl#"


def results_by_severity(graph):
    """Group validation results as {severity: [(focus_node, message)]}.

    Read off the results GRAPH rather than scraped out of the report text: the
    text is a human rendering and its layout is pyshacl's business, not a
    contract. Gating on a substring of it would be the same mistake as trusting
    `rows` without `query_execution_status`.
    """
    from rdflib import URIRef
    out = {}
    for r in graph.subjects(URIRef(SH + "resultSeverity"), None):
        sev = str(graph.value(r, URIRef(SH + "resultSeverity"))).replace(SH, "sh:")
        focus = str(graph.value(r, URIRef(SH + "focusNode")) or "?")
        msg = str(graph.value(r, URIRef(SH + "resultMessage")) or "?")
        out.setdefault(sev, []).append((focus, msg))
    return out


# Each entry: (what it guards, a string that MUST appear in the violations report).
#
# Asserting the presence of each one — rather than only `conforms is False` — is
# the point of the negative fixture. A single surviving violation would satisfy
# "does not conform" while every other shape sat silently disabled, which is
# exactly the failure mode measured in #139: shacl-engine skips all sh:sparql
# shapes unless opted in, and a core-only violation would still have gone red.
EXPECTED_VIOLATIONS = [
    ("status/kind outside the enum",      "InConstraintComponent"),
    ("effort/value/number out of range",  "InclusiveConstraintComponent"),
    ("self-dependency (chk_no_self_dep)", "DisjointConstraintComponent"),
    ("D1 — dependency cycle",             "Item participates in a dependency cycle"),
    ("D2 — unjustified block",            "Blocked item has no open dependency recorded"),
    ("D3 — Todo that should be Blocked",  "Todo item has open dependencies"),
    ("github-origin row with no number",  "must carry its issue number"),
    ("self-targeted closes edge",         "closes edge is malformed"),
]


def run_fixtures() -> int:
    """Validate the validator: the clean fixture must pass, the bad one must fail.

    A validator that cannot fail is not a validator. Without the negative case,
    `conforms: true` on the real mirror is indistinguishable from a validator
    that silently checked nothing — see the header of the shapes file.
    """
    fixtures = ROOT / "specs" / "shacl" / "fixtures"
    ok = True

    conforms, report, _ = validate_ttl(str(fixtures / "clean.ttl"))
    if conforms:
        print("✓ clean.ttl conforms")
    else:
        ok = False
        print("✗ clean.ttl MUST conform but reported violations:")
        print(report)

    conforms, report, _ = validate_ttl(str(fixtures / "violations.ttl"))
    if conforms:
        ok = False
        print("✗ violations.ttl MUST NOT conform — every shape is silently disabled")
    else:
        print("✓ violations.ttl is rejected")
        for label, needle in EXPECTED_VIOLATIONS:
            if needle in report:
                print(f"  ✓ {label}")
            else:
                ok = False
                print(f"  ✗ {label} — expected `{needle}` in the report, absent")

    print("\nSHACL fixtures:", "PASS ✓" if ok else "FAIL ✗")
    return 0 if ok else 1


def main() -> int:
    if "--fixtures" in sys.argv:
        return run_fixtures()

    live = "--live" in sys.argv
    items, edges, head = read_live() if live else read_dolt()
    ttl = render_turtle(items, edges)
    if "--print-graph" in sys.argv:
        print(ttl)
        return 0

    # Warnings do NOT gate. D1 (a dependency cycle) is sh:Violation — an item that
    # can never become Ready, i.e. the board is corrupt. D2/D3 are sh:Warning: a
    # Todo that should be Blocked is untidy, not broken, and a human fixes it by
    # moving a card. Gating on those would have red-lined this lane on its first
    # run (2 warnings live on 2026-08-04) — which is precisely how `broker-drift`
    # became a monitor nobody read (#124). They are printed, named and counted;
    # they are not laundered into a pass.
    conforms, report, graph = validate_ttl(ttl, allow_warnings=True)
    by_sev = results_by_severity(graph)

    # The conformance surface: one verdict line in the same shape conformance-kit's
    # runner emits (`✓ shacl-runner: conforms: true — N quad(s) …`), so the board
    # reports the way the sites do. It also NAMES THE COMMIT — a verdict about a
    # board that changes every few minutes is meaningless without the state it was
    # derived from, and `AS OF '<commit>'` re-derives this exact answer.
    at = f" AS OF '{head[:12]}'" if head else " (local clone)"
    scope = f"{len(items)} item(s), {len(edges)} edge(s){at}"

    # A focus node is a URI nobody can act on. Resolve it back to repo#number so
    # a warning names the card a human has to move.
    label = {uri(i["item_id"]).strip("<>"): f'{i.get("repository", "?")}#{i["number"]}'
             for i in items if i.get("number") is not None}

    warnings = by_sev.get("sh:Warning", []) + by_sev.get("sh:Info", [])
    violations = by_sev.get("sh:Violation", [])

    if conforms:
        print(f"✓ shacl-mirror: conforms: true — {scope} satisfy the SHACL contract")
    else:
        print(f"✗ shacl-mirror: conforms: false — {scope}; {len(violations)} violation(s)")
        for focus, msg in violations:
            print(f"    ✗ {label.get(focus, focus)} — {msg}")

    # Printed on BOTH paths, and after the verdict rather than folded into it: a
    # warning that only appears when something else already failed is a warning
    # nobody sees. Zero is stated explicitly too — "no output" and "not checked"
    # look identical otherwise (#124: zero attempts is not evidence of success).
    if warnings:
        print(f"  ⚠ {len(warnings)} warning(s) — advisory, not gating:")
        for focus, msg in warnings:
            print(f"    ⚠ {label.get(focus, focus)} — {msg}")
    else:
        print("  ⚠ 0 warnings")

    return 0 if conforms else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)
