/**
 * The pipeline, end to end, with fixture discipline (clean must pass,
 * violations must fail — asserted, not eyeballed):
 *
 *   JSON doc → [2] Zod gate (closed world, per document)
 *            → [3] JSON-LD expansion (tree dies, graph is born; the minted
 *                  context IRI resolves through a local documentLoader — the
 *                  vendored-hash-pinned answer to "IRIs need infrastructure")
 *            → [5] SHACL over the graph (shacl-engine — the same engine as
 *                  conformance-kit's shared runner)
 *            → and once more over the MERGED graph of two individually-valid
 *              documents, which is where S1 lives.
 */
import { readFile } from "node:fs/promises";
import jsonld from "jsonld";
import { Parser as N3Parser } from "n3";
import rdf from "@zazuko/env-node";
import { Validator } from "shacl-engine";
import { ClaimGrantDoc } from "./verb.ts";

const CONTEXT_IRI = "https://bounded.tools/ns/claim/v1";
const localContext = JSON.parse(await readFile(new URL("../context/claim-v1.jsonld", import.meta.url), "utf8"));

const documentLoader = async (url: string) => {
  if (url === CONTEXT_IRI) return { document: localContext, documentUrl: url };
  throw new Error(`refusing to fetch ${url} — all names must resolve locally (vendored, pinned)`);
};

async function toDataset(doc: unknown) {
  // `format` and a promise-returning documentLoader are jsonld.js's real API
  // (v8 docs); @types/jsonld lags it, hence the cast for the deno-check gate.
  const opts = { format: "application/n-quads", documentLoader } as unknown as Parameters<typeof jsonld.toRDF>[1];
  const nquads = (await jsonld.toRDF(doc as object, opts)) as string;
  return rdf.dataset(new N3Parser({ format: "N-Quads" }).parse(nquads));
}

const shapesTtl = await readFile(new URL("../shapes/claim.ttl", import.meta.url), "utf8");
const shapes = rdf.dataset(new N3Parser().parse(shapesTtl));
const validator = new Validator(shapes, { factory: rdf });

async function shaclReport(dataset: ReturnType<typeof rdf.dataset>) {
  const report = await validator.validate({ dataset });
  return {
    conforms: report.conforms,
    results: report.results.map((r: any) => ({
      focus: r.focusNode?.value ?? "?",
      path: r.path?.[0]?.predicates?.[0]?.value ?? r.path?.value ?? "(node)",
      message: (Array.isArray(r.message) ? r.message[0]?.value : r.message?.value) ?? r.sourceShape?.value ?? "violation",
    })),
  };
}

let failures = 0;
const expect = (name: string, got: boolean, want: boolean) => {
  const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗ FIXTURE BROKEN"}  ${name}: ${got ? "conforms" : "rejected"} (expected ${want ? "conforms" : "rejected"})`);
  if (!ok) failures++;
};

const load = async (f: string) => JSON.parse(await readFile(new URL(`../instances/${f}`, import.meta.url), "utf8"));

console.log("── layer 2: Zod gate ──────────────────────────────────");
const docs: Record<string, unknown> = {
  "grant-valid.json": await load("grant-valid.json"),
  "grant-violations.json": await load("grant-violations.json"),
  "grant-second.json": await load("grant-second.json"),
};
const gateResults: Record<string, boolean> = {};
for (const [name, doc] of Object.entries(docs)) {
  const r = ClaimGrantDoc.safeParse(doc);
  gateResults[name] = r.success;
  if (!r.success) for (const i of r.error.issues) console.log(`      ${name} → ${i.path.join(".") || "(root)"}: ${i.message}`);
}
expect("grant-valid", gateResults["grant-valid.json"], true);
expect("grant-violations", gateResults["grant-violations.json"], false);
expect("grant-second", gateResults["grant-second.json"], true);

console.log("\n── layers 3+5: expand → SHACL, per document ───────────");
for (const name of ["grant-valid.json", "grant-second.json"]) {
  const rep = await shaclReport(await toDataset(docs[name]));
  expect(name.replace(".json", ""), rep.conforms, true);
}
// the violations doc crosses layer 3 fine — show layer 5 catches it independently
{
  const rep = await shaclReport(await toDataset(docs["grant-violations.json"]));
  expect("grant-violations (graph layer, independent of the gate)", rep.conforms, false);
  for (const v of rep.results.slice(0, 6)) console.log(`      ${v.path.split("#").pop()}: ${v.message}`);
}

console.log("\n── the merged graph: where S1 lives ───────────────────");
const merged = rdf.dataset([
  ...(await toDataset(docs["grant-valid.json"])),
  ...(await toDataset(docs["grant-second.json"])),
]);
const rep = await shaclReport(merged);
expect("valid ⊎ second (each individually clean)", rep.conforms, false);
for (const v of rep.results) console.log(`      ${v.focus.split("/").pop()}: ${v.message}`);

console.log(failures ? `\n${failures} fixture expectation(s) BROKEN` : "\nall fixture expectations hold");
process.exit(failures ? 1 : 0);
