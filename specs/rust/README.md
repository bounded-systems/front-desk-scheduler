# specs/rust — loom interleaving harness (Slice 3, ✅ checked)

The **implementation** layer of the verification pyramid: the TLA+ spec proves
the *protocol* has no races; `loom` checks that the *actual Rust atomics*
implementing it have none either — real `compare_exchange` / `fetch_update`,
real thread interleavings, explored exhaustively. Same two invariants (S1
mutual-exclusion, S2 no-overspend), one altitude below TLA+.

`src/lib.rs`:

| function | mechanism |
|---|---|
| `claim_cas` | safe claim — `compare_exchange(READY→INPROGRESS)` |
| `reserve` | safe spend — `fetch_update` compare-and-add against the cap |
| `spend_racy` | racy spend — gate on a stale load, then `fetch_add` (the TOCTOU) |

loom tests:

| test | result |
|---|---|
| `safe_claim_is_mutually_exclusive` | ✅ exactly one claimer wins across all interleavings (S1) |
| `safe_reserve_never_overspends` | ✅ two atomic reserves never exceed the cap (S2) |
| `racy_spend_can_overspend` (`#[should_panic]`) | ✅ loom **finds** the interleaving where two stale-gated `fetch_add`s overspend (8 > 6) |

`racy_spend_can_overspend` is the implementation-layer twin of the TLC
`scheduler-overspend.cfg` counterexample and the Lean `racy_gate_unsound` — the
**same S2 bug at a fourth altitude**.

## Run

```sh
cargo test                                  # std atomics — sequential sanity
RUSTFLAGS="--cfg loom" cargo test --release # loom — exhaustive interleaving check
```

Verified with cargo 1.97.1 / loom 0.7: `test result: ok. 3 passed`.
