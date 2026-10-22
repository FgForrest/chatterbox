---
title: The owner keeps editing a recording shared with the Organization, as a curator of that recording
date: 2026-10-22
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [221]
areas: [src/lib/sharing/writer-rule.ts, src/lib/sharing/writer.ts, src/lib/learn/sharing.ts, src/lib/pipeline/driver.ts, src/lib/pipeline/effective-profile.ts]
supersedes: [2026-09-30-shared-recording-edited-by-organization]
superseded-by: []
relates: [2026-10-22-pipeline-steps-settle-their-jobs, 2026-09-23-shared-organization-scope, 2026-10-22-organization-almanac-grows-on-share, 2026-10-19-one-widget-for-recordings-and-mail]
---

# The owner keeps editing a recording shared with the Organization, as a curator of that recording

The owner of a recording (or mail) filed into an Organization folder keeps working on it after
sharing: transcribe and re-transcribe, name speakers, summarize, detect topics, rename, run and
review Learn, correct the transcript. These writes land in the Organization scope, exactly as a
curator's would. Other members stay read-only. The owner's processing pipeline keeps running
after sharing, and a Learn run that started privately is cancelled and restarted on the
Organization scope. Shipped in PR #221.

The rest of the earlier sharing model stands, so this record is complete on its own:

- a shared recording is **one set of rows**, never a copy; the owner's page and the Organization
  view show the same transcript, speakers, summary and topics;
- **withdrawal** returns the recording as the Organization left it, after which the owner owns it
  fully again; removing it from its last Organization folder needs `withdraw: true`;
- **erase withdraws first**, so immediate erasure is one action, and erasing one part withdraws the
  whole recording;
- **retention:** while shared, only the Organization's policy runs; after withdrawal the owner's
  applies at once, with no grace period (the withdraw dialog warns instead);
- speaker names keep pointing at Organization people after withdrawal, and people promoted by
  sharing stay in the Organization.

## Why

Two things came together on 2026-10-21. A recording shared while its automatic summary was running
showed a spinner forever: the summary was generated (and paid for), the save was refused with
`RECORDING_SHARED`, and the step was never settled. PR #216 settled such skips, but the cause was
the rule itself: sharing stopped the owner's own pipeline. The same day the maintainer asked why
he could not keep working on his own recording after filing it into an Organization folder at step
two of the workflow. Nothing technical forced it; it was the hand-over rule of 2026-09-28.

The hand-over protected three things, and any replacement had to keep them:

1. **Private people leaking into the Organization:** an owner naming speakers from their private
   Almanac would put private people on a transcript everyone reads.
2. **Which templates apply:** Organization runs use the Organization's templates and language; the
   owner's private profile would produce a different format for everyone.
3. **Curators' work:** an owner re-transcribing would wipe curators' speaker names, corrections and
   task evidence times.

### Previous state

