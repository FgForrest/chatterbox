---
title: Use one client store per open item
date: 2026-11-20
updated: 2026-11-20 13:35
status: accepted
kind: fix
issues: [426]
prs: [427, 430, 432, 435, 436]
areas: [src/components/items, src/components/dashboard, src/components/mail, src/lib/pipeline/presentation.ts, src/lib/pipeline/processing-status.ts, src/db/queries/item-content-versions.ts]
supersedes: [2026-10-19-processing-profiles-and-workflow, 2026-10-22-pipeline-steps-settle-their-jobs]
superseded-by: []
relates: []
---

# Use one client store per open item

Recording and mail detail use one client store per open item. The existing processing endpoint
supplies the workflow projection, authorized content view, and opaque versions that tell panels
when to reload. Folder operations use a per-item queue that can finish after the detail closes.

## Why

Filing a private item could send panels to the Organization view before the share committed. The
summary interpreted the resulting 404 as an empty summary, and other panels lost corrections or
remounted. Independent optimistic rollbacks could remove a second filing when the first failed.
An immediate read after a write could miss the pipeline advance, leaving the workflow strip behind
for 60 seconds or up to 10 minutes during a review hold.

### Previous state

The workflow strip already consumed a server projection. Each panel still chose its own scope,
refresh triggers and handling of stale results. The detail keyed parts of the page by view and
rendered flags, so switching between rows for the same item or receiving the first summary could
reset local state and the selected transcript.

## Options considered

### Option A — Targeted fixes

- **Pros.** Small changes could fix the premature scope switch, handle failed reads, add a Learn
  revision check and improve polling independently.
- **Cons.** The same policy would still live in several places, with panel-specific tests and
  refresh triggers.
- **Rejected because** each new panel would still have to decide when its scope and data changed.
  This approach would suit an isolated endpoint failure with an already shared scope and version policy.

### Option B — One client store per open item (chosen)

- **Pros.** One existing endpoint supplies scope, versions and workflow status to every panel. A
  single polling loop and an ordered write queue keep reads and optimistic changes consistent.
- **Cons.** The change crosses several panels. Transcript text and title still arrive through a
  dashboard refresh, and polling still generates requests.

### Option C — Server-pushed item revisions

- **Pros.** An event on the existing stream could wake the store as soon as a version moves, including
  changes from other tabs.
- **Cons.** Writers would need reliable post-commit event coverage and database-backed fan-out across
  processes. Polling would still cover missed events.
- **Rejected because** the pending-advance deadline and bounded retry address the observed
  post-action lag without introducing another cross-process delivery contract. Revisit if polling
  still leaves a measurable delay for open items.

## Decision

**We chose Option B.** Panel fetches converge on the same server projection and keep the last good
content while loading or on error. Optimistic folder chips show pending work immediately. The
server's `access.contentView` controls when content reads change scope.

## Key technical details

- `src/lib/pipeline/presentation.ts` builds versions from stored rows. Title and topics use SQL
  `md5` of the stored ciphertext where a write marker is missing, without decrypting it. There is
  no new column or stored counter. Summary, language and topics writers can bypass the pipeline
  advance request, so a counter at that boundary would miss changes. The item version combines
  part versions and advance generations. Versions cover the item's own rows. Joined Almanac data
  and people names in Knowledge continue to refresh through Organization events.
- `src/components/items/item-detail-store.tsx` owns the projection and its single polling loop. It
  uses the server's relative deadline with a 3 s floor and revalidates on focus, visibility and item
  invalidations, including existing Organization events. After invalidation it reads immediately,
  then backs off at 1, 2, 4 seconds and so on for at most 30 seconds while the item version stays
  the same. A pending advance counts as busy, giving the server deadline a 5 s ceiling.
- `src/components/items/item-operation-queue.ts` serializes writes for one item, including when
  the detail closes. Pending changes replay over the latest projection, and failure removes its own
  operation. A write can settle the detail with its returned projection. Otherwise, only a projection
  read requested after the write answered can settle it. The dashboard applies the same ordering
  to its folder snapshot and keeps the edit until a snapshot requested after the answer arrives.
- The maintainer's transcript rule sets the default once per visit. A visible workflow on the first
  projection chooses its source in workflow order (Custom, Mix, Plaud). Otherwise the preferred
  source supplies the default. A cold open provisionally shows the workflow order. After choosing
  the default, only an explicit tab selection, a workflow action targeting a source, or the current
  transcript disappearing can change it. Learn actions select the source Learn uses.
- The detail keeps its panel instances across private and Organization rows for the same item.
  When projected transcript or title versions get ahead of the server-rendered props, the store
  requests a dashboard refresh and briefly holds dependent reads. Learn serves reviews only for the
  current input revision.

## Verification

- `src/tests/regressions/426-mail-detail-steady.test.tsx` exercises 4 cases through the dashboard.
  It checks private reads and the pending chip during filing, isolated rollback of a refused
  share, formatted message identity across rows, and summary and remarks across a version refresh.
- In the stacked PRs, `221-processing-status.integration.test.ts` and
  `426-learn-review-revision-fence.integration.test.ts` check server versions, deadlines and Learn
  fencing. `426-filing-keeps-summary.test.tsx`, `426-folder-operations.test.tsx` and
  `426-panels-follow-versions.test.tsx` check recording scope, queue settlement and transcript
  selection. The demo browser checks covered recording filing and withdrawal with the summary
  retained.
- On Node 22, 522 tests passed in the changed suite. The full PostgreSQL run passed 13,342 tests
  with 204 skipped.

## Consequences & open follow-ups

- This resolves the workflow strip's delayed refresh after the person's own actions in the
  processing-profiles campaign and closes the same item's panel and folder races in #426.
- A re-transcription in another tab can supersede the review behind an unsent Learn draft. The draft
  can be lost, and the server rejects writes against that old revision.
- Server-pushed item revisions and carrying speaker names across re-transcriptions by speech
  overlap are deferred from #426. Revisit push if users still observe open-item lag. Handle speaker
  carry-over in the attribution flow when its effect on Learn proposals can be measured.

## Related work

- The processing-profiles record's phase-only comparison after a person's action is superseded by
  bounded polling against the item version. [Processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md)
- The pipeline-settlement record's client polling rule is superseded by the item store, version-based
  retries and the pending-advance deadline. Relative scheduling and worker settlement still apply.
  [Pipeline steps settle their jobs](2026-10-22-pipeline-steps-settle-their-jobs.md)

## Timeline

- **2026-11-20** The maintainer ruled on transcript selection. PRs #427, #430, #432 and #435
  implemented projections, the store, the queue and panel refreshes. The last slice verified mail
  and removed the obsolete client names.
