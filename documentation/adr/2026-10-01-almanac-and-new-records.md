---
title: Learn gets a cold start; it proposes the people and things it hears, and the Almanac is editable by hand
date: 2026-10-01
updated: 2026-10-22 22:30
status: accepted
kind: feature
issues: []
prs: [72]
areas: [src/app/(app)/almanac, src/app/api/knowledge, src/lib/learn/validate-new-records.ts, src/lib/learn/review.ts, src/lib/knowledge/vocabulary-core.ts, src/lib/knowledge/facts.ts, src/components/almanac]
supersedes: [2026-09-30-learn]
superseded-by: []
relates: [2026-10-01-name-matching-across-word-forms, 2026-10-21-curators-manage-organization-almanac]
---

# Learn gets a cold start; it proposes the people and things it hears, and the Almanac is editable by hand

The first Learn runs on a real library finished with nothing to review. Learn only matched what it
heard against records that already existed, and nothing in the app could create an organization,
project, product or term. PR #72 gave it a cold start: Learn now proposes new people and things it
hears, under a new first review section; the knowledge base, renamed from People to the
**Almanac**, can be edited by hand (things, nicknames, facts, a pasted import, merges); the Learn
button says how the last run went; and automatic Learn is offered without an operator flag.

## Why

- The first two runs on a real self-hosted library ended `finished` with 0 items. The recordings'
  speakers were already named, and `createEntity` had no route, so there was nothing to propose
  against.
- The evaluation's headline results came from an account seeded with 61 known things, which no real
  deployment has. An empty knowledge base yields empty runs.
- After an empty run the button went back to "Learn", as if nothing had happened.
- The maintainer believed there was no automatic-Learn setting: it existed, but only appeared with
  `LEARN_AUTO=true` in the environment.

## Options considered

### Option A: manual editing and import only (declined as the only path)

Add routes and UI to create, rename, merge and delete things, add facts and nicknames by hand, and
import a pasted list.

- **Pros:** no model guesses enter the knowledge base; predictable.
- **Cons:** someone has to type the company's whole vocabulary before Learn is useful.
- **Rejected because:** the maintainer expects people to be lazy and to let the knowledge come from
  conversations rather than type or import it. Manual editing shipped anyway, as the backstop and
  for corrections.

### Option B: Learn also proposes new records it hears (chosen, together with A)

A new output array `newRecords` (people who are mentioned but do not speak, and things the team's
work relies on), listed first in the review as "New in the Almanac", each editable, linkable to a
known record, or dismissed for good.

- **Pros:** the knowledge base fills from the recordings people already make; the review stays the
  only gate.
- **Cons:** more items to review; junk names and near-duplicates of known records need guards.

## Decision

**Chosen: B together with A.** Learn's proposals are the main way the Almanac grows, and manual
editing covers the rest. The follow-on choices:

- **`LEARN_AUTO` is dropped.** Options were to drop the gate or keep operators enabling it in the
  environment. Dropped: "Learn automatically" is offered wherever Learn can run and is off by default,
  so nobody gets it without choosing it. A review warned that dropping the gate could switch
  automatic Learn back on for users who had enabled it earlier; rejected, because no release ever
  shipped the gate.
- **Sensitive facts typed by hand are refused**, like Learn's. Options were to refuse or to allow a
  person deliberately typing it. Refused, which raised how to detect it: an LLM classifier, or the
  existing bilingual keyword list (`deniedTopicOf`) applied to the fact's literal. The keyword list
  won: crude, but instant, free and working without a provider. Only facts whose subject is a person
  are screened, after a term's definition ("KPI means Key Performance Indicator") was refused for
  the word "performance".
- **Re-learn only after Finish, and rejections stick.** A manual run used to ignore earlier
  dismissals; now it honors them, so Re-learn brings back only what is new. Both reviews then
  flagged that a mistaken rejection had become permanent, so the results dialog gained "also propose
  again what I rejected on this recording", which clears that recording's dismissals first.
