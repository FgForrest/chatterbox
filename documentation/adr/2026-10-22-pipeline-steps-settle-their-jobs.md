---
title: A pipeline step names its job and the worker settles both, one reconciler repairs drift, and the server says what each step waits for
date: 2026-10-22
updated: 2026-10-22 17:00
status: accepted
kind: fix
issues: []
prs: [209, 216, 220, 221]
areas: [src/lib/pipeline, src/db/queries/pipeline-jobs.ts, src/db/queries/pipeline-reconciler.ts, src/db/queries/async-jobs.ts, src/lib/jobs, src/hooks/use-item-processing.ts, src/lib/summary]
supersedes: []
superseded-by: []
relates: [2026-10-19-processing-profiles-and-workflow, 2026-10-22-owner-edits-shared-recording, 2026-09-13-durable-job-queue, 2026-10-22-summary-reads-the-preferred-transcript]
---

# A pipeline step names its job and the worker settles both, one reconciler repairs drift, and the server says what each step waits for

The processing pipeline kept a step's state in `item_processing.phases` and its work in
`async_jobs`, written by different code in different transactions, and repaired mismatches with
sweeps that each recognised one symptom. PR #221 made the binding explicit: enqueueing a step
records the job id and generation on the step in the same transaction as the job, handlers return a
typed outcome, and the worker writes the job's terminal status and the step outcome together. One
reconciler, every 60 s, replaces the sweeps. The processing response now carries each step's state
and what it waits for, and the client stopped guessing. Three summary rulings from the same
investigation are recorded here too: an old summary stays visible after a re-transcription, with a
note; naming speakers does not gate the summary; and where workflow order matters, the UI enforces
it, not the server.

## Why

- **A recording shared into an Organization folder never got its summary.** Its automatic summary
  had been held for Learn. When the hold ended, the summary job generated the summary (a paid call),
  the save was refused because the recording was now shared, and the handler returned "skipped"
  without settling the step. The step stayed pending with no job behind it; the only sweep looked
  at failed jobs; the card showed a spinner and a disabled button indefinitely. PR #216 fixed that
  path.
