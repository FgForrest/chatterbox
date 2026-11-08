---
title: Offer whole-transcript edge trimming before Learn and wait durably for the owner
date: 2026-11-08
updated: 2026-11-08 22:05
status: accepted
kind: feature
issues: [327]
prs: [357]
areas: [src/lib/recordings, src/lib/pipeline, src/lib/profiles, src/lib/export, src/db/queries, src/components/recordings, src/db/schema.ts]
supersedes: [2026-10-19-processing-profiles-and-workflow, 2026-10-22-pipeline-steps-settle-their-jobs, 2026-11-08-shared-recordings-cut-in-place, 2026-09-13-durable-job-queue, 2026-10-07-backup-scope]
superseded-by: []
relates: [2026-10-19-provider-defaults-and-no-fallback, 2026-10-22-summary-reads-the-preferred-transcript, 2026-09-30-learn, 2026-11-03-destructive-recording-cut, 2026-11-08-recording-cut-sentence-boundaries, 2026-11-08-stored-sentence-start-times]
---

# Offer whole-transcript edge trimming before Learn and wait durably for the owner

Audio processing evaluates a conservative prefix/suffix trim proposal after transcription and before automatic Learn. A nonempty proposal waits for the owner for four hours. The owner can use the existing destructive cut, adjust the sentence boundaries, decline, or explicitly run Learn or a summary uncut. The model never cuts anything. The internal trim phase occupies the existing Learn position in the workflow strip, including hosted installations where Learn is unavailable.

## Why

Off-topic openings and closings can become knowledge, summaries and task proposals if processing reads them before the owner can remove them. Relevance needs the entire conversation, while destructive changes need human confirmation. Hosted runs multiple workers, so a browser timer or process-local hold cannot safely order the work. Self-host must retain local and OpenAI-compatible providers without silent cloud fallback.

### Previous state

The pipeline moved from transcription directly to Learn or summary. The sentence-start cut panel already performed owner-confirmed cuts, including shared recordings in place. Intended sharing waited for an active cut, but had no trim decision to await. Archives exported content and profile provenance without an import adapter for decisions.

## Options considered

### Separate internal trim phase and owner confirmation (chosen)

- **Pros:** independent provider, input fence, bounded inference retries and durable decision deadline; works with Learn disabled and on hosted; reuses the established cut and its recovery.
- **Cons:** one additional whole-transcript request for eligible inputs, plus up to four hours before automatic continuation.

### Put the proposal inside Learn or Summary (declined)

- **Pros:** fewer internal phases.
- **Cons:** couples the decision to an optional or unavailable feature; Summary is already too late.
- **Rejected because:** the owner must decide before either automatic downstream step reads the uncut content.

### Inspect only the edges, window the transcript, or cut automatically (declined)

- **Pros:** smaller requests or no human delay.
- **Cons:** loses whole-meeting context or destroys content without a human decision.
- **Rejected because:** edge relevance depends on the whole discussion, and uncertain suggestions must never delete substantive speech. A longer-context chosen provider is the retry path; no shortening, paid repair or fallback escalation.

## Decision

Use one versioned whole-transcript request, strict sentence-ID/time validation and the existing sentence-start snapping policy. Missing providers, unsupported content, oversized input, context rejection, invalid output and exhausted inference retries release automatic work uncut. No usable chat provider at all (`no_provider`) and transcripts without cuttable timings (`unsupported_cut`) are silent, matching optional summary processing. A broken explicit profile pin or role default remains visible (`provider_unavailable`); choosing an unavailable provider must not silently select another one. Context, output and inference failures retain visible diagnostics. Valid empty output releases immediately. A valid nonempty result creates one encrypted owner-private decision and a four-hour wait; no worker sleeps through that wait.

The maintainer explicitly approved one nullable encrypted-envelope JSONB column, `recordings.trim_proposal`, generated through Drizzle. Audio V1/V2 revisions missing the setting parse as trim on, just like new profiles. Nothing automatic suppresses it, mail has no trim step, and a new profile revision can opt out. There is no backfill or sweep reopening old inputs, including unfinished pre-upgrade Learn reviews. Without a trim phase or explicit Process again generation, any Learn, Summary (including its Topics step) or task-review phase for the same content ID, source and revision grandfathers that input in every state. A new arrival has no such downstream phase; a new transcription changes the input identity; Process again explicitly requests another evaluation generation. The legacy Learn-release generation used to resume downstream work is not a trim evaluation event.

