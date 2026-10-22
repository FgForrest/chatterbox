---
title: A summary's tasks are accepted automatically and sharing no longer waits for a task review
date: 2026-10-21
updated: 2026-10-22 22:30
status: superseded
kind: feature
issues: []
prs: [224]
areas: [src/lib/tasks, src/lib/sharing/share-gate.ts]
supersedes: [2026-10-07-tasks-from-summaries, 2026-10-19-processing-profiles-and-workflow]
superseded-by: [2026-10-22-owner-reviews-tasks-sharing-ungated]
relates: []
---

# A summary's tasks are accepted automatically and sharing no longer waits for a task review

PR #224 made a summary's tasks open tasks the moment the summary was saved, for recordings and mail,
from summaries and Plaud action items alike. The owner's Task review step and its share blocker
went away. A task matched to its assignee on a first name alone was saved unassigned and flagged
"who is this?". It was superseded the next day: the maintainer had meant something narrower, and the
owner's review came back (see
[owner reviews tasks, sharing ungated](2026-10-22-owner-reviews-tasks-sharing-ungated.md)).

## Why

- **The trigger:** colleagues saw no tasks from a recording shared into the Organization. The cause
  turned out not to be acceptance at all (those tasks were accepted) but the link between an Almanac
  person and an account: many assignees had no e-mail, so their tasks reached nobody.
- **The maintainer's message while that was investigated:** "I think the entire logic about accepting
  tasks is wrong, tasks should be automatically perceived as accepted. Usually these people sit on
  the same meeting together." It was read as removing the owner's review.
- **What was said before building it:** auto-acceptance would not have fixed the reported case;
  wrong extractions would reach people and be fixed afterwards instead of before; the review step
  and the share blocker from 2026-10-07 would go; a re-summary must not duplicate tasks.

### Previous state

The owner reviewed proposals in the Task review step after the summary, and on a recording intended
for the Organization, unreviewed proposals blocked the share
([tasks from summaries](2026-10-07-tasks-from-summaries.md), share gate kept by the processing
pipeline).

## Options considered

### Option A: auto-accept, first-name-only matches saved unassigned and flagged (chosen)

- **Pros:** tasks reach assignees at once; a first-name guess never lands on the wrong colleague.
- **Cons:** wrong extractions become real tasks; uncertain matches need an automatic rule.

### Option B: auto-accept everything, including first-name-only matches (declined)

- **Rejected because:** a task matched on a first name alone could reach the wrong colleague; saving
  it unassigned and flagged means it "reaches nobody by mistake".

### Option C: auto-accept only on shared recordings (declined)

Private recordings keep the review; only items in an Organization folder skip it.

- **Rejected because:** the stated reason, that the people named sat in the same meeting, holds for
  private recordings too, and one rule for every item is easier to explain (inferred).

### Option D: keep the review and fix only the person-to-account link (declined)

- **Rejected because:** it did not match what the maintainer asked for, as understood at the time.
  In hindsight this was closest to his intent.

## Decision

**Chosen: Option A.** A proposal matching exactly one existing open task became accepted evidence on
it; one matching several tasks created nothing, on the assumption it repeated one of them; evidence
from quoted mail parts or unverified senders created nothing. The `tasks_unreviewed` share problem
and its refusal message were removed. Follow-up changes to existing tasks (done, drop, deadline,
assignee) kept their review.

## Key technical details

- No schema, migration, env or compose change; accepted tasks got the same fields the review used to
  set (`acceptedAt`, `acceptedByUserId`, `assignedAt`, effective times, a home mention).
- Leftover `proposed` rows from before the change stayed reviewable in the existing dialog.

## Verification

- `auto-accept-ui.test.tsx` plus updated task store, proposal, Plaud, mail, share-gate and workflow
  tests; whole suite 6,717 passed, 99 skipped.

## Consequences & open follow-ups

- **Why it was superseded:** the next morning the maintainer reported the missing Task review step as
  a bug and explained the misunderstanding. He had wanted to remove any acceptance by the *assignee*;
  the owner's review after the summary was right. Two silent losses had also come to light: a
  proposal the model thought might match one existing task was attached to it without creating a
  new task, one that might match several created nothing, and a task heard only in a quoted mail
  part created nothing, all without anyone seeing it.
- **What survived:** sharing does not wait for the task review, and the "who is this?" hint on an
  accepted task without an assignee.
- PR #224 was merged into the branch of PR #221 on 2026-10-21, reached `dev` with it on 2026-10-22
  and shipped in release 2026.17; the restoring PR #238 shipped in 2026.18 the same day.

## Related work

- [2026-10-07-tasks-from-summaries](2026-10-07-tasks-from-summaries.md): the review and share gate
  this removed; superseded in that part.
- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md):
  the pipeline whose share-gate task rule (unreviewed proposals block the share) this removed;
  superseded in that part.
- [2026-10-22-owner-reviews-tasks-sharing-ungated](2026-10-22-owner-reviews-tasks-sharing-ungated.md):
  the correction that superseded it.

## Timeline

- **2026-10-21**: auto-acceptance asked for and chosen; PR #224 merged into the PR #221 branch.
- **2026-10-22**: reached `dev` with PR #221, released in 2026.17; superseded by PR #238.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
