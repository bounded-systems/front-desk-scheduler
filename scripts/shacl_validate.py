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
    items = dsql("SELECT item_id, number, status, kind, effort, value FROM items")
    edges = dsql("SELECT item_id, dep_item_id FROM item_deps")
    lines = [f"@prefix fd: <{NS}> .",
             "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .", ""]
    for it in items:
        u = uri(it["item_id"])
        parts = [f"{u} a fd:Item",
                 f'fd:self {u}',
                 f'fd:status "{it["status"]}"',
                 f'fd:kind "{it["kind"]}"',
                 f'fd:effort "{it["effort"]}"^^xsd:double',
                 f'fd:value "{it["value"]}"^^xsd:double']
        if it["number"] is not None:
            parts.append(f'fd:number "{it["number"]}"^^xsd:integer')
        lines.append(" ;\n  ".join(parts) + " .")
    for e in edges:
        lines.append(f'{uri(e["item_id"])} fd:dependsOn {uri(e["dep_item_id"])} .')
    return "\n".join(lines) + "\n"


def main() -> int:
    ttl = render_turtle()
    if "--print-graph" in sys.argv:
        print(ttl)
        return 0
    from pyshacl import validate
    conforms, _graph, report = validate(
        ttl, shacl_graph=str(SHAPES), data_graph_format="turtle",
        shacl_graph_format="turtle", inference="none", advanced=True,
    )
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
