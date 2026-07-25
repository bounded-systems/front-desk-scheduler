-------------------------- MODULE scheduler --------------------------
(***************************************************************************)
(* The Front Desk scheduler, as a protocol — the SECOND projection of the  *)
(* one contract (the first is the TS DST sim in ../../src).                 *)
(*                                                                          *)
(* Agents claim ready items and spend against a shared budget. Every        *)
(* check-then-act is split across TWO actions (a yield point between them), *)
(* so TLC explores the interleavings a real concurrent scheduler would hit. *)
(*                                                                          *)
(*   Atomic = FALSE  -> the "racy" mechanism: Claim and Spend trust a stale  *)
(*                      read. TLC finds a counterexample to MutualExclusion  *)
(*                      (double-claim) or NoOverspend (budget TOCTOU).       *)
(*   Atomic = TRUE   -> the "safe" mechanism: Claim is a CAS, Spend is an    *)
(*                      atomic reserve. Safety holds; with enough budget,    *)
(*                      Liveness (<>AllDone) holds too.                      *)
(*                                                                          *)
(* This mirrors ops.ts exactly: commitClaim (racy|safe) and applySpend       *)
(* (racy|safe). The invariants MutualExclusion / NoOverspend are the S1 / S2 *)
(* of invariants.ts.                                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Agents,   \* set of agent ids (threads), e.g. {a1, a2}
          Items,    \* set of item ids, e.g. {i1, i2}
          Cap,      \* budget capacity (points)
          Effort,   \* effort cost per item (uniform, for model tractability)
          Atomic    \* TRUE = safe (CAS + reserve), FALSE = racy

VARIABLES itemStatus,  \* [Items -> {"ready","inprogress","done"}]
          owners,      \* [Items -> SUBSET Agents]  (a set, so double-claim is visible)
          consumed,    \* Nat: budget spent so far
          pc,          \* [Agents -> phase]
          target,      \* [Agents -> Items]: the item an agent decided on
          gate         \* [Agents -> BOOLEAN]: the (possibly stale) gate read

vars == <<itemStatus, owners, consumed, pc, target, gate>>

AnItem == CHOOSE i \in Items : TRUE

Init ==
  /\ itemStatus = [i \in Items |-> "ready"]
  /\ owners     = [i \in Items |-> {}]
  /\ consumed   = 0
  /\ pc         = [a \in Agents |-> "pick"]
  /\ target     = [a \in Agents |-> AnItem]
  /\ gate       = [a \in Agents |-> FALSE]

\* DECIDE: choose a ready item. Does NOT mutate it — this is the race window.
Pick(a) ==
  /\ pc[a] = "pick"
  /\ \E i \in Items :
       /\ itemStatus[i] = "ready"
       /\ target' = [target EXCEPT ![a] = i]
       /\ pc'     = [pc EXCEPT ![a] = "claim"]
  /\ UNCHANGED <<itemStatus, owners, consumed, gate>>

\* COMMIT the claim. Atomic: CAS (only if still ready). Racy: unconditional.
Claim(a) ==
  /\ pc[a] = "claim"
  /\ LET i == target[a] IN
       IF Atomic /\ itemStatus[i] # "ready"
       THEN /\ pc' = [pc EXCEPT ![a] = "pick"]          \* lost the race, retry
            /\ UNCHANGED <<itemStatus, owners, consumed, target, gate>>
       ELSE /\ owners'     = [owners EXCEPT ![i] = owners[i] \cup {a}]
            /\ itemStatus' = [itemStatus EXCEPT ![i] = "inprogress"]
            /\ pc'         = [pc EXCEPT ![a] = "gate"]
            /\ UNCHANGED <<consumed, target, gate>>

\* READ the gate against the current budget (no mutation).
GateRead(a) ==
  /\ pc[a] = "gate"
  /\ gate' = [gate EXCEPT ![a] = (consumed + Effort =< Cap)]
  /\ pc'   = [pc EXCEPT ![a] = "spend"]
  /\ UNCHANGED <<itemStatus, owners, consumed, target>>

\* APPLY the spend. Atomic: re-check now (reserve). Racy: trust the stale gate.
Spend(a) ==
  /\ pc[a] = "spend"
  /\ IF Atomic
       THEN IF consumed + Effort =< Cap
              THEN /\ consumed' = consumed + Effort
                   /\ pc' = [pc EXCEPT ![a] = "finish"]
                   /\ UNCHANGED <<itemStatus, owners, target, gate>>
              ELSE /\ LET i == target[a] IN
                        /\ itemStatus' = [itemStatus EXCEPT ![i] = "ready"]
                        /\ owners'     = [owners EXCEPT ![i] = owners[i] \ {a}]
                   /\ pc' = [pc EXCEPT ![a] = "pick"]
                   /\ UNCHANGED <<consumed, target, gate>>
       ELSE IF gate[a]
              THEN /\ consumed' = consumed + Effort
                   /\ pc' = [pc EXCEPT ![a] = "finish"]
                   /\ UNCHANGED <<itemStatus, owners, target, gate>>
              ELSE /\ pc' = [pc EXCEPT ![a] = "finish"]
                   /\ UNCHANGED <<consumed, itemStatus, owners, target, gate>>

Finish(a) ==
  /\ pc[a] = "finish"
  /\ LET i == target[a] IN
       /\ itemStatus' = [itemStatus EXCEPT ![i] = "done"]
       /\ owners'     = [owners EXCEPT ![i] = owners[i] \ {a}]
  /\ pc' = [pc EXCEPT ![a] = "pick"]
  /\ UNCHANGED <<consumed, target, gate>>

AgentStep(a) == Pick(a) \/ Claim(a) \/ GateRead(a) \/ Spend(a) \/ Finish(a)

AllDone == \A i \in Items : itemStatus[i] = "done"

Next ==
  \/ \E a \in Agents : AgentStep(a)
  \/ (AllDone /\ UNCHANGED vars)    \* stutter once finished (avoid deadlock)

Fairness == \A a \in Agents : WF_vars(AgentStep(a))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Invariants — S1 and S2 of invariants.ts.                                *)
(***************************************************************************)
MutualExclusion == \A i \in Items : Cardinality(owners[i]) =< 1
NoOverspend     == consumed =< Cap
TypeOK ==
  /\ consumed \in 0..(Cap + (Cardinality(Agents) * Effort))
  /\ \A i \in Items : itemStatus[i] \in {"ready","inprogress","done"}

(***************************************************************************)
(* Liveness — L (every item eventually Done). Holds only under Atomic AND   *)
(* Cap >= Cardinality(Items)*Effort (enough budget). See scheduler-atomic.  *)
(***************************************************************************)
Liveness == <>AllDone
=============================================================================
