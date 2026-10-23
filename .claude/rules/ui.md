---
paths:
  - "src/components/**"
  - "src/app/**/*.tsx"
  - "src/hooks/**"
  - "src/app/globals.css"
---

# UI components and pages

- Prefer **server components**; use `"use client"` only for interactivity.
- Toasts via `sonner`; no `alert()` or custom toast systems.
- Client components that fetch from our own API use existing `/api/...` routes; no duplicate
  client-side Plaud API calls.
- Performance first (`AGENTS.md`, Product principles): optimistic updates on writes, data-loader
  patterns and link prewarm on hover, no JS or data waterfalls.
- User-facing strings and the product name follow `.claude/rules/i18n.md`.
- No generic arrow functions (`<T,>(x) =>`) in `.tsx` (`AGENTS.md`, Code quality).

## Target UX comparisons

- **Yes:** Linear, Vercel dashboards.
- **No:** generic self-host transcription stacks (Whisper + a script). Chatterbox must feel like a
  product, not a pile of utilities.

## One body per widget

When a widget appears in more than one variant (inline card and dialog, recording pane and mail
pane, personal and Organization list), one body component holds all its logic: state, fetching,
apply. The variants only frame it. Its behavior tests run once per variant from one suite
(`describe.each`). The personal and Organization versions of a list look and act the same (one
card, row, empty state and dialog; the same actions); the Organization version stands apart only
through its title, the `Users` icon in the Organization colour and a subtle accent border.

## The Organization colour

Every mark that means "Organization" (folder icons and chips, Organization profile and share chips,
Organization item headers, Almanac and People badges, Organization provider cards) uses the
`organization` token from `src/app/globals.css` (`text-organization`, `bg-organization/…`,
`border-organization/…`), never `blue-*` or `primary`. Private folders, selection highlights,
focus rings, calls to action and progress stay `primary`.

## Screenshots

To see a change in a real browser, the disposable E2E stack in `docker-compose.e2e.yml` builds the
working tree (`docs/DEVELOPMENT.md`, "Isolated Docker E2E Instance"). It and the other
`docker-compose.e2e*.yml` stacks, including the user-guide demo stack, may be started for browser
checks without asking (`AGENTS.md`, Commands and tests); the real stack still needs the user's
go-ahead.
