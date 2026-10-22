---
title: Topics exist only for timed transcripts and take their times from the transcript; lecture paragraphs are cut at display time
date: 2026-10-05
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: [202]
prs: [57, 58, 59, 86]
areas: [src/lib/topics, src/lib/transcription/turns.ts, src/lib/transcription/format.ts, src/components/dashboard/transcript-view.tsx, src/db/schema.ts]
supersedes: []
superseded-by: []
relates: [2026-10-07-sentence-playback-two-way-sync]
---

# Topics exist only for timed transcripts and take their times from the transcript; lecture paragraphs are cut at display time

A transcript can carry AI-detected topics (chapters): a title and a time range each. Clicking one
moves the audio to its start without playing and scrolls the transcript there (PR #58). Topics exist
only for transcripts with stored timed turns, and none at all otherwise; Whisper transcripts gained
timed turns first so they qualify (PR #57). The model never invents a time: it must answer with one
of the times it was given, and the server snaps to them. Topics belong to one exact transcript and
are cleared whenever it is written again. Long single-speaker turns (lectures) are cut into
paragraphs at display time so topic headings land inside the text (PR #86); stored turns stay
untouched.

## Why

The maintainer wanted chapters that jump to where a topic starts in both the text and the audio, run
automatically or on demand, on the AI enhancement provider, with an overridable default prompt. The
hard part was anchoring: a chapter is only useful if its start is a real point in the recording.

Constraints:

- **Only some transcripts have timings.** Plaud imports, ElevenLabs, Speechmatics and the diarize
  models store timed turns. Whisper returned timed segments that the parser threw away. Gemini, chat,
  browser and managed transcription have no timings at all.
- **Turns can be minutes long.** Plaud merges consecutive segments of one speaker, and a lecture is a
  single turn, so a turn's start time says nothing about a topic that begins in its middle.
- **A transcript is rewritten from several places** (own provider, Plaud sync, browser path,
  Organization copy), and any of them could leave stale topics behind.

### Previous state

Whisper `verbose_json` responses were reduced to flat text, so Whisper transcripts had no timings and
nothing to seek to. `TranscriptView` rendered one block per stored turn, and a heading could only sit
at a turn's start: on a lecture every topic heading stacked above one block of minutes of text, with
a speaker label that added nothing.

## Options considered

### Anchoring: time ranges on timed transcripts only (chosen)

A topic is `{title, fromMs, toMs}`; the time is the anchor. Click: seek to `fromMs` with no
autoplay, scroll to the turn containing it. Transcripts without timings get no topics, no button and
no automatic job.

- **Pros:** one anchor kind; every topic seeks; the "containing turn" lookup is trivial.
- **Cons:** Gemini, chat and browser transcripts get no chapters.

### Anchoring: numbered sentence units with text anchors, for every transcript (declined)

The first proposal: split turns into sentence units, store `{turn, charOffset, startMs}`, and give
untimed transcripts topics that scroll but show no time and do not seek.

- **Rejected because:** the maintainer narrowed it to timed transcripts with the time as the only
  anchor, which was simpler and kept every topic able to move the audio. Untimed transcripts would
  have had topics that cannot do the one thing a chapter is for.

### Times: the model picks from given times, the server snaps (chosen)

The prompt lists each turn with its start (`[03:42] Speaker 1: ...`); the model must answer with one
of those times. The server snaps each answer to the nearest given time, drops starts that do not parse
or lie past the end, and sets each `toMs` to the next topic's start.

### Times: ask the model for timestamps (declined)

- **Rejected because:** a model-made time need not exist in the transcript, and a start in a silent
  gap or inside the wrong turn breaks the jump. Snapping guarantees every `fromMs` is a real start.

### Long turns: extra time marks inside the prompt (chosen)

Turns over 60 s get extra marks at sentence starts, at least 15 s apart, placed by character
position. Without them a topic starting mid-monologue snaps back to the turn's start, and clicking it
plays the previous topic's tail first.

### Lecture paragraphs: cut at display time (chosen)

`paragraphsOf` cuts turns longer than 60 s at sentence ends about every 30 s and wherever a topic
starts, mapping each topic time back to the nearest sentence by character position.

- **Pros:** works for every transcript already stored; stored turns stay unchanged, so corrections,
  Learn marks and speaker playback keep their turn anchors.
- **Cons:** times inside a turn are interpolated and can be a few seconds off.

### Lecture paragraphs: split at transcription time with word timings (deferred)

Speechmatics and ElevenLabs return per-word timings; long single-speaker turns could be split into
real timed turns when the transcript is created.

- **Deferred because:** it helps only new or re-transcribed recordings and changes what is stored;
  the display cut fixed every existing transcript at once. Revisit when exact paragraph times matter
  more than the few seconds of interpolation error.

## Decision

Topics are time ranges on timed transcripts only, chosen by the model from times the server gave it
and snapped back to them, tied to one exact transcript. Whisper keeps its segments as paragraph turns
so it qualifies. Lecture paragraphs are a view over the stored turns. A future change that wants
topics on untimed transcripts, or wants topics to survive re-transcription, contradicts this record
and needs its own.

## Key technical details

- `src/lib/topics/`: `timeline.ts` (marks, clock, windows, `paragraphsOf`, containing-turn lookup),
  `anchor.ts` (reply parsing, snapping, joining windows), `generate-topics.ts`, `topics-job.ts`,
  `topic-presets.ts` (the third template kind next to summaries and titles).
- Storage: `transcriptions.topics`, jsonb, encrypted like `turns` (migration `0056`).
- **Invariant: every writer of a transcript writes `topics`.** Own-provider and browser writes set it
  to NULL; the Organization copy carries it because the text is identical.
  `src/tests/topics/transcript-writers.test.ts` scans the source for every insert or update of
  `transcriptions` that writes `text` or `turns` and fails if it does not also write `topics`.
- The topics write is conditional on the transcript's text ciphertext being unchanged, so a
  re-transcription during detection ends in a 409 instead of stale topics.
- The reply format and the "use only the given times" rule live in the system message, so an edited
  template cannot remove them.
- Long transcripts go in windows of 40k characters overlapping by 4k; each window decides only its own
  stretch.
- Whisper (`src/lib/transcription/turns.ts`, `paragraphsFromTimedSegments`): segments are grouped into
  speakerless paragraph turns, breaking on a pause of 1.5 s or more, at the next sentence end after
  30 s, and unconditionally after 60 s. The flat text is rendered from the same paragraphs, so text
  and turns agree. A `verbose_json` reply without segments keeps flat text only.
- Looks like a bug: a single speaker's name is hidden in the transcript, except while a Learn review
  proposes a name for that speaker, so the confirmation stays reachable.
- At merge, topics were shown but not generated on the Organization view (the transcript row there
  could be the owner's), and they were not part of exports or Markdown sidecars.

## Verification

- `src/tests/topics/timeline.test.ts` (marks, windows, lookups, `paragraphsOf`),
  `anchor.test.ts` (parsing, snapping, dropping, joining), `generate-topics.test.ts` (untimed
  transcript refused before any call, conflict, multi-window), `transcript-writers.test.ts`
  (confirmed to fail when a writer drops `topics`).
- `src/tests/dashboard/transcript-topics.test.tsx`, `transcript-lecture.test.tsx` (paragraphs, seek
  times, heading placement, corrections kept whole across a cut);
  `src/tests/regressions/transcript-view-paragraph-timestamps.test.tsx`;
  `src/tests/transcription/turns.test.ts` and `format.test.ts`.
- Browser check of PR #58 on a test stack with a stand-in provider: 4 topics stored encrypted; a jump
  to topic 3 left the audio paused at 2:09.97, scrolled and highlighted. Suites at merge: 1615 (PR
  #57), 1663 (PR #58), 2288 (PR #86) passed. PR #86 was not checked in a browser.

## Consequences & open follow-ups

- Issue #202 proposes summarizing long recordings chapter by chapter on top of the topics windows.
- Splitting long turns at transcription time with word timings remains the path to exact paragraph
  times.
- Re-transcribing a recording always drops its topics; getting them back is a new model call.

## Related work

- [2026-10-07-sentence-playback-two-way-sync](2026-10-07-sentence-playback-two-way-sync.md): builds
  sentence playback on the same timed turns and the same character-position interpolation, and keeps
  the chapter display in step with playback.

## Timeline

- **2026-09-23**: topics designed with the maintainer; Whisper timings merged (PR #57), topics merged
  (PR #58); follow-up merged (PR #59): job enqueue stops logging duplicate-key errors on dedupe, and
  the panel follows a topics job already running.
- **2026-10-05**: lecture paragraphs and topics inside long turns merged (PR #86).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