Intended sharing waits both while trim inference runs and while the owner decides, with reason `trim`. Planner checks are repeated under the share transaction's existing Organization tree, people and recording locks. Decline, timeout and committed cuts release the hold and wake planning. Existing shares remain in place; previously obtained copies cannot be recalled.

The owner's full archive carries decrypted pending proposals, their original deadline and the evaluated/resolved marker. A focused import adapter remaps recording, transcript, profile, credential and payer identifiers, checks restored audio and raw transcript identity and sentence ranges, recomputes the destination rendering fingerprint, and encrypts with destination keys. Expired or mismatched proposals resolve and cannot cut. Operational jobs are never restored. Organization archives, received downloads, folder exports, MCP and `/api/v1` omit proposals. This does not add a general archive import UI.

## Key technical details

- `trim.propose` uses the existing atomic job/phase binding and claim fencing, concurrency two, two attempts, a five-minute attempt timeout and no SDK retries. Per-user fair claims and a dedicated hourly bucket prevent one bulk sync from monopolizing optional work. Organization quota and per-attempt usage accounting remain authoritative; operation `trim` appears in spending.
- The request includes the complete corrected preferred transcript mapped to raw sentence anchors, exact milliseconds, display clocks and recording end. Corrections spanning boundaries are indivisible. Strict output permits only a prefix and/or suffix with short localized reasons. The preferred transcript alone rejects a sentence overlapping either edge, including overlapping diarized turns. Secondary transcripts keep a sentence exactly when its start lies in `[startMs, endMs)`, matching manual cuts from PR #352. Every stored transcript must retain some text. This explicitly overrides the design's all-transcript overlap rule (design.md line 196): independently interpolated secondary sentence starts need not coincide with the preferred transcript's anchors. The 512-KiB input ceiling is a resource bound, not a context-size claim; requested output is capped at 4,096 tokens and the configured card cap.
- Provider precedence is trim profile pin; member trim default; title profile pin; member title default; summary profile pin; member summary default; Organization trim, title and summary defaults; oldest suitable member then Organization provider. A present broken choice stops resolution and skips trim. The pure candidate builder also drives the picker preview. Title and Summary switches do not erase their configured pins.
- Recording then processing/job locks serialize publication, decision, expiry, downstream automatic admission and cut acceptance. `prepareClaimedPipelineJob` rechecks the job's trigger and trim/cut holds at claim preparation, including jobs queued before the hold or before deployment. Held automatic Learn, Summary, Topics and Plaud task imports return to pending with the attempt refunded. Manual owner Learn/summary resolves `bypassed_manual`; permitted curator manual work leaves the owner's hold intact. A held job waits until the decision deadline, or 30 seconds while inference runs or a cut is active, so it takes no claim slot meanwhile; every decision, expiry, publication and cut settlement wakes it at once. Cut commit cancels work on the old input and replans on the retained revision. The reconciler resolves due `trimReview` waits before generic lost-job repair, without retrying inference. Cut preparation takes precedence over expiry. A failed cut keeps the original deadline; a committed cut records trim settled for the retained input.
- Explicit owner Learn/summary bypasses the proposal uncut. Permitted curator manual processing remains allowed but cannot decline the owner's decision; a later cut may regenerate those results. This narrow automatic gate does not introduce general server ordering for manual actions.
- Profile reassignment refreshes an unfinished enabled proposal against the new recipe without renewing its original deadline; disabling resolves it. Transcript replacement, retention and deletion invalidate it. Incidental provider changes, Learn overlays and generation bumps do not reopen settled decisions.
- The owner card and checked transcript marks load through existing processing data. Polls read only audio identity, transcript revisions and the deadline without a recording row lock, rendering, fingerprinting or trial cuts. A failed cheap check acquires the writer lock and rereads before resolving; publication, decisions and cut commit retain full snapshot validation. The cut context's `openWithRange` captures reviewed revisions and opens the existing irreversible confirmation or editing panel. No new workflow circle or public processing enum is introduced.

