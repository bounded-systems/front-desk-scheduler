#!/usr/bin/env node
// cloud-env-check — is the Claude Code cloud-environment dialog in sync with
// the repo's checked-in record of it (.claude/cloud-environment.json)?
//
// The dialog is configured by hand in the claude.ai/code UI and can go stale
// (it once shipped a wrong Lean hostname). This script catches that at boot,
// with a message, instead of later by whichever install the stale config breaks.
//
// ── FLEET-MANAGED FILE — canonical copy lives in bounded-systems/ci-workflows ──
// at tools/cloud-env-check.mjs. Every adopting repo carries a VENDORED copy at
// .claude/hooks/cloud-env-check.mjs, and env-check-drift.yml measures that copy
// against a digest pinned upstream (CANONICAL_SHA256).
//
// So: DO NOT EDIT A VENDORED COPY. A local fix goes red on that repo's next
// relevant PR and is lost on the next re-vendor. Because this script is
// repo-agnostic, a change you want here is almost always one every adopter needs
// — make it upstream and re-vendor. Bump procedure: ci-workflows README,
// "Bumping the canonical script".
//
// Repo-agnostic on purpose: everything repo-specific lives in the config file's
// "handshake" block, so no edit to this script is needed to adopt it.
//
// ADOPTION IS FOUR THINGS, NOT TWO — steps 3 and 4 live outside both files, and
// nothing runs the script if they are skipped:
//   1. vendor this file to .claude/hooks/cloud-env-check.mjs
//   2. write .claude/cloud-environment.json (handshake block + domain list)
//   3. invoke it from a SessionStart hook
//   4. set the handshake variable in the cloud environment dialog
//
//   "handshake": { "variable": "FDS_ENV_CONFIG", "prefix": "FDS_" }
//
// Three checks:
//   1. handshake — the config content is hashed into a short digest; the dialog
//      echoes it back via the handshake variable. Mismatch ⇒ the dialog and the
//      file disagree about domains or env vars. The handshake variable's NAME is
//      part of the digest (renaming it is a real dialog change) but its VALUE is
//      excluded (it IS the digest — hashing it would be circular).
//   2. prefix reconciliation — every session env var starting with the prefix
//      must be recorded under environmentVariables, and vice versa. The
//      handshake variable itself is exempt: it is always present in a configured
//      session, so flagging it UNRECORDED would be a permanent false positive in
//      any repo that doesn't also list it (this bug shipped once, masked here
//      because front-desk happened to list it).
//   3. --verify-domains — probe every allowlisted domain through the proxy and
//      reconcile what answers against what the record expects ("expect" per
//      entry: "reachable" | "blocked", default "reachable"). The digest attests
//      to what the operator typed, not what the dialog actually contains; an
//      allowlist edit the operator didn't record (or a drop they didn't notice)
//      is invisible to it. The proxy is its own oracle: a blocked host yields
//      curl code 000, an allowlisted one yields any real HTTP status. Red means
//      the record and the proxy DISAGREE, in either direction: an entry that is
//      recorded-but-absent on purpose ("expect": "blocked") stays green while
//      the dialog withholds it — no more tolerating a red gate as the cost of
//      honest record-keeping — and goes red the moment the dialog grants it,
//      so the record gets corrected instead of rotting in prose
//      (.github-private#316: two entries kept probing green after a dialog
//      update while their reasons still said blocked, and neither check could
//      say so). Wildcard entries can't be probed literally — give them a
//      "probe" field naming a representative concrete host. Like "reason" and
//      "probe", "expect" is repo-side annotation: excluded from the digest, so
//      adopting it moves no handshake value and needs no dialog edit.
//
// Self-contained node stdlib only: this runs at SessionStart, BEFORE
// dependencies are installed, so it must never import a package. Probes go
// through curl (not node https) because curl honors HTTPS_PROXY and the
// proxy CA bundle without any code here knowing about either.
//
// Flags:
//   --verify-domains   probe the allowlist (network; a few seconds)
//   --print-digest     print the expected digest and exit
//   --config <path>    config file (default: ../cloud-environment.json
//                      relative to this script)
//
// Exit code: 0 unless --verify-domains found expectation mismatches (then 1).
// The handshake mismatch alone is a warning, not a failure — SessionStart must
// start a degraded session, never refuse to start one.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const TAG = 'cloud-env-check:';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const configPath =
  opt('--config') ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'cloud-environment.json');

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  console.log(`${TAG} cannot read ${configPath} — ${err.message}`);
  process.exit(0); // non-fatal: no record means nothing to check against
}

const handshake = config.handshake;
if (!handshake?.variable || !handshake?.prefix) {
  console.log(
    `${TAG} no "handshake" block ({variable, prefix}) in ${configPath} — nothing to check.`,
  );
  process.exit(0);
}

