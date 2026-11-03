---
title: Untouched reviews can be skipped without rejection, with task state scoped to the item and view
date: 2026-11-02
updated: 2026-11-02 19:53
status: proposed
kind: feature
issues: []
prs: []
areas: [src/lib/tasks, src/lib/learn/review.ts, src/lib/learn/learn-job-handler.ts, src/db/schema.ts, src/components/learn, src/components/tasks, src/components/pipeline/workflow-widget.tsx, src/hooks/use-deferred-review-commit.ts]
supersedes: [2026-10-22-owner-reviews-tasks-sharing-ungated, 2026-10-20-learn-review-one-column, 2026-09-30-learn, 2026-10-02-almanac-guided-transcript-correction]
superseded-by: []
relates: []
---

# Untouched reviews can be skipped without rejection

A reviewer can leave Learn after confirming speakers, or skip Task review, without teaching the app
that the other suggestions are wrong. Finish remains final, including with zero selected. The
implementation is unmerged; this record is proposed.

## Why

A busy reviewer needs a summary without deciding every Almanac fact and task. Previously, leaving
all suggestions unticked and finishing remembered rejections; leaving Learn open held the summary
for up to 72 hours. Treating both exits as Finish loses the difference between an unanswered
suggestion and an unwanted one. The difference must survive reload, later summaries, sharing,
retention and backup without introducing review-batch ownership into every proposal table.

### Previous state

Learn showed repeated known facts pre-ticked alongside new suggestions. Task review had no group
checkbox or Skip, and its action footer followed the last proposal. Finish dropped untouched
assignee-check proposals without remembering a rejection. No persistent item-level state distinguished
skipped tasks from waiting tasks.

## Options considered

### Option A: two nullable markers on item_processing (chosen)

Use `task_review_skipped_at` and `task_review_changed_at`, keyed by item and view, for the current
review. A later summary inherits the skip until the reviewer finishes the proposals.

- **Pros:** reuses existing item ownership, lifecycle and uniqueness; two additive columns, no
  backfill; state is cheap to export even before the released summary produces any tasks.
- **Cons:** cannot distinguish summaries as review batches. Skipping is deliberately sticky across
  manual re-summary, unlike the initial proposal to skip only the released summary's tasks.

### Option B: task_review_batches with proposal membership (declined)

Store one review batch per summary, allowing independent old and new review outcomes.

- **Pros:** precise per-summary history and automatic expiry of a skip on a new summary.
- **Cons:** adds a table, three foreign keys and a uniqueness change, plus batch creation,
  replacement, sharing, retention and archive/restore rules for proposals, matches and follow-ups.
- **Rejected because:** the approved semantics are one review per item and view, sticky until
  Finish. Batch identity adds lifecycle and migration costs without representing a required state.
  Revisit only if independent reviews of multiple summaries become a product requirement.

### Option C: treat quick exit as Finish with zero selected (declined)

- **Pros:** needs no separate skipped state.
- **Cons:** records rejections for suggestions the reviewer never considered.
- **Rejected because:** a later Learn run or summary must be allowed to propose skipped suggestions
  again. Rejection memory cannot express “not now”.

## Decision

**Chosen: Option A, with separate Skip and Finish semantics.** Skip does not accept tasks or create
rejection memory. Finish applies selected changes and removes every unticked current suggestion.
Untouched assignee-check proposals keep their existing exception: dropped without rejection memory.
Only UI availability enforces untouched review order; authorized server actions remain idempotent
without new workflow-order restrictions.

Learn quick finish applies explicitly accepted speakers, previously confirmed pre-ticked
corrections, the default/ticked transcript language, and repeated known facts. A new record needed
by an explicitly confirmed speaker is applied with that speaker. Calendar/Meet guesses are never
confirmed by quick finish. Other outcomes are `not_now`, without Learn dismissals. Repeated known
facts never enter visible review items or counts; a run containing only those facts finishes on its
own. Only quick finish omits the extra correction pass so the summary hold releases immediately.
Known-only runs, ordinary Finish and empty Learn runs retain that pass when enabled; the pass then
releases the hold, otherwise it releases at once.

## Key technical details

- `src/lib/tasks/review-state.ts` owns the markers. All task-review mutations mark changed in their
  transaction; local text edits also persist the marker before blur. Learn uses
  `learn_runs.inputs.reviewChanged`, with speaker answers and their new-record dependency exempt.
- Skip and Finish recheck the caller under existing owner/item locks. The skip endpoint does
  nothing after Finish leaves no current decisions, and repeated skips preserve their state.
  Proposals remain protected by the existing reviewer-only visibility and encrypted content paths.
- Sharing and withdrawal carry task markers with the proposals. Finish clears both view copies
  for that owner/item, preventing a stale private skip from reappearing after withdrawal.
- Erase/retention needs no new cleanup: markers are ignored when no proposals exist. A future
  summary of the same item still inherits its skip until a review is finished.
