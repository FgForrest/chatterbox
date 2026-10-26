---
title: Members see three aggregate statistics scopes on shared self-host
date: 2026-10-26
updated: 2026-10-26 17:34
status: proposed
kind: feature
issues: [287]
prs: []
areas: [src/db/queries/statistics.ts, src/components/statistics, src/app/api/statistics]
supersedes: []
superseded-by: []
relates: []
---

# Members see three aggregate statistics scopes on shared self-host

Every signed-in member can read Mine, Organization and Everyone statistics on a shared self-hosted instance. Everyone includes private items as aggregate numbers. Organization and Everyone include a named people ranking visible to every signed-in member. Hosted and local deployments expose Mine only.

## Why

Shared self-hosted teams need a usage overview that helps members understand and increase their use of the app. Named comparisons serve that purpose, but expose colleagues' activity and spending. The visibility boundary must therefore be explicit and enforced before querying, rather than inherited from a hidden UI control.

### Previous state

Only hosted operators had daily usage dashboards. Organization-provider management already had a privileged usage list. There was no general member statistics page and no authorization to inspect private content through statistics.

## Options considered

### Option A: member-visible ranking and three aggregate scopes (chosen)

- **Pros:** members can compare contributions and understand the instance's use without an administrator exporting reports.
- **Cons:** Everyone exposes the amounts and timing of private activity, and the ranking associates totals with colleagues' display names. Aggregates are not anonymous data.

### Option B: administrator-only ranking and no private-item aggregates (declined)

- **Pros:** follows the privileged Organization-provider usage list and reveals less about private activity.
- **Cons:** ordinary members cannot compare their use to the team or see total adoption.
- **Rejected because:** issue #287 explicitly accepts member-visible comparisons to motivate use on shared self-hosted instances. The restriction would remove that intended behavior. Revisit if the deployment's privacy expectations change.

## Decision

**Chosen: Option A.** Mine follows item ownership and payer identity. Organization follows current shared placement for items, Organization ownership for knowledge, and Organization payer identity for spend. Everyone includes every account's retained data, once per item, actual usage event or live knowledge record. It never returns content. Organization needs an existing Organization account; Everyone remains available in shared mode without one.

Everyone and Organization are refused on hosted deployments and in local mode, even if an old Organization account remains in the database. The ranking never includes the Organization account. Colleague names use account display names, with a neutral Member fallback for absent or email-shaped names; account emails and identifiers are not returned.

## Key technical details

- `loadStatistics` checks scope and deployment before starting parallel aggregate queries. The API authenticates through `requireApiSession`; the server page through `requireAuth`.
- Activity and spend intentionally have separate scope predicates: Organization may pay for a member's private item. Such spend belongs to Organization without exposing the item itself.
- Shared transcript and summary rows stay owner-held. Summary latency reads the owner's earliest summary and ignores historical Organization-owned copies. Almanac promotion moves a record or merges into an existing one; merge tombstones are excluded. Folder placement is an existence predicate, so multiple placements cannot multiply totals.
- Task resolution ranking uses the transition's `actorUserId`, falling back to `statusChangedByUserId` for legacy tasks without history; spend uses its event's `actorUserId`. Null or Organization actors remain in totals but are not ranked.
- The first hourly housekeeping run of each UTC day upserts storage totals in one SQL statement for every existing user, including measured shared bytes. A transaction advisory lock guards the indexed day check and measurement: any existing row for today skips the run, and a failure rolls back and is retried by the next hourly run, never by the 5-second worker tick. No job-queue marker is used. Accounts created later wait until the next UTC day; their measured contribution is zero before their first row. The composite primary key keeps upserts idempotent. Only downloaded, retained audio and retained raw MIME (attachments included) count; export archives can live on separate backup storage and stay outside this chart. Missing days carry the last observation, and estimates precede the first snapshot. Snapshots survive item erasure, cascade on account deletion, and are excluded from portable content archives.
- Task creation and actual status changes append history in the writer's transaction. Resolutions survive reopening; dismissed proposals are excluded from dropped counts. Legacy tasks retain the latest-state fallback without invented history. Archives embed optional transitions in each task, including own tasks; restore preserves history, maps missing actors to null, and accepts older archives. Task deletion cascades history, including the source of a merge; open-task merges do not invent transitions.
- Everyone deduplicates aliases by their target, kind, keyed text and correction identity across scopes. People and entities move in place or leave merge tombstones, rather than gaining live copies. Independently created, unlinked records cannot be reliably deduplicated.
- Meeting Recorder records also carry `deviceSn=local`: its `meeting-` file prefix takes precedence over the generic upload marker, preserving the source split.
- All five processing steps retain their meaning; correction is grouped into Learning. Unknown operations appear as Other. Unpriced jobs remain visible without inventing a cost.
- Daily compact arrays allow local range selection. Per-member ranking arrays use base64 delta/zero-run varints, decoded once per loaded scope, with millisecond durations and microdollar costs; uncompressed ranking tuples alone exceeded 300 KB on a dense 50-member year. Latency retains second-resolution weighted distributions, so weekly percentiles are computed from recordings rather than daily percentile averages. The preceding year's minutes support an equally long comparison for every range.

