---
title: An arriving recording or e-mail never moves the selection; one corner notice offers to open the newest
date: 2026-10-22
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [235, 236]
areas: [src/components/dashboard/workstation.tsx, src/components/dashboard/arrival-notice.tsx, src/lib/history-state.ts, src/app/(app)/layout.tsx]
supersedes: []
superseded-by: []
relates: [2026-10-22-library-column]
---

# An arriving recording or e-mail never moves the selection; one corner notice offers to open the newest

When a recording or e-mail arrives while the dashboard is open, the selection, the folder and the URL
stay where they are. A single notice in the bottom-right corner (docked at the bottom on phones)
names the newest arrival and offers "Otevřít"; a newer arrival replaces it, so there is never more
than one (PR #236). The jump to the new item that prompted this came from history writes Next.js
ignored, fixed separately (PR #235).

## Why

The maintainer: when a new recording or e-mail arrived, the dashboard navigated straight to its
detail, which was "disturbing" because the user may have been working on something else. People lost
their place while reading whenever a sync or a mail push landed.

### Previous state

The dashboard's `pushState` / `replaceState` calls copied Next.js's internal history keys. Next 16
treats such writes as its own and does not sync the URL into its router, so the next router commit (a
refresh after a sync or mail push, or auto-sync) restored an older folder-only URL, and the
dashboard's location reader then opened that folder's newest item: the new arrival. The same defect
could close an open recording outright. Arrivals were announced by a "Synchronizováno N nových
nahrávek" toast.

## Options considered

### Leave the screen alone and show one notice (chosen)

The maintainer's own proposal: an unobtrusive notice with Open or close, at most one, always the
newest. The design page then put five questions to him (A to E below).

### Keep navigating to the newest arrival (declined)

- **Rejected because:** it takes the reader away from what they were doing; that was the complaint.

### A: the notice hides by itself (declined)

Hide after 30 seconds, with hover pausing the timer.

- **Rejected because:** an auto-hide that fires while the user looks away loses the only pointer to
  the new item. The notice stays until Open, close, opening the item another way, the item
  disappearing, or leaving the dashboard.

### B: count further arrivals, "+N další" (chosen) versus the latest item only (declined)

- **Rejected because:** without a count, a sync that brings three recordings looks like one.

### C: a notice for items a colleague shares to the Organization (declined)

- **Rejected because:** in a large Organization these arrive all day and would keep replacing the
  user's own arrivals. They still appear in the Organization folders.

### D: an app-wide notice on Úkoly, Almanach and Settings (declined for now)

- **Rejected because:** only the dashboard already knows every item; the other pages would need a
  new endpoint to learn about arrivals. Revisit as a follow-up if people miss arrivals there; until
  then those pages keep the sync toast.

### E: keep the sync toast next to the notice (declined)

- **Rejected because:** both would say the same thing. On the dashboard the notice replaces the
  "Synchronizováno N nových nahrávek" toast, and the sync-notifications setting never silences the
  notice. The "no new recordings" toast after a manual sync and browser notifications are unchanged.

## Decision

**An arrival never changes the selection, the folder or the URL.** One notice, newest wins, counts
the rest, never hides itself, dashboard only, own items only, and replaces the sync toast there. The
invariant is the part that outlives this change: any future code that reacts to new items (sync, mail
push, a recorder upload, a new channel) must announce, not navigate.

## Key technical details

- The notice is a sonner custom toast with the fixed id `new-item` and no timeout
  (`src/components/dashboard/workstation.tsx`, `arrival-notice.tsx`), so a newer arrival replaces it
  instead of stacking. The dashboard remembers which of the viewer's own item ids it has already
  shown; ids present at page load are never arrivals.
- Open behaves exactly like clicking the row: it pushes history, so Back returns; phones switch to the
  detail view. The title updates in place when the AI title lands or the item is renamed.
- Own uploads: an upload that finishes while the user has not clicked anything since starting it
  still opens itself (as before); one that finishes after the user moved on gets the notice.
- History writes go through `getAppHistoryState()` (`src/lib/history-state.ts`), which drops Next's
  internal keys and keeps application keys such as `mobileView`. Copying Next's keys into a history
  write is what produced the jump; never do it again.
- Processing data in the detail is keyed by kind, view and item and stays empty until the current
  item's data arrives; the previous item's "transcript exists" once triggered a dashboard refresh that
  undid a fresh selection.
- The app layout used to mount a second `<Toaster />`, so sonner rendered every toast twice; only the
  root one remains (also removed from the hosted admin layout).

## Verification

- `src/tests/regressions/unfiled-selection.test.tsx`: arrivals of a newer private recording, mail and
  Organization recording leave the selection, folder and URL in place; a control test reproduces the
  old jump when history writes forward Next's keys; a selection survives a router commit; all three
  original regressions failed before PR #235.
- `src/tests/dashboard/workstation-empty-upload.test.tsx` ("Dashboard arrival notices"): one notice
  for the newest, Open selects and pushes history, close keeps the selection, upload ownership.
  `src/tests/dashboard/arrival-notice.test.tsx` (Czech plural forms of "+N další") and
  `arrival-toaster.test.tsx` (one notice with the root toaster).
- PR #236: whole suite 7,246 passed, 99 skipped; browser check on a demo stack: two uploads made
  elsewhere showed one notice with "+1" and the newest title, Open selected it, at 400 px the notice
  docked at the bottom.

## Consequences & open follow-ups

- Arrivals are announced only on the dashboard; an app-wide notice is a possible follow-up (D).
- The dashboard keeps its selection on arrival only with both PRs merged; PR #236 alone shows the
  notice but would still have jumped.

## Related work

- [2026-10-22-library-column](2026-10-22-library-column/README.md): the location state (folder plus
  item in the URL) that an arrival must not move; the stale folder-only URL behind the jump belonged
  to it.

## Timeline

- **2026-10-22**: the maintainer reports the jump and asks for a notice; design page with questions A
  to E answered the same morning; PR #235 (selection kept after router updates) and PR #236 (the
  notice) merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