- `tasks/reviews.json` carries skipped and changed booleans per item/view, including a pre-skipped
  review with no proposals yet. Restore validates ownership and scope; omitted state in older
  archives means unskipped. Learn archives also carry choice, outcome and version, retaining
  `not_now` and draft state through their existing run inputs.
- `learnQuickFinishPolicy` gathers the owner's pipeline facts and asks the existing planner what
  releasing Learn would queue. A current or hand-edited summary, active summary job, manual placement
  or Plaud-only task import does not promise a summary or pre-skip tasks. Task skip additionally
  requires tasks enabled.
- Marker upserts select from `chatter_items` under the supplied owner, allowing a first-summary or
  Organization-view row to be created without permitting another owner's item. An open-task merge
  never marks or advances an item named only by its route.
- Known-only auto-finish checks the job actor against the stored actor (owner for legacy runs), then
  rechecks current item and curator access. Access refusal leaves the successful run ready. Older
  ready runs with no visible findings offer Finish directly from the collapsed review card.
- Quick finish clears the hold, requests the pipeline and marks Learn released in one transaction.
  The latter prevents the next advance from starting Learn again after the hold disappears.
- The shared deferred-commit hook hides the card and offers Undo for 8 seconds. No mutation is sent
  before toast dismissal. Page hide and unmount flush once with fetch keepalive. A commit failure
  reloads the review and reports an error; Undo cancels pending work without a server write.
- Both reviews use the shared group checkbox and inline sticky footer. Dialog scrolling keeps its
  existing footer behavior. Mail uses the same Learn body, omitting speaker controls and counts.

## Verification

- Dedicated PostgreSQL coverage in `src/tests/tasks/quick-finish.integration.test.ts` verifies
  retrievability, sticky skip, final rejection, caller checks, mutation markers, archive restore,
  sharing/withdrawal, quick application, pipeline release and known-only completion (40 tests).
- Deferred commit coverage checks Undo, timeout, hidden page, unmount keepalive and failure
  recovery (5 tests). Review component suites cover inline and dialog frames, mail, counts,
  selected-state controls, skipped-proposal access and persisted edits.
- `./node_modules/.bin/drizzle-kit generate`: generated migration 0152 with two nullable
  columns; `origin/dev` ended at 0151. No deployment migration was applied.
- `./node_modules/.bin/fumadocs-mdx source.config.ts src/.source`,
  `./node_modules/.bin/biome check . --write` (2,248 files), and
  `./node_modules/.bin/tsc --noEmit`: passed, no errors or warnings.
- The repository Biome configuration excludes `messages/`, so the prescribed
  `biome check --write messages` processes no files. Both catalogs were checked through
  `biome check --write --indent-width=2 --stdin-file-path=catalog-en.json < messages/en.json`
  and the equivalent `catalog-cs.json < messages/cs-CZ.json` invocation. Both retain their
  formatting; 3,669 matching keys, no empty Czech values.
- All Vitest runs used Node 22.22.2 with the disposable PostgreSQL test URL and
  `ALLOW_REMOTE_TEST_DATABASE_URL=true`; DB files ran with `--no-file-parallelism`.

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Task, Learn, pipeline and related integration/component suites | 1,411 | 1 | 0 |
| Changed against origin/dev | 7,215 | 30 | 91 |
| Full suite, run once | 10,250 | 30 | 113 |
| Fresh final verification on ten affected files | 211 | 0 | 0 |

The long runs overlapped final edits. Their failures exposed the old export mock, permission-route
catalogs, the previous zero-selection button label, and workers using pre-fix code after an
assertion changed. The area run's one translation-guard failure overlapped catalog regeneration.
Every distinct failing assertion from the changed and full runs (32 in total) passed in the fresh
final run. It also verifies the archive manifest before proposals exist and denies all new write
methods to read-only recipients. The complete suite was not repeated.

The executed test commands below omit only the Node executable-path prefix and shell redirection
of complete stdout/stderr to temporary logs:

```sh
./node_modules/.bin/vitest run src/tests/tasks src/tests/learn src/tests/pipeline src/tests/mail/mail-learn.integration.test.ts src/tests/mail/mail-learn-card.test.tsx src/tests/mail/mail-export.integration.test.ts src/tests/export/archive-scope.integration.test.ts src/tests/knowledge/item-knowledge.integration.test.ts --no-file-parallelism --reporter=json --outputFile=docs/plans/quick-finish-areas-2.json
./node_modules/.bin/vitest run --changed origin/dev --no-file-parallelism --reporter=json --outputFile=docs/plans/quick-finish-changed.json
./node_modules/.bin/vitest run --no-file-parallelism --reporter=default --reporter=json --outputFile=docs/plans/quick-finish-full.json
./node_modules/.bin/vitest run src/tests/tasks/quick-finish.integration.test.ts src/tests/tasks/summary-review-ui.test.tsx src/tests/tasks/deferred-review-commit.test.tsx src/tests/learn/learn-review.test.tsx src/tests/learn/review-language-guards.test.ts src/tests/mail/mail-learn-card.test.tsx src/tests/regressions/strip-opens-review.test.tsx src/tests/export/build-archive.test.ts src/tests/sharing/route-classification.test.ts src/tests/sharing/person-shares.integration.test.ts --no-file-parallelism --reporter=json --outputFile=docs/plans/quick-finish-final-targeted.json
```

