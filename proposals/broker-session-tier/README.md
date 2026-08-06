# broker-session-tier — ⚠ DRAFT, a trust-boundary change; nothing in this repo runs it

A session tier for the broker (`cf-oidc-token-broker`), authenticated by the one
cryptographic act a Claude Code cloud session can perform: **a commit the git
proxy signs**. It amends the `docs/write-surfaces.md` doctrine paragraph that
says a session "cannot authenticate to the broker at all" — deliberately, with
the property that paragraph protects kept intact: **no credential ever lands in
the session.** The session still holds only the ability to ask; what changes is
who it asks and how the answer comes back.

## The problem, measured (2026-08-05/06, this session)

One item through the ticket window costs ~10 tool calls and ~15–30s per
claim/release pair: dispatch via the GitHub MCP server (the session's only
dispatch route), then poll runs → list jobs → fetch logs to read one
`FDS-CLAIM-RESULT` line. A session-side verb cannot absorb the dispatch,
probed live:

```
POST /repos/…/dispatches                       → 403 repository_dispatch is not
                                                     permitted for this session type
POST /repos/…/actions/workflows/…/dispatches   → 403 Resource not accessible by
                                                     integration
```

The egress proxy is a policy point, and its injected credential holds no
`actions: write`. So "consolidate the flow under one verb" (the motivating ask)
dead-ends at identity: the broker's trust boundary is a GitHub Actions OIDC JWT
(`verifyOIDC` pins `job_workflow_ref@refs/heads/main`), and a session is not an
Actions runner.

## What a session CAN prove

Inventoried empirically, same dates:

