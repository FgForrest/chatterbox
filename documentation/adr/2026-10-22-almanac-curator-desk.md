---
title: Curators get a duplicate queue in the Almanac and every folder shows its knowledge read-only
date: 2026-10-22
updated: 2026-10-23 13:35
status: accepted
kind: feature
issues: [240]
prs: [244, 247, 275]
areas: [src/app/(app)/almanac, src/lib/knowledge/name-match.ts, src/lib/knowledge/people.ts, src/lib/knowledge/entities.ts, src/components/almanac/merge-target-picker.tsx, src/db/queries/almanac-usage.ts, src/lib/knowledge/duplicate-score.ts, src/lib/knowledge/duplicates.ts, src/components/almanac/care-queue.tsx, src/lib/knowledge/read-folder-knowledge.ts, src/components/dashboard/folder-knowledge-panel.tsx, src/lib/transcription/almanac-terms.ts, src/lib/learn/correction-pass.ts, src/lib/authz/curator.ts]
supersedes: []
superseded-by: []
relates: [2026-10-22-organization-almanac-grows-on-share, 2026-10-21-curators-manage-organization-almanac, 2026-10-01-name-matching-across-word-forms]
---

# Curators get a duplicate queue in the Almanac and every folder shows its knowledge read-only

Once sharing turns confirmed Learn findings into Organization knowledge without asking
([organization Almanac grows on share](2026-10-22-organization-almanac-grows-on-share.md)), a few
curators have to keep a growing Organization Almanac clean. Issue #240 plans three PRs: a curators'
"Péče" (Care) tab that finds likely duplicate people and things and joins them; a read-only view of
the knowledge each folder contributes, including what the models receive; and the rest of the
problem queue. Decided on 2026-10-22 from a design page. PR 2 merged as #244 and PR 1 as #247;
PR 3 is #275 (2026-10-23).

## Why

The maintainer, choosing organic growth: "I need some tools for the curator, I should have some help
to identifying duplicated same persons to be able to easily join them. Also when I enter the folder
with recordings, I should be able to see the related knowledge base (i.e. similar view that is sent
to transcription models and MCP when learning / summarizing)." Merge already existed, but only for
someone who already knew which two records were the same; nothing showed what a folder contributes.

Findings that shaped the design (issue #240): folders only rank knowledge for transcription key terms
(at most 500) and the correction pass (at most 500 records), they never filter it; items filed
directly in a root folder get no folder context; summaries receive no Almanac context; MCP tools have
no folder filter; the Learn name matcher (diacritic folding, edit distance, trigrams, stems) can rank
duplicate candidates.

## Options considered

Each question on the design page carried a recommendation and an alternative.

### A: where the queue lives

- **Chosen:** a Péče tab in the Almanac, visible to curators, with a count badge, covering
  Organization records only; private records are their owner's business.
- **Declined:** a section of the existing review tab. **Rejected because:** the maintainer wants
  curation as a separate tab, placed last among the Almanac's tabs and visible only to curators.
  `src/components/almanac/almanac-tabs.tsx` renders it after People, Things, Vocabulary and Review,
  only when the layout reports the viewer as a curator; the page itself answers 404 to anyone else.

### B: who sees a folder's knowledge

- **Chosen:** everyone, read-only; curators also get the fixes. Members see their own and the
  Organization's knowledge, which explains why a name was or was not recognised.
- **Declined:** curators only. **Rejected because:** the maintainer chose "everyone, read-only".

### C: remembering "not the same", and undo per share

- **Chosen:** a small schema addition: dismissed pairs, and which share added which record or fact.
- **Declined:** no schema change. **Rejected because:** dismissals would last a session, so the same
  pair returns every day, and a bad share could only be cleaned record by record.

### D: one PR or three

- **Chosen:** three, duplicates and joining first, with a tracking issue.
- **Declined:** one larger PR. **Rejected because:** organic sharing starts creating duplicates as soon
  as the Learn change lands, so duplicates must come first.

### "Person without e-mail" as a problem type (declined)

- **Rejected because:** outside people rarely have an e-mail, so it would flag too many false
  positives (the maintainer). E-mail status shows as plain information instead.

## Decision

**A as recommended, B everyone read-only, C yes, D three PRs with issue #240** (maintainer,
2026-10-22). Duplicate detection ranks by the Learn matcher's signals and never treats a missing
e-mail as one. Joining goes through the existing merge, so every merge rule (locks, Organization
scope, history) stays in one place.

## Key technical details

As merged in #247 (PR 1) and #244 (PR 2), and extended by #275 (PR 3):

- **Signals for** a pair: nickname, Czech surname form, diacritics, typo, legal form, a shared heard-as
  form. **Signals against:** both are confirmed speakers in the same recording; different e-mails at
  different domains. Pairs are ranked high, medium or low.
