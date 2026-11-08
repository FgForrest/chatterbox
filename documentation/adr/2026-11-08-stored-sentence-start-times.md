---
title: New transcripts store each sentence's start time, aligned with the sentence split, only when every sentence has its own timed unit
date: 2026-11-08
updated: 2026-11-08 14:12
status: accepted
kind: feature
issues: []
prs: [347]
areas: [src/lib/transcription/turns.ts, src/lib/transcription/sentences.ts, src/lib/topics/timeline.ts, src/lib/transcription/elevenlabs-transcribe.ts, src/lib/transcription/speechmatics-transcribe.ts, src/lib/transcription/format.ts, src/lib/recordings/cut-range.ts]
supersedes: []
superseded-by: []
relates: [2026-10-05-timed-turns-topics-and-paragraphs, 2026-10-07-sentence-playback-two-way-sync]
---

# New transcripts store each sentence's start time, aligned with the sentence split, only when every sentence has its own timed unit

A stored transcript turn can carry `sentenceStartsMs`: one absolute start time per sentence, index-aligned with
`sentencesOf(turn.text)`. It is derived when the transcript is created, from the finest timing the provider
returned (words, or segments), and stored only when every sentence of the turn gets its time from a unit that lies
inside that sentence. Sentence playback, time marks, lecture paragraphs and topic placement use it when present
and fall back to character interpolation otherwise.

## Why

Only turns carried times, so a sentence's start inside a turn was interpolated by character position and could be
seconds off. That was accepted for playback (300 ms pre-roll) and lecture paragraphs. A destructive cut at a
sentence or topic boundary inside a turn cannot accept it: a few seconds off deletes words the owner meant to keep.
The providers that diarize (ElevenLabs, Speechmatics) return a time for every word, which the merge into turns threw
away.

Constraints: the turns column is encrypted JSON and existing transcripts must keep working unchanged. Several
writers rewrite turns (the cut, Learn corrections), and a stored time that no longer matches its sentence is worse
than an interpolated one.

### Previous state

`TranscriptTurn` had `speaker`, `startMs`, `endMs` and `text`. `sentenceStarts` in `src/lib/topics/timeline.ts`
interpolated every sentence after the first. Both older records defer exact times to "word timings stored at
transcription time".

## Options considered

### Shape: one start time per sentence, index-aligned (chosen)

- **Pros:** small; survives every text edit that keeps the number of sentences (the usual Learn correction fixes a
  word, not a sentence break); readers check alignment with one length comparison.
- **Cons:** an edit that adds or removes a sentence loses that turn's times.

### Shape: store the provider's word array (declined)

- **Pros:** the most information; any later split could use it.
- **Cons:** many times larger encrypted payload per transcript; every writer of turns would have to keep word
  offsets in step with edited text.
- **Rejected because:** nothing needs more than sentence starts, and the payload cost lands on every read of every
  transcript. Revisit if a feature needs word-level positions (karaoke highlighting, word-level cuts).

### Shape: sentence start as a character offset plus time (declined)

- **Rejected because:** any correction shifts the offsets, so every writer would have to rewrite them, where
  index alignment only needs the sentence count to stay the same.

### Coverage: all sentences or none (chosen)

A sentence's time is the start of the first word inside the sentence, or a position interpolated inside the coarse
segment that contains its first character. A sentence without such a unit omits the field for the whole turn.

### Coverage: keep partial times and borrow the nearest earlier unit (declined)

- **Rejected because:** the cross review showed concrete wrong outputs. An untimed word made the next sentence take
  the previous sentence's word time. A word list missing one occurrence of a repeated word aligned the next word to
  the wrong place. Readers cannot tell a borrowed time from a real one, and interpolation is never worse than a
  wrong stored time.

### Scope: only turns that already exist (chosen)

### Scope: give turnless transcripts timed paragraphs (declined)

