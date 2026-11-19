---
title: Remove per-share review from Care
date: 2026-11-18
updated: 2026-11-19 07:44
status: accepted
kind: fix
issues: []
prs: []
areas: [src/components/almanac/care-queue.tsx, src/lib/knowledge/care-summary.ts, src/lib/knowledge/share-review.ts, src/db/queries/almanac-share.ts, src/app/api/knowledge/care/shares/route.ts]
supersedes: [2026-10-22-almanac-curator-desk]
superseded-by: []
relates: [2026-11-18-owner-review-before-share]
---

# Remove per-share review from Care

Care lists duplicate candidates, conflicting facts, conflicting corrections and thin records. Curators can correct an individual share's additions from the affected record or fact in a folder's Knowledge panel.

## Why

The maintainer, after going through a share's two dozen additions in Care: checking them is tiring, "I would simply trust the recording owners. It is beyond one person's capacity to go through it anyway." Folder flags already give curators a way to correct a mistake where they find it.

### Previous state

Care grouped additions from the last 14 days by share. A curator could mark a group reviewed to clear it from the badge and from folder flags. The queue and the folder flags both offered single-addition deletion and whole-share undo.

## Options considered

### Option A: keep the section as history (declined)

The assistant's recommendation: drop the badge contribution and the review action, keep a 14-day list
with single-addition deletion and whole-share undo, so a bad share can be undone from one place.

- **Rejected because:** the maintainer chose to remove the section entirely and gave no further
  reason; the undo controls stay reachable from the folder Knowledge panel.

### Option B: remove the section (chosen)

Remove the section, its badge contribution and the review action. Curators keep the controls in folder
Knowledge flags. This removes the standing workload at the cost of a central list of recent additions.

### Option C: only exclude shares from the badge (declined)

The badge would stop growing with share volume, with minimal change to the queue.

- **Rejected because:** the section and its "Mark reviewed" would still ask a curator to check every
  share, which is the work the maintainer wants gone.

## Decision

The maintainer chose option B. Care directs curator time to specific problems. Recording owners are trusted to share, and curators can delete an addition or undo a share's additions from a folder flag when a problem surfaces. Revisit a central history if curators need a documented way to investigate additions across folders.

## Key technical details

- The folder flag opens one event through `GET /api/knowledge/care/shares` with `eventId`. Pagination applies to additions within that event. The `delete` and `undo` actions use the existing dependency checks and preserve the item's sharing status.
- The `almanac_share_events` and `almanac_share_changes` tables still record provenance. The schema and backup and archive formats stay as they are. The review columns hold historical values, and undo writes its own timestamp and actor.

## Verification

- All 15 tests in `src/tests/regressions/240-care-queue.test.tsx` passed, covering the four Care sections, folder flags, addition pagination and undo feedback.
- All 74 PostgreSQL tests in `src/tests/regressions/240-care-queue.integration.test.ts` passed, covering the badge count, former review markers, event lookup, single-addition deletion, safe undo and archive restore.

## Consequences & open follow-ups

- In the folder Knowledge panel, records and facts a share added in the last 14 days carry a neutral
  "Added by N shares" line, separate from the amber "open problems" flag and not counted in it, so a
  share is not presented as work. Every recent share of a record is listed, not only the newest:
  without the central list, the newest-only lookup would have hidden an earlier share's undo.
- A prior review marker no longer hides anything; `reviewed_at` keeps its historical values.
- Curators lose the central view of recent additions across folders.

## Related work

- This partially supersedes the per-share queue, badge contribution and review action in the curator desk decision. Folder flags, provenance and undo still apply. [Curator desk](2026-10-22-almanac-curator-desk.md)
- [Owners finish reviews before recordings are shared with the Organization](2026-11-18-owner-review-before-share.md) requires owners to finish Learn and task review before a recording is first shared and shows those reviews only to owners.

## Timeline

- **2026-11-18** The maintainer chose to remove per-share review from Care.
