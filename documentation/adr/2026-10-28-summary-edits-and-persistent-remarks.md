---
title: Hand-edited summaries survive automatic processing and owner remarks replay on later runs
date: 2026-10-28
updated: 2026-10-28 19:31
status: proposed
kind: feature
issues: [299]
prs: [303, 304]
areas: [src/lib/summary, src/lib/transcription/persist.ts, src/lib/pipeline, src/lib/learn/summary-refresh.ts, src/lib/export/build-archive.ts, src/db/schema.ts, src/components/summary]
supersedes: [2026-10-22-summary-reads-the-preferred-transcript]
superseded-by: []
relates: []
---

# Hand-edited summaries survive automatic processing and owner remarks replay on later runs

The owner can edit a generated summary's Markdown and key points, or revise it through stored
remarks. Hand edits block automatic replacement, including transcript replacement. Remarks belong
to the item and apply to later summary runs by the owner in either their private or Organization
view, even after explicit regeneration. A manual run by a curator or the Organization account
never reads or sends the owner's remarks.

## Why

A useful human correction must survive the next sync, Learn correction or transcription. Storing
only the revised output loses the owner's explanation on regeneration. Storing that explanation
as model instructions would give user content authority over the application's output contract.
Both hosted and self-hosted workers can finish concurrently with a human edit, so checking only
when a job is queued cannot protect the text.

### Previous state

Generated summaries were replaceable processing outputs. New preferred content or Learn input
could queue another summary, and forced transcription removed the old generated summary. The
owner could neither edit the summary directly nor attach persistent corrections to its item.

## Options considered

### Protect edits and persist item remarks (chosen)

- **Pros:** preserves reviewed text, reuses corrections on future runs and uses the existing
  queue, providers, usage accounting and task proposal flow.
- **Cons:** summaries may deliberately remain older than their input; remarks consume prompt
  tokens on each later run and need independent retention and backup handling.

### Keep corrections only in the revised summary (declined)

- **Pros:** requires no separate remark lifetime or replay rules.
- **Cons:** the correction disappears when another run replaces that output.
- **Rejected because:** explicit regeneration and later automatic processing must retain the
  owner's corrections. This becomes viable only if that product requirement changes.

## Decision

Protect hand-edited generated summaries until a permitted writer explicitly confirms replacement. Store
encrypted remarks separately from summary rows. A remark run reads the preferred input, current
summary and all remarks in a USER message, gives the owner's corrections priority over conflicting
source content, and runs once through the existing manual job queue. Later runs read the remarks
without the old summary exactly when the actor is the owner, in either view. Automatic runs on
shared items run as the owner and retain corrections. Manual runs by curators or the Organization
account never read or decrypt remarks, deliberately excepting them from “every later run includes
the remarks”. Those runs store an applied-remark count of zero, removing the provenance chip until
the owner next runs the summary; the stored remarks remain. This keeps private correction inputs
out of another actor's provider request. No remark text enters the system instructions.

## Key technical details

- Edits and remark access require the item owner in a private view or, while shared, the
  Organization view of their own page. Received views, Plaud summaries, the Organization account,
  curators and other members get no correction controls or remark text. A correction run from the
  Organization view uses its Organization job subject. Both views read and update the same row;
  the panel preserves its shared scope, Organization templates and profile resolution. The
  Organization picker offers Organization profiles, matching the route's existing selection rule.
  Generation responses carry the correction permission alongside provenance, so completing a run
  cannot temporarily expose correction actions to a different writer.
- Every writer allowed to regenerate, including curators and the Organization account, must confirm
  replacement of hand edits. Only the owner gets the confirmation's link to write a remark.
- The summary transaction locks the item, rechecks the writer and fences row identity, revision
  and remark membership. Explicit expected absence differs from revision zero on a stored row.
  Editors and replacement confirmations retain the version present when opened; a conflict keeps
  the draft. Queue payloads contain flags and versions, never remark text. Job claiming order is
  unchanged. A Learn catch-up pass uses only the exact version committed by its first pass.