The browser Whisper path (with `return_timestamps`), undiarized ElevenLabs and Speechmatics jobs, and `verbose_json`
responses without segments store flat text and no turns. They could gain timed turns, which would make them
cuttable and give them sentence playback and timed topics.

- **Rejected because:** the maintainer judged the benefit too small. Diarized transcripts already have turns. The
  browser path would change Whisper's decoding in the local, privacy-critical path without a check in a real
  browser. The undiarized version as first built made one turn for the whole recording instead of pause-based
  paragraphs. Revisit if production shows a meaningful share of turnless transcripts, or a self-hoster asks for it.

### Splitting long turns into timed turns at transcription time (not chosen)

The option the topics record deferred. Sentence starts give paragraphs and topics exact times while stored turns,
and everything anchored to a turn index, stay as they are.

## Decision

**Index-aligned sentence starts, all or nothing per turn, only on turns that already exist.** This fixes the
precision a sentence-level cut needs, costs one small array per turn, and changes nothing for stored transcripts.
A feature that needs word positions, or that wants turnless transcripts timed, needs its own record.

## Key technical details

- Derivation: `withSentenceTiming`, `trimTimedText` and `timedWordsInText` in `src/lib/transcription/turns.ts`;
  `sentencesOf` and `validSentenceStarts` in `src/lib/transcription/sentences.ts`. Providers pass transient units
  through the segment-to-turn merge. Word arrays are never stored.
- Readers use the field only when its length equals `sentencesOf(turn.text).length`, clamped to the turn and kept
  non-decreasing. **Invariant:** without the field, `sentenceStarts`, `buildTimeMarks` and `paragraphsOf` return
  exactly what the previous code returned, including topic placement by character distance;
  `src/tests/topics/sentence-times-legacy.test.ts` guards it.
- Writers: `cutTranscript` shifts and clamps the field; `withTurnText` (Learn rendering) keeps it only when the
  sentence count is unchanged; `readTranscriptTurns` drops a malformed field instead of failing. A new writer that
  changes a turn's text must go through `withTurnText` or drop the field.
- The v1 API and MCP serializers pick turn fields explicitly and do not expose it. Backups carry it unchanged.
- No migration: the field is additive inside the encrypted `turns` JSON.

## Verification

- `src/tests/transcription/sentence-times.test.ts` and `sentence-times-review.test.ts`: provider derivation,
  the cut shift, omission when a sentence lacks its own unit, leading and embedded whitespace, repeated words with
  an incomplete word list, invalid bounds, and a linear word-to-segment assignment (10,000 segments, 20,000 words).
- `src/tests/topics/sentence-times-legacy.test.ts`: output without the field equals the previous code.
- Consumers: `src/tests/dashboard/transcript-sentence-playback.test.tsx`, `src/tests/transcription/read-turns.test.ts`,
  `src/tests/export/build-archive.test.ts` (backup round-trip).
- Before merge: 92 test files, 1,077 tests passed locally (transcription, topics, Learn, Plaud, export, cut); CI's
  full suite passed.

## Consequences & open follow-ups

- Existing transcripts keep interpolated times until they are transcribed again.
- The next cut UI can split a turn at a sentence and snap typed cut times to sentence starts using these times.
- A Learn correction that changes a turn's sentence count drops that turn's times; it falls back to
  interpolation.

## Related work

- [2026-10-05-timed-turns-topics-and-paragraphs](2026-10-05-timed-turns-topics-and-paragraphs.md): its lecture
  paragraphs and topic placement now use stored sentence times; its deferred split at transcription time stays
  unbuilt.
- [2026-10-07-sentence-playback-two-way-sync](2026-10-07-sentence-playback-two-way-sync.md): sentence playback
  starts at stored times where they exist; its deferred "exact sentence times" item is this record.

## Timeline

- **2026-11-08**: decided with the maintainer while planning sentence-level cuts; implemented, narrowed to turns
  that already exist after review.
