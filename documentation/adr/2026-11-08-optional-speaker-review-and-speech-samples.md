---
title: Show every unanswered speaker without making optional naming hold processing
date: 2026-11-08
updated: 2026-11-08 21:05
status: accepted
kind: feature
issues: [354]
prs: []
areas: [src/lib/learn, src/lib/pipeline/presentation.ts, src/lib/transcript/speech-samples.ts, src/components/learn, src/components/dashboard/transcription-panel.tsx]
supersedes: [2026-09-30-learn]
superseded-by: []
relates: [2026-09-14-speaker-identity-without-biometrics]
---

# Show every unanswered speaker without making optional naming hold processing

Every unanswered transcript label gets a row in an audio Learn review, including Organization
reviews. Rows added by the application carry `unmentioned: true`. They are opportunities to name
someone, never findings that require review. Listening samples replay bounded parts of the existing
recording, selected in the browser from transcript timing and text; no derived audio is stored.
The maintainer approved these rules on 2026-11-08.

## Why

The Learn evaluation named only 14 of 70 labels. Leaving the others out of the review made them
hard to answer. Adding them as ordinary proposals would make a run that found nothing hold its
summary for up to 72 hours, and finishing would silently remember unnamed labels as rejections.
A short first turn is also a poor listening sample, while a name-evidence timestamp often plays
the person saying the name rather than the proposed speaker.

### Previous state

Only labels mentioned by Learn appeared. Unticked rows, including its nobody-known rows, became
dismissals on ordinary Finish. Review chips expanded the transcript above the review. Evidence
timestamps played without an end bound.

## Options considered

### Option A: require an answer for every displayed label (declined)

- **Pros:** a simple checkbox count; all labels are resolved before proceeding.
- **Cons:** brief replies and diarization mistakes become mandatory work.
- **Rejected because:** merely displaying an omitted label would introduce review holds and prevent
  the existing nothing-new path from releasing the summary. Revisit only with an explicit decision
  to make naming every label mandatory.

### Option B: optional coverage rows and bounded listening shortcuts (chosen)

- **Pros:** all labels are reachable while automatic processing keeps its current release rules;
  untouched labels can be offered on a later run.
- **Cons:** model proposals and application-added rows need different review semantics, and
  selection totals can be smaller than the displayed row count.

## Decision

**Chosen: Option B.** A no-name row cannot be ticked until a person or an explicit unknown is
chosen. Leaving it untouched on either Finish path applies nothing and stores no dismissal.
Those rows are excluded from selection totals and tick-all until answered. Model-written
nobody-known rows retain their effect on whether a review is required. Application-added rows
never create that requirement, even alongside repeated known facts.

Samples use only timing and text: merge consecutive same-label turns across gaps of at most
1.5 seconds, require 6 seconds and 12 words, and reject more than 20% union overlap with others.
Choose up to three by recording thirds, then fill; use the recording duration, ignoring turns that
start outside it and clamping their ends. Only an unknown or zero duration falls back to the largest
turn end. Rank by duration capped at 20 seconds, less
overlap, then earlier start. Play with 300 ms pre-roll for at most 12 seconds. Without a candidate,
use the three longest individual turns of at least one second. Evidence clips end with their
containing turn, capped at 15 seconds. A stretch that fits plays to its end. Longer samples stop
at the latest exact inner boundary between 6 and 12 seconds after the pre-rolled start, falling
back to 12 seconds when none exists. Exact boundaries are merged turn ends and valid stored
sentence starts after the first; character interpolation never supplies a cut point.

## Key technical details

- `validate.ts` appends coverage rows after proposals and guesses, once per unanswered audio label;
  mail framing explicitly disables them. Their payload uses the existing encrypted review storage.
- `review-policy.ts` defines optional rows. When nothing needs review, the handler drops coverage
  rows before insertion: an empty run finishes and queues correction in the same transaction;
  repeated known facts follow their existing automatic application path. The handler returns a
  released outcome; pipeline facts therefore see a finished run. The 72-hour hold, pending badges
  and sweeper need no new exception to their run-status checks.
- Findings counts include model-written nobody-known rows and exclude known facts and coverage
  rows. Selection totals also exclude any no-name row without a choice. Finished presentation
  omits deferred optional speakers while preserving applied choices.
- Job statistics and pipeline presentation counts exclude application-added rows. Ordinary Finish
  excludes unanswered no-name rows and all application-added rows from dismissals, recording
  `not_now`; quick finish also omits them from skipped-item notices. Existing correction-pass
  holds still apply.
