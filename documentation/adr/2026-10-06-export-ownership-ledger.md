---
title: Folder exports keep a ledger of what they wrote and move it, instead of never deleting anything
date: 2026-10-06
updated: 2026-10-22 22:30
status: accepted
kind: fix
issues: []
prs: [87]
areas: [src/lib/folder-exports, src/lib/folder-exports/filesystem-nodes.ts, src/lib/folder-exports/drive-provider.ts, src/db/schema.ts]
supersedes: [2026-09-28-google-drive-export]
superseded-by: []
relates: []
---

# Folder exports keep a ledger of what they wrote and move it, instead of never deleting anything

The filesystem folder export now records every file and directory it creates in
`filesystem_export_nodes` before creating it, and may move, overwrite or delete exactly those and
nothing else (PR #87). When a recording changes placement (filed from the export root into a folder,
moved between folders, renamed) the export moves its directory instead of writing a second copy. A
recording deliberately filed in several folders still gets one copy per folder. The Google Drive
export moves files the same way and trashes only its own duplicates. This reverses the maintainer's
earlier rule that an export never deletes files.

## Why

The maintainer found the export directory in "total chaos". A recording transcribed quickly was
exported into the export root under its first title. Filing it into a folder created a second
directory there and wrote audio, transcript and summary again; the root copy stayed under the old
title. Renames did the same. The same recording could exist in several places on disk.

The constraint: the export root is a directory people also use. It may hold files the export did not
write, so "delete what is no longer planned" is only safe for files the export can prove it wrote.
The maintainer's requirement was exactly that: the export may fully manipulate what it created,
tracked by database rows, and must never touch unknown files or folders.

### Previous state

