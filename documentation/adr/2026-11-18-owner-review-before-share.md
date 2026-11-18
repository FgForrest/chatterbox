---
title: Owners finish reviews before recordings are shared with the Organization
date: 2026-11-18
updated: 2026-11-18 21:42
status: accepted
kind: feature
issues: []
prs: []
areas: [src/lib/sharing, src/lib/pipeline, src/lib/tasks, src/lib/learn, src/app/(app)/almanac/review]
supersedes: [2026-09-30-learn, 2026-10-19-processing-profiles-and-workflow, 2026-10-21-curators-manage-organization-almanac, 2026-10-21-tasks-accepted-automatically, 2026-10-22-organization-almanac-grows-on-share, 2026-10-22-owner-edits-shared-recording, 2026-10-22-owner-reviews-tasks-sharing-ungated, 2026-11-02-quick-finish-of-reviews]
superseded-by: []
relates: []
---

# Owners finish reviews before recordings are shared with the Organization

An owner finishes or skips Learn and Task review before a recording is first published to the
Organization. Pending item reviews belong in the owner's queue, including reviews created after
sharing. Mail can be shared while its owner still has proposals to review.

## Why

Pending reviews of members’ shared recordings accumulated in the curators’ queue. The combined workload was more than one person could work through.
The maintainer ruled, “Before Learn is finished and the tasks are confirmed I would not allow the recording to be shared to the Organization (i.e. when shared to the Organization it must already be in order), and so it would no longer fall to the curator.”

### Previous state

The recording gate checked the transcript and speaker names. A curator could see and finish
pending reviews for shared items alongside their own work, including task proposals and matches. Mail had no content-review gate.

## Options considered

### A. Require the reviews before sharing and queue them for the owner (chosen)

- The Organization receives recordings after the owner has dealt with proposals. An absent owner's recording waits for them.
- Publication can take longer when an automatic step fails or the owner defers a review.

### B. Share immediately and let curators finish pending reviews (declined)

- Members can read a recording sooner and a curator can take over if the owner is absent.
- **Rejected because** one curator was left with outstanding tasks and Learn decisions from multiple owners.

### C. Restrict the queues to owners and share immediately (declined)

- This reduces the curator's queue without delaying publication.
- **Rejected because** recordings would still reach the Organization with unfinished work, and absent owners would leave nobody to review the proposed tasks.

## Decision

Require the owner to finish or skip their reviews before the first Organization publication of
audio. An intended share advances after the existing review mutations request a pipeline replan.
Mail distribution stays independent of task approval. The maintainer ruled, “No, mail without a
gate, but its tasks are seen for approval only by the owner, not the curator.” Curators can
still finish Organization-view Learn from the shared recording itself so they can handle the
existing backlog and reruns. They also retain their rights over accepted shared tasks. The
Almanac's suggested relations continue to go to curators.

## Key technical details

- `src/lib/sharing/load-share-gate.ts` reads the effective private processing profile, Learn runs and pipeline phases, and the same task decisions and skip state used by the workflow.
- `src/lib/pipeline/plan.ts` records intended shares as waiting on the gate. The share transaction rechecks the gate before publishing. Existing Organization placements can be moved or supplemented while the item is shared.
- `src/lib/learn/pending.ts` and `src/lib/tasks/tasks.ts` restrict the queues to the owner. Task review writes recheck the owner, including for proposals from an Organization-view summary.

## Verification

`src/tests/regressions/2026-11-18-owner-review-before-share*.test.ts` covers first-share waits,
finish and skip, a skipped failed Learn run, direct filing, moves and restriction lifts, legacy
placements, mail, existing shares and owner-only review access and counts, against PostgreSQL.
`src/tests/regressions/strip-opens-review.test.tsx` checks the Learn, task review
and Summary links, including opening Summary without starting another job.

## Consequences & open follow-ups

- The share gate reads only the latest private Learn run for the preferred transcript’s current revision. The owner can retry or skip a failed run. Skip cancels the run, settles Learn for that input, releases the summary hold and requests another pipeline advance. A new preferred transcript or revision needs its own Learn.
- A curator can quick-finish Organization-view Learn from the item, and the owner’s task review stays pending. Only the source item’s owner can accept or undo a match, including for shared items. Curators retain editing rights for accepted tasks.
- Direct filing of an unprofiled recording into an open Organization subfolder saves an intended placement when the folder's profile introduces automatic Learn or Summary work. The profile binds in the same transaction. The pipeline runs privately and publishes when the gate clears. A recording with a bound profile gets the review problems when direct filing is refused.
- A skipped or failed automatic Summary settles the gate for its current preferred transcript input if the planner has no retry due. Share settlement wakes the planner when a newer request arrived while the share job was bound. Updating an earlier task wakes the source item’s intended share if that update clears its last task decision.
- The Organization account’s own mail proposals appear in its review queue. Learn and task review queues use the item’s current view, including after switching to local mode.
- Mail has no share gate. Automatic filing waits for the existing Learn hold for up to 72 hours. Filing by hand shares immediately. Publication closes any still-open private Learn run, including those of recordings whose open run falls outside the gate. Only the mail owner reviews its task proposals.
- Intended placements on recordings already processed before profiles can advance once their reviews clear, including when opening a restricted folder creates an intent. Their legacy processing phases continue to count as settled.
- Both deployment modes use the existing review and processing state. Learn contributes a requirement where the deployment supports it.

## Related work

- [Learn](2026-09-30-learn/README.md) checked every Learn review before sharing. Only the latest private run for the current preferred transcript now counts, and the owner can skip a failed run.
- [Processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md) described the older share checks and an open mail review blocking publication past the timeout. Recordings have owner review checks and mail follows its existing timed hold.
- [Curators manage the Organization Almanac](2026-10-21-curators-manage-organization-almanac.md) gave curators the Organization Learn queue. The queue and count now cover their own items.
- [Tasks accepted automatically](2026-10-21-tasks-accepted-automatically.md) removed the task-review gate. The gate now applies to the first Organization publication of a recording.
- [The Organization Almanac grows on share](2026-10-22-organization-almanac-grows-on-share.md) kept cancel-and-restart for open private Learn runs. Required private Learn now settles before a recording’s first share, and finished reviews still publish their receipts.
- [The owner edits a shared recording](2026-10-22-owner-edits-shared-recording.md) cancelled and restarted open private Learn at publication. That still applies when an open run can reach publication, including for mail.
- [Owner reviews tasks, sharing ungated](2026-10-22-owner-reviews-tasks-sharing-ungated.md) is superseded for first-time Organization recording shares. Accepted tasks still reach assignees directly.
- [Quick finish of reviews](2026-11-02-quick-finish-of-reviews.md) is superseded for ungated recording shares and for curator quick finish skipping the owner’s task review. The remaining rules for applying and deferring suggestions still hold.

## Timeline

- **2026-11-18** The maintainer confirmed the recording gate, owner-only queues and task review, and the mail exception.