// The record's shape is validated, not coerced. `?? []` here was a silent hole:
// a typo'd container key ("allowedDomians") hashed ZERO domains and still
// emitted a plausible digest, so the operator would paste it and the handshake
// would go green over a record listing no allowlist at all. Refuse instead.
const rawDomains = config.networkAccess?.allowedDomains;
if (!Array.isArray(rawDomains) || rawDomains.length === 0) {
  console.log(
    `${TAG} ⚠ ${configPath}: networkAccess.allowedDomains is missing, not an array, or empty — check for a typo'd key. Refusing to emit a digest over an empty allowlist.`,
  );
  process.exit(1);
}
const domains = rawDomains.map((d) => (typeof d === 'string' ? { domain: d } : d));
for (const [i, d] of domains.entries()) {
  if (typeof d?.domain !== 'string' || d.domain.trim() === '') {
    console.log(
      `${TAG} ⚠ ${configPath}: allowedDomains[${i}] has no usable "domain" string — got ${JSON.stringify(d)}.`,
    );
    process.exit(1);
  }
  // "expect" gates whether a probe result is a failure, so a typo here would
  // silently fall back to the default and un-fail the check — refuse it loudly
  // instead, same posture as the typo'd-container-key refusal above.
  if (d.expect !== undefined && d.expect !== 'reachable' && d.expect !== 'blocked') {
    console.log(
      `${TAG} ⚠ ${configPath}: allowedDomains[${i}] ("${d.domain}") has expect=${JSON.stringify(d.expect)} — must be "reachable" or "blocked" (or absent, meaning "reachable").`,
    );
    process.exit(1);
  }
}
const recordedVars = config.environmentVariables ?? {};

// --- digest ------------------------------------------------------------------
// Hash what the operator types into the dialog: the domain list and the env
// vars (names and values) — except the handshake variable, which contributes
// its name only.
const material = JSON.stringify({
  // The variable's name is dialog content (the operator creates it there), so
  // it is hashed explicitly — NOT via environmentVariables, which repos are
  // not required to list it under. The prefix is a repo-side convention, not
  // dialog content, and stays out.
  handshakeVariable: handshake.variable,
  domains: domains.map((d) => d.domain).sort(),
  env: Object.keys(recordedVars)
    .sort()
    .map((k) => (k === handshake.variable ? k : `${k}=${recordedVars[k]}`)),
});
const digest = createHash('sha256').update(material).digest('hex').slice(0, 12);

if (flag('--print-digest')) {
  console.log(digest);
  process.exit(0);
}

// --- check 1: handshake ------------------------------------------------------
const sessionValue = process.env[handshake.variable];
if (sessionValue === digest) {
  console.log(`${TAG} environment config ${digest} ✓ (dialog matches ${configPath})`);
} else if (sessionValue === undefined) {
  console.log(
    `${TAG} ⚠ ${handshake.variable} is not set — the cloud environment dialog does not carry the handshake.`,
  );
  console.log(`  Add env var ${handshake.variable} = ${digest} in the environment dialog.`);
} else {
  console.log(
    `${TAG} ⚠ ENVIRONMENT CONFIG MISMATCH — session has ${sessionValue}, repo expects ${digest}.`,
  );
  console.log('  The cloud environment dialog and the checked-in record disagree. Re-apply:');
  console.log(`    domains:  jq -r '.networkAccess.allowedDomains[].domain' ${configPath}`);
  console.log(
    `    env vars: jq -r '.environmentVariables | to_entries[] | "\\(.key)=\\(.value)"' ${configPath}`,
  );
  console.log(`    then set ${handshake.variable} = ${digest} in the dialog.`);
  console.log('  (Env vars freeze at session start — edits apply to the NEXT session.)');
  console.log('  Continuing anyway — expect provisioning WARNs if domains are missing.');
}

// The file records the handshake variable's value for the copy-paste flow
// above; it is excluded from the hash, so keep it honest by hand.
if (
  handshake.variable in recordedVars &&
  recordedVars[handshake.variable] !== digest
) {
  console.log(
    `${TAG} ⚠ ${configPath} records ${handshake.variable}=${recordedVars[handshake.variable]} but the content digests to ${digest} — update the recorded value.`,
  );
}

// --- check 2: prefix reconciliation ------------------------------------------
// The handshake variable is exempt in both directions: check 1 owns it, and it
// is always present in a configured session even in repos that don't list it.
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith(handshake.prefix) || key === handshake.variable) continue;
  if (!(key in recordedVars)) {
    console.log(
      `${TAG} ⚠ ${key} is set in this session but UNRECORDED in ${configPath} — record it (or remove it from the dialog).`,
    );
  } else if (recordedVars[key] !== value) {
    console.log(
      `${TAG} ⚠ ${key}: session has "${value}", ${configPath} records "${recordedVars[key]}".`,
    );
  }
}
for (const key of Object.keys(recordedVars)) {
  if (key === handshake.variable) continue;
  if (!(key in process.env)) {
    console.log(
      `${TAG} ⚠ ${key} is recorded in ${configPath} but missing from this session — add it in the environment dialog.`,
    );
  }
}

