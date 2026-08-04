#!/usr/bin/env python3
"""Render the Dolt mirror as RDF and validate it against the SHACL shapes.

The declarative twin of the SQL shape checks (D1-D6): the SAME item/edge data,
rendered as one fd:Item per row + fd:dependsOn edges, validated by pyshacl
against specs/shacl/front-desk-shapes.ttl. This is the org-conformance path
(#3) — the shapes here can move to conformance-kit's runner unchanged.

Usage: .venv/bin/python scripts/shacl_validate.py [--print-graph]
Exit 0 = conforms, 1 = violations, 2 = error.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR = ROOT / "mirror"
SHAPES = ROOT / "specs" / "shacl" / "front-desk-shapes.ttl"
NS = "https://bounded.tools/ns/front-desk#"


def dsql(query: str):
    out = subprocess.run(
        ["dolt", "sql", "-q", query, "-r", "json"],
        cwd=MIRROR, capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out or "{}").get("rows", [])


def uri(item_id: str) -> str:
    # item_id is a project-item id (PVTI_...) or dolt:<local> — keep URI-safe.
    return f"<{NS}item/{item_id.replace(':', '_')}>"


def render_turtle() -> str:
    items = dsql("SELECT item_id, number, status, kind, effort, value, origin FROM items")
    edges = dsql("SELECT item_id, dep_item_id FROM item_deps")
    lines = [f"@prefix fd: <{NS}> .",
             "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .", ""]
    for it in items:
        u = uri(it["item_id"])
        parts = [f"{u} a fd:Item",
                 f'fd:self {u}',
                 f'fd:origin "{it["origin"]}"',
                 f'fd:status "{it["status"]}"',
                 f'fd:kind "{it["kind"]}"',
                 f'fd:effort "{it["effort"]}"^^xsd:double',
                 f'fd:value "{it["value"]}"^^xsd:double']
        # Absent iff dolt-born (#143): number is github identity, and the shapes
        # agree — fd:GithubIdentityShape reds a github-origin item without one.
        if it["number"] is not None:
            parts.append(f'fd:number "{it["number"]}"^^xsd:integer')
        lines.append(" ;\n  ".join(parts) + " .")
    for e in edges:
        lines.append(f'{uri(e["item_id"])} fd:dependsOn {uri(e["dep_item_id"])} .')
    return "\n".join(lines) + "\n"


def validate_ttl(ttl_or_path: str):
    """Run pyshacl over a Turtle string or file path. Returns (conforms, report)."""
    from pyshacl import validate
    conforms, _graph, report = validate(
        ttl_or_path, shacl_graph=str(SHAPES), data_graph_format="turtle",
        shacl_graph_format="turtle", inference="none", advanced=True,
    )
    return conforms, report


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
    ("github-origin item w/o a number",   "GitHub-origin item has no fd:number"),
]


def run_fixtures() -> int:
    """Validate the validator: the clean fixture must pass, the bad one must fail.

    A validator that cannot fail is not a validator. Without the negative case,
    `conforms: true` on the real mirror is indistinguishable from a validator
    that silently checked nothing — see the header of the shapes file.
    """
    fixtures = ROOT / "specs" / "shacl" / "fixtures"
    ok = True

    conforms, report = validate_ttl(str(fixtures / "clean.ttl"))
    if conforms:
        print("✓ clean.ttl conforms")
    else:
        ok = False
        print("✗ clean.ttl MUST conform but reported violations:")
        print(report)

    conforms, report = validate_ttl(str(fixtures / "violations.ttl"))
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
    ttl = render_turtle()
    if "--print-graph" in sys.argv:
        print(ttl)
        return 0
    conforms, report = validate_ttl(ttl)
    print(f"SHACL: {'CONFORMS ✓' if conforms else 'VIOLATIONS ✗'}")
    if not conforms:
        print(report)
    return 0 if conforms else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)