## Verification

- `src/tests/statistics/data.test.ts`: 23 tests for range slicing, scales, time zones, percentiles and compact ranking transport.
- `src/tests/statistics/page.test.tsx`: 16 tests, including measured/dashed storage boundaries and the measured-since caption.
- `src/db/queries/statistics.integration.test.ts`: 43 PostgreSQL tests covering scope/privacy, concurrent daily snapshot claims, same-day skips, UTC rollover, failure rollback and retry without job rows, late-account zero/carry-forward behavior, measured values and baselines, legacy and logged task counts, actor attribution and knowledge deduplication. Simultaneous legacy task transitions do not depend on random id ordering.
- The statistics and jobs batch passes 218 tests across 12 files on Node 22, including PostgreSQL statistics, housekeeping and job-queue integration tests and both areas' unit tests.
- `src/tests/tasks/status-transitions.integration.test.ts`: 8 PostgreSQL tests for creation, review, source and routed changes, concurrent versions, no-ops, merges, cascades, and full ZIP archive/restore round-trips of own and mail tasks. Legacy archives and missing historical actors are covered.
- Full unit suite on Node 22: 6,392 passed across 575 passing files. The affected-area batch passed 903 tests across 64 files, including statistics, tasks, housekeeping, backups/exports, sharing, MCP task tools and migration checks.
- The full migration chain through `0143` applies to empty integration databases, including on top of `0142`. The generated SQL creates only the two new tables and their constraints/indexes.
- The 50-member PostgreSQL fixture with 2,499 recordings returns 37,958 bytes of JSON for 365 days. A varied dense fixture with 18,250 active member-days returns 195,458 bytes. All nine aggregate statements use indexes in the selective Mine scope.
- Browser checks in the seeded demo stack covered 1440px desktop and 390px phone, both themes, English and Czech, tables, tooltips, brushing and scope switching, without page overflow or console errors. `src/tests/regressions/287-statistics-chart-width.test.tsx` pins chart width measurement.

## Consequences & open follow-ups

- This decision reveals private activity totals to shared self-host members; changing that boundary requires a superseding decision. It grants no access to private recording or mail content and creates no correspondence graph.
- Both deployment modes receive additive migration `0143_shallow_mariko_yashida.sql`, creating `storage_daily_snapshots` and `task_status_transitions`, with no environment or compose changes. Existing installations need no configuration changes. Older images ignore the new tables, so application rollback requires no data recovery.
- A scope-query regression can expose aggregates to unintended users; explicit refusal and ownership tests guard this boundary in both modes. Snapshot failures leave prior measurements available. Task/log failures roll back together and affect only the attempted edit.
- Storage before the first measurement and tasks predating transition history remain estimates. Task erasure removes history; aggregate storage snapshots remain until account deletion. This is not an audit ledger or a history of item ownership and sharing.

## Timeline

- **2026-10-26**: three scopes, shared-mode availability and member-visible rankings accepted in issue #287; implementation and tests prepared without schema changes.

- **2026-10-26**: additive schema approved for daily measured storage and transactional task status history; backup parity and legacy fallbacks included.