- Message catalogs were regenerated with `unstable_extractMessages` from `next-intl/extractor`
  for `en` and `cs-CZ`; the temporary extractor was deleted.
- `node scripts/generate-adr-index.mts`, `node scripts/generate-adr-index.mts --check` (63 records),
  and `git diff --check`: passed. Temporary reports and logs were removed after their results
  were recorded here.

### Review-fix verification

The addendum's regression baseline was 29 passed and 15 failed across the dedicated PostgreSQL
suite and the four recording/mail inline/dialog known-only UI cases. After the fixes, all 44 passed.
The wider task, Learn, pipeline, sharing and export run passed 1,864 tests and failed 2: both workflow
fixtures called an empty review a normal waiting review and expected Review rather than Finish.
Those fixtures now contain a visible finding, with separate empty-review cases. Fresh verification
passed all 71 tests across the 40 PostgreSQL cases, 4 known-only UI cases and 27 workflow cases.
No application code changed after the wider run. The full suite was left to the orchestrator.

All runs used Node 22.22.2 and the disposable PostgreSQL test URL with
`ALLOW_REMOTE_TEST_DATABASE_URL=true` and `--no-file-parallelism`. Exact additional commands,
excluding only complete-output log redirection:

```sh
./node_modules/.bin/vitest run src/tests/tasks/quick-finish.integration.test.ts src/tests/learn/known-only-review.test.tsx --no-file-parallelism --reporter=json --outputFile=docs/plans/quick-finish-fixes-before.json
./node_modules/.bin/vitest run src/tests/tasks/quick-finish.integration.test.ts src/tests/learn/known-only-review.test.tsx --no-file-parallelism --reporter=json --outputFile=docs/plans/quick-finish-fixes-after.json
./node_modules/.bin/vitest run src/tests/tasks src/tests/learn src/tests/pipeline src/tests/sharing src/tests/export src/tests/mail/mail-learn-card.test.tsx src/tests/regressions/strip-opens-review.test.tsx src/tests/regressions/224-owner-task-review.test.ts --no-file-parallelism --reporter=json --outputFile=docs/plans/quick-finish-fixes-affected.json
./node_modules/.bin/vitest run src/tests/tasks/quick-finish.integration.test.ts src/tests/learn/known-only-review.test.tsx src/tests/learn/learn-workflow-regressions.test.tsx --no-file-parallelism --reporter=json --outputFile=docs/plans/quick-finish-fixes-final.json
```

MDX generation passed, Biome checked 2,250 files without errors or warnings, TypeScript passed,
and the ADR index generator and check passed for 63 records. Existing translated labels are reused;
no catalogs, schema or migration changed in these fixes. Temporary reports were removed after
recording the results. No commit or Git state mutation was made.

## Consequences & open follow-ups

- Both deployment modes receive nullable migration 0152, with no backfill, new environment variable
  or compose change. Apply through the normal deployment migration path; no manual data step is
  required. Learn remains self-host only. Task skip works on both modes through existing access
  checks. A faulty skip can be recovered by opening skipped proposals and finishing them; stored
  proposals are not destroyed by skipping. Rolling back application code leaves ignorable columns.
- The approved storage model intentionally changes the initial per-summary design: every later
  summary remains skipped until Finish. A skipped review with no remaining proposals has no link;
  replacement proposals become retrievable when they exist again.
- No production data or real AI provider was used for verification. Browser layout has component
  coverage; a live visual review at phone width remains a maintainer check.

## Related work

- [Owner reviews tasks, sharing ungated](2026-10-22-owner-reviews-tasks-sharing-ungated.md): superseded
  only for optional deferral. Untouched assignee-check rejection memory, ungated sharing and the
  absence of assignee acceptance are unchanged.
- [Learn review in one column](2026-10-20-learn-review-one-column.md): superseded for the visible
  repeated-known-facts section; its layout and language rules remain.
- [Learn](2026-09-30-learn/README.md): superseded for visible known-fact pre-ticks and requiring a
  person to finish a known-only run; confirmation of new knowledge and guesses is unchanged.
- [Almanac-guided transcript correction](2026-10-02-almanac-guided-transcript-correction.md): superseded
  only for omitting the correction pass after quick finish. Known-only runs keep the same pass and
  hold-release behavior as empty runs; ordinary Finish and provider key terms remain unchanged.
