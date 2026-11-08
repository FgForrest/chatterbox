---
title: Shared recordings are cut in place and intended shares wait for cuts
date: 2026-11-08
updated: 2026-11-08 19:20
status: superseded
kind: fix
issues: [327]
prs: [346]
areas: [src/lib/recordings, src/lib/pipeline, src/db/queries/async-jobs.ts, src/components/recordings/recording-cut.tsx]
supersedes: [2026-11-03-destructive-recording-cut]
superseded-by: [2026-11-08-recording-cut-sentence-boundaries, 2026-11-08-ai-trim-proposal-before-learn]
relates: []
---

# Shared recordings are cut in place and intended shares wait for cuts

The owner cuts a shared recording in place from their private view. Organization folders keep the recording, colleagues see the retained content, and generated results are rebuilt through the existing owner-scoped pipeline. An intended Organization placement waits while a cut is pending or processing.

**Superseded in part** by [sentence-boundary recording cuts](2026-11-08-recording-cut-sentence-boundaries.md): the cut controls move into a panel above the transcript, with typed sentence-snapped edges and paragraph-gap actions. Inline errors still retain the selection; sharing, locking, polling and all other rules remain in force.

**Superseded in part** by [AI trim proposals before Learn](2026-11-08-ai-trim-proposal-before-learn.md): Intended sharing also waits for running or pending owner trim decisions. Already-shared content stays shared and cuts still commit in place.

## Why

An intended placement can execute between a cut request and its commit. Refusing the commit after audio preparation wastes the work and leaves the owner uncertain whether anything changed. Sharing during preparation also exposes the uncut content and promotes knowledge from it.

### Previous state

A shared cut required withdrawal consent, with the same retention warning as erasure. A recording private at request time could become shared before commit and fail permanently. The cut UI closed before the request completed and only showed a toast on failure.

## Options considered

### Cut in place and serialize intended sharing (chosen)

- **Pros:** existing Organization links and placements survive; colleagues read the same retained content as the owner; automatic sharing cannot publish content being cut.
- **Cons:** existing readers see a destructive change and regeneration can incur provider charges.

### Withdraw before every cut (declined)

- **Pros:** colleagues cannot read the recording during the destructive change; withdrawal already has retention and knowledge cleanup rules.
- **Cons:** sharing the retained version requires another placement and withdrawal removes Organization knowledge.
- **Rejected because:** cutting must preserve placements and confirmed knowledge, and a share between request and commit still races with a private cut. Revisit only if cuts become a separate operation that explicitly revokes sharing.

## Decision

Keep the recording shared and limit cutting to the owner in their private view. Extend the destructive-cut exception to knowledge decay: an owner or Organization fact citing this recording becomes manual if the cut removes its last supported evidence. Normal retention and withdrawal decay are unchanged. Accepted tasks, including routed tasks, remain human decisions.

Intended placements wait at both the planner and transaction layers. The transaction check is required across worker processes; a planner snapshot alone cannot prevent publication during audio preparation.

## Key technical details

- `requireRecordingView` resolves both content views to owner rows. Like `upsertTranscription`, the cut uses `transcriptRewrittenInTx` and `requestAdvanceInTx`; `pipelineDriver` drives the owner's private row. Legacy Organization processing phases are reset too, and a completed title step in either stored view identifies a generated title; manually edited titles still stay. There is no second summary to generate.
- Sharing and cut commit acquire Organization tree, Organization people and recording locks in that order, before processing and job locks. Task-graph item locks stay sorted. A cut request holds the recording lock while inserting its job, so a share rechecks the active job after that insertion commits.
- A cut cancels obsolete share actions and resets their phase alongside derived content. Queue terminal settlement wakes the owner pipeline after the cut leaves the active states, including terminal failure. A share settling as waiting specifically for a cut also wakes planning, so settlement after the earlier wake cannot strand the intent. Share actions validate their job id and claim token under the same locks before filing, preventing cancelled workers from filing before regeneration.
- Both the commit and checkpoint-recovery paths plan exports for the owner and the Organization before storage cleanup. Repeated planning uses the existing per-export active-job deduplication. The existing Organization-folder query also queues curator-owned export configurations; existing fingerprints replace audio and rendered documents. The normal shared-content notification also refreshes open Organization views, and summary completion sends it again after regeneration.
- Old payloads containing `withdraw` parse with that unknown field discarded. No schema, environment variable or API-v1 shape changes are required.
- Refused requests and failed jobs keep the chosen range with an inline alert. Failures arriving after navigation use a toast. One watcher per job bounds status errors to three consecutive failures and observation to 65 minutes, including after navigation; terminal observations clear timers. Cut/share event logs contain only ids, numeric ranges, boolean state and error codes. The cut failure log is emitted by terminal queue settlement, including exhausted stale claims, rather than by each handler attempt.

## Verification

The final fresh run of all 6 cut regression files passed 130 tests with PostgreSQL 16 and ffmpeg enabled under Node 22.

- `327-cut-shared-race.integration.test.ts`: 12 PostgreSQL cases cover shared reset/export scheduling, pending/processing holds, common-lock serialization, late share settlement after all four cut endings, confirmation waits without wake-ups, revoked share claims after cut completion, cleanup failure on commit and recovery, and exactly one terminal failure log including stale burial.
- `327-cut-shared-plan.test.ts`: 3 planner cases cover automatic and confirmed manual-only sharing.
- `327-cut-shared-errors.test.tsx`: 31 UI cases cover mapped refusals, late status responses after refusal, transport failure, recovery of a queued range after reload, navigation with both discovery and submission pending, bounded 401/404/transport retries before and after navigation, and detached observation deadlines including a stuck request, and returning discovery racing with watcher completion.
- Existing cut regressions verify Organization and private facts become manual and every route refusal logs its code and status.

## Consequences & open follow-ups

Both self-host and hosted retain owner authorization and the same destructive-cut recovery limits. A committed cut changes content for every authorized reader; restoring removed content still needs an external original or older backup. Organization folders and future exports use the retained version, but previously obtained copies cannot be recalled. No deployment migration is needed. Provider calls are simulated in regression tests; browser visual review and real storage-provider checks remain deployment checks.

## Related work

[Destructive recording cuts](2026-11-03-destructive-recording-cut.md) is superseded only for withdrawal before cutting, Organization fact pruning on a cut, recognizing generated titles in both stored views, and intended sharing during a cut. The original destructive operation, owner-only authorization, preservation of accepted tasks and Plaud cut marker remain in force.

## Timeline

- **2026-11-08**: decided and implemented; PR #346 merged.
