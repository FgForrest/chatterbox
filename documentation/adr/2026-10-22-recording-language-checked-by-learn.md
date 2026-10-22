---
title: Generated text follows the language the transcript is written in; Learn asks when the provider's language is wrong, and the answer is stored per recording
date: 2026-10-22
updated: 2026-10-22 21:45
status: accepted
kind: fix
issues: []
prs: [246, 251]
areas: [src/lib/ai/summary-presets.ts, src/lib/recordings/language.ts, src/lib/recordings/language-metadata.ts, src/lib/summary/generate-summary.ts, src/lib/summary/generate-mail-summary.ts, src/lib/ai/generate-title.ts, src/lib/learn/output.ts, src/lib/learn/review-language.ts, src/db/schema.ts, src/components/dashboard/transcription-panel.tsx, src/components/dashboard/recording-language.tsx]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn, 2026-10-20-learn-review-one-column]
---

# Generated text follows the language the transcript is written in; Learn asks when the provider's language is wrong, and the answer is stored per recording

A Czech recording, transcribed correctly, got a Hungarian summary: the transcription provider had
reported the language as Hungarian, and with the output language on "Auto" the summary step told the
model to write Hungarian. Two changes were decided on 2026-10-22 and merged the same day. The
hotfix, PR #246: under "Auto" the model writes in the language the transcript is predominantly
written in, and the provider's detected language never names the output language. The feature, PR
#251: Learn, which already reads the whole transcript, also says which language it is written in;
when that disagrees with the provider, the review asks the user, and the confirmed language is
stored once per recording in `recordings.confirmed_language` and drives later steps. The transcript
card shows and changes it, and the API, MCP, webhooks and exports carry it as `confirmed_language`.

## Why

- **Provider language detection is unreliable.** The case above came from a provider reporting the
  wrong language for clean Czech text; Whisper-style detection guesses from the first seconds.
- **The rule had been decided once and lost.** PR #55 (2026-09-23) made "Auto" mean "write in the
  language the transcription is mostly spoken in" and said why not `detectedLanguage`: some providers
  leave it empty and Whisper guesses it early, while the summarizing model reads the whole transcript.
  By 2026-10-22 generation resolved "Auto" through the detected language instead
  (`resolveAiOutputLanguage`, introduced in PR #104 to localize headings, then also used for the model
  directive). The reasoning lived only in a PR description.
- **The maintainer's idea:** "communicate the identified language from transcription model during
  phase learn to users with option to change it to different language". One wrong detection then
  gets fixed once, for every later step, instead of each step guessing again.

## Options considered

### Option A: the hotfix alone (declined as the whole answer)

Under "Auto", send the generic "predominantly spoken language" directive and persist no inferred
output language.

- **Pros:** small, catches every case, including recordings nobody reviews.
- **Cons:** the wrong language still shows on the transcript, still feeds title wording, topics,
  spelling context and re-transcription, and the user has nowhere to correct it.
- **Rejected because:** the assistant's own analysis judged the maintainer's idea better than the
  hotfix on its own; the hotfix stays as the safety net.

### Option B: hotfix plus a language finding in Learn and one confirmed language per recording (chosen)

