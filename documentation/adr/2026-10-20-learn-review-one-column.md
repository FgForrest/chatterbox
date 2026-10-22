---
title: The Learn review is one column of stacked sections, written in the reviewer's language
date: 2026-10-20
updated: 2026-10-22 17:05
status: accepted
kind: feature
issues: []
prs: [82, 172, 173, 175, 194, 199]
areas: [src/components/learn/learn-widget.tsx, src/components/learn/review-parts.tsx, src/lib/learn/review-language.ts, src/lib/learn/review-prose.ts, src/lib/knowledge/vocabulary-labels.ts, messages/cs-CZ.json]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn, 2026-10-22-recording-language-checked-by-learn]
---

# The Learn review is one column of stacked sections, written in the reviewer's language

The Learn review ("Review what Learn found") lists proposed speakers, new Almanac records,
corrections and facts for a person to tick. It is now one column: sections stacked with speakers
first, jump chips to each section, a pinned section title with tick-all and "n of m selected", and
every item as its own tinted block with its reason and quote underneath (PR #173). Its text follows
the reviewer: core vocabulary labels are shown in the interface language (PR #172), and Learn
writes the reasons under each proposal in the reviewer's language (PR #175), with a locale fallback
for people whose interface is on Auto (PR #194) and a check of the answer rather than only an
instruction (PR #199).

## Why

- The two-column card wasted space: with many new records and few facts the right column stood
  mostly empty, and each record wrapped its name, type and two actions over three lines (about five
  lines, 210 px, per record).
- At phone width (380 px) items were hard to tell apart; too many divider rules separated them.
- A Czech reviewer read English type names ("Term", "works for") and English reasons written by the
  model, while everything else was Czech.

### Previous state

PR #79 widened the review dialog and split it into two columns on large screens (new records and
speakers on the left, corrections and facts on the right). PR #82 then put speakers first at full
width, as chips styled like the transcript's speaker tags, with a play button that stops at the end
of that speaker's turn (the dialog hides the player) and a tri-state tick-all per section, where
unticking a new record leaves it undecided rather than rejected. Learn's prompts named no language
for reasons, and core vocabulary labels were fixed English strings.

## Options considered

### Option A: one column with local tabs (declined)

One tab per section with its count, the footer counting across tabs, speaker chips above the tabs.
It was the proposal's first pick.

- **Pros:** short card; each section on its own.
- **Cons:** at 380 px there is no room for more tabs; working through the items means scrolling back
  to the top to switch tabs; and since an unticked item is rejected at Finish, a tab never opened
  could reject facts the reviewer never saw (raised in the proposal as an open question).
- **Rejected because:** the maintainer's two reasons, the narrow width and the scroll back to the
  tabs.

### Option B: one column, sections stacked (chosen)

Every section visible in order, jump chips at the top once two or more sections show, a pinned
section title, one tinted block per item.

- **Pros:** nothing hidden; works at 380 px; one scroll direction.
- **Cons:** a longer card.

Two smaller choices followed. Records quoting the same text could share one quote as a group
heading, or each record could carry its own quote under its reason; the maintainer chose the quote
under each record, even when it repeats. The tinted block per item, first drawn for 380 px, applies
at every width, and groups are separated by space rather than rules.

### The reviewer's language

- **Whose language:** the owner's for a personal item; on the Organization view the Organization
  account's, else the person who started the run, else the owner, so a shared review has one
  language even when members differ; English when none is set.
- **Stored proposals:** translating or re-running past reviews was not done; the maintainer said to
  leave existing data as it is.
- **Asking versus checking:** PRs #175 and #194 put the language rule in every Learn prompt, and a
  Czech reviewer still read English reasons, because any valid JSON answer was accepted whatever
  language its prose was in. PR #199 checks the answer: reviewer prose detected confidently in the
  wrong language goes back to the same provider in one extra call per run, only when such fields
  exist, and only those fields are patched.

## Decision

**Chosen: B, and reasons in the reviewer's language, checked after the answer.** Tabs fail on a
phone and hide part of what Finish decides; stacked sections show everything in one pass. The
language rule alone was ignored three times, so the server verifies it.

## Key technical details

- **Layout:** `src/components/learn/learn-widget.tsx` and `review-parts.tsx`. Below a 560 px card
  (container query `@container/learn`) the name takes the full line and both record actions move
  into one "More options" menu. Section titles are pinned (`sticky top-0`) only inside the review
  dialog; in the inline card they stay static so they do not collide with the page header.
- **Vocabulary labels:** `useVocabularyLabels` in `src/lib/knowledge/vocabulary-labels.ts` shows core
  types and relations by their stable key through the message catalog; labels of custom vocabulary
  are shown as typed.
- **Language:** `learnReviewLanguageRule` and `resolveLearnReviewLocale` in
  `src/lib/learn/review-language.ts`. With the interface on Auto the stored locale is null, and a
  background run has no browser, so the chain continues: the default transcription language, then
  the content's language, then English. A manual run saves the starting browser's locale for that
  run.
- **Never translated:** names, quotes, correction replacements, relation phrases and fact values are
  source content and stay in the source language. Only speaker reasons and new-record reasons are
  reviewer prose today (`src/lib/learn/review-prose.ts`).
- **Every free-text field of Learn's output schema is classified** as reviewer prose, source content
  or identifier; the marker is stripped before the schema reaches a provider. A new field without a
  class fails `src/tests/learn/review-prose.test.ts`; a new Learn prompt builder without the language
  rule fails `src/tests/learn/review-language-guards.test.ts`.
- **A proposal is never dropped for its language.** A failed, malformed or still-wrong retry keeps the
  original text. The extra call is metered like the rest of the run.
- Server-composed reasons go through `src/lib/learn/review-message-catalog.ts` so the extractor keeps
  them in the catalog.

## Verification

- PR #173: `src/tests/learn/learn-review.test.tsx`, `src/tests/learn/review-parts.test.tsx`,
  `src/tests/mail/mail-learn-card.test.tsx` (speakers first, no grid, jump chips only with two or more
  sections, selected counts, reason before quote, the narrow menu); whole suite 5,351 passed, 98
  skipped.
- PR #175: `src/tests/learn/review-language.test.ts` (every prompt path for Czech and English) and
  `review-language.integration.test.ts` (owner, Organization account, actor and owner fallbacks);
  5,374 passed.
- PR #199: unit suite 4,814 passed, DB-backed suite 6,276 passed; the guards above.
- PR #82: browser check at 1,600 and 400 px; playback from a chip stopped at the end of the turn.

## Consequences & open follow-ups

- An automatic run for someone on Auto, with no default transcription language and no detectable
  content language, still writes English reasons; setting the language in the profile avoids it.
- Reviews stored before PR #175 keep their English reasons.
- Learn may make one extra provider call per run when its reasons come back in the wrong language.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): the review's two defaults and dependencies, which the
  layout keeps unchanged.
- [2026-10-22-recording-language-checked-by-learn](2026-10-22-recording-language-checked-by-learn.md): adds a language item to this review when detection disagrees.

## Timeline

- **2026-10-02**: PR #79 merged with the two-column dialog; PR #82 merged (speakers first, play one
  turn, tick-all).
- **2026-10-19**: layout proposals A and B, four rounds with the maintainer; PRs #172, #173 and #175
  merged and released.
- **2026-10-20**: PRs #194 (Auto locale) and #199 (the answer checked) merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
