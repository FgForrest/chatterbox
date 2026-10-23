---
title: The owner reviews a summary's tasks, the assignee never has to accept anything, and sharing does not wait for the review
date: 2026-10-22
updated: 2026-10-22 22:30
status: accepted
kind: fix
issues: []
prs: [238]
areas: [src/lib/tasks, src/lib/sharing/share-gate.ts, src/lib/pipeline/plan.ts]
supersedes: [2026-10-21-tasks-accepted-automatically, 2026-10-07-tasks-from-summaries, 2026-10-19-processing-profiles-and-workflow]
superseded-by: []
relates: []
---

# The owner reviews a summary's tasks, the assignee never has to accept anything, and sharing does not wait for the review

A summary's tasks are proposals again, and the Task review step follows the summary for the item's
owner, with the defaults it had before: ordinary tasks ticked; first-name-only assignees, evidence
from quoted mail and suggested matches to earlier tasks unticked; ambiguous matches offered as
choices with "Keep as new". What the previous day's change got right stays: sharing does not wait
for the task review, and an accepted task reaches its assignee directly. Nobody but the owner
accepts anything; there is no acceptance step for the person a task is assigned to.

## Why

- **The reversal came from a misunderstanding.** On 2026-10-21 the maintainer wrote that tasks
  "should be automatically perceived as accepted", and it was implemented as removing the owner's
  review ([tasks accepted automatically](2026-10-21-tasks-accepted-automatically.md)). The next day
  he reported the missing review step as a bug and explained: he had thought a task needed
  acceptance by the person it was assigned to, and that was what he wanted to eliminate. "I think the
  final step with reviewing tasks was correct, but I don't want any other step - like that the
  target person needs to accept anything as well."
- **Automatic acceptance also lost tasks silently.** A proposal the model thought might be one
  existing task was attached to it without a new task; one that might be several created nothing;
  a task heard only in a quoted mail part created nothing. Before, each of these waited unticked in
  the review, where the owner could decide.

### Previous state

Since PR #224, merged into the PR #221 branch and released with it, a summary's tasks became open
tasks on save, the Task review step appeared only for follow-ups and leftover proposals, and the
`tasks_unreviewed` share problem was gone.

## Options considered

### Option A: restore the owner's review, keep sharing ungated (chosen)

Proposals wait in Task review; a shared recording's proposals, and the summary's fallback action
items, stay invisible to colleagues until the owner accepts them, so an ungated share exposes
nothing unreviewed.

- **Pros:** matches the maintainer's intent; nothing is attached or dropped without being seen;
  sharing stays as simple as after PR #224.
- **Cons:** an Organization member can open a shared recording whose tasks are not there yet.

### Option B: restore the review and the share gate as before 2026-10-21 (declined)

The assistant recommended it, so colleagues never see a shared recording before its tasks are
checked.

- **Rejected because:** the maintainer answered "not necessarily, do what is simpler, we are in beta
  testing". With proposals hidden from colleagues until accepted, the gate is not needed to keep
  unreviewed tasks private. The maintainer confirmed on 2026-10-22 that sharing stays ungated until
  the maintainer decides otherwise; the end of the beta does not reopen it by itself. Revisit if
  members find shared recordings with missing tasks confusing.

### Option C: keep automatic acceptance and send only uncertain cases to the review (declined)

The assistant's first suggestion after the bug report: clear tasks accepted automatically, only
uncertain matches and quoted-mail tasks reviewed, so nothing disappears.

- **Rejected because:** the maintainer's correction was that the owner's review of every summary's
  tasks "was correct"; only an assignee's acceptance was to go.

## Decision

**Chosen: Option A.** It restores what the maintainer meant to keep and removes only what he never
asked to remove from PR #224's ungated sharing. Tasks PR #224 had already accepted stay accepted.

## Key technical details

- Re-summarizing replaces untouched proposals; touched ones, accepted tasks and remembered rejections
  survive, as before PR #224.
- No `tasks_unreviewed` share problem: `src/lib/sharing/share-gate.ts` does not count proposals, and
  automatic sharing runs while proposals wait.
- An accepted task reaches its assignee through the unchanged primary-e-mail rule; there is no
  assignee acceptance anywhere in `src/lib/tasks/`.
- The "who is this?" hint and picker on accepted tasks without an assignee stay from PR #224.
- No schema, environment or compose change.

## Verification

- `src/tests/regressions/224-owner-task-review.test.ts`: recordings and mail from summary to badge,
  the workflow step, ungated sharing, hidden proposals, and assignment after acceptance.
- `vitest --changed origin/dev`: 2,496 passed, 81 skipped. No browser check.

## Consequences & open follow-ups

- The user guide (mail, Organization, processing and profiles, in both languages) no longer says
  sharing waits for the task check.
- **Open since PR #224:** whether follow-up proposals from a later recording (done, drop, deadline,
  assignee) should apply automatically; they still wait for review.
- **Still unsolved:** tasks assigned to people without an e-mail reach nobody (see
  [tasks from summaries](2026-10-07-tasks-from-summaries.md)).

## Related work

- [2026-10-21-tasks-accepted-automatically](2026-10-21-tasks-accepted-automatically.md): the change
  this supersedes, and why it was made.
- [2026-10-07-tasks-from-summaries](2026-10-07-tasks-from-summaries.md): the original review and its
  defaults, restored here without the share gate; this supersedes its share-gate rule.
- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md):
  its share gate's task rule stays removed here; this supersedes that rule.

## Timeline

- **2026-10-21**: automatic acceptance chosen (PR #224).
- **2026-10-22**: missing review reported as a bug, the misunderstanding explained; sharing left
  ungated; PR #238 merged and released in 2026.18.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
- **2026-10-22**: the maintainer confirmed that sharing stays ungated until the maintainer decides
  otherwise.
