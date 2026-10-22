---
title: Every Learn run uses the Calendar and Meet roster to guess speakers for the user to confirm
date: 2026-10-22
updated: 2026-10-22 16:00
status: proposed
kind: feature
issues: []
prs: []
areas: [src/lib/integrations/google, src/lib/learn/auto-learn.ts, src/lib/learn/run-fallback.ts, src/lib/learn/run-bridge.ts, src/lib/learn/correction-pass.ts, src/lib/transcription/transcribe-recording.ts]
supersedes: []
superseded-by: []
relates: [2026-10-12-calendar-meet-speaker-candidates, 2026-09-14-speaker-identity-without-biometrics]
---

# Every Learn run uses the Calendar and Meet roster to guess speakers for the user to confirm

Proposed on 2026-10-22, in progress on a branch, not merged. Every Learn run, automatic ones
included, gets the meeting's roster from the recording owner's Google Calendar and Meet. The model
makes a best guess for every speaker it cannot name from the transcript, choosing among known
people and roster names; each guess is shown with a question mark and its source (invited, or was in
the call) and waits for the user to confirm it. Roster names also go to the transcription
provider's spelling hints and to the correction pass. Matching attendees to Almanac people by e-mail
was dropped.

This reverses two rules of `2026-10-12-calendar-meet-speaker-candidates` once it ships: that only
runs started by hand get a roster, and that the model may not infer identity from attendance or
elimination. Because it is not merged, that record stays in force and the two are linked as
related only; when this ships, it should supersede it.

## Why

Asked how Calendar and Meet actually help speaker naming, the maintainer learned that they barely
do: automatic Learn (the normal path) never passes an event, names reach the model as plain text,
the transcription never sees them, and the review never says where a suggestion came from. He had
noticed that Learn can already show a speaker attribution with a question mark, and asked for that
to be used: "model should try to guess ... assign speakers to known person to be on the meeting
(calendar) based on information we know there? All will be somehow attributed with question mark
and user will just confirm it." His other points: "automatic runs MUST use it", "we should pass it
to transcription spelling", "the review should show the source". Identity still comes from
invitations and attendance, never from voices (`2026-09-14-speaker-identity-without-biometrics`).

### Previous state

See `2026-10-12-calendar-meet-speaker-candidates`: a roster only on a manual run on the private view,
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

- **Automatic event choice:** the event that overlaps the recording most and covers at least half of
  it; an ambiguous match gives no roster. An explicit choice on a manual run wins, and "continue
  without calendar" stays.
- **Organization-view runs** use the recording owner's calendar too.
- **Guesses are never pre-ticked;** finishing a review never confirms a guess.
- **Guesses never reach** transcript text, summaries, exports or the API: only confirmed names do.

## Key technical details

As designed on the branch (not on `dev`):

- One roster resolver reads only the audio owner's Google connection; mail items, missing grants and
  Google failures give no roster. Calendar and Meet names are deduplicated ignoring case and
  diacritics, and Meet attendance counts more than an invitation. No attendee e-mail, event title or
  description leaves the resolver.
- A separate validator accepts a guess only for a known person or an exact roster name, at most one
  label per person per transcript; a roster name nobody knows becomes an unticked new-person
  proposal, created only after explicit confirmation. Guesses are stored as suggestions with their
  confidence capped below one half; re-learning replaces earlier unconfirmed guesses but keeps human
  answers and rejections.
- Evidence-backed proposals keep the old rule (self-introduction, a reply right after being
  addressed by name, a confirmed name); the "no inference from attendance or elimination" clause
  applies to them, not to guesses.
- Roster names join the transcription spelling hints after the recorder's name, within the existing
  500-term limit, and get their own spelling block in the correction pass, which may not use it to
  rename speaker labels.
- No schema, env or provider-format change; no biometric input of any kind.

## Verification

Not merged; nothing verified on `dev` yet. The branch adds a regression test that automatic Learn no
longer ignores the calendar.

## Consequences & open follow-ups

- When this merges, `2026-10-12-calendar-meet-speaker-candidates` becomes superseded; the link must
  change from `relates` to `supersedes`.
- The defaults above need the maintainer's confirmation.
- Coverage should be re-measured with the Learn evaluation after it ships; the last measured
  coverage was 14 of 70 speaker labels.

## Related work

- `2026-10-12-calendar-meet-speaker-candidates`: the rule this proposes to replace.
- [2026-09-14-speaker-identity-without-biometrics](2026-09-14-speaker-identity-without-biometrics.md): the non-biometric boundary these guesses stay inside.

## Timeline

- **2026-10-22**: Calendar and Meet gaps explained; the maintainer ruled automatic runs must use the
  roster, the model guesses for confirmation, names go to spelling, the review shows the source, and
  e-mail matching is out; implementation started on a branch.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
