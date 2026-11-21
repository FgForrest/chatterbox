---
title: A speaker-less Plaud transcript does not replace automatic own transcription
date: 2026-11-21
updated: 2026-11-21 18:22
status: accepted
kind: fix
issues: [458]
prs: [459]
areas: [src/lib/pipeline, src/lib/learn, src/lib/plaud, src/lib/sync]
supersedes: [2026-10-19-processing-profiles-and-workflow, 2026-10-22-summary-reads-the-preferred-transcript]
superseded-by: []
relates: []
---

# A speaker-less Plaud transcript does not replace automatic own transcription

The `use` profile setting accepts Plaud's imported transcript by default. A fresh
recording can take the automatic transcription path when the timed Plaud transcript
has no speaker labels that Learn can offer for confirmation.

## Why

A live migrated Plaud account showed that recordings processed by Plaud 4.0 returned
v4 transcript segments without speaker fields. Pre-migration recordings read from
the same API still carried `speaker` and `original_speaker`. New recordings therefore
lost the labels people use to confirm who spoke and attribute action items.

### Previous state

With `use`, importing any Plaud transcript settled Transcribe and supplied the
content for later stages. This worked when the provider supplied speaker labels.
The first attempted revision required an exact completed input tuple to keep
speaker-less Plaud text. Routine cuts and concurrent sync imports can change the
row revision, and earlier workflows can have sparse phases. Those cases exposed
already processed recordings to paid transcription. A read-only share also
repeatedly queued jobs that the worker would skip.

## Options considered

### Keep using Plaud whenever it has a transcript

- **Pros** Existing recordings keep their text without another provider call.
- **Cons** A fresh Plaud 4.0 recording gives Learn no speakers to confirm.
- **Rejected because** The default automatic profile needs a route to labelled text when it can run one.

### Queue own transcription under the fresh-arrival conditions (chosen)

- **Pros** The existing provider and queue can produce labels for new recordings. Established recordings keep using their available text.
- **Cons** An eligible new recording incurs a provider job even though Plaud already supplied text. Labels depend on the selected provider.

### Rely on the profile switch alone

- **Pros** Owners can already choose `also_transcribe` when they prefer their provider for every recording.
- **Cons** It can add calls for labelled Plaud transcripts and takes an explicit configuration change.
- **Rejected because** The loss affects the default profile and is detectable per recording.

### Change the Plaud parser

- **Pros** Recovering labels upstream would avoid another transcription.
- **Cons** The verified Plaud 4.0 payload has no source labels to recover.
- **Rejected because** A parser cannot infer who spoke from the missing fields.

## Decision

Use the imported transcript unless the profile is `use` with automatic
transcription enabled, the item permits automation, the driver can run on
available audio, the current request has no terminal Transcribe phase, and
processing evidence supports a fresh arrival with timed turns that contain
no confirmable speaker labels. A Chatterbox transcript takes precedence.

## Key technical details

- `src/lib/pipeline/transcript-policy.ts` owns the selection. A current `done`, `failed`, or non-sharing `skipped` phase keeps Plaud regardless of the input tuple or failure trigger. **Process again** sets the minimum Transcribe generation for the request.
- A durable arrival marker is positive evidence of freshness. Its absence, a legacy marker, a settled downstream phase, a saved Chatterbox summary, stored topics, a finished Learn run, or saved Learn review items keep Plaud. A summary imported from Plaud with the transcript can come from the same sync.
- A `skipped/shared` phase leaves Transcribe eligible to run again. The owner's private driver and worker both treat an active, read-only Organization share as blocked. While blocked, the driver settles on available Plaud text. That `done/plaud-transcript` result stays terminal after withdrawal, and the owner can still re-transcribe manually. Without Plaud text, the skip allows automatic transcription after withdrawal. A retained Organization assignment in local mode allows the driver's next advance to queue transcription for an otherwise eligible item.
- The speaker check uses Learn's placeholder rule and decrypts timed turns only after the other conditions pass.
- The workflow keeps the stored transcript visible during a new attempt. The pipeline evaluates readiness separately. Sync uses valid v4 manifest language when the payload supplies none.

## Verification

`458-plaud-speakerless-transcript.test.ts` passed 18 cases and
`458-plaud-speakerless-transcript.integration.test.ts` passed 46 PostgreSQL
cases. Coverage includes five combinations of v4 arrival, filing and import
timing, manual Learn evidence, language handling, and error redaction.
The Organization cases run the transcription job handler and exercise
the local-mode transition and withdrawal after the skip-triggered advance.
The local-mode regression failed before the share-policy correction.
The transcript card regression passed with the initial change and failed on
the previous integration branch.

The focused pipeline, Learn, sync, and transcription run passed 1,472 tests
across 112 files, with one FFmpeg-dependent test skipped.

## Consequences & open follow-ups

Eligible fresh recordings can incur a Chatterbox transcription job at the
configured provider's rate. The delayed sweep can win the race with fallback
after a failure has waited 30 minutes. It requests at most five retries per
sweep, and an item qualifies only while it has fewer than three failed
automatic jobs in the last 24 hours. That allows up to two additional delayed
jobs while the initial failure remains in the window. Each job can have its own
queue attempts. Once the planner settles on Plaud, that phase leaves retry
eligibility. Both deployment modes use the existing records.

## Related work

- [Processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md) supplies the profile recipe and filing rules. This decision supersedes the unconditional selection of an available Plaud transcript under `use`.
- [Summary reads the preferred transcript](2026-10-22-summary-reads-the-preferred-transcript.md) tied automatic Summary and Title to the pipeline's choice. This decision supersedes when the pipeline accepts Plaud under `use`. Chatterbox's transcript retains priority.

## Timeline

- **2026-11-21** Verified the Plaud 4.0 and pre-migration payload shapes and implemented the guarded selection rule in PR #459.
