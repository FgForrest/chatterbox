---
title: One app header on every page with search scoped to the page, and topics as a chapter bar with a list instead of arrows
date: 2026-10-19
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [183, 184]
areas: [src/components/app-header.tsx, src/components/app-chrome-provider.tsx, src/app/api/app-search, src/lib/search/app-search.ts, src/components/dashboard/transcript-chapter-bar.tsx, src/app/(app)/layout.tsx]
supersedes: []
superseded-by: []
relates: [2026-10-07-sentence-playback-two-way-sync, 2026-10-22-library-column]
---

# One app header on every page with search scoped to the page, and topics as a chapter bar with a list instead of arrows

Klepy, Almanach and Úkoly now share one header: page-scoped search, Upload and the ≡ menu (Settings,
Help, Re-run setup, Log out), with the settings dialog, help drawer, onboarding and global shortcuts
mounted once in the app layout (PR #184). ⌘K opens search scoped to the current page; Tab switches
to "Všude" (everywhere). In the transcript card, speaker chips became play-button chips and topics
became a sticky chapter bar showing where you are, whose title opens the list of all topics; there
are no previous/next arrows (PR #183).

## Why

The maintainer flagged three things. The right-click hint next to the speaker chips wrapped badly
with three or more speakers. The "Témata" menu and the "Zobrazit původní" button looked unfinished
and had to be remembered. Almanach and Úkoly had their own header with no ≡ menu and no search, so
Settings and Log out were unreachable there and Help existed only as a separate button on those two
pages.

### Previous state

Each page rendered its own header. The transcript card stacked a hint row, a "Topics (n)" menu and a
"Show original" button above the text; speaker playback was a right-click on the chip (PR #75).

## Options considered

### Transcript card: C, play-button chips plus a chapter bar (chosen)

Chips start with a ▶ in the speaker's colour (click plays the next turn, the name opens the picker,
right-click stays as a shortcut). Topics become a sticky bar inside the transcript ("3 / 9", current
title); the original-text switch sits at its end and appears only when Learn changed something.

- **Pros:** topics are always visible where the text is; no hint text needed.
- **Cons:** the most work of the three (scroll tracking); the bar takes about 50 px inside the
  transcript.

### Transcript card: A, chips in one row with a tooltip, then a view bar (declined)

- **Rejected because:** right-click playback stays hidden until someone hovers a chip; it was the
  smallest change but kept topics as a separate menu.

### Transcript card: B, the same chips in one toolbar (declined)

- **Rejected because:** it was the cheap version of C's chips without the chapter bar, so topics
  stayed a menu to remember. The maintainer took B's chips into C.

### Moving between topics: N1, the list only (chosen)

The bar shows where you are; a click on the title opens all topics with their times.

### Moving between topics: previous/next arrows on the bar's sides (declined)

- **Rejected because:** the maintainer found the ‹ › arrows not intuitive. Two replacements were
  offered as well, ⌃⌄ together at the end of the bar (N2) and the next topic shown by name (N3); he
  chose the list alone ("N1 only"), keeping one control (inferred for N2 and N3).

### Header: one component on every page, Help inside ≡ (chosen) versus a visible Help button (declined)

- **Rejected because:** the separate Help button existed only on Almanach and Úkoly, while Klepy
  already kept Help in ≡ next to Settings and Log out; the maintainer chose ≡ everywhere. The help
  icons inside cards stay.

### Search: scoped to the page by default, "Všude" one Tab away (chosen)

"Hledat v Almanachu" finds people, things and taught forms; "Hledat v úkolech" finds visible tasks;
list filters such as "Hledat osoby" keep filtering their lists.

### Search: always everywhere, current page's results first (declined)

- **Rejected because:** the maintainer chose page scope as the default; on the Almanac or Tasks page
  the reader is looking for that page's records (inferred), and everywhere stays one key away.

## Decision

**Card variant C with the list-only chapter bar; one shared header with page-scoped search.** A new
top-level page uses the shared header and adds its own search scope rather than a header of its own.
Arrows on the chapter bar were tried and rejected; re-proposing them needs a reason the maintainer's
"not intuitive" did not cover.

## Key technical details

- `src/components/app-header.tsx` and `src/components/app-chrome-provider.tsx`; the settings dialog,
  help drawer, onboarding and shortcuts (⌘K, `,`, `?`) mount once in `src/app/(app)/layout.tsx`, so
  every ≡ item works on every page.
- `GET /api/app-search?scope=chatter|almanac|tasks|all&q=` (`src/app/api/app-search/route.ts`,
  `src/lib/search/app-search.ts`). **Invariant:** results follow the same visibility rules as the
  lists: own items, Organization sharing, masking of colleagues' mail; deleted items excluded.
  Guards: a per-user rate limit, a 2-character minimum, a deadline on the task scan, cancellation on
  abort, `%` and `_` matched literally. A new scope must apply the same rules.
- `requireAuth`, the Organization-account check, the settings row and the Plaud row use React
  `cache()`, so layout and page share one read per request.
- The chapter bar (`src/components/dashboard/transcript-chapter-bar.tsx`) follows the audio while
  playing and the reading position while paused; when the transcript is collapsed it stays above it,
  not sticky, so topics remain reachable. Follow-along and jumps scroll to below the bar.
- Below a 560 px card width the card's header actions become icon buttons; at 380 px the app header's
  search, Upload and ≡ do the same.

## Verification

- `src/tests/dashboard/transcript-chapter-bar.test.tsx`, `transcript-card-behavior.test.tsx`,
  `transcript-reading-line.test.tsx`, `transcript-card-layout.test.tsx` (PR #183).
- `src/tests/dashboard/app-header.test.tsx`; `src/tests/search/app-search.integration.test.ts` on
  PostgreSQL (user scoping, Organization visibility, another user's private item never returned,
  colleague mail masked, literal `%` and `_`); `app-search-route.test.ts` and
  `app-search-bounds.test.ts` (PR #184). Whole suite at merge of PR #184: 5,812 passed.

## Related work

- [2026-10-07-sentence-playback-two-way-sync](2026-10-07-sentence-playback-two-way-sync.md): the
  follow-along and reading line that the chapter bar tracks and sits above.
- [2026-10-22-library-column](2026-10-22-library-column/README.md): the next rework of the dashboard,
  which puts folders into ⌘K and the shared header's search.

## Timeline

- **2026-10-19**: proposals page with variants A, B, C and the header; the maintainer chose C and the
  shared header, rejected the side arrows, then chose N1; PR #183 and PR #184 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
