---
title: Summaries and titles read the same transcript the pipeline chose, own first, then the user's edit, then Plaud's
date: 2026-10-22
updated: 2026-10-22 17:00
status: proposed
kind: fix
issues: []
prs: []
areas: [src/lib/summary/generate-summary.ts, src/lib/ai/generate-title.ts, src/lib/recordings/title-input.ts, src/lib/pipeline/facts.ts, src/lib/profiles/settings.ts, src/components/dashboard/transcription-panel.tsx]
supersedes: []
superseded-by: []
relates: [2026-10-19-processing-profiles-and-workflow, 2026-10-22-pipeline-steps-settle-their-jobs]
---

# Summaries and titles read the same transcript the pipeline chose, own first, then the user's edit, then Plaud's

The private summary and title now pick their transcript in the order the Organization summary
already used: the own transcript (`riffado`), then the user's edited one (`mixed`), then Plaud's
(`plaud`). Before, they read only the own transcript, so a recording that had only Plaud's
transcript, under a processing profile set to use Plaud's transcript (the built-in default), had its
transcript, Learn and topics done and then failed summary and title with `INVALID_INPUT` ("No custom
transcription available"). Decided on 2026-10-22; the fix is on a branch, not merged.

## Why

- **Two rules disagreed.** Processing profiles (`plaudTranscript: "use"`, the default in
  `src/lib/profiles/settings.ts`) let the pipeline accept Plaud's transcript as the item's
  transcript: the transcript step is marked done for that reason, Learn corrects it, topics read it.
  The summary and title generators kept an older rule: a "custom" summary needs a custom (own)
  transcript, with matching card copy ("Pro vytvoření vlastního shrnutí je potřeba vlastní přepis.")
  and a disabled Summarize button.
- **Every Plaud-only recording failed the same way** under the default profile; recordings people
  transcribed with their own provider were unaffected. Found from a failed summary on a real
  instance; the workaround was to re-transcribe with an own provider.

### Previous state

`generateSummaryForRecording` selected `transcriptions.source = "riffado"` in the private view and
fell back from own to edited to Plaud only in the Organization view. Title input and its language
lookup assumed an own transcript too.

## Options considered

### Option A: keep "a custom summary needs an own transcript" (declined)

- **Pros:** a summary always reads the user's chosen provider's text.
- **Cons:** contradicts the profile setting that makes Plaud's transcript the content; the pipeline
  then plans a summary it cannot make, and the user is told to pay for a second transcription.
- **Rejected because:** the content choice belongs to the profile and the pipeline; a generator that
  silently applies a different choice turns a supported configuration into a failure.

### Option B: one preferred-transcript order for every summary and title reader (chosen)

The order the Organization summary already used, applied to private summaries and titles on both the
automatic and the manual path, and to the summary card's availability.

## Decision

**Chosen: B** (proposed by the assistant with the diagnosis; the maintainer waited for "the fix" after
confirming the cause with data). A summary or title reads the transcript the pipeline treats as
content; the order is own, edited, Plaud.

## Key technical details

As built on the branch (not on `dev`):

- One reader supplies both summary views and the title readers, scoped to recording and owner; the
  client uses the same selection for the card's content, speaker labels and Summarize availability.
- The generated summary row keeps `source = "riffado"` (it marks a generated summary, not its input);
  its `transcriptionId`, content id, revision and fences name the transcript actually read. Learn
  corrections are applied to that row.
- **Staleness:** a summary made from Plaud's transcript stays current for that unchanged row; when an
  own transcript appears, the planner sees the new content and requests another summary.
- **Unchanged on purpose:** `plaudTranscript: "also_transcribe"` still waits for the own transcript;
  the own-transcript rewrite hook in `src/lib/learn/hold.ts` and transcription reads and writes stay
  own-only.
- Already failed items recover through the normal manual Summarize; no migration or bulk retry.

## Verification

Not merged. On the branch: a regression file with 14 database cases (automatic Plaud summary and
title, Learn staleness, later own transcript, manual recovery, source priority, `also_transcribe`
waiting), widget tests for Plaud-only and edited-only content; the changed-test run's failures were
fixture updates, rerun green.

## Consequences & open follow-ups

- Any new reader of "the transcript" for generation must use the same preferred order, or the class
  of failure returns.
- The card copy that described the old rule now describes the available transcript.

## Related work

- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md):
  the profile setting that makes Plaud's transcript the content.
- [2026-10-22-pipeline-steps-settle-their-jobs](2026-10-22-pipeline-steps-settle-their-jobs.md): how
  the failed steps surfaced and settle.

## Timeline

- **2026-10-22**: failed summary and title on a Plaud-only recording diagnosed and confirmed with
  data; fix built on a branch.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
