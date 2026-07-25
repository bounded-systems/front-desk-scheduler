# specs/rust — loom interleaving harness (planned, Slice 3)

The **implementation** layer of the verification pyramid: the TLA+ spec proves the
*protocol* has no races; `loom` checks that the *actual Rust code* implementing it
has none either — real `Arc`/`Mutex`/atomics, real thread interleavings, explored
exhaustively.

Sketch:

```rust
// loom exhaustively permutes the interleavings of two agents claiming + spending.
loom::model(|| {
    let budget = Arc::new(AtomicUsize::new(0));   // consumed
    let item   = Arc::new(AtomicU8::new(READY));  // itemStatus
    // agent A and agent B: compare_exchange to claim (CAS), fetch_update to reserve.
    // assert: item claimed at most once; budget never exceeds CAP.
});
```

Fits the org's Rust door daemons (`keeperd`, `netd`, `door-peercred`). Build this
when the Concierge's hot path moves from the TS model into a supervised Rust
service.

Status: **stub.** Not built. See `../../docs/model.md`.