- **A second defect was found in the code while looking:** Learn findings of an Organization-scoped
  run are stored under the run's scope, but the page counted them under the owner, which would hide
  the review and hold the summary up to 72 h (PR #216).
- **PR #209** fixed a related loss: a manual re-summary that was generated and billed, then
  discarded as outdated, because its fence compared the newly selected profile revision with the
  revision the item was filed on.
- **The maintainer asked whether the design was wrong**, since this was not the first failure of the
  queuing logic. It was. Four faults kept producing such bugs:
  1. **Two records of the truth, written separately.** A handler wrote success before its job
     completed; failure was written by a hook after the job was buried and was lost if the process
     died in between; exhausted stale jobs never called that hook; handlers that returned "skipped"
     (held, shared, outdated) touched neither record; a manual job never settled an automatic step
     that had been deduplicated onto it.
  2. **Sweeps chased symptoms they could name.** The orphaned-step sweep fired only for a failed
     automatic job. A job that completed normally, never existed, or had been deleted by
     housekeeping (finished jobs are kept one day) left its step stuck for good. Learn and Share
     were not covered at all.
  3. **A shared item had no owner per step.** The private view kept planning work the sharing rule
     then refused; the Organization view planned nothing. That part is decided in
     [owner edits shared recording](2026-10-22-owner-edits-shared-recording.md).
  4. **The page guessed.** "Queued" was the client labelling the next automatic step; no job had to
     exist. Polling ran only while a step looked active, ignored fetch errors, and never showed
     progress the server made later to an idle page.

### Previous state

The pipeline of [processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md)
introduced `item_processing` with request counters and fenced outputs, but left step settlement to
each handler and recovery to `listOrphanedPipelineStepRows`, which filtered on failed jobs. This
held while every automatic job either saved or failed; sharing added a third ending, "refused at
save", that nobody settled.

## Options considered

### Option A: the step names its job, the worker settles both, one reconciler checks an invariant (chosen)

- **Pros:** every way a job can end goes through one path (done, skipped with a reason, failed with
  a code and retryability, lost); the step outcome lives on the step, so deleting job rows hides
  nothing; a new handler cannot add a new way to get stuck, because the reconciler's check does not
  depend on why the job ended; no schema change (the binding goes into the phase JSON).
- **Cons:** rewrites the bookkeeping of every pipeline handler at once; needs a global lock order,
  since settlement now touches the item, its processing rows, profile locks and the job together.

### Option B: keep adding targeted sweeps (declined)

PR #216 shipped one: settle a summary step whose latest job *completed* without settling it, after a
two-minute grace, unless the item is held for Learn.

- **Pros:** small, quick to ship, fixed the observed case.
- **Cons:** every new drift needs a new sweep with its own heuristics; it still cannot see drift once
  housekeeping has deleted the job row.
- **Rejected because:** it treats the symptom and keeps two sources of truth. PR #216 itself was
  framed as the stopgap until this redesign. Worth revisiting only if pipeline jobs stop sharing
  steps with manual runs and sharing.

### Option C: a stale pipeline-bound job fails as "lost" at once (declined)

The first version of the rewrite buried a bound job on its first missed heartbeat, even with
attempts remaining.

- **Pros:** simpler; a stale job never runs twice.
- **Cons:** every app restart mid-processing (a self-host upgrade, a hosted deploy) failed
  in-flight summaries, topics, titles, Learn and shares, each needing a manual retry.
- **Rejected because:** the review flagged exactly that self-host restart case. Stale jobs are now
  reclaimed while attempts remain, under the same job id and generation so the step binding stays
  valid, with the old claim revoked; only an exhausted job settles as a retryable "lost".

## Decision

**Chosen: Option A, with stale jobs reclaimed (not Option C).** It removes the fault class instead of
one instance, keeps the step's outcome after job rows are deleted, and makes recovery a property of
an invariant rather than of a list of known failure modes: an unfinished step either names a live
job or names what it is waiting for. What would change it: if steps stopped being shared between
automatic and manual runs and sharing, per-handler settlement would be simple enough again.

### Summary rulings from the same investigation (2026-10-21)

- **An old summary stays visible after a re-transcription**, next to the new, unanswered Learn
  review. Hiding or gating it was raised as a gap; the maintainer ruled it fine, "at most we may
  inform user". PR #220 adds an amber note "Made from an earlier transcript" with Regenerate.
- **Naming speakers is not a condition for the summary;** the summary waits only for the Learn
  review. The maintainer's "this is wanted" was read as keeping today's behaviour.
- **The UI, not the server, enforces workflow order where order matters.** The server accepts almost
  every manual action whatever is still running; the maintainer does not want server-side limits,
  only a UI that effectively prevents the confusing states.

## Key technical details

- **Binding:** enqueueing a step writes `{ state: "running", jobId, generation }` on the driving row
  in the same transaction as the job (`src/db/queries/pipeline-jobs.ts`). Handlers return a
  `StepOutcome` (`src/lib/pipeline/outcome.ts`: done, skipped, waiting, failed). The worker settles
  the job and the step together, fenced by claim token and generation. A superseded job is still
  made terminal; only current bindings settle, and each binding settles on its own, because one job
  can carry two (a summary job that also claims the title step). An all-or-nothing loop once wedged
  such a job for good.
- **Lock order, on every path that takes more than one:** item, then processing rows sorted, then
  profile locks sorted, then the job (JSDoc in `pipeline-jobs.ts`). The folder and share paths retry
  once on a deadlock (`retryOnDeadlock`).
- **Reconciler:** `reconcilePipelineSteps` (`src/db/queries/pipeline-reconciler.ts`), run every
  60 s from `src/lib/pipeline/sweep.ts`, at most 100 steps per tick and 5 per user. It settles steps
  whose job is finished, missing or without a heartbeat for 120 s, and re-plans steps with no job
  after a 2-minute grace, backing off 2, 10 and 60 minutes before "lost". It covers Learn and Share.
- **Server-computed state:** `src/lib/pipeline/processing-status.ts` gives each step `state`,
  `reason`, `waitingFor` (a job with its queue position, a Learn review until a time, a folder, a
  share confirmation, the Organization) and the allowed actions. "Queued" appears only when a pending
  job row exists; a running step with no heartbeat for 120 s is reported as stalled. The
  Organization view gets the driving row's state with the viewer's own actions.
- **Polling:** the response carries `nextCheckAt` and `nextCheckInMs`; the client
  (`src/hooks/use-item-processing.ts`) schedules from the relative `nextCheckInMs`, because comparing
  the server's absolute deadline with the browser's clock was a must-fix in review. One timer per
  item, a refetch on focus and visibility, no polling while hidden, and two failed fetches show a
  quiet "state may be stale, retry" line. The client's `inferUpcomingStates` guessing is gone.
- **Summary fence (PR #209):** a run reads the item's profile revision once at its start and fences
  against it; the summary row still records the revision that made it, and the item does not move
  to that revision. A summary that passes the full fence clears an `outdated / profile_changed`
  mark on the summary phase, which also repaired items the bug had marked.
- **Older-content note (PR #220):** `GET /api/recordings/[id]/summary` returns `olderContent` when
  the summary's recorded content id or revision differs from the current transcript or mail.
  Summaries without recorded provenance report `false`.

## Verification

- PR #221: whole suite on Postgres 6,925 passed, 99 skipped. Regression files in
  `src/tests/regressions/`: `221-pipeline-settlement.integration.test.ts` (worker and reconciler
  reclaim, old-claim fencing, final loss), `221-pipeline-outcome.test.ts`,
  `221-deadlock-retry.test.ts` (a genuine two-connection deadlock and the lock order),
  `221-processing-status.test.ts`, `221-processing-status.integration.test.ts`,
  `221-processing-polling.test.ts`, `221-retry-wait.test.ts`.
- PR #216: `src/tests/pipeline/shared-skip.integration.test.ts`; the Learn scope regression fails on
  the old code (count 0). PR #209: `src/tests/regressions/manual-summary-profile-revision.integration.test.ts`,
  16 tests that failed before the fix. PR #220: `src/tests/summary/older-content.integration.test.ts`.
- The PR merged before a browser check or a real Plaud sync test; the maintainer reported both as
  "seems ok" the same day.

## Consequences & open follow-ups

- Stuck steps should now end within a minute or two as a retryable failure; a step left pending with
  nothing behind it is not a state the UI has copy for, by design.
- **Awaiting the maintainer's confirmation** (listed in PR #221): stale jobs are reclaimed while
  attempts remain instead of failing as lost at once.
- The server enforces almost no workflow order. A future server-side check should not be added "for
  safety" without a new decision, because the maintainer explicitly declined it.
- PR #221 also changed `src/lib/sync/` (shared skips removed); `AGENTS.md` asks for a real Plaud
  account test on such changes.

## Related work

- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md):
  built the pipeline whose step bookkeeping this replaces.
- [2026-10-22-owner-edits-shared-recording](2026-10-22-owner-edits-shared-recording.md): the same
  PR #221 decided who owns a shared item's steps; this record covers how steps and jobs agree.
- [2026-09-13-durable-job-queue](2026-09-13-durable-job-queue.md): the claim-token scoping and
  heartbeat reclaim this settlement builds on.
- [2026-10-22-summary-reads-the-preferred-transcript](2026-10-22-summary-reads-the-preferred-transcript.md): fixed summary and title steps that failed on Plaud-only recordings.

## Timeline

- **2026-10-21**: PR #209 (manual summary kept with a newer profile revision) and PR #216 (settle shared skips, count Organization Learn findings, sweep
  unsettled steps) merged; design for step ownership, settlement and server status written; summary
  rulings given; PR #220 (note on a summary made from an earlier transcript) merged.
- **2026-10-22**: PR #221 merged with the settlement, reconciler and server status.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
