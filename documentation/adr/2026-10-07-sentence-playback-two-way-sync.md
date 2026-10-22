---
title: Play a transcript sentence from a gutter control, and keep transcript and player on one position in both directions
date: 2026-10-07
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [75, 90, 204, 225]
areas: [src/components/dashboard/transcript-view.tsx, src/hooks/use-transcript-follow.ts, src/hooks/use-playback-engine.ts, src/components/playback]
supersedes: []
superseded-by: []
relates: [2026-10-05-timed-turns-topics-and-paragraphs, 2026-10-19-transcript-card-and-one-header]
---

# Play a transcript sentence from a gutter control, and keep transcript and player on one position in both directions

In a timed transcript, clicking a sentence plays the audio from it; a play marker in the left gutter
follows the sentence under the pointer, and each turn's speaker dot becomes its play button on hover
(PR #90). The transcript and the player are synchronized both ways: playback, a waveform click or a
keyboard skip tints the sentence being played and scrolls the transcript to it, and a scroll the
reader makes in the transcript seeks the audio to the sentence on the reading line, paused or
playing. Sentence times are estimated from character positions, so playback starts 300 ms early.
Later work moved every play control onto one engine (PR #204) and one button component (PR #225).

## Why

The maintainer asked to play a particular sentence, then added the rule that shaped the feature:
"When scrolling in transcript the audio widget should automatically adapt the position in the stream
(even if no sound is played). These two widgets should be synchronized."

The constraint: only turns carry times. No word timings are stored, so a sentence's start inside a
turn can only be estimated.

### Previous state

Turns showed a start time that seeked; right-clicking a speaker chip played that speaker's next turn
(PR #75). Nothing tied the player's position to what the reader saw, and nothing could start
playback at a sentence.

## Options considered

### Layout A: play gutter (chosen)

The speaker dot becomes a play button on hover; a play marker in the left gutter follows the hovered
or playing sentence. The text indent grows from 14 px to 24 px.

### Layout B: play icon beside each block's timestamp (declined)

Each block gets a start time with a quiet play icon; hovered sentences are underlined; the layout
stays as it was. This was close to the maintainer's own first idea.

- **Rejected because:** the maintainer picked A without stating a reason. A shows the play target
  on the line of the sentence that will play, where B's one icon per block sits at the block's first
  line only (inferred).

### Follow-along with auto-scroll (chosen)

The sentence being played is tinted (stronger while playing, softer while paused) and the transcript
box scrolls to keep it in view.

### Tint without auto-scroll, or click-to-play only (declined)

- **Rejected because:** without scrolling the playing sentence leaves the box during playback, and
  without a tint there is no feedback at all; the maintainer chose auto-scroll, then asked for full
  two-way sync.

### Two-way sync: the reader's scroll seeks the audio (chosen)

### One-way sync: the player drives the transcript only (declined)

The auto-scroll option as first offered would have stopped following once the reader scrolled.

- **Rejected because:** the maintainer explicitly wanted both widgets on one position, including
  scrolling while paused to move the audio.

## Decision

**Layout A, follow-along with auto-scroll, and two-way sync.** The maintainer's requirement was one
position shared by both widgets. A change to "scrolling never seeks" or "stop following after the
reader scrolls" reverses an explicit ruling and needs his confirmation and a new record.

## Key technical details

- **Looks like a bug, is intended:** reading ahead in the transcript while listening moves the audio
  to where you are reading. That is the scroll-seeks-while-playing ruling. Ask before changing it.
- `src/hooks/use-transcript-follow.ts`: a scroll counts as the reader's only right after a wheel,
  touch, scrollbar or paging-key input; it seeks once the scroll has settled, to the sentence on the
  reading line (a third of the way down the box, below the sticky chapter bar). Scrolls the page makes
  itself never seek, so following cannot feed back into seeking.
- `src/components/dashboard/transcript-view.tsx`: sentence times inside a turn are interpolated by
  character position; `SENTENCE_PREROLL_MS = 300` starts playback a little early so the first word is
  not cut. Clicks on corrections, Learn marks and text selections are left alone.
- **One transport** (PR #204): `src/hooks/use-playback-engine.ts` owns play, pause, `playFrom` with an
  optional end, seeks and the source (loaded once per recording). Every entry point goes through it:
  player buttons, keyboard, sentence and gutter play, transcript scrolling, speaker chips, Learn review
  chips and task evidence. UI state is read from the media element, an older or rejected `play()`
  cannot overwrite a newer one, a seek before metadata waits for it, and explicit seeks cancel a
  turn's stop-at-end. A second, private copy of play state is how the silent-audio bug happened.
- **One control and one availability rule** (PR #225): every "play from here" control is
  `PlayAtButton` / `usePlayAt` in `src/components/playback/`, owning its playback and pausing on a
  second click. `WorkstationDetailPane` provides a `PlaybackProvider` that is `null` when the audio was
  reaped, the item is mail, or nothing is open, so no play control renders without audio. Evidence in
  another recording is a link, not playback; the server sends only an `audioAvailable` boolean
  (`src/lib/recordings/audio-availability.ts`).

## Verification

- `src/tests/dashboard/transcript-sentence-playback.test.tsx` (PR #90); at merge 2359 tests passed,
  and a real-browser check on a seeded 3-minute recording confirmed click to play, a waveform seek
  scrolling the transcript, and a transcript scroll seeking the audio while playing and paused (one
  check moved a paused position from 0:48.9 to 1:22.2 without starting playback). Hover styles, dark
  mode and phone width were not checked.
- `src/tests/regressions/audio-playback-silent-after-speaker-play.test.tsx` (PR #204): 14 cases with
  the real player, transcript, Learn review and evidence controls against a fake media element; 9
  failed on the previous engine.
- `src/tests/dashboard/unified-playback.test.tsx`, `playback-availability.test.tsx` and
  `src/tests/tasks/audio-availability.integration.test.ts` (PR #225).

## Consequences & open follow-ups

- Exact sentence times need word timings stored at transcription time; the same deferral is recorded
  for lecture paragraphs.
- Audible output in a real Safari session was never verified for the engine rewrite.

## Related work

- [2026-10-05-timed-turns-topics-and-paragraphs](2026-10-05-timed-turns-topics-and-paragraphs.md): the
  timed turns, paragraph cuts and character-position interpolation this playback runs on.
- [2026-10-19-transcript-card-and-one-header](2026-10-19-transcript-card-and-one-header.md): replaced
  the right-click speaker chips with play-button chips and added the sticky chapter bar that the
  reading line sits below.

## Timeline

- **2026-10-01**: right-click a speaker chip to play their turns (PR #75).
- **2026-10-07**: layout A, auto-scroll and two-way sync chosen and built; PR #90 merged.
- **2026-10-20**: audio stayed silent after speaker and transcript plays; one playback engine
  (PR #204).
- **2026-10-22**: one play control and one availability rule (PR #225).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