| material | provable? | note |
|---|---|---|
| proxy-signed commits | **yes** — ed25519 SSH signature added at push time; `verified: true` on GitHub (observed on `bf39d3d`, this repo) | the primitive |
| proxy-injected GitHub credential | exercisable against GitHub hosts only; not presentable to a Worker (sentinel goes out — the lease Worker's observed 403) | the *medium* for the proof |
| GCP metadata identity tokens | no — metadata server blocked ("private/reserved range") | would have been the clean OIDC analogue |
| Anthropic OAuth / session-ingress tokens | Anthropic-verifiable only; must never reach a third party | account credential |
| session / account / org UUIDs | no — unsigned strings | anyone can claim them |

The org posture already names this: *privileged effects are verified against a
signed owner — git-writes today (signing); egress and external reads next.*
This proposal is the "egress next" step, built on the signing that exists.

## The ceremony: signed-commit nonce

1. `POST /session/nonce` → `{ nonce, exp }` (~60s, single-use). Unauthenticated;
   rate-limited.
2. The session pushes an **empty-tree commit** to `refs/fds/nonce/<nonce>` in a
   pinned repo (this one). The commit message carries the nonce and the
   session's `agent_label`. The git proxy signs it in transit — the session
   cannot produce this signature any other way, because it never holds the key.
3. `POST /session/exec { nonce, verb, args }` → the broker fetches the ref,
   verifies the ed25519 signature against a **pinned public key** (not
   GitHub's `verified` flag — offline verification, no trust in the UI),
   checks freshness and single-use, then executes the verb **server-side** and
   returns the verdict inline.
4. The ref is deleted (by the broker where possible, else a janitor lane).

**Grant rule** — the same one the lease Worker already applies to installation
tokens ("coverage of the repo IS the grant"), reached indirectly: the ability
to land a proxy-signed commit on the pinned repo is the grant. Nothing new is
trusted; the existing rule is exercised through the only door a session has.

**Verbs, allowlisted and nothing else:** lease-plane `claim` / `bind` /
`release` (the broker calls the lease Worker with a broker-signed assertion —
no Actions run at all), and `workflow_dispatch` of named workflow files (the
broker's own App token holds `actions: write`; the session never sees it).

## What it buys

- Claim: ~10 tool calls / 15–30s → **1–2 calls / ~1s**, verdict inline —
  including the refusal taxonomy (`not-eligible` vs `not-in-mirror`) that today
  exists only in a CI log line.
- The `fds` verbs become the same single command on CLI and MCP, in sessions
  and in CI (one definition, #59): direct Worker call where a real credential
  exists, signed-commit ceremony where only the proxy identity does, and a
  clear refusal naming this proposal where neither is available.

## Honest limits (the assumptions, named)

- **S1: only Anthropic's git proxy wields the signing key.** Untested
  assumption, C1-style. Before trusting: establish whether the key is
  per-account or Anthropic-global, and its rotation story. Note the grant rule
  is repo-coverage-scoped either way — a global key still only grants what a
  write to *this* repo grants — but the blast-radius reading differs and must
  be written down, not assumed.
- **The `Claude-Session:` trailer is self-reported.** The signature proves "an
  authorized session of this owner", not *which* session — any session could
  write another's trailer. Session disambiguation stays with `agent_label`,
  exactly as coarse as today's `AUTH_MODE=github`. No regression; no
  improvement either.
- **Replay:** bound by single-use + expiry + the pinned repo + the signature
  covering the message (the nonce is inside the signed payload).
- **Noise:** `refs/fds/nonce/*` writes are real pushes to a real repo. The
  namespace is chosen to be janitorable and to never collide with branches.
- **The nonce endpoint is a DoS surface.** Rate-limit; a nonce costs the
  attacker nothing but grants nothing without the signed push.

## Local sessions: the inverted profile

A local Claude Code session (the operator's machine) inverts the cloud profile
almost row for row, and the inversion is what makes the tier table below
complete rather than cloud-specific:

- **Ambient authority instead of a sentinel.** The agent runs as the user —
  real credentials on disk and in agent sockets, presentable to this broker
  today with no ceremony. But nothing distinguishes the agent from the human,
  or from anything else running as that user.
- **The signer sits inside the boundary.** Commits are signed with the user's
  key, which the agent can read or use unless it is hardware-bound. Agent
  attribution (`Co-Authored-By`) is convention, not cryptography.
- **A hardware root of trust IS available** — Secure Enclave, FIDO2 `sk-`
  keys, TPM: non-exportable, optionally user-presence-gated. A touch-gated
  signature proves **human co-presence at signing time**, the one statement a
  cloud session can never make.
- **What a local signature cannot prove is the agent path.** The cloud proxy
  signature proves exactly that — the key lives at Anthropic's door and the
  human has no route to it. The local user key proves the owner, agent-or-not.
  Closing that gap locally is `keeperd`'s job: a signer room whose key the
  agent room can invoke but never read is the local reconstruction of what the
  cloud proxy provides by construction.

The two contexts attest complementary halves — cloud attests *role* (agent,
through the door), local attests *owner and presence* (this human's hardware).

**The tier table** — one native signer per caller context, each living outside
the caller's readable memory; the design rule is "use the native one", never a
shared secret:

| caller | native signer | trust statement |
|---|---|---|
| CI workflow | Actions OIDC JWT (`verifyOIDC`, today) | this named workflow file, on main |
| cloud session | proxy-signed commit nonce (this proposal) | an authorized Claude session of this owner, via the agent path |
| local session | hardware-backed user key, or a keeperd door signature | this owner's device — with user presence, this human, now |

## Rejected alternatives

- **A stored session credential** (`FDS_CLAIM_TOKEN`-shaped): rejected already
  on #61, and `write-surfaces.md` names why — a standing write credential
  inside a process that reads untrusted issue text.
- **GCP identity tokens:** metadata server unreachable from the sandbox
  (probed).
- **Unsigned nonce ref:** works, but its verification chain is "GitHub says the
  proxy identity pushed it" — the signed variant verifies offline against a
  pinned key and survives GitHub-side identity confusion.

## Sequencing (independent steps, each useful alone)

0. **No trust change:** a `triage-ticket.yml` window (claim → comment → close →
   release in one dispatch) and verdict readback via the lease Worker's open
   `/status` — cuts most of the measured cost without touching the boundary.
1. Broker endpoints behind a feature flag; the pinned key and S1 established;
   a monitor in the `broker-drift` mold probing the ceremony end-to-end.
2. `fds` verbs grow the sentinel-aware fallback and the window docs point here.

## What keeps this draft honest while it sits here

The DRAFT banner; the broker code lives in `cf-oidc-token-broker`, outside this
repo — nothing here deploys; and the two 403 probes plus the signature
observation above are dated claims about a specific session type, re-verifiable
in any cloud session with two `curl`s and one `git push`.