- **Compare and join:** keeps everything that does not clash, asks only about real clashes (name,
  single-valued facts), proposes the record with an e-mail and more evidence as the survivor, then
  calls the existing `mergePeople` / `mergeEntities`. Merging now also moves a person's extra e-mails
  and mail participants to the survivor (a behaviour change named in #247).
- **Scan cost is a constraint:** the first build scanned 2,000 people in 12 to 68 seconds (more
  nicknames, slower) and blocked a single-process server. The fix precomputes stems, considers only
  pairs that share trigrams, works one kind at a time, and caches the ranked list per Organization
  (up to five minutes, keyed by the scope generation); the scan took about 1.9 seconds, with a test
  that fails above ten seconds. Decrypted names stay in memory only.
- **Folder knowledge** uses the same functions as transcription key terms and the correction pass
  (`src/lib/transcription/almanac-terms.ts`, `src/lib/learn/correction-pass.ts`), with the folder's
  default profile language and the shared folder access check; the models tab sends what it shows plus
  a count, not the whole list.

- **Share provenance:** speaker, correction/fact, finished-Learn and task-assignee publication all
  record additions in their share transaction. Existing records are references, not additions.
  A transaction identity groups publishers of one item, under the existing Organization lock.
- **Fact conflicts:** reuse the existing relation `cardinality: one`; losing current values point at
  the kept fact through `replacedByFactId`, retaining evidence. Correction conflicts use heard-as
  forms; thin records use distinct Organization-visible item mentions, including mail participants.
- **Deploy surface:** the generated additive migration `0142_spicy_inertia.sql` adds provenance and
  extends the existing dismissal table. No environment or compose changes. Hosted and self-host
  without an Organization expose no Care data.

## Verification

- **PR 3 review fixes:** additional database regressions bring the Care integration file to 74
  cases. They cover private dependencies on both record kinds, private speaker/mail usage, withdrawn
  sources, private correction cascades, 15 concurrent FK writes (task, proposal, mail participant and
  speaker link) during all Care erasure paths, and
  existing recording writers finishing before Care takes parent locks. The populated plan test uses
  50,002 heard-as forms, 40,000 facts, 100,000 historical dismissals and 10,000 unrelated shared items:
  indexed candidates stop at 32,000 facts, 16,000 forms and 2,000 records per kind; dismissal membership
  reads one indexed row. A 496-decision archive round-trips through the actual route above 16 KiB;
  maximum decision content fits the documented 32 MiB chunk limit. Final whole Node 24 suite: 722
  files / 8,558 tests passed, 12 files / 104 tests skipped, no failures or unhandled errors (1,711.40 s).
  Final Node 22 selection: four files / 190 tests passed, none skipped. MDX, Biome (1,996 files, no
  errors or warnings), TypeScript and the ADR index passed.
- **PR 3:** `src/tests/regressions/240-care-queue.integration.test.ts` adds 30 database-backed
  cases, including every publication path, untouched and protected undo, publication timestamps, reshare receipts,
  private-scope boundaries, detector positives and negatives, dismissals, counts, all new routes,
  the missing-Organization case, and actual archive export/restore. The 11 UI cases in
  `src/tests/regressions/240-care-queue.test.tsx` cover shared Care/folder fixes, optimistic rollback,
  section navigation, lazy folder share details, share outcomes and the layout badge. A regression
  in the existing duplicate UI tests checks removal of every related pair after merging; they still run
  against the extracted shared duplicate card. Whole Node 24 suite: 717 files and 8,468 tests
  passed, 12 files and 103 tests skipped. Node 22 affected checks: 99 passed, seven Keycloak tests
  skipped without an issuer. Biome, TypeScript, MDX, message extraction and the ADR index passed.
- **PR 2 (#244):** `src/tests/knowledge/folder-knowledge.integration.test.ts` checks parity with
  `almanacTermsFor`, including an inherited pinned language, for private and Organization child
  folders; `src/tests/regressions/240-folder-knowledge-ranking.test.ts` covers the overflow and
  below-the-cut ranking and the Czech plurals. Targeted folder API and UI, ranking and plural
  regressions, transcription ranking and route classification: 6 files, 60 tests.
  `vitest run --changed origin/dev`: 4,085 passed; whole suite 7,332 passed (two teardown errors in
  the task-review test were fixed afterwards and the affected UI files rerun clean). Browser check on
  the demo stack: an Organization folder, all tabs, the model preview with reasons and the correction
  block. Three review rounds, all approving: the access control and the parity with the real model
  input held, the findings (hard-coded limits, the untested Private-root path, the panel toggle, an
  untranslated heading, the total on an empty page, a Czech label) were fixed before merge, and the
  third round raised none. CI (lint and format, type check, test, build, CodeQL, review) was green on
  the merged head.
- **PR 1 (#247):** new `src/tests/knowledge/duplicate-score.test.ts`,
  `src/tests/knowledge/duplicates.integration.test.ts`, `src/tests/almanac/care.test.tsx` and
  `src/tests/regressions/240-duplicate-scan.test.ts` cover scorer signals, authorization,
  Organization boundaries, dismissals, bounds and cursors, name and clash choices, stale comparisons,
  reference moves, backup scope, cache expiry and in-flight sharing. The benchmark in
  `240-duplicate-scan.test.ts` scans 2,000 people with eight aliases and eight heard-as forms each in
  about 2 s (in-memory scoring; the first version took 12 to 68 s and blocked the server). Locally
  against PostgreSQL, as stated in the PR: `vitest --changed origin/dev` 465 files / 5,130 tests
  passed; whole suite 671 files / 7,364 tests passed; Biome, tsc, fumadocs-mdx and the message
  extractor clean. The review fixes added `src/tests/regressions/240-duplicate-comparison-previews.test.ts`,
  `src/tests/regressions/240-duplicate-picker-access.test.tsx`,
  `src/tests/regressions/240-duplicate-evidence.test.ts` (identical evidence before and after
  inserting 2,000 unrelated facts) and a database-backed `email_conflict` case in
  `duplicates.integration.test.ts` that asserts a refused join changes nothing. The fourth review
  round approved with no findings.

## Consequences & open follow-ups

- PR 3 implements per-share review and safe undo, single-valued fact conflicts, two-way corrections,
  thin records, folder flags with shared fixes, and the Care badge. Provenance starts at upgrade;
  older shares cannot be undone through Care.
- Organization archives preserve dismissals as portable problem content, encrypted in the database.
  Restore matches the restored records, values and usage and recomputes instance-specific fingerprints.
  Provenance and undo history are omitted: ciphertext fingerprints and dependencies cannot be reused
  safely after re-encryption or id remapping. Imported knowledge stays, without undo of old shares.
- The non-duplicate scan checks 2,000 newest records per kind, 32,000 current facts and 16,000 heard-as
  forms, with at most 2,000 problems per detector. Its five-minute cache checks scope generation on
  every read. Problems beyond these caps may be absent; the queue and user guide state the limits.
- Share undo preserves any addition changed, merged, confirmed elsewhere or referenced by a later
  share. It also keeps records whose deletion would affect private notes, aliases, facts or other
  sources. This can retain more than the visible Organization evidence suggests; it must never
  cascade into another source to make an undo look complete. Thin deletion applies the same protection.
  Care holds the Organization lock, then existing recording locks, then parent row locks before
  dependency checks and erasure;
  concurrent FK writers wait and fail if the parent was erased. Indexed candidate limits precede
  joins, dismissal reads use current keys only, and thin detection skips records above 64 uses.
  Restore accepts independently retryable chunks of at most 32 MiB including the ID map; it checks
  archived pairs in batches and matches problems through one map of current problems.
- Keeping one value of a fact conflict retires every other current value of that relation on the
  subject, including values Care cannot display (an object merged away), so the single-valued rule
  holds after the fix. Thin deletion and share undo ask for confirmation in the UI.
- The archive restore endpoint restores Care decisions after records, facts and usage; a general
  archive-import UI remains separate work.
- Each kind scans at most the newest 2,000 live records (`MAX_DUPLICATE_RECORDS` in
  `src/lib/knowledge/duplicate-limits.ts`; 8 aliases, 8 heard-as forms and 16 extra addresses per
  record, 40 nearest neighbours each). A new record is not paired with an older one beyond that cap;
  the Care tab and the user guide say so.
- The full scan looks each record up by its primary and canonical name only, while aliases and
  heard-as forms are indexed as targets. A pair whose only overlap is alias-to-alias is therefore not
  listed in the queue; it still appears in the merge picker for either record, which looks up all
  forms. Seeding the scan with every form would multiply lookups by up to eight; the #247 review
  accepted the trade-off.
- The five-minute cache means a merge or new duplicate can take that long to change the queue unless
  the scope generation moves. Every request checks the database scope generation, and dismissals,
  authorization and merge validation always read the database, so the cache is safe across processes
  (confirmed in the #247 review).

## Related work

- [2026-10-22-organization-almanac-grows-on-share](2026-10-22-organization-almanac-grows-on-share.md):
  the organic growth these tools exist to keep clean.
- [2026-10-21-curators-manage-organization-almanac](2026-10-21-curators-manage-organization-almanac.md):
  the curator rights the Péče tab uses.
- [2026-10-01-name-matching-across-word-forms](2026-10-01-name-matching-across-word-forms.md): the
  matcher whose signals rank duplicate candidates.

## Timeline

- **2026-10-22**: tooling requested with organic growth; design page reviewed ("pretty good design");
  decisions A to D and the e-mail remark; issue #240 opened; PR 1 and PR 2 built; PR 1 scan blocker
  found in review and fixed.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
- **2026-10-22**: PR 2 merged as #244.
- **2026-10-22**: PR 1 merged as #247, after four review rounds (per-record comparison previews and
  curator-only picker ranking, fact evidence read for candidate records only, a database-backed
  e-mail conflict test).

- **2026-10-23**: PR 3 built; provenance, safe undo, remaining problem kinds, shared folder fixes, badge and
  portable curator decisions. A review before opening found a thin-record delete reaching private notes,
  an undo race with concurrent task assignment and unindexed scans; all fixed. Opened as #275.
