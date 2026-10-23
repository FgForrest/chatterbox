---
title: Calendar invitees and Meet participants reach Learn only as speaker candidates, never as proof
date: 2026-10-12
updated: 2026-10-23 09:11
status: superseded
kind: feature
issues: []
prs: [105, 106, 107, 117]
areas: [src/lib/integrations/google, src/app/api/recordings/[id]/calendar-events/route.ts, src/lib/learn/run-fallback.ts, src/lib/learn/learn-job-handler.ts, src/components/learn/learn-widget.tsx]
supersedes: []
superseded-by: [2026-10-22-calendar-speaker-guesses-in-automatic-runs]
relates: [2026-09-14-speaker-identity-without-biometrics, 2026-09-30-learn, 2026-09-28-google-drive-export]
---

# Calendar invitees and Meet participants reach Learn only as speaker candidates, never as proof

The Google connection used for Drive export can additionally get read-only Calendar and Meet
consent. When the owner starts Learn on a private audio recording, Klepna looks up the owner's
primary-calendar events around the recording, takes the invitees' display names and, when Meet
access is granted, the participants of the one Meet session that overlaps the recording, and
passes those names to the Learn model as `speakerCandidates`. They are fetched for that run and
dropped; nothing is stored, no e-mail address is requested, and no schema changed. The model may
use the names as hints, but a speaker is named only from direct evidence in the transcript.
Attendance alone never assigns a speaker. Shipped as PRs #105 (all unnamed speakers assessed),
#106 and #107 (Calendar and Meet), recreated as PR #117.

