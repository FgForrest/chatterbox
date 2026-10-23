---
title: Tasks come out of the summary call, the owner reviews them, and they reach other people only through the Organization
date: 2026-10-07
updated: 2026-10-23 07:00
status: superseded
kind: feature
issues: []
prs: [91, 92, 93]
areas: [src/lib/tasks, src/components/tasks, src/app/(app)/tasks, src/lib/export, src/db/schema.ts]
supersedes: []
superseded-by: [2026-10-19-processing-profiles-and-workflow, 2026-10-21-tasks-accepted-automatically, 2026-10-22-owner-reviews-tasks-sharing-ungated, 2026-10-22-person-to-person-sharing]
relates: [2026-10-07-backup-scope, 2026-10-22-assignee-task-list]
---

# Tasks come out of the summary call, the owner reviews them, and they reach other people only through the Organization

A summary's action items became real tasks. The summary call itself (and the multi-pass merge)
returns them as structured objects: text, who, the deadline as said plus a resolved date, and a
quote. The recording's owner reviews them like Learn findings: tick, edit, reassign, set the
deadline, merge, add; unticking is the only way to say no. Accepted tasks appear under the summary
and on a Tasks page beside the Almanac, with "Mine" and "Tracked" tabs and a badge. A task on a
private recording is the owner's alone; it reaches anyone else only when its recording is shared
into the Organization. A task has one assignee and is open, done or dropped. In backups a task
follows its recording, never its assignee.

**Superseded in part.** [Processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md)
changed the task lifetime, the candidate source and who edits tasks on a shared item;
[tasks accepted automatically](2026-10-21-tasks-accepted-automatically.md) removed the review and
the share gate, and [owner reviews tasks, sharing ungated](2026-10-22-owner-reviews-tasks-sharing-ungated.md)
restored the review without the gate; with [person-to-person sharing](2026-10-22-person-to-person-sharing.md)
an accepted receiver reads the tasks on a private item and closes or reopens those assigned to their
login email, without the item being shared into the Organization. *Consequences & open follow-ups*
lists the changed rules; the rest of this record (proposals from the summary call, one assignee, the
three states, backups) still holds.

## Why

- **Action items were uncorrectable strings.** They lived as plain Markdown in
  `ai_enhancements.action_items`: no ids, assignees, deadlines or status, often too granular and
  sometimes attributed to the wrong person. Nobody could fix them, and there was no list of what
  people had to do across recordings.
- **The maintainer asked for a Learn-like correction step** in which the owner fixes the person, the
  wording and the deadline, drops what is wrong and adds what is missing, plus a personal task list.
- **Constraints:** sharing at the time handed a recording's content to the Organization account (the
  writer rule), and private recordings must not leak anything to colleagues.

### Previous state

Summaries produced free-text action items; Plaud's action items were imported as text. Nothing was
stored per task.

## Options considered

The design was settled in one session of questions; each fork below lists what was on the table.

### Where proposals come from

- **Chosen: the summary call and its merge.** A directive appended to every summary prompt, custom
  templates included, turns `actionItems` into objects; the parser accepts plain strings too.
