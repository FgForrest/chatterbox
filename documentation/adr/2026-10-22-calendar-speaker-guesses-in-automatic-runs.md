---
title: Every Learn run uses the Calendar and Meet roster to guess speakers for the user to confirm
date: 2026-10-22
updated: 2026-10-22 21:40
status: accepted
kind: feature
issues: []
prs: [250]
areas: [src/lib/integrations/google, src/lib/learn/auto-learn.ts, src/lib/learn/learn-job.ts, src/lib/learn/validate-speaker-guesses.ts, src/lib/learn/run-fallback.ts, src/lib/learn/run-bridge.ts, src/lib/learn/correction-pass.ts, src/lib/transcription/transcribe-recording.ts]
supersedes: [2026-10-12-calendar-meet-speaker-candidates]
superseded-by: []
relates: [2026-09-14-speaker-identity-without-biometrics]
---

# Every Learn run uses the Calendar and Meet roster to guess speakers for the user to confirm

Merged as PR #250 on 2026-10-22. Every Learn run, automatic ones included, gets the meeting's
roster from the recording owner's Google Calendar and Meet. The model makes a best guess for every
speaker it cannot name from the transcript, choosing among known people and roster names; each
guess is shown with a question mark and its source (invited, or was in the call) and waits for the
user to confirm it. Roster names also go to the transcription provider's spelling hints and to the
correction pass. Matching attendees to Almanac people by e-mail was dropped.

This supersedes [2026-10-12-calendar-meet-speaker-candidates](2026-10-12-calendar-meet-speaker-candidates.md) and reverses two of its rules: that only
runs started by hand get a roster, and that the model may not infer identity from attendance or
elimination. Its read-only scopes, its event lookup and its Meet resolution are reused, no attendee
e-mail is requested, and evidence-backed proposals still need direct transcript evidence.

## Why

Asked how Calendar and Meet actually help speaker naming, the maintainer learned that they barely
do: automatic Learn (the normal path) never passes an event, names reach the model as plain text,
the transcription never sees them, and the review never says where a suggestion came from. He had
noticed that Learn can already show a speaker attribution with a question mark, and asked for that
to be used: "model should try to guess ... assign speakers to known person to be on the meeting
(calendar) based on information we know there? All will be somehow attributed with question mark
and user will just confirm it." His other points: "automatic runs MUST use it", "we should pass it
to transcription spelling", "the review should show the source". Identity still comes from
invitations and attendance, never from voices ([2026-09-14-speaker-identity-without-biometrics](2026-09-14-speaker-identity-without-biometrics.md)).

### Previous state

See [2026-10-12-calendar-meet-speaker-candidates](2026-10-12-calendar-meet-speaker-candidates.md): a roster only on a manual run on the private view,
candidate names as hints, a speaker named only from direct transcript evidence, no e-mails requested.

## Options considered

### Option A: keep the evidence-only, manual-only rule (declined)

- **Pros:** no name without direct transcript evidence; the safest against a wrong name in minutes.
- **Cons:** most recordings get no Calendar or Meet context at all; coverage stays where Learn's
  evaluation left it (14 of 70 speaker labels named).
- **Rejected because:** the maintainer wants the roster on every run and accepts guesses, as long as
  the user confirms each one.

### Option B: match attendees to Almanac people by e-mail (declined)

Requesting attendee e-mails would link them exactly to Almanac people by primary e-mail, as tasks
already do, and settle "two known people share this first name".

- **Rejected because:** the maintainer judged the information "not usable for e-mails"; no further
  reason was recorded. Likely: outside participants rarely have an e-mail in the Almanac, the same
  observation that dropped a "person without e-mail" problem type from curator tooling that day
  (inferred).

### Option C: roster on every run, model guesses for confirmation, names to spelling, source shown (chosen)

- **Pros:** every recording with a matching event gets help; confirming a guess is one click; correct
  spelling from the start.
- **Cons:** guesses will sometimes be wrong; the review has to make a guess unmistakable from an
  evidence-backed proposal.

## Decision

**Chosen: Option C** (maintainer, 2026-10-22). Defaults set in the implementation brief and not
confirmed by him (to be told if he asks):

- **Automatic event choice:** among events with at least one attendee that overlap at least half of
  the recording or half of the event, the one that overlaps the recording most; an ambiguous match
  gives no roster. An explicit choice on the owner's manual run wins, and "continue without
  calendar" stays.
- **Organization-view runs** use the recording owner's calendar too.
- **Guesses are never pre-ticked;** finishing a review never confirms a guess.
- **Guesses never reach** transcript text, summaries, exports or the API: only confirmed names do.

## Key technical details

- `resolveMeetingRoster` (`src/lib/integrations/google/meeting-roster.ts`) reads only the audio
  owner's Google connection; mail items, missing grants and Google failures give no roster, and a
  Meet error keeps the Calendar invitees. Calendar and Meet names are deduplicated ignoring case
  and diacritics, and Meet attendance counts more than an invitation. No attendee e-mail, event
  title or description leaves the resolver. Event matching filters to eligible events before
  ranking, so an out-of-window event with a larger overlap can neither hide nor veto a clean match.
  The chosen event id is stored in the run inputs and reused by the correction pass.