**Superseded in part on 2026-10-22** by [2026-10-22-calendar-speaker-guesses-in-automatic-runs](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md) (PR #250): every Learn
run, automatic ones included, now gets the roster, and the model guesses speakers from it for the
user to confirm. Updated for issue #256 on 2026-10-23: the successor also supersedes the
no-email-request rule. Addresses may be matched transiently through the existing hashes in the run’s
scope, with ambiguity falling back to names. Read-only scopes and no stored roster addresses still
hold; Calendar and Meet never apply to mail items.

## Why

Learn's evaluation at merge (PR #69) named 14 of 14 speakers it proposed correctly and left all 35
deliberately hidden speakers unnamed, but it named only 14 of 70 speaker labels: meetings rarely
say names. Calendar and Meet were the planned way to raise that coverage without voice data: the
maintainer ruled on 2026-09-13 that speaker identity uses Google Calendar and Meet, never
voiceprints ([2026-09-14-speaker-identity-without-biometrics](2026-09-14-speaker-identity-without-biometrics.md)), and the Learn work deferred
Calendar and Meet to a follow-up on 2026-09-28. The constraint that made the design non-obvious is
the failure Learn is built to avoid: a wrong name in a summary or the minutes is worse than no
name, which is why Learn already refused to resolve a first name two known people share.

### Previous state

Learn named speakers from the transcript and the Almanac only. The 2026-09-13 speaker
knowledge-base plan, never built, designed something larger: a periodic Calendar sync storing
events with attendee lists and organizer e-mails, the attendee e-mail as the join key to people, a
background job matching recordings to events by overlap, Meet transcript entries adopted as named
turns when their language is English, and Calendar and Meet treated as facts rather than guesses
("closed-set assignment over a roster").

## Options considered

### Option A: the roster as evidence, synced and stored (the 2026-09-13 plan) (declined)

- **Pros:** exact matching to people by e-mail; works for every recording without the owner
  choosing anything; attendance can settle which of two people sharing a first name spoke.
- **Cons:** a periodic job and a table of third-party personal data (the plan itself flagged
  attendee names and addresses as such); assigning by attendance or elimination puts names on voices
  without anything in the transcript supporting it.
- **Rejected because:** Calendar guests are possible attendees, not proof of attendance or of
  speaker identity (PRs #106, #117), and naming from attendance would trade Learn's abstention for
  wrong names. Not storing events or e-mails kept the change free of schema and retention questions
  (inferred: the PRs state the outcome, not the reason).

### Option B: adopt Meet transcript entries as named turns (declined)

- **Pros:** Meet already knows who said what.
- **Cons:** Google's Meet transcription mangles Czech, so it is usually switched off where Czech is
  spoken; Meet's clock and the recording's differ by an unknown offset (the plan left alignment to a
  spike).
- **Rejected because:** the participant roster gives attendance without any transcription and with
  join and leave times, which the notes of 2026-09-13 called the durable win; transcript entries
  stayed "opportunistic only" and were not built.

### Option C: names as candidates for one run, evidence still required (chosen)

- **Pros:** read-only, opt-in scopes; nothing stored; no e-mails leave Google; the model can still
  complete a first name or fix a garbled spelling from the list.
- **Cons:** helps only indirectly; only runs the owner starts by hand get a roster.

## Decision

**Chosen: Option C.** Learn's speaker rule, shared by both model paths, says external candidates
"are possible attendees, not proof that a person spoke or that a label is theirs. Do not infer
identity from topic, attendance, or elimination." The same change (PR #105) made Learn assess every
unnamed label separately and look up people by the names used to address a speaker who then answers.
What would make Option A win: a review flow where a roster-based name is clearly marked as a guess
the user confirms. That is what [2026-10-22-calendar-speaker-guesses-in-automatic-runs](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md) built.

## Key technical details

- **Scopes:** `calendar.events.readonly` (`src/lib/integrations/google/config.ts`) and
  `meetings.space.readonly` (`meet-consent.ts`), added incrementally to the Drive connection. Without
  them everything below is skipped silently. Google integration is self-host only.
- **Event choice:** `src/app/api/recordings/[id]/calendar-events/route.ts` lists primary-calendar
  events overlapping the recording with 30 minutes of slack (`calendar-events.ts`); one event is used, several open a
  choice dialog (`src/components/learn/learn-widget.tsx`). The job re-fetches the chosen event
  server-side by id (`src/lib/learn/learn-job-handler.ts`); the client never supplies names.
- **Invitees:** `calendar-events.ts` requests only display name, response status, resource and self
  flags in its field mask, and skips the owner, rooms and declined guests. An invitee without a
  display name is left out.
- **Meet:** `meet-context.ts` and `meet-speaker-candidates.ts` resolve the event's single Meet link to
  exactly one conference record overlapping the recording (15 minutes of slack, recordings younger
  than 30 days), skip phone participants, and cap the list at 80 names; the Google user id is
  discarded.
- **Rule:** `SPEAKER_RULE` and `LearnSpeakerCandidate` in `src/lib/learn/run-fallback.ts`.
- **Automatic Learn passes no event** (`src/lib/learn/auto-learn.ts`), so automatic runs get no
  candidates. PR #250 reversed this.
- **Looks like a bug in the history:** #106 and #107 show as merged, but they merged into their stacked
  parent branches after #105 had reached `main`, so neither reached `main`; PR #117 carried both
  commits. Stacked PRs must be retargeted before the parent merges.

## Verification

Stacked suite for #105 to #107: 314 files and 2,623 tests passed, 795 tests skipped. Tests:
`src/tests/integrations/google/calendar-events.test.ts`, `calendar-events-route.test.ts`,
`calendar-consent.test.ts`, `src/tests/learn/calendar-choice.test.ts`, the
`src/tests/integrations/google-meet-*.test.ts` files (consent, code, context, handoff, settings,
candidates), and the candidate contract in `src/tests/learn/run-fallback.test.ts` and
`run-bridge.test.ts`. PR #117 was not re-run locally on its base; CI ran it. Live validation against a
real Google account was still pending at merge.

## Consequences & open follow-ups

Checked on 2026-10-22, the integration helped little in practice:

- automatic runs, the normal path, never get a roster;
- names reach the model as plain text, with no exact link to Almanac people;
- attendee names are not added to the transcription keyterms or the correction pass;
- the review never shows that a suggestion came from Calendar or Meet (the attribution source values
  exist, nothing writes them);
- only the owner's primary calendar, only the private view, Meet data only for 30 days.

[2026-10-22-calendar-speaker-guesses-in-automatic-runs](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md) (PR #250) addressed all but the e-mail link, which
is implemented in issue #256 under the successor’s scope, hashing and ambiguity rules (an early
reading that it had been ruled out was corrected by the maintainer on 2026-10-22).

## Related work

- [2026-09-14-speaker-identity-without-biometrics](2026-09-14-speaker-identity-without-biometrics.md): why identity comes from Calendar and Meet at all.
- [2026-09-30-learn](2026-09-30-learn/README.md): the Learn passes and evaluation these candidates feed.
- [2026-10-22-calendar-speaker-guesses-in-automatic-runs](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md): the successor rule that supersedes this one
  (roster on every run, guesses for the user to confirm, and transient e-mail matching in issue #256).
- [2026-09-28-google-drive-export](2026-09-28-google-drive-export.md): the per-user Google connection Calendar and Meet reuse.

## Timeline

- **2026-09-13**: no-biometrics ruling; Calendar and Meet chosen as the identity source.
- **2026-09-28**: Calendar and Meet deferred from the Learn work.
- **2026-10-09**: PRs #105, #106, #107 merged; only #105 reached `main`.
- **2026-10-12**: the gap found; PR #117 merged with both stranded commits.
- **2026-10-22**: gaps reviewed; a successor rule proposed.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
- **2026-10-22**: superseded in part by PR #250.