- Learn's output gains the language the text is written in (with a confidence). Only when it
  disagrees with the provider does the review get a language item ("Jazyk přepisu: maďarština? Text
  je česky."), with the read language preselected, "keep", or another language; only then does the
  summary wait for the answer. Agreement shows nothing and stores nothing.
- The answer, or a change in the transcript card's language control, is stored in one approved
  additive, nullable column, one value for the recording in both views, surviving re-transcription.
- A change after a summary exists offers "Re-summarize" and "Re-transcribe in <language>"; nothing
  re-runs by itself.

## Decision

**Chosen: B, shipped as two PRs:** the hotfix first (#246), then the Learn item and the stored
language (#251) (maintainer, 2026-10-22: "yes do it like that", including the one additive column).
Output language resolution becomes: an explicit profile or user language, then the confirmed
recording language, then "Auto" (the generic directive).

## Key technical details

- **Hotfix (#246):** `explicitAiOutputLanguage` (in `src/lib/ai/summary-presets.ts`) keeps a valid
  explicit code and returns nothing for "Auto". New "Auto" summaries store `output_language` as null
  instead of the provider's guess. `resolveAiOutputLanguage` stays for localized prompt wording and
  export headings only. Since #251, mail summaries still use `explicitAiOutputLanguage`; audio
  summaries, titles and topics resolve through `recordingOutputLanguage`
  (`src/lib/recordings/language.ts`) in the order above.
- **Learn item (#251):** Learn's output has a separate `language` field (ISO 639-1 code and
  confidence; a malformed value becomes null without discarding the rest of the answer). The review
  gets a language item only when it disagrees with the normalized provider detection at confidence
  0.90 or more; like other findings it holds the summary until answered. Rejecting it writes nothing
  and it is not asked again. Audio only.
- **Storage:** one nullable column, `recordings.confirmed_language varchar(2)` (`src/db/schema.ts`),
  on the recording so it survives re-transcription and is shared by private and Organization views.
  The same migration (`0137_short_leopardon.sql`) widens the Learn review kind check constraint to
  admit `language`. The
  provider's detection is kept unchanged beside it.
- **Transcript card** (`src/components/dashboard/recording-language.tsx`): the footer shows the
  confirmed language, or the detected one marked as detected. The owner, or a curator for an
  Organization item, changes it or sets it back to Automatic through
  `PATCH /api/recordings/[id]/language` (same authorization as editing the transcript, under the
  recording lock). `src/lib/recordings/language-metadata.ts` keeps two offers apart: Re-summarize
  for a summary in another language, and Regenerate title for an automatic title in another
  language, because re-summarizing cannot fix a title once the automatic title step has settled. A
  title the user typed is never flagged. "Re-transcribe in <language>" pins the language for one
  manual forced run.
- **API, MCP, webhooks, export:** `confirmed_language` is a new field beside `language`, which keeps
  meaning the provider's detection everywhere, including the Markdown transcript sidecar's front
  matter (`src/lib/export/document-sidecars.ts`). JSON export and the archive manifest carry the
  column.
- The confirmed language also feeds the correction pass, spelling context, task context and the
  Learn review locale fallback. Mail keeps its current language handling.

## Verification

- **#246:** `src/tests/regressions/summary-language-auto.test.ts`, 20 tests (Czech text detected as
  Hungarian, explicit Czech, private and Organization audio and mail multi-pass, the merge
  extraction variant, legacy settings, nullable persistence, titles). Three older test files that
  asserted the forced language (`generate-title-profile.test.ts`, `markdown-directive.test.ts`,
  `mail-summary.integration.test.ts`) now expect the generic directive. Locally the changed-files
  run passed 195 files and 2,630 tests before the PR was rebased onto #243, and the summary, title
  and mail suites passed 24 files and 342 tests after it.
- **#251:** new `src/tests/learn/language.test.ts`,
  `src/tests/learn/confirmed-language.integration.test.ts`,
  `src/tests/dashboard/recording-language.test.tsx` and
  `src/tests/transcription/language-override.test.ts`, plus updated output, MCP, v1, export
  sidecar, transcript card, topics and title tests. They cover a mismatch holding the summary and
  the answer releasing it, agreement and low confidence adding nothing, rejection writing nothing,
  malformed language fields, mail untouched, resolution order in private and Organization views,
  footer permission and Automatic, offers only when they would change something, the override only
  on a manual forced run, the export round trip and the meaning of the API and MCP fields. Locally
  the whole suite passed, 672 files and 7,347 tests, before the review fixes; after them the
  related run passed 366 files and 4,390 tests, and the changed files 94 tests.
- **Review fixes (a104093e):** a title regenerated after the automatic title step settled clears
  its offer; title-only offers in private and Organization views, and a refused regeneration
  keeping the button; the Markdown sidecar with `language: "hun"` and `confirmed_language: "cs"`
  together; zero per-row language queries in the `search_transcripts` scan for a null and a
  confirmed language.

## Consequences & open follow-ups

- Existing summaries made in a wrong language are not rewritten; a user regenerates them.
- Upgrade: the app runs the migration on start (one nullable column, one widened check constraint,
  no backfill), with no env or compose change. Existing recordings keep automatic language
  behaviour until someone confirms a language.
- The migration was generated as 0135 and regenerated as 0137 after #247 merged its own 0135 and
  0136; the statements are unchanged.
- PR #250 (Calendar speaker guesses) also changes Learn's output schema, in nearby lines of the
  Learn handler, both model paths and the correction pass; the two keep separate fields, so
  whichever merges second only resolves neighbouring hunks.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): the full-transcript read the language check rides on.
- [2026-10-20-learn-review-one-column](2026-10-20-learn-review-one-column.md): the review where the
  language item appears, already written in the reviewer's language.

## Timeline

- **2026-09-23**: PR #55 defines "Auto" as the transcript's predominant language.
- **2026-10-08**: PR #104 adds `resolveAiOutputLanguage` for localized headings.
- **2026-10-22**: a Czech recording summarized in Hungarian; hotfix and the Learn language item
  decided.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
- **2026-10-22**: hotfix merged as PR #246.
- **2026-10-22**: merged as PR #251, after review fixes (separate Re-summarize and Regenerate title
  offers, a typed title never flagged, `language` kept as the provider's detection in the Markdown
  sidecar, no per-row language query in `search_transcripts`).