- **Declined: a dedicated extraction pass after each summary** (the assistant's recommendation).
  Rejected because the maintainer wanted no extra extraction run: "This should come right from
  summarization process / summarization merge process." It also avoids a second paid call per
  summary (inferred).
- **Declined: keep free-text Action Items and add tasks as a separate panel.** Rejected because the
  two lists would disagree.

### Who sees a task

- **Chosen: only via the Organization.** Tasks on a private recording stay the owner's.
- **Declined: hand an accepted task to a colleague with the recording link locked**, or a per-task
  "send to" toggle. The maintainer chose the literal rule; it keeps the private/shared boundary that
  every other piece of content follows (inferred).

### Shared recordings

- **Chosen on 2026-10-07: task review joins the share gate; after sharing only the Organization
  account edits tasks; the owner and the assignee may still mark them done.** It matched the writer
  rule of the time.
- **Declined:** the owner keeps editing tasks after sharing; the assignee may edit their own task;
  sharing does not wait for the review. These lost to consistency with the writer rule.
- **Later changed, see below:** the owner's edit rights came back on 2026-10-14, and the share gate
  was dropped on 2026-10-21.

### Lifetime

- **Chosen: tasks die with the summary** (the recording's last summary removed by retention, Erase or
  delete), not with the transcript; a re-summary or re-transcription keeps them.
- **Declined:** tasks outlive the transcript and go only with the recording (the assistant's
  recommendation); tasks die with the transcript, like Almanac facts; tasks outlive everything. The
  maintainer answered "die with summarization". As built, a re-transcription drops and remakes the
  summary, so deleting tasks there would lose accepted work on every re-run.

### Smaller forks

- **Notification: badge only.** Declined: an opt-in e-mail digest, and digest plus due-date
  reminders (which need a daily scheduled job). Nothing outbound.
- **One assignee or none.** Declined: several assignees. "Done means done", with no doubt about who
  closes it; joint work is split in review or named in the text.
- **Lists: "Mine" and "Tracked".** Declined: unassigned tasks landing in the owner's "Mine" (fills it
  with other people's work); other people's tasks visible only on the recording (nobody tracks them).
- **Granularity: one task per deliverable per person in the prompt, plus Merge in the review.**
  Declined: prompt only; tasks with sub-steps (more UI and data model).
- **Deadline: the model resolves a date against the recording's day and the spoken phrase is kept;**
  vague phrases get no date. Declined: date and time; phrase only with the owner picking the date.
- **States: open, done, dropped.** Declined: open and done only (removal would mean deletion); an
  "in progress" state (the app is not an issue tracker).
- **Follow-ups in this round:** a later recording may propose "done" or a new deadline for open
  tasks. Declined: a later issue; none.
- **Folders live from the recording.** Declined: folders copied onto the task and refiled per task.
- **Rejection by unticking only (PR #93).** The review dialog also had a bin that deleted a proposal
  at once, without undo, while an unticked row stays visible and can be ticked again until the review
  is accepted. The bin and its `DELETE /api/tasks/[taskId]` route went, matching Learn's review.
  Drop and Restore on accepted tasks stayed.
- **Review in a dialog (PR #92), not inline under the summary,** opened by "Review tasks (N)", with
  accepted tasks rendered by the same `TaskRow` as the Tasks page.

## Decision

**Chosen: proposals from the summary call, an owner's review, visibility only through the
Organization.** It reuses the call that already reads the whole transcript, keeps people's private
recordings private, and keeps the owner in control of what reaches colleagues. A competing design
would need a reason to pay for a second call or to let a private recording's content reach someone
else.

## Key technical details

- **Directive and parsing:** `src/lib/tasks/directive.ts`; proposals are written in the summary's
  `upsertEnhancement` transaction. A re-summary replaces only untouched proposals (`version = 0`).
- **Rejections are remembered as HMAC fingerprints only**, so the model is shown accepted tasks but
  not rejected ones; a reworded rejected item can come back. Accepted as is in review.
- **Task lists in the prompt go into the user message, framed as data,** not into the system message
  (a prompt-injection finding in review).
- **"Mine" is an e-mail match:** the assignee person's primary e-mail hash equals the HMAC of the
  viewer's login e-mail (`src/lib/tasks/access.ts`, `tasks.ts`). A person created from a transcript
  has no e-mail, so their tasks reach nobody.
- **Accept sends the ids it showed;** a changed set answers 409. The badge counts `assigned_at`
  (migration 0092), set on accept, on a new assignee and on share.
- **Backups:** `tasks.json` per recording, `task-updates.json` for follow-ups heard on it,
  assignees in `knowledge/people.json`; `src/lib/tasks/archive.ts` scopes them like the rest of the
  archive ([backup scope](2026-10-07-backup-scope.md)). A task assigned to someone on a colleague's
  shared recording is in the Organization's archive, not the assignee's.
- Task text, quotes, hints and phrases are encrypted at rest. Migrations 0091 and 0092.

## Verification

- PR #91: 34 task integration tests (proposals, accept, reject and merge, versions, the private and
  shared permission table, follow-ups, share gate, badge, assignee promotion, person-merge repoint,
  retention drop, accept snapshot 409, archive scope); browser checked on the e2e stack with a fake
  OpenAI server. Two independent reviews found 5 and 20 issues; all were fixed except the rejection
  memory (accepted as is) and comment style.
- Tests to start from: `src/tests/tasks/tasks.integration.test.ts`, `review-ui.test.tsx`,
  `task-row.test.tsx`, `summary-items.test.ts`; `src/tests/export/build-archive.test.ts`.

## Consequences & open follow-ups

- [Assignee task list](2026-10-22-assignee-task-list.md): Own tasks now have no item and are author-only; follows, outcome notes and assignee merges extend the task lifecycle.
- **Revised by [processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md)
  (2026-10-14):** a task now lives while any of its mentions lives, not with one summary; candidates
  come from the folder scope (40, ranked), not from confirmed speakers (30); on a shared item the
  home owner and curators edit and the assignee closes; Plaud action items go through the Summary
  step instead of becoming proposals at sync.
- **The share gate changed twice:** [tasks accepted automatically](2026-10-21-tasks-accepted-automatically.md)
  removed the review and the gate; [owner reviews tasks, sharing ungated](2026-10-22-owner-reviews-tasks-sharing-ungated.md)
  restored the owner's review and kept sharing ungated.
- **Assignees without an e-mail reach nobody.** Learn and speaker naming create people without one,
  so many tasks on shared recordings appear on no colleague's list.
- **Out of scope in this round:** v1 API and webhooks for tasks, e-mail and due-date reminders,
  calendar export, manual reordering.

## Related work

- [2026-10-07-backup-scope](2026-10-07-backup-scope.md): the personal versus Organization archive
  rules that `tasksForArchive` follows.
- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md):
  generalized this task model across recordings, mail and folders, superseding its lifetime,
  candidate and shared-edit rules.
- [2026-10-21-tasks-accepted-automatically](2026-10-21-tasks-accepted-automatically.md) and
  [2026-10-22-owner-reviews-tasks-sharing-ungated, 2026-10-22-person-to-person-sharing](2026-10-22-owner-reviews-tasks-sharing-ungated.md):
  the later changes to who reviews and whether sharing waits.
- [2026-10-22-person-to-person-sharing](2026-10-22-person-to-person-sharing.md): tasks on a private
  item reach the people it is shared with, not only the Organization.

## Timeline

- **2026-10-07**: design settled with the maintainer; PR #91 (review and Tasks page) merged; PR #92
  (review dialog, full review in backups) merged; PR #93 (untick is the only rejection) merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
