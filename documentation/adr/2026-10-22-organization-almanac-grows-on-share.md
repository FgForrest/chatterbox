---
title: A finished private Learn review becomes Organization knowledge on share, without asking; curators clean up
date: 2026-10-22
updated: 2026-10-22 17:00
status: proposed
kind: feature
issues: [240]
prs: []
areas: [src/lib/knowledge/share-knowledge.ts, src/lib/sharing/share-names.ts, src/lib/learn/sharing.ts, src/components/learn/learn-widget.tsx, src/app/(app)/almanac]
supersedes: []
superseded-by: []
relates: [2026-10-21-curators-manage-organization-almanac, 2026-10-22-owner-edits-shared-recording, 2026-10-22-almanac-curator-desk]
---

# A finished private Learn review becomes Organization knowledge on share, without asking; curators clean up

When an owner shares a recording or mail whose private Learn review they have already finished,
what they confirmed becomes Organization knowledge, with no confirmation step and no second
review, and the item's Organization view counts Learn as done. The Organization Almanac is meant to
grow "organically"; a few curators clean it up afterwards with dedicated tools (issue #240, three
PRs). Decided on 2026-10-22; nothing is merged yet.

## Why

The usual workflow files a new recording into a private folder, runs it through transcription,
Learn and summary, and then shares it into an Organization folder. Klepna keeps one Learn result
per Almanac, so after sharing, the Organization view had no Learn result and offered a fresh Learn
that looked exactly like the one the owner had just finished. The rule from the day before
([2026-10-22-owner-edits-shared-recording](2026-10-22-owner-edits-shared-recording.md): a private Learn run still open at share time is
cancelled and restarted on the Organization scope) covered only unfinished runs. The maintainer's
requirement: the process must be easy and straightforward, the knowledge base grows organically,
"do not ask for permission, ask for forgiveness. The curator can erase and merge data afterwards."

### Previous state

Sharing already publishes most of what the owner confirmed, and has since the Learn work:
`publishSpeakerNamesInTx` (`src/lib/sharing/share-names.ts`) moves every person confirmed on the
item's transcripts into the Organization (`promotePersonInTx`: the same record re-owned, or folded
into the Organization person with the same e-mail), and `publishKnowledgeInTx`
(`src/lib/knowledge/share-knowledge.ts`) publishes the owner's corrections and heard-as forms on
the item and states the owner's facts said there in the Organization scope, promoting the people
and things they name; `withdrawKnowledgeInTx` takes it back. What was missing is the Organization
view's Learn state, and possibly records the review created that no confirmed speaker, fact or
correction names.

## Options considered

### Option 1: a finished private Learn counts as done after sharing, with an optional "teach the Organization too" action (declined)

The assistant's recommendation.

- **Pros:** nothing private reaches colleagues unless the owner clicks.
- **Cons:** the Organization Almanac learns nothing from the recording unless someone clicks.
- **Rejected because:** the maintainer wants the Organization Almanac to grow without extra steps.

### Option 2: ask again in the Organization view, and say why (declined)

- **Pros:** the Organization Almanac learns, with a human looking.
- **Cons:** a second review of the same recording.
- **Rejected because:** it is a second review; the process must be easy.

### Option 3: confirmed findings become Organization knowledge on share, no confirmation (chosen)

The risks were put to the maintainer before he chose it, and he accepted them:

- any member who shares adds people, facts and corrections to the Organization Almanac without a
  curator, a conscious widening of the rule that a curator's new entries stay private
  ([2026-10-21-curators-manage-organization-almanac](2026-10-21-curators-manage-organization-almanac.md));
- one person's mistaken correction then corrects every transcript that uses the Organization Almanac;
- a share by mistake leaves promoted people behind after withdrawal.

A one-line notice in the share dialog ("N confirmed findings will be added to the Organization
Almanac") was offered and dropped with the confirmation: no line, no step.

### Implementation 3a: replay accepted review items into Organization copies (declined)

The first implementation replayed the finished review's accepted items into Organization copies and
skipped the existing publication.

- **Rejected because** review found it lost correction-pass and manual corrections, facts from
  earlier runs, and everything after a re-transcription; deleted hand-named speakers on reshare; and
  created a duplicate Organization person on every share. Its premise ("copy, not move") was wrong:
  the share path already moves people and publishes knowledge.

### Implementation 3b: keep the existing publication and settle Learn in the Organization view (chosen, in progress)

At share, after the existing publication, a finished private run for the current content writes a
finished Learn receipt in the Organization view (the private run's counts, no review items, no
job), so nothing waits on Organization Learn; records the review created that the existing path
does not reach are promoted with the existing helpers. Withdrawal removes the receipt; reshare
writes it once. Open private runs keep the cancel-and-restart rule.

## Decision

**Chosen: Option 3, built as 3b.** Rules that bound it, set in the brief and accepted with the risks:

- people are matched only by e-mail or an existing link, never by name alone: a duplicate is
  acceptable, a wrong merge is not;
- things by exact name and type;
- only what the accepted items assert travels, plus a person's primary e-mail; never private notes
  or facts from other items;
- on conflict the existing Organization data wins.

The curator tooling decided the same day (issue #240) is its own record:
[almanac curator desk](2026-10-22-almanac-curator-desk.md).

## Key technical details

- **Keep, do not replace:** `publishSpeakerNamesInTx`, `publishKnowledgeInTx` and
  `withdrawKnowledgeInTx`. Their callers are the folder share path (`src/lib/folders/folders.ts`) and
  the mail share gate (`src/lib/mail/share-gate.ts`).
- **Open runs:** `cancelPrivateLearnAtShareInTx` in `src/lib/learn/sharing.ts` stays the rule for a
  private run that is not finished.
- **Receipt idempotence:** concurrent shares and reshares must write the Organization receipt at most
  once, under the locks the share already holds.
- **Self-host without an Organization:** nothing changes.

## Verification

Not merged; nothing verified yet. The rework is required to pin, as regression tests, exactly the
cases the first attempt broke: correction-pass and manual corrections, facts from an earlier run, a
hand-named speaker surviving share, withdrawal, private rename and reshare, and one Organization
person for someone without an e-mail named on two shared items.

## Consequences & open follow-ups

- Duplicates will appear; the first curator PR exists to find and join them, and undo per share needs
  provenance recorded at share time (see the curator desk record).
- Withdrawal removes the recording's facts from the Organization and hands its corrections back to
  the owner, but promoted people stay in the Organization.

## Related work

- [2026-10-21-curators-manage-organization-almanac](2026-10-21-curators-manage-organization-almanac.md): curator rights this relies on, and the "new
  entries stay private" rule it widens for sharing.
- [2026-10-22-owner-edits-shared-recording](2026-10-22-owner-edits-shared-recording.md): the cancel-and-restart rule for unfinished private Learn
  runs, which this complements for finished ones.
- [2026-10-22-almanac-curator-desk](2026-10-22-almanac-curator-desk.md): the curator tools that clean up
  what organic growth adds.

## Timeline

- **2026-10-22**: the repeated Learn offer reported; Option 3 chosen with its risks; curator tooling
  designed and decided, issue #240 opened; the first implementation (3a) rejected in review and the
  rework (3b) started.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