- Automatic queueing, Learn refresh, pipeline planning and final persistence all respect the edit
  marker. Forced server/browser transcription retains the edited summary and its sidecar. The
  existing older-input note still describes changed input.
- Explicit regeneration clears attribution; a remark revision preserves it. Hand editing never
  edits tasks. Model revisions use normal task proposals and usage recording.
- Speaker links preserve their href and numeric offset. Every audio summary run records the
  offset inferred from its fresh model output, and the first edit of an older summary captures its
  pre-edit numbering, both in the existing summary input metadata. A remark run shows the model the
  current summary in the transcript's own numbering. Display, later edits and exports use the saved
  offset instead of inferring it from edited prose or key points. The editor projects attributed
  names; saves restore canonical `Speaker N` labels.
- Migration `0151_summary_edits_and_remarks` adds nullable edit attribution (who, when) and a
  revision and applied-remark count (not null, default 0) to `ai_enhancements`, plus owner-scoped `summary_remarks` with item-cascade deletion. User text is
  encrypted. There are no new environment variables, services or provider defaults.
- Remarks are removed with summary erasure/retention and item deletion. Personal backup archives
  carry remark text; Organization archives carry the shared summary and its provenance, without
  private remarks. Archive restore remains outside this change.

## Verification

`src/tests/regressions/299-summary-edit-remarks.integration.test.ts`: 75 PostgreSQL cases cover
recording/mail authorization, private remark disclosure, identity/revision races, immutable save
responses, speaker-reference removal and exports, automatic protection, Learn catch-up, usage,
erasure, retention and backup contents. Shared-owner cases exercise both views, Organization job
subjects and automatic remark replay; curator and Organization runs never read remarks and clear
applied provenance. Real-resolver cases verify Organization placement and hand-picked profiles for
owners, curators and the Organization account. `299-summary-editor-refresh.test.tsx` has 9 real-hook/widget
and dashboard-panel cases; `299-summary-speaker-edit.test.ts` has 3 speaker round-trip cases.
The complete unit suite passed 6,918 tests with 2,715 skipped and no failures under Node 22.
The area integration run passed 1,686 cases across 97 files, with 25 cases in two Keycloak suites
skipped because no test issuer was configured. Shared widget and remarks-dialog tests cover editing,
confirmation, cancellation and stored remarks.
A rebuilt disposable demo verified owner actions, edit/save, correction runs and both provenance
markers, replacement confirmation, and absence of actions for Plaud and an Organization member.
The browser correction run used a deterministic local provider fixture; the real queue, usage and
persistence paths ran, and the demo provider configuration was restored afterwards.

## Consequences & open follow-ups

- New summary writers must preserve the transaction fences and respect edited output. A stale
  edited summary is a deliberate durable artifact, even after a new preferred transcript appears.
- Remarks are owner-private inputs although their resulting summary is shared. Replay follows the
  actor, not the view: another actor's manual run excludes them and clears applied provenance without
  deleting them. Deleting a remark affects future owner runs; it does not rewrite the current
  summary or remove its provenance marker.
- The selected-profile revision loader retains the request's actual view. Organization-view
  resolution is unchanged; an explicitly selected personal profile remains usable from the owner's
  private view while shared. Placement profiles and hand-picked Organization profiles keep their
  existing precedence.
- A failed model run leaves its stored remarks available to retry. Revision conflicts require a
  reload; no automatic merge of competing human edits is attempted.

## Related work

- [Preferred transcript selection](2026-10-22-summary-reads-the-preferred-transcript.md) is
  superseded only for automatic replacement of a hand-edited summary when preferred content
  changes. The `riffado`, `mixed`, `plaud` input order and all other rules remain in force.

## Timeline

- **2026-10-28**: approved issue #299 design implemented and opened as PR #303, stacked on PR #300,
  after two cross-review rounds. Owner corrections are available in either own view; replay is
  limited to runs whose actor is the owner. #303 merged into its base after #300 had landed; PR #304
  carried it to `dev`, with the migration renumbered to 0151.
