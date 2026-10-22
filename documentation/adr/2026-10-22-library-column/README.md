---
title: The dashboard's library column browses by location, with a folder rail from 1280 px, walk-in folders below it, and one Organization colour
date: 2026-10-22
updated: 2026-10-22 17:00
status: accepted
kind: feature
issues: []
prs: [226, 228, 237]
areas: [src/components/dashboard/workstation.tsx, src/components/dashboard/folder-tree.tsx, src/components/dashboard/library-location-header.tsx, src/components/dashboard/folder-settings-panel.tsx, src/components/recordings/folder-picker.tsx, src/lib/folders/navigation.ts, src/lib/folders/permissions.ts, src/hooks/use-library-preferences.tsx, src/app/globals.css]
supersedes: []
superseded-by: []
relates: [2026-10-19-transcript-card-and-one-header, 2026-10-22-arrivals-never-move-selection]
---

# The dashboard's library column browses by location, with a folder rail from 1280 px, walk-in folders below it, and one Organization colour

The dashboard's left column was rebuilt around folders, which had been hidden behind a small
"Uspořádat" toggle (PR #226). The column always has one current location (Nedávné, Soukromé,
Organizace or a folder). From 1280 px it is drawn as a folder rail next to the list and the detail;
below that, as walk-in folders (breadcrumb and subfolder grid) inside the list column. A folder
filters the list, subfolders included. The folder table is gone; its functions moved to a folder
settings panel. One folder matcher serves the folder picker, the rail filter and ⌘K. Newcomers open on
the Organization. Testing with real data then gave every Organization mark one colour token and put
the item's folder on each list row (PR #228), and one rule for where a subfolder may be created
(PR #237).

## Why

The maintainer named four problems:

- the left column grew far taller than the recording detail next to it;
- "Uspořádat" was too small, so many users would never open the folder tree, although folders are
  the product's key mechanism;
- the number of folders can be high, especially in the Organization part where colleagues share
  recordings together;
- newcomers saw an empty Recent list and did not know that "Uspořádat" revealed the Organization's
  recordings.

Found along the way: a folder opened as a table that replaced the recording detail, so going through
a folder meant clicking it again after every recording; ⌘K did not find folders; and "Přidat do
složky" was a plain two-group menu with no search and no path, so two folders with the same name
could be told apart only by their group.

### Previous state

`libraryMode` switched the column between a Recent list (50 rows, growing as the page scrolled) and
a fully expanded folder tree. Opening a folder showed `FolderRecordingPane`, a table in the right
column with sort by title, date, duration and size, the folder's mail address, default processing
profile, export, rename and delete. Organization folders used stock Tailwind blue in the column,
while the rest of the app marked the Organization with the red primary.

## Decisions taken

| Date | Decision | Why | Detail |
|------|----------|-----|--------|
| 2026-10-21 | Variant C (rail, list, detail) from 1280 px, variant D (walk-in folders) below | C is the only layout that shows folders, the list and the detail together; D handles hundreds of folders and keeps two columns where there is no room for three | Both are rendered from one state and Tailwind shows one per breakpoint, so the first paint does not jump |
| 2026-10-21 | One location state replaces `libraryMode` and the "Uspořádat" mode | The tree as a hidden mode was the core problem | The URL holds folder and item together; old links with only one of them still work |
| 2026-10-21 | A folder's list includes its subfolders, each row naming its subfolder | Going through a folder one item after another keeps the location | Default taken by the assistant, not yet confirmed |
| 2026-10-21 | The folder table goes; its functions move to a folder settings panel | Browsing now happens in the list; the table held settings that had to live somewhere | Only the side-by-side columns view is lost (not yet confirmed) |
| 2026-10-21 | One folder matcher for the picker, the rail filter and ⌘K; "Přidat do složky" becomes a searchable picker | Many Organization folders and duplicate names; the maintainer asked for autocomplete in the detail's picker | Names first, then paths, diacritics ignored; built on cmdk, which the app already shipped |
| 2026-10-21 | Newcomers with no items of their own and a non-empty Organization open on Organizace, newest item open | Newcomers saw an empty list and a blank detail | A banner offers Sync and Upload; both empty keeps the onboarding empty state |
| 2026-10-21 | Rail and list fill the viewport under the header and scroll on their own | The column was taller than the detail | From `lg` up; below it the page scrolls as before |
| 2026-10-22 | All three planned phases ship as one PR | The maintainer asked for it | PR #226, instead of foundation, location and rail as three PRs |
| 2026-10-22 | One `--organization` colour on every mark that means "Organization" | The same thing showed in two colours on one screen | Private folders, selection, focus rings, calls to action and progress stay primary red |
| 2026-10-22 | List rows show the item's first folder instead of the transcript start | The transcript start told nothing; the folder places the item | Search excerpt first, then mail sender, then folder, then nothing (PR #228) |
| 2026-10-22 | One rule for where a subfolder may be created, mirroring the server | The location header offered "New folder" to members in nested Organization folders although the server allowed a subfolder | `canCreateSubfolder()`, used by the panel, the header and the tree (PR #237) |

## Rejected outright

| Option | Rejected because | Revisit if |
|--------|------------------|------------|
| A: two big tabs, Nedávné and Složky | Cheapest, but folders stay a place you switch to, which was the original problem | Never on its own; it is the old mode with a bigger button |
| B: three recently used folders and "Všechny složky" above the list | Fine for small libraries; with many folders most of the tree is one click away again | Libraries turn out to stay small |
| C at every width | The detail loses about 230 px and phones would get a third navigation level | Screens below 1280 px stop mattering |
| A JavaScript screen-width check choosing C or D | The first paint would jump between layouts | Never; CSS breakpoints carry it |
| Keeping the folder table as a browsing view | The list column took over browsing; its settings moved to the panel | People miss the columns view (the maintainer has not confirmed dropping it) |
| Pinned folders in "Naposledy použité" | Automatic recently used folders need no setup | People ask for pins (default taken, not confirmed) |
| Mixing the Organization's newest items into Nedávné | Noisy in a large Organization; they live under Organizace | The maintainer decides otherwise (default taken, not confirmed) |
| Stock `blue-*`, or the primary red, for Organization marks | Two colours for one meaning, or the same colour for private and Organization | Never |
| Relative colour syntax (`oklch(from …)`) for the token | Browser support | Supported in every browser the app targets |

## Key technical details

- Location and history: `src/components/dashboard/workstation.tsx`. User navigation pushes history,
  automatic selection replaces it. Opening a folder keeps the item being read when it is in that
  folder.
- Rail: `src/components/dashboard/folder-tree.tsx` (collapsed below the first level, current path
  open, long levels show the eight most active folders then "Všech N"); walk-in header:
  `library-location-header.tsx`; settings panel: `folder-settings-panel.tsx`; picker:
  `src/components/recordings/folder-picker.tsx`.
- Matcher: `src/lib/folders/navigation.ts`. A new folder search must reuse it, not add a fourth one.
- Browser preferences (tree state, recently used folders, rail collapsed) live in `localStorage`
  under a per-user key (`src/hooks/use-library-preferences.tsx`); every access is wrapped and the page
  renders correctly without them.
- Permissions did not change: the server stays the authority, the panel only hides actions the
  server refuses anyway. `canCreateSubfolder()` in `src/lib/folders/permissions.ts` mirrors the
  server's `createFolder` check: anywhere private, inside nested Organization folders, and directly
  under the Organization root only for curators and the Organization account.
- Collaborative filing is kept: members may move colleagues' items between Organization folders.
  The rule is documented in `src/lib/folders/folders.ts`.
- Colour: `--organization` in `src/app/globals.css` is the primary's oklch lightness and chroma at hue
  255, written as literal values: light `oklch(0.5565 0.1747 255)` (4.53:1), dark
  `oklch(0.6793 0.1817 255)` (5.15:1), exposed as `text-organization`, `bg-organization/…`,
  `border-organization/…`. New Organization UI uses these classes, never `blue-*` or `primary`.
- Known limit: a row placed in two subfolders of the folder you are in moves only from the first
  placement when dragged.
- No schema, env or compose change; the only server change added `duration` and `size` to the sort
  allowlist.

## Verification

- `src/tests/folders/library-column.test.tsx` (rail, walk-in, drag move and copy, row menu, keeping
  the item being read, ⌘K with an empty query), `library-navigation.test.ts` (the matcher),
  `library-preferences.test.tsx` (storage throwing), `folder-settings-panel.test.tsx` (member, curator
  and Organization account), `folder-picker.test.tsx`;
  `src/tests/dashboard/command-palette-folders.test.tsx`; `recording-list-folders.test.tsx` (12 cases,
  PR #228).
- PR #226: whole suite 6,877 passed (99 skipped); browser check on a demo stack at 1440, 1100 and
  390 px, light and dark, as a member and as a newcomer. PR #228: 466 tests in 30 changed files. PR
  #237: 177 passed, 12 of them new; no browser walkthrough.

## Consequences & open follow-ups

- **Four defaults are not confirmed by the maintainer:** Nedávné shows only the user's own items;
  recently used folders are automatic with no pins; a folder's list includes its subfolders; the
  table's side-by-side columns view is dropped. Any of them may still flip.
- Open question from the maintainer: whether members should be allowed to move colleagues' items
  between Organization folders. Collaborative filing stays until he decides.
- **Every folder list must follow live folder changes.** The filing card loaded its folders once, so a
  folder created in the column while the card was open could not be chosen until a reload (fixed by
  PR #241). The maintainer then asked for the shared folder search to become one reusable autocomplete
  that replaces the folder selects and picks up folders created or changed while it is on the page
  (PR #242, open).

## Related work

- [2026-10-19-transcript-card-and-one-header](../2026-10-19-transcript-card-and-one-header.md): the
  shared header and ⌘K palette that gained the Folders group here.
- [2026-10-22-arrivals-never-move-selection](../2026-10-22-arrivals-never-move-selection.md): the same
  location state must not be moved by a sync or mail arrival; the jump it fixed came from a stale
  folder-only URL.

## Timeline

- **2026-10-21**: problem statement; proposals page with layouts A to D; the maintainer chose C with D
  below 1280 px and asked about the folder table; final proposal with a three-PR plan.
- **2026-10-22**: all phases in one PR, PR #226 merged; real-data test, PR #228 merged; PR #237 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