From 2026-09-28 (PR #69, record `2026-09-30-shared-recording-edited-by-organization`): while shared,
only the Organization account, and since PR #131 verified curators, changed the recording; the owner
got 409 `RECORDING_SHARED` from `writerRefusal`. Tasks were the exception: `taskEditable` already let
the owner edit and close tasks on their shared recording.

## Options considered

### Option A: keep the hand-over and hand unfinished steps to the Organization view (declined)

The first version of the pipeline-ownership design (rule R3): sharing hands unfinished work to the
Organization view. It left three decisions open: whether the Organization view processes shared items
by itself or waits for a member to click; what happens to a private job mid-call when the item is
shared; and what happens to a Learn run already started privately.

- **Pros:** keeps the rulings of 2026-09-28 intact.
- **Cons:** every step needs an owner per view and a hand-over path; three more decisions; the owner
  still cannot finish their own workflow.
- **Rejected because:** the maintainer wanted to keep working after sharing at step two ("it fits the
  workflow more naturally"), and allowing it removes the whole class of stuck states instead of
  routing around it.

### Option B: the owner writes like a curator of that one recording (chosen)

- **Pros:** one pipeline per item, running as the owner; the earlier open decisions about mid-call
  jobs and hand-over disappear; no copy and no schema change.
- **Cons:** owner and curators can overwrite each other; the owner's content choices now follow the
  Organization's templates while shared.

### Learn run already started privately when the item is shared

- **A, finish privately and move its findings to the Organization review (declined).** Rejected
  because findings carry their scope (people and terms land in a different Almanac), so moving them
  would be a second code path to get wrong.
- **B, cancel it and restart Learn on the Organization scope (chosen).** Its private findings stay
  private.

## Decision

**Chosen: Option B, with Learn option B** (maintainer, 2026-10-21). The three protections are kept
another way:

1. The speaker picker on a shared recording offers Organization people only, and new names become
   Organization people, as for curators.
2. The owner's runs on a shared recording use the Organization's templates. Steps that have not
   started when the item is shared, moved or withdrawn bind to the placement's profile; a running
   step finishes on its revision, completed output is never marked outdated, and a hand-picked
   profile wins.
3. Overwrites are accepted: the last write wins under the recording lock, which was already true
   between two curators.

What would bring the hand-over back: a requirement that the Organization's copy be stable against
its owner, for example an approval or publishing step for shared content (inferred).

## Key technical details

- **Writer rule:** `writerRefusal` in `src/lib/sharing/writer-rule.ts`. Shared: the owner, the
  organization account and verified curators write, everyone else gets `RECORDING_SHARED`. Not
  shared: owner only. Call it under the recording lock, which sharing and withdrawal take too.
  Without an Organization (`getOrgUserId()` null, as in `local` mode) the owner-only path applies.
- **Organization scope for the owner's writes:** the owner's speaker answers, corrections and Learn
  go to the Organization scope; the Organization view of an owner's item is effectively their view.
- **Curator and organization-account writes advance the owner's driving row** (`pipelineDriver()` in
  `src/lib/pipeline/driver.ts`), so the step they should wake actually moves; the content stays in the
  Organization scope.
- **Learn at share:** `cancelPrivateLearnAtShareInTx` in `src/lib/learn/sharing.ts`; a claimed private
  handler whose share commits during its model call discards its output and restarts once.
- **One effective manual-only policy** for pending work, share intents, provider recovery, automatic
  Learn and summary refresh: `src/lib/pipeline/effective-profile.ts`.
- No schema, migration, env or compose change.

## Verification

PR #221: whole suite on Postgres, 6,925 passed and 99 skipped. Regression files include
`src/tests/regressions/221-owner-shared-phase1.integration.test.ts` (profile binding at share, move
and withdrawal, curator authorization after the owner's access is revoked, a real row-lock deadlock
retried) and `src/tests/regressions/221-owner-shared-jobs.test.ts`; the writer rule is pinned in
`src/tests/sharing/writer-rule.test.ts`; the Learn restart in
`src/tests/learn/learn-runs.integration.test.ts`. The PR also removed shared skips from
`src/lib/sync/`; it merged before the real Plaud account test and the browser check of the
processing card, which the maintainer reported as fine the same morning.

## Consequences & open follow-ups

- **A finished private Learn review was not covered.** The cancel-and-restart rule handles an
  unfinished run only; after sharing, the Organization view offered a fresh Learn for a recording
  whose review the owner had finished. The answer is `2026-10-22-organization-almanac-grows-on-share`
  (proposed).
- **Decisions taken for the maintainer and not yet confirmed (PR #221):** withdrawal rebinds pending
  steps to the profile the item would have now without the Organization placement, not the one it
  had before sharing; an unclassified pre-change profile counts as an automatic placement when it
  equals today's automatic resolution.
- Concurrent edits by owner and curator are not merged; the later write wins.

## Related work

- `2026-10-22-pipeline-steps-settle-their-jobs`: the job and reconciler half of the same PR (#221);
  the owner's pipeline can only keep running because steps now settle reliably.
- `2026-09-23-shared-organization-scope`: the Organization scope, account and promotion rules.
- `2026-10-22-organization-almanac-grows-on-share`: what a finished private Learn contributes when the
  item is shared.
- [2026-10-19-one-widget-for-recordings-and-mail](2026-10-19-one-widget-for-recordings-and-mail.md): the shared header and erase menu whose permission check follows the new writer rule.

## Timeline

- **2026-10-21**: a shared recording's automatic summary stuck as pending; small fix PR #216 merged;
  the maintainer ruled the owner keeps editing (Option B), then chose Learn option B.
- **2026-10-22**: PR #221 merged with the pipeline redesign.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