## Verification

`src/tests/recordings/trim-proposal.test.ts` covers output and anchor safety, profile defaults, provider precedence, grandfathered unfinished inputs, legacy Learn release and the three eligible evaluation events. `trim-proposal.integration.test.ts` uses fake providers and PostgreSQL to cover atomic publication, claim-time deferral/refunded attempts, release after decline/expiry/cut, manual actor boundaries, cheap nonlocking polling, fenced/prose JSON, reasoning output caps, secondary Plaud sentence starts, stale claims, ownership, sharing and destination-key restore. `trim-proposal-ui.test.tsx` exercises checked marks, range prefill, confirmation, optimistic decline, silent optional skips, visible broken choices and transcript expansion/source selection/focus through the real collapsed `TranscriptionPanel`. Archive scope and shared-cut regression tests cover portability and retained-input processing. The whole suite under Node 22 with PostgreSQL and ffmpeg passed 11,109 tests, skipped 108 opt-in tests and reported only the 40 known SSO failures in two files, out of 11,257 tests across 866 files. The preceding focused check passed 238 tests across eight files; the final whole run includes the additional timeout-cut regression. Exact commands and complete output are recorded in the implementation report. External providers are never called.

## Consequences & open follow-ups

Both deployment modes gain the same additive column and default-on optional inference for future processing events. Upgrading an existing installation requires no configuration changes; normal release migration adds the column. Each eligible input can incur one extra whole-transcript call, or another after a transient retry/reclaim. A wrong suggestion remains playable and requires human destructive confirmation. A committed cut affects every existing authorized reader and can only be undone from an external original or older backup. A failed preparation leaves the original intact. Arbitrarily long transcripts cannot fit every model: context skips are deliberate and visible. A browser check on the demo stack with a stub OpenAI-compatible provider covered the card, editing in the transcript, a committed cut and a decline. Real provider quality remains unmeasured.

## Related work

- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md): Audio processing gains an internal trim phase before Learn, enabled even for old profile revisions unless automation is suppressed. The existing visible positions and other profile rules stay.
- [2026-10-22-pipeline-steps-settle-their-jobs](2026-10-22-pipeline-steps-settle-their-jobs.md): Automatic downstream work now rechecks the owner trim decision under writer locks. Explicit manual runs remain permissive, and job settlement and reconciliation keep their existing contracts.
- [2026-11-08-shared-recordings-cut-in-place](2026-11-08-shared-recordings-cut-in-place.md): Intended sharing also waits for running or pending owner trim decisions. Already-shared content stays shared and cuts still commit in place.
- [2026-09-13-durable-job-queue](2026-09-13-durable-job-queue.md): The new trim inference kind uses per-user fair claims alongside pipeline and cut jobs. Summary and Learn claiming stays oldest first.
- [2026-10-07-backup-scope](2026-10-07-backup-scope.md): A focused trim-decision import adapter now exists, without a general archive restore UI. Account-selected archive scopes and other export rules stay.
- [2026-10-19-provider-defaults-and-no-fallback](2026-10-19-provider-defaults-and-no-fallback.md): the no-silent-fallback rule the trim provider order follows.
- [2026-10-22-summary-reads-the-preferred-transcript](2026-10-22-summary-reads-the-preferred-transcript.md): the preferred transcript the proposal reads.
- [2026-09-30-learn](2026-09-30-learn/README.md): the automatic step the decision gates.
- [2026-11-03-destructive-recording-cut](2026-11-03-destructive-recording-cut.md): the destructive cut the owner confirms.
- [2026-11-08-recording-cut-sentence-boundaries](2026-11-08-recording-cut-sentence-boundaries.md): sentence-start retention and the cut panel the proposal opens.
- [2026-11-08-stored-sentence-start-times](2026-11-08-stored-sentence-start-times.md): the sentence times the anchors use.

## Timeline

- **2026-11-08**: maintainer answered the open questions; implemented in PR #357.
