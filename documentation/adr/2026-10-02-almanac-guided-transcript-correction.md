---
title: The Almanac corrects transcripts twice; ranked key terms go to the transcription provider, and an agent pass after Learn fixes what is left
date: 2026-10-02
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [80, 81, 83]
areas: [src/lib/transcription/almanac-terms.ts, src/lib/transcription/elevenlabs-transcribe.ts, src/lib/transcription/speechmatics-transcribe.ts, src/lib/learn/correction-pass.ts, src/lib/learn/correction-pass-job.ts, src/lib/learn/correction-pass-queue.ts, src/lib/profiles/settings.ts]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn, 2026-09-13-native-transcription-adapters, 2026-10-19-processing-profiles-and-workflow]
---

# The Almanac corrects transcripts twice; ranked key terms go to the transcription provider, and an agent pass after Learn fixes what is left

Transcription mishears the names a team uses every day. The Almanac now corrects that in two
places. Before transcription, up to 500 Almanac names are sent as key terms to ElevenLabs Scribe v2
and Speechmatics (PR #80), always, with no setting. After a Learn run finishes, a correction pass
has the Learn model read the whole transcript again with the Almanac and fix what was misheard,
including words that are not Almanac names; its fixes apply at once with an undo per spot, and the
pass has its own setting, on by default (PR #81, brought to `main` as PR #83).

## Why

- Learn proposes corrections only within its review budget and only for what its lookups connect
  to the Almanac; misheard words elsewhere stayed in the transcript, the summary and the exports.
- **The constraint:** on 2026-09-27 the maintainer ruled that the knowledge base is too wide to send
  in the initial transcription call, which is why name correction was designed as an agent pass
  with MCP tools in the first place. Key terms revisit that ruling only partly: a ranked, capped
  subset, not the knowledge base.
- Key terms alone cannot fix what the Almanac does not know yet, because transcription runs before
  Learn. A pass after Learn alone works for every provider but cannot improve the raw transcript.
  The two complement each other.

### Previous state

The ElevenLabs and Speechmatics adapters sent no vocabulary at all. Corrections existed only as
Learn review items a person ticked (`correct` and `link`, each pointing at a record).

## Options considered

### Key terms: where the switch lives

- **One user setting** (recommended in the proposal): one switch under transcription settings; a new
  column.
- **Per provider credential:** on for one provider, off for another; a new column.
- **Always on, no setting (chosen):** no schema change; every Scribe v2 and Speechmatics run gets the
  names. ElevenLabs charges key terms as a flat per-hour add-on independent of their number (0.05
  USD per hour on top of 0.22 USD per hour at the time), and past 100 terms a request bills at least
  20 seconds. Speechmatics lists no surcharge.
- **Rejected because (the settings):** the maintainer chose always on without a stated reason, and
  the cost answer given afterwards (a flat add-on, independent of the number of terms) left the
  choice unchanged. The proposal's two concerns, the surcharge and sending names of people who may
  not be in the recording, are therefore accepted costs, not oversights.

### Key terms: how many, and from where

- **200** (recommended), **1,000** (the ElevenLabs maximum and the Speechmatics recommendation),
  **100** (under the 20-second minimum billing), or **500 (chosen)**.
- **Scope:** both the private and the Organization Almanac, as the recording's Learn reads them; on
  the Organization view the Organization's only. The maintainer insisted on both parts.

### Correction pass: what it may fix

- **Almanac names and terms only** (recommended): fits the existing overlay, where every correction
  points at a record; no schema change.
- **Also general mishearings (chosen):** any word that looks misheard. Needs a correction kind
  without a target, and is riskier: a model rewriting what people said.
- **Rejected because (names only):** the maintainer wanted the pass to fix whatever transcription
  skewed, not only names.

### Correction pass: how fixes land and when it runs

- **Applied at once, undo per spot (chosen)** versus **another review** to tick: the Almanac records
  are already confirmed, so a second review would repeat Learn's.
- **After Finish, automatically (chosen)**, versus a button only, versus both. The maintainer added
  that the step needs its own user setting, default on.

## Decision

**Key terms always on, at most 500, from both Almanacs; the correction pass fixes general
mishearings too, applies them with undo per spot, and runs after every finished Learn run behind
its own setting, default on.** Key terms improve the raw transcript for names already known; the
pass fixes what is left, for every provider. It is also queued after a Learn run that found nothing
to review.

## Key technical details

- **Key terms** (`src/lib/transcription/almanac-terms.ts`, `MAX_ALMANAC_TERMS = 500`): order is the
  recorder (the person with the account's email), records named in the owner's transcripts in the
  last 90 days, those named earlier, records with heard-as forms, then the rest. Per record its name
  and nicknames; Speechmatics also gets heard-as forms in the recording's language as `sounds_like`.
  Terms over 49 characters or 5 words are dropped. Scribe v1 gets none.
- **If the Almanac cannot be read, transcription runs without terms.** Key terms must never fail a
  transcription.
- **Privacy cost:** every Scribe v2 and Speechmatics run sends up to 500 names of people and things
  to the provider, including people who are not in that recording.
- **The pass** is job `learn.correct`, queued in the transaction that finishes the Learn review
  (`src/lib/learn/review.ts`), tracked in `transcript_correction_passes` (migration 0087). The tool
  path sends the transcript, up to 500 Almanac records and the standing corrections, with Learn's MCP
  tools under the pass's own token (`cp1`, `src/lib/learn/run-token.ts`); the fallback reads
  30,000-character windows without tools (`src/lib/learn/correction-pass.ts`).
- **Placement is server-side:** whole words in the stated turn, unique or picked by a longer quote,
  at most six words each side, never over a standing correction, case- or punctuation-only changes
  dropped. A fix naming an Almanac thing spreads to every occurrence; a person's does not
  (namesakes).
- **Fixes have kind `fix`**, an optional target and a `pass_id`, and never teach heard-as forms, so a
  model's guess cannot become a later pre-tick. They are underlined in amber ("Corrected
  automatically. Heard as ..."). The public v1 transcript API may carry `kind: "fix"`.
- **The pass keeps the automatic-Learn hold** and releases it when it ends or fails for good, so
  title, summary and topics read the corrected transcript.
- **The setting moved:** `correctAfterLearn` started as a `user_settings` column and now lives in the
  processing profile (`steps.learn.correctAfterLearn` in `src/lib/profiles/settings.ts`).

## Verification

- PR #80: `src/tests/transcription/almanac-terms.test.ts` (cleaning, ranking),
  `almanac-terms.integration.test.ts` (ranking from real speaker rows across private and Organization
  scopes, rejected speakers ignored, other accounts excluded), `elevenlabs-routing.test.ts` and
  `speechmatics-routing.test.ts` (v2 sends, v1 skips, Almanac failure).
- PR #81: `src/tests/learn/correction-pass.test.ts` (placement, both paths, repair) and
  `src/tests/learn/correction-pass.integration.test.ts` (Finish queues the pass and keeps the hold,
  spread and plain fixes, setting off, transcript changed meanwhile, empty run, pass token, sharing);
  full suite 2,753 tests green.

## Consequences & open follow-ups

- **Never run live at merge.** Key terms were not sent to the real ElevenLabs or Speechmatics APIs,
  and the pass was not run against a real model or checked in a browser.
- **Merge-order trap:** PR #81 was stacked on PR #79 and merged into its base 26 seconds after PR #79
  merged into `main`, so it never reached `main`. PR #83 re-opened the same head against `main`; its
  CI was the first run with PR #80 and the pass together.
- A wrong general fix is visible only as an amber underline; nobody reviews it unless they look.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): the 2026-09-27 ruling on the knowledge base's width,
  the corrections overlay and the hold this pass extends.
- [2026-09-13-native-transcription-adapters](2026-09-13-native-transcription-adapters.md): the native
  ElevenLabs and Speechmatics adapters that now carry the key terms.
- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md): the correction-pass setting later moved into the processing profile.

## Timeline

- **2026-09-27**: the knowledge base ruled too wide for the transcription call; correction by an
  agent pass instead.
- **2026-10-02**: key terms and the correction pass decided and built; PR #80 merged, PR #81 merged
  into its stale base, PR #83 brought it to `main`.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
