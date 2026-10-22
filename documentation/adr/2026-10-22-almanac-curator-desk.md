---
title: Curators get a duplicate queue in the Almanac and every folder shows its knowledge read-only
date: 2026-10-22
updated: 2026-10-22 17:00
status: proposed
kind: feature
issues: [240]
prs: []
areas: [src/app/(app)/almanac, src/lib/knowledge/name-match.ts, src/lib/knowledge/people.ts, src/lib/knowledge/entities.ts, src/components/almanac/merge-target-picker.tsx, src/db/queries/almanac-usage.ts, src/lib/folders/item-scope.ts, src/lib/transcription/almanac-terms.ts, src/lib/learn/correction-pass.ts, src/lib/authz/curator.ts]
supersedes: []
superseded-by: []
relates: [2026-10-22-organization-almanac-grows-on-share, 2026-10-21-curators-manage-organization-almanac, 2026-10-01-name-matching-across-word-forms]
---

# Curators get a duplicate queue in the Almanac and every folder shows its knowledge read-only

Once sharing turns confirmed Learn findings into Organization knowledge without asking
([organization Almanac grows on share](2026-10-22-organization-almanac-grows-on-share.md)), a few
curators have to keep a growing Organization Almanac clean. Issue #240 plans three PRs: a curators'
"Péče" tab that finds likely duplicate people and things and joins them; a read-only view of the
knowledge each folder contributes, including what the models receive; and the rest of the problem
queue. Decided on 2026-10-22 from a design page; PR 1 and PR 2 are in review, nothing is merged.

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
- **Declined:** a section of the existing review tab. **Rejected because:** the maintainer took the
  recommendation; a curator-only tab keeps member review and curation apart (inferred).

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

As built on the PR 1 and PR 2 branches (not on `dev`):

- **Signals for** a pair: nickname, Czech surname form, diacritics, typo, legal form, a shared heard-as
  form. **Signals against:** both are confirmed speakers in the same recording; different e-mails at
  different domains. Pairs are ranked high, medium or low.
- **Compare and join:** keeps everything that does not clash, asks only about real clashes (name,
  single-valued facts), proposes the record with an e-mail and more evidence as the survivor, then
  calls the existing `mergePeople` / `mergeEntities`. Merging now also moves a person's extra e-mails
  and mail participants to the survivor (a behaviour change named in the PR).
- **Scan cost is a constraint:** the first build scanned 2,000 people in 12 to 68 seconds (more
  nicknames, slower) and blocked a single-process server. The fix precomputes stems, considers only
  pairs that share trigrams, works one kind at a time, and caches the ranked list per Organization
  (up to five minutes, keyed by the scope generation); the scan took about 1.9 seconds, with a test
  that fails above ten seconds. Decrypted names stay in memory only.
- **Folder knowledge** uses the same functions as transcription key terms and the correction pass
  (`src/lib/transcription/almanac-terms.ts`, `src/lib/learn/correction-pass.ts`), with the folder's
  default profile language and the shared folder access check; the models tab sends what it shows plus
  a count, not the whole list.

## Verification

Not merged. PR 1 fixes: whole suite 7,349 tests passing on the branch; PR 2 review found no blockers
(access control and byte parity with the real model input confirmed) and four should-fix items, in
progress.

## Consequences & open follow-ups

- PR 3 (what each share added with undo per share, conflicting facts, corrections pointing two ways,
  thin records, problem flags in the folder view, the count badge) depends on per-share provenance
  recorded at share time.
- The five-minute cache means a merge or new duplicate can take that long to change the queue unless
  the scope generation moves; the PR 1 review checks it across processes.

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
