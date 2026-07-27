---
name: Epic
about: A container of related work — decomposed into tasks the scheduler ranks individually
title: ""
labels: []
---
---
kind: epic
effort: 8           # 1..10 — epics are big by definition; if this is ≤4, it's probably a task
value: 60           # 0..100 — cost of delay of the OUTCOME, not the sum of the children
depends-on: []      # [repo#123] — what must land before any child is startable
---

## Outcome

<!-- What is true when this epic closes. Children carry their own frontmatter
     and depend on each other; the epic's number goes in their depends-on when
     the epic itself gates them. -->

## Children

<!-- Use GitHub sub-issues (mined into the dep graph automatically), or list: -->

- [ ] #