Filesystem folder exports arrived with PR #48 and readable directory names with PR #49. From the
start the export never deleted files: PR #49 states that disabling an artifact type "stops future
materialization without deleting files already exported", and PR #60 added pruning of directories
only while empty, repeating that "the export still never deletes files, so a directory holding any,
the user's own included, stays". The Drive design (PR #61) mirrored the same rule: only empty
folders go. The maintainer later called it his own decision ("my decision about non-removing
existing files"); it was made before the session history that survives, so PR #49 is its earliest
written trace.

The rule was acceptable while placements rarely changed. It broke once filing, automatic titles and
sharing made placement changes routine: placements were keyed by (recording, folder), so a new
placement was a new directory, and the old one was never empty, so it was never removed.
Separately, a plan requested while another plan of the same export was running was folded into the
running job and lost.

## Options considered

### Keep "never delete" and clean up by hand (declined)

- **Pros:** zero risk of deleting a file someone cares about.
- **Cons:** every placement change leaves a full duplicate.
- **Rejected because:** the duplicates were the reported problem; the maintainer reversed the rule.

### Ownership ledger with moves (chosen)

Record each created node before creating it; pair a placement a recording left with one it gained
and move the directory; delete or trash only owned nodes the plan no longer has.

- **Pros:** one copy per placement; foreign content provably untouched; audio is moved, not
  downloaded again.
- **Cons:** a new table, adoption of what earlier versions wrote, and collision rules when names
  meet.

### Multi-folder filing: one copy per folder (chosen)

Only moves (root to folder, folder to folder, renames) must not duplicate.

### Multi-folder filing: a single final placement (declined)

Offered as "most recent assignment wins" (recommended at the time) or "deepest folder wins".

- **Rejected because:** the maintainer chose one copy per folder: filing into two folders is
  deliberate, and each folder's export should be complete on its own (inferred). "Deepest folder"
  also ignores what the user did last.

### Audio reaped by retention stays in the export (chosen) versus mirroring (declined)

- **Rejected because:** once retention removes the app's own copy, the exported file may be the only
  one left; mirroring would delete it.

### Drive: move, trash only own duplicates (chosen) versus filesystem-only rules (declined)

The maintainer's answer: move files where possible; trash only files the export created that
duplicate the file in its correct placement; orphans stay on Drive. Keeping Drive on the old
never-touch-files behavior was the declined alternative.

- **Rejected because:** Drive had the same duplicate problem; trashing is reversible for 30 days and
  limited to the export's own tagged files.

### Legacy installs: adopt everything old rows say was written (chosen) versus current placements only (declined)

- **Rejected because:** adopting only current placements would leave today's stale duplicates on
  disk forever as unknown files, to be deleted by hand once.

## Decision

**Chosen: the ownership ledger with moves**, one copy per folder, reaped audio kept, Drive trashing
only its own duplicates, and adoption of legacy rows. It removes the duplicates while keeping the one
promise that matters for a shared directory: what the export did not create, it never touches. A
return to "never delete" would need a new record.

## Key technical details

- `filesystem_export_nodes` (migration `0089`) and `filesystem_export_settings.nodes_adopted_at`
  live in `src/db/schema.ts`; the node store is `src/lib/folder-exports/filesystem-nodes.ts`, the
  planner `planner.ts`.
- Foreign content: new directory names skip foreign names (`Title (2)`); a directory still holding
  foreign files stays; a foreign file at a path the export must write fails that file with
  `ExportPathTakenError` (`filesystem-provider.ts`), shown on the export and not retried.
- Moves: whole directory when everything in it is the export's, otherwise file by file. A pending
  file reuses an already written copy by moving it. Recording directories avoid every name in their
  folder, the export's own included, so a recording never inherits the directory of one that is
  leaving. A directory move claims the new paths, renames, then releases the old ones.
- Cleanup order: stale files first, then owned files and empty owned directories the plan no longer
  has.
- Drive (`drive-provider.ts`): a stale copy is trashed only once the same artifact is written in its
  place; until then its row waits for the next plan. Trashing refuses paths outside the picked
  folder.
- Adoption: the first plan of a filesystem export adopts every path earlier versions recorded as
  written, stale rows included, and skips paths another export of the same user already owns. The
  first plan after upgrading therefore deletes existing duplicates the export wrote.
- Synchronize forgets nodes removed from disk before planning, so those files are written again.
- A plan requested while one is processing queues one follow-up job (`<exportId>:again`,
  `jobs.ts`).
- Looks like a bug but is intended: a recording filed in two folders is exported twice; reaped audio
  stays in the export after the app deleted its own copy; deleting an export configuration leaves its
  files on disk.

## Verification

- `src/tests/folder-exports/placements.integration.test.ts` on PostgreSQL: filing moves instead of
  writing again; move plus rename; one copy per folder; a second copy leaves the first; nothing it did
  not create is moved, reused or deleted; a foreign file in the way is refused; legacy duplicates are
  cleaned; reaped audio is kept and moved; synchronize rewrites removed files; a recording never gets
  a departing recording's directory; adoption skips another export's paths; one follow-up plan.
- Drive: move without re-upload and legacy duplicate trashed, plus provider unit tests in
  `src/tests/folder-exports/drive-provider.test.ts`.
- At merge the full suite passed against PostgreSQL: 2819 passed (seven suites timed out only in
  `afterAll` database drops under parallel load and passed alone). An adversarial review led to the
  collision and failure fixes listed above.
- Not run at merge against a real export directory or real Google Drive.

## Consequences & open follow-ups

- Open at merge (rated low by the review): with several worker processes, a change arriving in a
  short window around the end of a plan can still be missed. A single-process self-hosted instance
  cannot hit it; hosted, with several processes, could.
- Nested filesystem targets (one export's target inside another's) are not rejected. Adoption skips
  paths another export of the same user owns, which covers the first plan only.
- Orphans on Drive (files the export wrote whose artifact is gone) stay; only duplicates are trashed.

## Related work

- [2026-09-28-google-drive-export](2026-09-28-google-drive-export.md): introduced the Drive provider,
  its node map and the trash-own-folders rule that this record widens to own duplicate files, so it
  supersedes that rule.

## Timeline

- **2026-09-18**: filesystem folder exports and readable directory names (PRs #48, #49); the export
  never deletes files.
- **2026-09-23**: empty-directory pruning, files still never deleted (PR #60).
- **2026-10-05**: the maintainer reverses the rule and answers the placement, reaped-audio, Drive and
  adoption questions; implementation and review fixes; PR #87 opened.
- **2026-10-06**: PR #87 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