- `speech-samples.ts` owns the exported selection constants, statistics, ordering and evidence
  bounds. Stretches retain sorted, deduplicated inner boundaries and sentence indexes; a boundary
  cut quotes only played turns and sentences from `sentencesOf`. Sentence timing must align with
  the text and lie inside the original turn before recording bounds are applied. A stretch whose
  merged turns of one label overlap in time keeps no boundaries (12-second cut), because its
  sentences have no single order to quote by. The dashboard's
  `readTranscriptTurns` path carries sentence times through `TranscriptionPanel`, `LearnReview`
  and `LearnWidget`; the existing sample quote UI needs no change. Evidence clips are unchanged.
  Speaker turns are grouped once for statistics; samples are cached per label and computed
  only for visible review rows. Processing reads count non-speaker findings in SQL and decrypt only
  speaker payloads. No provider, storage adapter, schema or environment variable changes are needed.
- Inline and dialog reviews share `LearnWidget`, `ReviewSpeaker` and `SpeakerClips`. The review
  chip still advances through turns in order. Playback never expands the transcript or scrolls
  the window; existing follow-along scrolls only its own box.

## Verification

- `speech-samples.test.ts`: 40 cases for merging, boundary values, union overlap, thirds, fill,
  ranking, playback bounds, fallback, statistics, numeric label ordering and evidence quotes.
  Sentence-end cases cover the latest stored boundary, merged turn ends, inclusive 6/12-second
  bounds with pre-roll, too-early boundaries, invalid timing lengths and bounds, legacy transcripts,
  matching played quotes, ordered indexes, overlapping turns of one label, recording bounds and long
  fallback turns.
- `every-speaker.test.ts` and `every-speaker.integration.test.ts`: 19 cases for unique rows,
  answered/mail guards, both Finish paths, optional-only automatic completion, known facts,
  summary release, pipeline counts and explicit unknown answers against disposable PostgreSQL.
- `every-speaker-review.test.tsx` runs the same six behavior checks across inline and dialog
  variants. `speaker-playback.test.tsx` checks collapsed and expanded transcript playback.
- Browser checks at 1280 and 390 pixels: 12 of 12 chip, sample and evidence playback checks
  preserve window scroll position, review position and transcript expansion state.
- Private evaluation aggregates: 12 recordings, 51 labels, 100% with a full sample, 92.16% with
  three, 0% fallback and 0% without samples. Longest-stretch median 59.68 s, p10 19.84 s.
  At 5/6/8 seconds, three-sample coverage is 94.12/92.16/86.27%; 10/12/15 words changes none of
  these shares. Measurement chooses the latest Riffado transcript per recording and deduplicates
  identical exports; these are availability measures, not listening-quality judgments.
- Sentence-end before/after measurement: the same 12 recordings and 51 labels yield 146 selected
  samples in both versions. Cuts at 12 seconds mid-stretch remain 91.78%, exact-boundary ends
  remain 8.22%, and median played length remains 12 s. These transcripts predate stored sentence
  starts, so the comparison measures turn-end cutting only. None of the selected samples has an
  exact inner boundary in its 6-to-12-second window; this corpus therefore shows no improvement.
  Expected effect on new transcripts, estimated by giving the same turns character-interpolated
  sentence starts in place of stored ones (real sentence lengths, approximate positions): 63.01%
  of samples end at a sentence boundary, 36.99% are still cut at 12 seconds, and the median played
  length is 10.75 s (p10 7.04 s, p90 12 s).

## Consequences & open follow-ups

Naming remains optional and human-confirmed. Short speakers remain ordinary rows. Existing waiting
reviews can calculate listening samples without a new Learn run; newly appended coverage rows
arrive on the next run. Timing inaccuracies, overlapping speakers and a label mixing several
voices can still make samples misleading. Samples now use exact sentence ends from
[stored sentence start times](2026-11-08-stored-sentence-start-times.md) and merged turn ends,
within the approved playback window. Older transcripts gain only turn-end cutting; without an
eligible boundary the 12-second cap can still stop mid-sentence. There is no acoustic analysis.

Self-host receives the optional-row behavior without a deployment change. Hosted retains its
existing Learn availability restriction; the shared playback code keeps the same transport API.
A regression affects a review or its item's summary timing, recoverable by re-opening the item,
running Learn again or rolling back the application. Neither mode requires data conversion.

## Related work

- [Learn](2026-09-30-learn/README.md): superseded only for the rule that every unticked row is
  remembered as dismissed. Untouched no-name rows are now deferred. Other confirmation, encryption,
  scope and hold rules remain in force.
- [Speaker identity without biometrics](2026-09-14-speaker-identity-without-biometrics.md): listening
  shortcuts replay the existing recording without stored voice samples, profiles or identity inference.

## Timeline

- **2026-11-08**: maintainer approved optional naming, timing-and-text sample selection and stable
  viewport behavior; implemented the same day.
