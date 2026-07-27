---
name: Task
about: A unit of work the scheduler can rank and an agent can claim
title: ""
labels: []
---
---
kind: task          # epic | room | door | task
effort: 3           # 1..10 — how long the queue is occupied: 1-2 tiny, 3-4 an afternoon, 5-6 days, 8+ decompose into an epic
value: 40           # 0..100 — cost of delay: what does a month of waiting cost? nothing≈20, blocks a lane≈70, correctness/security≈90
depends-on: []      # [repo#123, other-repo#45] — gates readiness AND feeds the unblocks bonus
---

## What

<!-- One paragraph: what exists after this is done that doesn't exist now. -->

## Done when

<!-- Checkable criteria a claimant can verify without asking you. -->

- [ ]