- **Only the owner picks an event.** `startLearnRun` (`src/lib/learn/learn-job.ts`) rejects an
  explicit `calendarEventId` unless the run is manual, private and started by the owner; without
  that guard an Organization curator could pick which of the owner's calendar events supplied the
  attendee names in the shared review. The handler and the correction pass also ignore a payload or
  stored event id from a non-owner run unless the handler itself marked it as automatically
  selected (`calendarEventAutoSelected`, server-written).
- A separate validator (`src/lib/learn/validate-speaker-guesses.ts`) accepts a guess only for a
  known person or an exact roster name, at most one label per person per transcript. A roster name
  nobody knows becomes an unticked new-person proposal, created only after explicit confirmation;
  these proposals count against the same 20-record budget (`MAX_NEW_RECORDS`) as evidence-backed
  ones and are dropped with reason `budget` beyond it. Guesses are stored as suggestions with
  confidence capped at 0.49, in the speaker row and in the review payload alike; re-learning
  replaces earlier unconfirmed guesses but keeps human answers, rejections and carried suggestions,
  and a label/person pair rejected with "Not this person" is dropped from later guesses and
  proposals.
- **A carried speaker is not a guess.** A `heuristic` speaker row re-attaches a name the user
  already confirmed on an earlier transcript and has no confidence; it shows without a question
  mark, titled as carried from the previous transcript (`src/components/people/speaker-tags.tsx`).
  Only a stored confidence below 0.5 makes a guess.
- Evidence-backed proposals keep the old rule (self-introduction, a reply right after being
  addressed by name, a confirmed name); the "no inference from attendance or elimination" clause
  applies to them, not to guesses.
- Roster names join the transcription spelling hints after the recorder's name, within the existing
  500-term limit (the Almanac spelling wins on a diacritics-insensitive collision), and get their
  own spelling block in the correction pass, declared as untrusted data, which may not use it to
  rename speaker labels.
- The prompt is bounded to 100 people and 150 literal facts; Organization-view runs see only
  Organization knowledge.
- No schema, env or provider-format change; no biometric input of any kind.

## Verification

The PR states 44 cases in three new test files: `src/tests/learn/meeting-speaker-contract.test.ts`,
`src/tests/learn/meeting-speaker-source.test.tsx` and
`src/tests/regressions/automatic-learn-ignored-calendar.integration.test.ts`. They cover prompt
bounds with 300 people and 1,500 facts, Organization-only context, diacritics and alias collisions,
rejections across re-learn, carried suggestions, a Meet failure with working Calendar, event
ranking, Google request counts and provenance on confirmation. At the first push the whole suite
passed locally, 670 files and 7,331 tests, with biome, tsc and the message extractor clean.

Review fixes added tests for: a curator's explicit event rejected by the route, forged payload and
stored event ids ignored in Organization runs, and the owner's manual choice and empty opt-out still
working; an ineligible event with a larger overlap no longer masking an eligible one; the confidence
cap for 0, 0.2, 0.49, 0.7 and 1 (all fc604cc9); carried rows with null or missing confidence not
shown as guesses, and 22 roster names against 0, 18 and 20 evidence-backed records always yielding
exactly 20 new-person proposals with no dangling speaker reference (d16f0ec8); a rejected guess
leaving the speaker strip when the review finishes while a confirmed, edited or replaced row stays,
and Calendar and Meet names reaching the Scribe v2 `keyterms` and Speechmatics `additional_vocab`
requests once with the Almanac spelling (aeaf950c). Google and model calls are stubbed; no live
Google smoke test was run.

## Consequences & open follow-ups

- The defaults above need the maintainer's confirmation.
- Coverage should be re-measured with the Learn evaluation; the last measured coverage was 14 of 70
  speaker labels.
- The roster has not been checked against a real Google account.

## Related work

- [2026-10-12-calendar-meet-speaker-candidates](2026-10-12-calendar-meet-speaker-candidates.md): the rule this supersedes; its scopes, event lookup and
  Meet resolution are reused.
- [2026-09-14-speaker-identity-without-biometrics](2026-09-14-speaker-identity-without-biometrics.md): the non-biometric boundary these guesses stay inside.

## Timeline

- **2026-10-22**: Calendar and Meet gaps explained; the maintainer ruled automatic runs must use the
  roster, the model guesses for confirmation, names go to spelling, the review shows the source, and
  e-mail matching is out; implementation started.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
- **2026-10-22**: merged as PR #250, after review fixes (only the owner picks a calendar event,
  eligible events ranked first, the 0.49 cap in the review payload, carried speakers kept out of
  guesses, roster proposals inside the 20-record budget, a rejected guess cleared from the speaker
strip when the review finishes).
