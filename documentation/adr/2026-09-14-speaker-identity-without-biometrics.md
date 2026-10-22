---
title: Speakers are identified from names and calendar rosters, never from voiceprints
date: 2026-09-14
updated: 2026-10-22 21:10
status: accepted
kind: feature
issues: []
prs: [25]
areas: [src/lib/knowledge/attribution.ts, src/lib/knowledge/people.ts, src/lib/transcription/speechmatics-transcribe.ts, src/lib/transcription/elevenlabs-transcribe.ts, src/lib/integrations/google]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn, 2026-10-12-calendar-meet-speaker-candidates, 2026-09-28-google-drive-export, 2026-10-22-calendar-speaker-guesses-in-automatic-runs]
---

# Speakers are identified from names and calendar rosters, never from voiceprints

Diarization gives anonymous labels (`speaker_0`, `speaker_1`). Chatterbox turns them into people
using non-biometric evidence only: a person naming a speaker, names said in the conversation (read
later by Learn), and the attendee roster of the matching Google Calendar event or Meet conference.
Voice samples, speaker embeddings, voice enrollment and provider voiceprint identifiers are
permanently out of scope. PR #25 shipped the first two phases of the speaker knowledge base under
this rule: timed turns from every diarizing provider, a `people` table, and manual attribution.

## Why

- The point of a speaker knowledge base is to name a person once and recognize them later. The
  obvious technical route is voice biometrics, and both supported diarizing providers offer it
  (Speechmatics `speaker_identifiers`, the ElevenLabs speaker library).
- Voiceprints used to match the same person across recordings are biometric data under GDPR
  Art. 9. Art. 9 has no legitimate-interest basis, only explicit consent, and meeting participants
  are not users of the app: there is no surface where they could consent. Every operator (the
  hosted service, and each self-hosting company as controller) would hold special-category data
  about third parties.
- The upstream hosted privacy policy states that no separate copy of recordings is kept. A derived
  voice sample would contradict it.
- The maintainer set this as a product red line, not a sequencing decision: build the knowledge
  graph from different information than biometrics.

### Previous state

Every diarizing provider already returned turn timings, but the app discarded them at four call
sites and stored only flat `Speaker N: text`. Nothing could attach an identity to a span of audio,
and there was no table of people.

## Options considered

### Option A: non-biometric evidence, closed-set assignment over a roster (chosen)

Identity comes from what people tell the app (naming a speaker), what is said in the recording
(introductions, addressing), and who attended (Calendar attendees, Meet participants). Attribution
picks from a short candidate list, "unknown" is always allowed, and machine output stays a
suggestion until a person confirms it.

- **Pros:** no special-category data, so no consent problem for non-users; a wrong name is one
  label to change, with no voice profile to poison; works with every diarizing provider.
- **Cons:** coverage depends on names being said or a calendar event existing. Learn's later
  evaluation named 14 of 70 speaker labels, because meetings rarely say names.

### Option B: voice biometrics (declined)

Provider voiceprint identifiers, speaker embeddings clustered across recordings, or explicit voice
enrollment.

- **Pros:** open-set recognition that does not depend on names being said; high coverage once a
  voice is known.
- **Cons:** Art. 9 data about non-users; a stored voice sample or embedding is a derived copy of
  recordings; a mislabeled voice profile mislabels every later recording.
- **Rejected because:** there is no lawful basis without the explicit consent of every recorded
  person, and meeting participants cannot give it. The maintainer ruled it permanently out, so
  there is no trigger to revisit; a proposal to reintroduce it needs a new record that supersedes
  this one.

## Decision

**Chosen: Option A.** It is the only option that needs no consent from people who never had an
account. For the Google side, the roster comes from Calendar attendees and from Meet
`conferenceRecords.participants`, which give real attendance (join and leave times) without any
transcription. Meet's own transcript entries are opportunistic only: Google's Meet transcription
mangles Czech, so entries are used only when their own `languageCode` fits, never because of a user
setting. Meetings are recorded either by Meet or by a recorder, never both, so no cross-source merge
was designed.