- **New records are never pre-ticked**, at most 20 per review. "Never propose it" dismisses a name
  across the whole scope; a record merely left unticked is dismissed for that recording only.

## Key technical details

- **Validation:** `src/lib/learn/validate-new-records.ts` (`MAX_NEW_RECORDS = 20`). A name must
  appear in its evidence lines; a name the Almanac already has resolves to that record instead of
  being new; a person named by one word gets "Only a first name: add the surname".
- **References:** items may point at a new record through `newRef`; the refs are read from the
  payload (`src/lib/learn/new-refs.ts`), because one fact can refer to two new records. Dependent
  items wait until their record is ticked and are skipped with `record_not_added` if it is not.
- **Finish creates new records first, in the same transaction** (`src/lib/learn/review.ts`). People
  take a per-(scope, name) advisory lock in sorted order; things rely on the unique index
  `knowledge_entities_owner_type_name_unique`, and a race maps to the winner. An import running at
  the same time does not take the people locks (accepted, low).
- **Routes:** `src/app/api/knowledge/` (entities, aliases, facts, import). The import is previewed
  first, takes at most 500 records in one transaction under the Organization lock, and never creates
  a type implicitly.
- **Deny list:** `DENIED_TOPICS` and `deniedTopicOf` in `src/lib/knowledge/vocabulary-core.ts`, used
  for type creation, new record names and person facts' literals (`src/lib/knowledge/facts.ts`).
- **Routes renamed:** `/people` redirects permanently to `/almanac` (`next.config.ts`); the component
  folder stays `components/people`.
- **Migrations:** 0083 (each review item's outcome), 0084 (the new item kind, `learn_dismissals.scope_wide`).

## Verification

- Evaluation round on 9 private recordings with three accounts: *cold* (people known, no things),
  *empty* (nothing known), *warm* (61 things known). Precision of new records counts right and
  partly right (the right record, its name misheard) against wrong and duplicates of known records;
  all proposed names but one were judged by hand. The plan's target was at least 80% on *cold*.

  | | Opus 5.5, tool path | gpt-5.6-terra, fallback |
  |---|---|---|
  | cold | 99% | 81% |
  | empty | 99% | 86% |
  | warm | 90% | 72% (64% before the word-form lookups) |

  Opus showed no regression in speakers, corrections or facts.
- Tests: `src/tests/learn/review-new-records.integration.test.ts`, `src/tests/learn/validate-new-records.test.ts`,
  `src/tests/knowledge/almanac-routes.integration.test.ts`, `src/tests/learn/learn-review.test.tsx`
  (every button state), `src/tests/knowledge/vocabulary-core.test.ts` (deny list).
- Browser-checked on the end-to-end stack with invented data.

## Consequences & open follow-ups

- **Near-duplicates remain.** On the warm account the fallback still proposed 7 duplicates of known
  records, all sound-alikes or nicknames. Linking such a proposal to the known record saves the heard
  name as a nickname, so the next run recognizes it (see the word-form record).
- The keyword deny list is crude in both directions: it misses sensitive text phrased without its
  words, and it would refuse a person fact that merely uses one.
- Who may edit the Organization's Almanac was left to the Organization account; curators came later.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): the Learn design this fixes the cold start of; it
  supersedes Learn's `LEARN_AUTO` operator flag.
- [2026-10-01-name-matching-across-word-forms](2026-10-01-name-matching-across-word-forms.md): Block 4 of
  the same PR, which lifted the fallback's precision on known records.
- [2026-10-21-curators-manage-organization-almanac](2026-10-21-curators-manage-organization-almanac.md):
  later rules for who edits the Organization's entries.

## Timeline

- **2026-09-30**: the first real runs come back empty; the maintainer decides the rename, manual editing,
  new records, the results popup and dropping `LEARN_AUTO`; Blocks 1 and 2 built and committed.
- **2026-10-01**: Block 3 (new records) and Block 4 (word forms) committed; evaluation verdicts in;
  PR #72 opened and merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