// --- check 3: --verify-domains -----------------------------------------------
// Probes what the digest can't see: the allowlist as it actually is, not as it
// was last recorded. Blocked ⇒ curl reports code 000; allowlisted ⇒ any HTTP
// status (the probe asks "did we get through the proxy", not "is the service
// healthy"). Each observation is reconciled against the entry's "expect"
// (default "reachable"); only a DISAGREEMENT is a failure. Note the probe
// tests OUR OWN proxy's egress policy, never the far service's — a mismatch is
// fixed by editing the dialog or the record, and the probe itself is the
// lightest conformant touch on the endpoint: one GET per domain per explicit
// invocation, no retries.
if (flag('--verify-domains')) {
  const probeHost = (entry) => {
    if (entry.probe) return entry.probe;
    if (entry.domain.startsWith('*.')) return null; // wildcard with no probe host
    return entry.domain;
  };

  const probe = (host) =>
    new Promise((resolve) => {
      execFile(
        'curl',
        ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', `https://${host}/`],
        // Trust the status code, not curl's exit code: a large body can blow
        // --max-time AFTER headers arrive (curl exits 28, http_code 200) —
        // that is a reachable host. A proxy-denied CONNECT never yields a
        // status, so http_code stays 000 in every genuinely-blocked case.
        (_err, stdout) => resolve((stdout || '').trim() || '000'),
      );
    });

  const results = await Promise.all(
    domains.map(async (entry) => {
      const host = probeHost(entry);
      if (host === null) return { entry, status: 'skip' };
      return { entry, status: await probe(host), host };
    }),
  );

  const expectation = (entry) => entry.expect ?? 'reachable';
  const observed = (r) => (r.status === '000' ? 'blocked' : 'reachable');

  const skipped = results.filter((r) => r.status === 'skip');
  const probed = results.filter((r) => r.status !== 'skip');
  const mismatched = probed.filter((r) => observed(r) !== expectation(r.entry));
  const blockedUnexpected = mismatched.filter((r) => observed(r) === 'blocked');
  const reachableUnexpected = mismatched.filter((r) => observed(r) === 'reachable');
  const blockedAsRecorded = probed.filter(
    (r) => observed(r) === 'blocked' && expectation(r.entry) === 'blocked',
  );
  const ok = probed.length - mismatched.length;

  // Every expected-reachable probe failing is a dead network, not N revoked
  // grants. Printing "re-add it in the dialog" for the whole allowlist would
  // be wrong the vast majority of the time, and would train people to ignore
  // this check. Only expected-reachable probes carry the signal: a 000 that
  // matches "expect": "blocked" cannot distinguish the proxy refusing from the
  // network being gone, so it neither triggers nor vetoes this guard.
  const expectedReachable = probed.filter((r) => expectation(r.entry) === 'reachable');
  if (
    expectedReachable.length > 1 &&
    expectedReachable.every((r) => r.status === '000')
  ) {
    console.log(
      `${TAG} allowlist check INCONCLUSIVE — all ${expectedReachable.length} expected-reachable probes returned 000 (no network?). Not reporting individual domains.`,
    );
    process.exit(0);
  }

  for (const r of blockedUnexpected) {
    console.log(
      `${TAG} ✗ ${r.entry.domain} BLOCKED (probe ${r.host} → 000) — re-add it in the environment dialog, or record "expect": "blocked" if the absence is deliberate. Reason on record: ${r.entry.reason ?? 'none'}`,
    );
  }
  for (const r of reachableUnexpected) {
    console.log(
      `${TAG} ✗ ${r.entry.domain} REACHABLE (probe ${r.host} → ${r.status}) but recorded "expect": "blocked" — the dialog now carries it. Update the record (expect + reason) or remove the grant from the dialog. Reason on record: ${r.entry.reason ?? 'none'}`,
    );
  }
  for (const r of skipped) {
    console.log(
      `${TAG} ? ${r.entry.domain} is a wildcard with no "probe" host — add one so it can be verified.`,
    );
  }
  if (mismatched.length === 0 && skipped.length === 0) {
    const blockedNote =
      blockedAsRecorded.length > 0 ? ` (${blockedAsRecorded.length} blocked as recorded)` : '';
    console.log(`${TAG} allowlist ✓ ${ok}/${results.length}${blockedNote}`);
  } else {
    console.log(
      `${TAG} allowlist ${ok}/${results.length} as recorded, ${mismatched.length} mismatched, ${skipped.length} unverifiable`,
    );
  }
  process.exit(mismatched.length > 0 ? 1 : 0);
}
