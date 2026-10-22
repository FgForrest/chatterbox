---
title: Generated text follows the language the transcript is written in; Learn asks when the provider's language is wrong, and the answer is stored per recording
date: 2026-10-22
updated: 2026-10-22 17:00
status: proposed
kind: fix
issues: []
prs: []
areas: [src/lib/ai/summary-presets.ts, src/lib/summary/generate-summary.ts, src/lib/summary/generate-mail-summary.ts, src/lib/ai/generate-title.ts, src/lib/learn/output.ts, src/lib/learn/review-language.ts, src/components/dashboard/transcription-panel.tsx]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn, 2026-10-19-learn-review-one-column]
---

# Generated text follows the language the transcript is written in; Learn asks when the provider's language is wrong, and the answer is stored per recording

A Czech recording, transcribed correctly, got a Hungarian summary: the transcription provider had
reported the language as Hungarian, and with the output language on "Auto" the summary step told the
model to write Hungarian. Two changes were decided on 2026-10-22. A hotfix: under "Auto" the model
writes in the language the transcript is predominantly written in, and the provider's detected
language never names the output language. A feature: Learn, which already reads the whole
transcript, also says which language it is written in; when that disagrees with the provider, the
review asks the user, and the confirmed language is stored once per recording and drives later
steps. Both are on branches, not merged.

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

**Chosen: B, shipped as two PRs:** the hotfix first, then the Learn item and the stored language
(maintainer, 2026-10-22: "yes do it like that", including the one additive column). Output language
resolution becomes: an explicit profile or user language, then the confirmed recording language, then
"Auto" (the generic directive).

## Key technical details

As designed on the branches (not on `dev`):

- Hotfix: `explicitAiOutputLanguage` (in `src/lib/ai/summary-presets.ts`) keeps a valid explicit code
  and returns nothing for "Auto"; audio summaries, mail summaries and titles use it for their
  directives. New "Auto" summaries store `output_language` as null instead of the provider's guess.
  `resolveAiOutputLanguage` stays for localized prompt wording and export headings only.
- The confirmed language also feeds the title, topics, the correction pass and spelling context, the
  Learn review locale fallback and export metadata, and travels in backup and restore. Mail keeps its
  current language handling.

## Verification

Not merged. Hotfix branch: a regression file with 20 tests (Czech text detected as Hungarian,
explicit Czech, private and Organization audio and mail, multi-pass merges, nullable persistence,
titles); three older tests that asserted the forced language were changed to the generic directive.

## Consequences & open follow-ups

- Existing summaries made in a wrong language are not rewritten; a user regenerates them.
- The feature changes `src/db/schema.ts`, so its PR needs the whole suite and an upgrade note
  (migration on start, no env change).
- Learn's output schema is also being changed by the Calendar speaker-guess work; the two branches
  keep separate fields to merge cleanly.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): the full-transcript read the language check rides on.
- [2026-10-19-learn-review-one-column](2026-10-19-learn-review-one-column.md): the review where the
  language item appears, already written in the reviewer's language.

## Timeline

- **2026-09-23**: PR #55 defines "Auto" as the transcript's predominant language.
- **2026-10-08**: PR #104 adds `resolveAiOutputLanguage` for localized headings.
- **2026-10-22**: a Czech recording summarized in Hungarian; hotfix and the Learn language item
  decided, both built on branches.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
