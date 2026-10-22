---
title: One body per widget across its variants, tested by one suite per variant set; an erase never undoes Almanac data a person confirmed
date: 2026-10-19
updated: 2026-10-22 16:00
status: accepted
kind: refactor
issues: []
prs: [164, 165, 166, 167, 168]
areas: [src/components/pipeline/workflow-widget.tsx, src/components/summary/summary-widget.tsx, src/components/learn/learn-widget.tsx, src/components/items/item-header.tsx, src/lib/recordings/erase.ts, src/lib/sharing/change-permission.ts]
supersedes: []
superseded-by: []
relates: [2026-10-18-inbound-mail, 2026-10-22-owner-edits-shared-recording]
---

# One body per widget across its variants, tested by one suite per variant set; an erase never undoes Almanac data a person confirmed

A widget that appears in more than one variant (inline card and dialog, recording pane and mail
pane, personal and Organization list) has one body component holding all its state, fetching and
apply logic; the variants only frame it. Its behaviour tests run once per variant from one suite
(`describe.each`). The recording and mail detail were brought onto this rule: one item header, one
erase menu, one Summary widget, one Learn widget, and the Transcription card on the same shell (PRs
#164 to #168). Along the way the maintainer ruled that "Erase Learn results" removes Learn's run
history but keeps everything a person accepted into the Almanac, and generalized it: no erase or
cleanup undoes Almanac data a human confirmed.

## Why

The maintainer set the rule during the workflow UI rework, when widgets got inline and dialog
variants: "I'd like to avoid duplicate widget implementation, and I think most of the code could and
should be shared and tested together." Mail detail then showed why. A side-by-side audit of the
recording and mail detail found mail behind the recording almost everywhere, and one real bug:

- a mail shared into the Organization looked editable on the private view (Summarize, Learn and
  Match tasks were offered and the server refused them);
- mail had bare download and trash icons where a recording had a labelled erase menu, a static title
  where a recording's could be renamed and regenerated, a single "Summarize again" button instead of
  the profile picker and Markdown actions, and a flat "Apply all" Learn list with no Re-learn.

Each gap existed because the mail pane was a second implementation that nobody had moved forward.

### Previous state

Recordings and mail had separate header, summary and Learn components. The recording summary lived
inside `TranscriptionPanel`; mail had its own summary card and Learn card. Each pane decided on its
own whether an item could be changed.

## Options considered

### One body per widget, variants as thin frames (chosen)

- **Pros:** a feature or fix lands in every variant at once; one permission rule; one suite proves
  every variant behaves the same.
- **Cons:** the body must express kind-specific parts (transcript-only Learn sections, the Plaud /
  Custom switcher) through small renderers or flags.

### Separate implementations kept in step by hand (declined)

The state before this work: each variant its own component, parity achieved by copying features
across.

- **Rejected because:** parity by copying is what had already failed; the mail pane fell behind and
  produced a permission bug. Removing the duplicates deleted about 690 lines from
  `TranscriptionPanel` and about 2,300 lines of duplicated Learn state, fetching and apply logic.

### Erase Learn results: keep the Almanac (chosen)

Erasing removes the item's Learn runs, review items, dismissals, the summary hold and queued Learn
jobs. Accepted people, terms, aliases, facts and their evidence stay, as do speaker names and applied
corrections. Learn is marked as erased, so no paid automatic run starts again on its own.

### Erase Learn results: also remove what this item contributed (declined)

Delete this item's quotes from facts and any learned fact only this item supports.

- **Rejected because:** everything in the Almanac was confirmed by a person, may have been edited
  since or confirmed by other items, and in the Organization other people rely on it; an erase button
  that silently undid that would surprise them. It would also need a schema change, because people,
  terms and aliases do not record which item they came from. Wrongly learned records are removed in
  the Almanac itself.

## Decision

**One body per widget, one suite per variant set; erase keeps confirmed Almanac data.** A new widget
variant (a third item kind, a new frame) reuses the body and joins the existing `describe.each`
suite; a per-variant copy of state, fetching or apply logic is a review finding. The personal and
Organization versions of a list follow the same rule: same card, row, empty state, dialog and
actions; the Organization version differs only by its title, the `Users` icon in the Organization
colour and an accent border.

## Key technical details

- Shells and bodies: `src/components/pipeline/workflow-widget.tsx` (the shared widget frame, inline
  or dialog), `src/components/summary/summary-widget.tsx`, `src/components/learn/learn-widget.tsx`
  (with a kind-specific item renderer), `src/components/items/item-header.tsx` (title with rename and
  regenerate, metadata line, AI spend, Organization marker, erase menu). The older recording and mail
  components are thin adapters around them.
- Kind-specific parts stay explicit: speakers, corrections and the calendar chooser are
  recording-only Learn sections; the Plaud / Custom source switcher is recording-only; mail has no
  transcript Markdown.
- One permission rule for both panes: `canChangeItem` in `src/lib/sharing/change-permission.ts`. Its
  content changed later, when owners regained edit rights on recordings they shared; both panes still
  call the same function.
- Erase: `eraseLearnResults` in `src/lib/recordings/erase.ts`, scope `learn` on
  `POST /api/recordings/[id]/erase`, for recordings and mail. Correction passes keep their corrections
  with the run reference cleared. The phase is recorded as skipped with reason `erased`; a manual
  Learn afterwards works.
- **Invariant:** an erase or cleanup never removes Almanac people, terms, aliases or facts a person
  accepted, nor their evidence.

## Verification

- Per-variant suites: `src/tests/summary/summary-widget.test.tsx` (audio and mail),
  `src/tests/learn/learn-workflow-regressions.test.tsx` (audio and mail),
  `src/tests/mail/mail-learn-card.test.tsx` and `src/tests/pipeline/workflow-widget.test.tsx` (inline
  and dialog), `src/tests/settings/organization-providers-card.test.tsx` (personal and Organization).
- Erase: `src/tests/learn/auto-learn.integration.test.ts` ("keeps erased Learn results idle until a
  person starts Learn again"), plus route and lib integration tests for mail rename, regenerate, AI
  cost, erase and delete across own, shared and Organization cases.
- Whole DB suite at each step: 5279 (PR #164), 5306 (PR #166), 5309 (PR #167), 5324 (PR #168)
  passed.

## Consequences & open follow-ups

- Stacked PRs merged in the GitHub UI land in their base branch, not `dev`: PRs #165 to #168 reached
  `dev` only through PR #164.

## Related work

- [2026-10-18-inbound-mail](2026-10-18-inbound-mail/README.md): introduced mail as a second item kind
  next to recordings; this record makes its detail pane share the recording's widgets.
- [2026-10-22-owner-edits-shared-recording](2026-10-22-owner-edits-shared-recording.md): changed who may change a shared item, which the shared header's erase menu follows.

## Timeline

- **2026-10-16**: the maintainer sets the one-body rule during the workflow UI rework.
- **2026-10-17**: the same rule applied to personal and Organization provider lists.
- **2026-10-18**: recording vs mail audit; the maintainer's rulings on the erase menu, mail titles and
  the per-run profile picker.
- **2026-10-19**: PRs #165 to #168 merged into their stack bases, PR #164 merged into `dev`; the
  maintainer confirms that erasing Learn results keeps the Almanac.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
