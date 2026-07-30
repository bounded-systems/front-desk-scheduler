# ci-workflows

Reusable GitHub Actions workflows shared across `bounded-systems`.

**This repo is public on purpose.** Private-repo workflows and actions never resolve into
public callers, and no org setting overrides that. The same constraint already forced the
approval gate into its own public repo
([`bounded-systems/await-approval`](https://github.com/bounded-systems/await-approval)).
With ~87 public repos to serve, a shared workflow has to live somewhere public.

| workflow | what it does |
|---|---|
| `.github/workflows/osv-scan.yml` | Scans a repo's dependency lockfiles against the OSV database. Hard-fails on a known vulnerability. |

## Using `osv-scan`

```yaml
name: deps
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  osv:
    uses: bounded-systems/ci-workflows/.github/workflows/osv-scan.yml@<full-sha>  # vX.Y.Z
```

Pin the **full commit SHA**, not a tag or branch — the org's Actions policy requires it,
and it is the whole reason a shared workflow is safe to fan out this widely.

### Inputs

| input | default | notes |
|---|---|---|
| `runs-on` | `ubuntu-latest` | Runner label. |
| `scan-path` | `.` | Directory to scan, relative to the repo root. |
| `ref` | *(caller's ref)* | Set only when scanning something other than the triggering commit. |

The scanner **version and digest are not inputs** — they are a matched pair, and a caller
able to override either one could silently defeat the pin. Bumping the scanner is an edit
to `osv-scan.yml`, reviewed once, inherited by every caller.

### When something is found

The lane goes red. To accept a finding, commit an `osv-scanner.toml` beside the lockfile:

```toml
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
reason = "Not reachable: we never call the affected codepath. Revisit when upstream ships a fix."
```

It is picked up automatically, and it leaves the reason in the tree as a reviewable diff
rather than quietly weakening the lane.

## Coverage — read this before assuming a green check means much

`scan source -r` walks the tree and selects its own extractors, so npm, Cargo, Go, Python,
Maven and the other ecosystems OSV-Scanner supports are all discovered without
configuration.

**`deno.lock` is not supported.** OSV-Scanner 2.4.0 ships no extractor for it; an explicit
`--lockfile=deno.lock` fails with `could not determine extractor suitable to this file`.
For a Deno-first repo, this workflow scans only whatever *other* manifests the repo
carries — **a green check does not mean the JSR/npm graph was examined.** Since a good part
of this org is Deno/JSR, that gap is a material limit on the rollout, not a footnote.
Tracked in [infra#104](https://github.com/bounded-systems/infra/issues/104).

A repo with nothing scannable passes (`--allow-no-lockfiles`) rather than red-lining.

## The scanner binary, and why it is pinned by digest

OSV-Scanner runs as a **pinned release binary**, not via `google/osv-scanner-action`. A
third-party action can invoke nested actions **by tag** — the proofs lane hit exactly this
when `lean-action` reached for `actions/cache/restore@v5` — and SHA-pinning the parent
cannot exempt its children. The org's full-SHA-pin policy rejects that. A release binary
has no children.

Current pin:

| | |
|---|---|
| version | `v2.4.0` |
| asset | `osv-scanner_linux_amd64` |
| sha256 | `15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0` |

### Provenance

infra#104 flagged that the original digest was captured inside a Claude Code session whose
egress runs through a TLS-intercepting proxy — *"pinned to what we saw"*, not a vendor
attestation — and asked for it to be re-derived before becoming an org-wide control.

Upstream publishes no `checksums.txt`, but it does publish a **SLSA provenance bundle**,
which is stronger than a checksums file. Verified 2026-07-30:

- the bundle's DSSE signature **verifies** against its embedded Fulcio certificate;
- the signed in-toto statement lists the digest above as the subject for
  `osv-scanner_linux_amd64`;
- the signing identity is the SLSA generator, not an ad-hoc key:

| field | value |
|---|---|
| SAN | `slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.1.0` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |
| source | `github.com/google/osv-scanner` @ `refs/tags/v2.4.0` |
| commit | `b56b5191101d5f27d4787d5583d8d01e9518a7af` |
| build run | [`google/osv-scanner` run 27762425209](https://github.com/google/osv-scanner/actions/runs/27762425209) |

**Residual gap, stated plainly:** the certificate was not chained to the Sigstore root
out-of-band, and Rekor was unreachable from the verifying session (egress policy), so the
transparency-log inclusion proof was **not** checked. A sufficiently capable interceptor
holding a forged Fulcio-chained certificate could still have produced what was observed —
a far higher bar than swapping a binary, but not zero.

Reproduce anywhere with open egress:

```sh
gh attestation verify --owner google \
  --bundle multiple.intoto.jsonl osv-scanner_linux_amd64
```

Or without `gh`, checking the signature and the subject directly:

```sh
V=v2.4.0
base=https://github.com/google/osv-scanner/releases/download/$V
curl -sSfLO $base/osv-scanner_linux_amd64
curl -sSfLO $base/multiple.intoto.jsonl
sha256sum osv-scanner_linux_amd64

python3 - <<'PY'
import json, base64
b = json.loads(open("multiple.intoto.jsonl").read().strip())
env = b["dsseEnvelope"]
open("cert.der","wb").write(base64.b64decode(b["verificationMaterial"]["certificate"]["rawBytes"]))
payload, pt = base64.b64decode(env["payload"]), env["payloadType"].encode()
open("pae.bin","wb").write(
    b"DSSEv1 " + str(len(pt)).encode() + b" " + pt + b" "
    + str(len(payload)).encode() + b" " + payload)
open("sig.der","wb").write(base64.b64decode(env["signatures"][0]["sig"]))
for s in json.loads(payload)["subject"]:
    print(s["digest"]["sha256"], s["name"])
PY

openssl x509 -in cert.der -inform DER -out cert.pem
openssl x509 -in cert.pem -noout -pubkey > pub.pem
openssl dgst -sha256 -verify pub.pem -signature sig.der pae.bin   # -> Verified OK
openssl x509 -in cert.pem -noout -text | grep -A2 "Subject Alternative Name"
```

Re-run this when bumping the version, and update both the digest and the identity table.
A wrong-but-stable digest fails loudly; an unpinned binary changes silently.
