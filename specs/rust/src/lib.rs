//! Implementation-layer projection of the scheduler contract.
//!
//! The TLA+ spec proves the *protocol* has no double-claim / overspend. `loom`
//! checks that the *actual atomic code* implementing it has none either — real
//! `compare_exchange` / `fetch_update`, real thread interleavings, explored
//! exhaustively. Same two invariants (S1 mutual-exclusion, S2 no-overspend),
//! one altitude lower.
//!
//! Run the model-checked build:
//!     RUSTFLAGS="--cfg loom" cargo test --release
//! Plain `cargo build` / `cargo test` uses std atomics and compiles the crate.

#[cfg(loom)]
use loom::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
#[cfg(not(loom))]
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};

pub const READY: u8 = 0;
pub const INPROGRESS: u8 = 1;

/// Safe claim = CAS. Returns true iff this caller won the item.
pub fn claim_cas(item: &AtomicU8) -> bool {
    item.compare_exchange(READY, INPROGRESS, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// Safe reserve = atomic compare-and-add against the cap. Returns true iff applied.
pub fn reserve(consumed: &AtomicUsize, add: usize, cap: usize) -> bool {
    consumed
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |c| {
            if c + add <= cap {
                Some(c + add)
            } else {
                None
            }
        })
        .is_ok()
}

/// Racy spend = gate on a stale read, then unconditionally accumulate (the
/// TOCTOU, faithful to the TS `applySpend` racy: `consumed += add`). Two threads
/// both pass the gate against the same snapshot, then both `fetch_add` → overspend.
/// Present only so the model can demonstrate that loom catches it.
pub fn spend_racy(consumed: &AtomicUsize, add: usize, cap: usize) {
    let c = consumed.load(Ordering::Acquire); // gate check against a stale snapshot
    if c + add <= cap {
        consumed.fetch_add(add, Ordering::AcqRel); // ...then accumulate — the race window
    }
}

#[cfg(not(loom))]
#[cfg(test)]
mod std_tests {
    use super::*;

    #[test]
    fn claim_cas_single_winner_sequential() {
        let item = AtomicU8::new(READY);
        assert!(claim_cas(&item));
        assert!(!claim_cas(&item)); // second attempt loses
    }

    #[test]
    fn reserve_respects_cap_sequential() {
        let consumed = AtomicUsize::new(0);
        assert!(reserve(&consumed, 4, 6));
        assert!(!reserve(&consumed, 4, 6)); // 4+4 > 6 denied
        assert_eq!(consumed.load(Ordering::Relaxed), 4);
    }
}

#[cfg(loom)]
#[cfg(test)]
mod loom_tests {
    use super::*;
    use loom::sync::Arc;
    use loom::thread;

    /// S1: across ALL interleavings of two claimers, exactly one wins the item.
    #[test]
    fn safe_claim_is_mutually_exclusive() {
        loom::model(|| {
            let item = Arc::new(AtomicU8::new(READY));
            let wins = Arc::new(AtomicUsize::new(0));
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let item = item.clone();
                    let wins = wins.clone();
                    thread::spawn(move || {
                        if claim_cas(&item) {
                            wins.fetch_add(1, Ordering::Relaxed);
                        }
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
            assert_eq!(
                wins.load(Ordering::Relaxed),
                1,
                "exactly one claimer must win"
            );
        });
    }

    /// S2: two atomic reserves can never drive consumed past the cap.
    #[test]
    fn safe_reserve_never_overspends() {
        loom::model(|| {
            const CAP: usize = 6;
            let consumed = Arc::new(AtomicUsize::new(0));
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let consumed = consumed.clone();
                    thread::spawn(move || {
                        reserve(&consumed, 4, CAP);
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
            assert!(
                consumed.load(Ordering::Relaxed) <= CAP,
                "reserve must never overspend"
            );
        });
    }

    /// The TOCTOU, at the implementation layer: loom finds an interleaving where
    /// two racy check-then-set spends overspend the cap (8 > 6), so the invariant
    /// assertion fails — which is exactly what `#[should_panic]` asserts. The same
    /// bug as the TLC `scheduler-overspend.cfg` trace and the Lean `racy_gate_unsound`.
    #[test]
    #[should_panic]
    fn racy_spend_can_overspend() {
        loom::model(|| {
            const CAP: usize = 6;
            let consumed = Arc::new(AtomicUsize::new(0));
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let consumed = consumed.clone();
                    thread::spawn(move || {
                        spend_racy(&consumed, 4, CAP);
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
            assert!(consumed.load(Ordering::Relaxed) <= CAP);
        });
    }
}
