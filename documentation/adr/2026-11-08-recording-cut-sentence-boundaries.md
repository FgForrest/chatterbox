---
title: Cut recordings at sentence starts, with typed times and paragraph-gap controls above the transcript
date: 2026-11-08
updated: 2026-11-08 19:20
status: accepted
kind: feature
issues: [327]
prs: [352]
areas: [src/lib/recordings, src/lib/knowledge/correction-recheck.ts, src/components/recordings/recording-cut.tsx, src/components/dashboard/transcript-view.tsx]
supersedes: [2026-11-03-destructive-recording-cut, 2026-11-08-shared-recordings-cut-in-place]
superseded-by: []
relates: [2026-11-08-stored-sentence-start-times, 2026-11-08-ai-trim-proposal-before-learn]
---

# Cut recordings at sentence starts, with typed times and paragraph-gap controls above the transcript

Owners select the retained range in a panel directly above the transcript card. Typed times snap to sentence starts. Gap controls offer the start of every visible paragraph, including a chapter starting inside a turn. Cutting retains individual sentences and splits a stored turn when necessary. The player keeps its waveform hatch preview and loses its scissors.

## Why

A chapter can begin halfway through a speaker turn. Whole-turn retention cannot express that boundary. Inline cut buttons also move text away from its sentence play gutter. The cut needs precise, shared millisecond edges without turning the transcript into a general audio editor.

### Previous state

The player and transcript both opened a floating cut bar, whose controls snapped the playhead to turn edges. Transcript actions were inserted inline only where turns opened or closed. A turn stayed when its midpoint lay in the range.

## Options considered

### Sentence starts with paragraph-gap actions (chosen)

Typed times can select any sentence start. Transcript actions stay limited to the existing reading paragraphs, so chapter starts and long monologues are usable without adding a control to every sentence.

### Keep whole-turn snapping (declined)

- **Pros:** no split-turn or correction-offset handling.
- **Rejected because:** a chapter start inside a turn cannot be selected. Revisit only if chapters and paragraphs become constrained to turn starts.

### Arbitrary mid-sentence cuts (declined)

- **Pros:** unrestricted audio editing.
- **Rejected because:** the maintainer explicitly limits this workflow to sentence starts and paragraph boundaries in the transcript. Revisit only with a new editing requirement and an explicit decision about partial sentences.

## Decision

Keep a sentence exactly when its start lies in `[startMs, endMs)`. A turn remains only if at least one sentence remains. Its raw text slice preserves internal whitespace. Retaining sentence zero keeps the clamped original turn start (`max(turn.startMs, range.startMs)`); removing a prefix moves the start to the first retained sentence. Its end is clamped to the range. Sentence times and the turn clock are shifted by the same start used to cut audio. There is no padding or pre-roll.

Retained turns are emitted in stable chronological order by their new `startMs`; equal starts keep original order. Correction anchors follow an original-index to output-index map. Whole-turn equality with the old midpoint rule holds for non-overlapping turns when both edges are turn starts. With overlapping diarized turns, sentence retention can differ from midpoint retention even at turn-start edges; that difference follows the sentence-retention decision.

`sentenceStarts` supplies both stored and interpolated times to the UI and server. Start candidates are zero and sentence starts; end candidates are sentence starts and the recording duration. Equal-distance snaps choose the earlier candidate. Invalid clocks or crossed edges restore the previous value with an inline hint.

Only the transcript-header scissors open the panel. Paragraph-gap controls occupy the existing gap without affecting text layout. An end action removes the paragraph it precedes. The confirmation dialog and share/cut coordination remain unchanged.

## Key technical details

- `src/lib/recordings/cut-range.ts`: `cutTurn` returns the retained raw character interval along with its rewritten turn. Legacy turns materialize retained sentence times whenever text splits or clamping changes the original start or end, so another cut cannot redistribute those times. A legacy turn with unchanged endpoints after rebasing keeps its original shape.
- `src/lib/knowledge/correction-recheck.ts`: subtract the raw slice's removed prefix from correction anchors; drop anchors outside or crossing the retained interval. The index map follows stable chronological sorting. Repeated words in removed text never relocate to retained occurrences.
- `loadCutInTx` and `commitRecordingCut` already use `cutTranscript` for every owner-scoped stored source: Plaud, provider/browser and mixed. Organization and received views read those same content rows. Fact evidence is deleted only when its words fall in removed text, as checked by its original interval and time-derived character spans against retained raw slices. Surviving evidence shifts its times and keeps the normal recheck status, including `wording_changed` and `speaker_changed`, comparing its stored quote with the previous turns without a second proportional extraction from shortened turns. Accepted-task quote validation reads the rewritten source turns.
- `paragraphsOf` remains the definition of transcript action locations. The waveform hatch stays a preview, not an edge-setting control. Typed edges within a paragraph label its boundary and dim the removed sentences without adding mid-paragraph actions.
- No schema, environment variable, provider-role or deployment change.

## Verification

The focused run passes with PostgreSQL and ffmpeg enabled. A browser check on the demo stack covered the panel, the gap controls at a paragraph inside a turn, typed snapping, and a real cut whose start split a turn.

- `327-recording-cut.test.ts`: stored and interpolated split turns, both edges in one turn, raw whitespace, whole-turn equality for non-overlapping turns, stable overlapping-turn order, repeated legacy cuts, the clamped sentence-zero start, candidate sets and clock validation.
- `327-recording-cut-ui.test.tsx`: paragraph-gap actions at a topic inside a turn, typed clocks, invalid input restoration, player scissors removal, previews, running and inline-error states, pointer-transparent gap rows, Enter focus retention, foreground time values and full-width invalid hints.
- `327-recording-cut.integration.test.ts`: both timing modes across all 3 stored sources, rebased clocks and correction anchors in both private and Organization scopes, overlapping-turn correction remapping, retained task/speaker data, surviving fact evidence and removed repeated-word spans.
- `sentence-times.test.ts`: retained sentence times rather than clamping removed sentence starts into the retained range.

## Consequences & open follow-ups

Legacy transcripts still use interpolated times, which can differ from the spoken word boundary. Both deployment modes retain the same owner authorization, encryption, job coordination and destructive recovery limits. A committed cut affects the owner and authorized readers; removed content requires an external original or older backup to recover. A failed preparation leaves the original intact. Application rollback requires no migration and cannot restore removed content. A cut of a real Plaud-synced recording remains a deployment check.

## Related work

- [Destructive recording cuts](2026-11-03-destructive-recording-cut.md) is superseded for midpoint retention and the player/inline cut controls. Destruction, accepted human decisions and the Plaud cut marker remain in force.
- [Shared recordings cut in place](2026-11-08-shared-recordings-cut-in-place.md) is superseded for cut-control placement. Selection-preserving inline errors, owner-only changes, shared placements and the share/cut race protections remain in force.
- [Stored sentence start times](2026-11-08-stored-sentence-start-times.md) supplies the common sentence clock and defers the turn split implemented here; all-or-nothing timing derivation remains unchanged.

- [AI trim proposals before Learn](2026-11-08-ai-trim-proposal-before-learn.md): reuses this contract for whole-transcript suggestions and an owner decision before automatic work.

## Timeline

- **2026-11-08**: maintainer chose sentence retention, typed-time snapping and paragraph-gap controls; implemented in PR #352.