The roster deliberately avoids Google's restricted scopes. `drive.readonly` and even the narrow
`drive.meet.readonly` are restricted: an External OAuth client needs a paid annual CASA assessment
for them, while an Internal client in the organization's own Workspace needs no verification. What
shipped asks only for `calendar.events.readonly`, `meetings.space.readonly` and `drive.file` (the
Drive export's choice, see its record).

## Key technical details

- **Speechmatics runs plain `diarization: "speaker"`** (`src/lib/transcription/speechmatics-transcribe.ts`),
  ElevenLabs plain `diarize`. Adding `speaker_identifiers`, a voice library, or any acoustic,
  accent or speaking-style signal for identity violates this record.
- **Attributions are keyed on the transcript, not the recording** (`transcript_speakers`). A Plaud
  import and the user's own transcript may coexist on one recording, and their `speaker_0`s are
  different people from different diarizers.
- **Stored transcript text is never rewritten.** Names are applied by a projection at each read
  seam (`buildNameResolver` in `src/lib/knowledge/attribution.ts`). The v1 API keeps raw `text` and
  adds `turns` and `speakers[]`; the backup archive does not project, because it is a restore
  format.
- **Only confirmed attributions project.** A machine guess never reaches a summary, an export or the
  API.
- **Personal data of third parties is encrypted.** Person names, emails and notes go through the
  field encryption; the email also has an HMAC shadow column for lookups and uniqueness
  (`src/lib/knowledge/lookup-hash.ts`).
- The Calendar and Meet roster lives in `src/lib/integrations/google/` (`meet-speaker-candidates.ts`,
  `calendar-events.ts`, `meet-context.ts`); how it feeds Learn is the Calendar/Meet record's subject.

## Verification

- PR #25: 1363 tests passing at opening, type-check and Biome clean; two review passes fixed 16 bugs
  before merge (daily log).
- `src/tests/knowledge/name-resolver.test.ts` and `src/tests/knowledge/projection-gate.test.ts`
  cover the projection and the confirmed-only rule.
- `rg -i "speaker_identifiers|voiceprint" src` finds only the explanatory comment in
  `attribution.ts`.

## Consequences & open follow-ups

- **No automated guard.** No test fails if a provider adapter starts sending voiceprint parameters;
  the rule is enforced by review only.
- **Coverage is the cost.** Most speaker labels stay unnamed unless someone says a name or a
  calendar event matches. Learned nicknames and the Calendar/Meet roster are the levers.
- **The 2026-09-13 encryption split did not last.** PR #25 kept organization and project names
  plaintext so SQL could search them; Learn reversed that and encrypts every knowledge-base name
  (see its record).
- The plan's later phases were replaced: its context, shortlist and attribution phases by Learn,
  its Google connection by the Drive export and the Calendar/Meet work.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): restates the boundary (no voice samples,
  embeddings, provider identifiers, style or accent) and builds speaker suggestions on it.
- [2026-10-12-calendar-meet-speaker-candidates](2026-10-12-calendar-meet-speaker-candidates.md):
  implements the roster this record chose as the identity source.
- [2026-09-28-google-drive-export](2026-09-28-google-drive-export.md): the Google connection the
  roster's scopes are added to, and the `drive.file` plus Picker choice.
- [2026-10-22-calendar-speaker-guesses-in-automatic-runs](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md): calendar rosters as the identity source on every Learn run, with model guesses for the user to confirm (PR #250).

## Timeline

- **2026-09-13**: red line decided and the speaker knowledge base plan written; Phases 0 and 1
  built and reviewed.
- **2026-09-14**: PR #25 merged.
- **2026-09-28**: the Learn design adopts the rule unchanged as one of its boundaries.
- **2026-10-12**: Calendar and Meet rosters reach Learn as speaker candidates.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
