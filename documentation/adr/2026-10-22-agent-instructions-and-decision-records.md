---
title: AGENTS.md stays the single source of agent rules, area rules move to path-scoped files, and decisions are recorded as ADRs with a generated, checked index
date: 2026-10-22
updated: 2026-10-22 22:30
status: accepted
kind: process
issues: []
prs: [245]
areas: [AGENTS.md, CLAUDE.md, BRANCHING.md, .claude/rules, .claude/agents/pr-reviewer.md, documentation/adr, scripts/generate-adr-index.mts, src/tests/adr-index.test.ts, .github/workflows/ci.yml, package.json]
supersedes: []
superseded-by: []
relates: [2026-10-12-calver-releases-from-dev]
---

# AGENTS.md stays the single source of agent rules, area rules move to path-scoped files, and decisions are recorded as ADRs with a generated, checked index

The maintainer asked for the agent instructions to be brought up to date and restructured along Claude
Code's best practices, and for decisions to be tracked formally with an ADR convention copied from
another project ("I need to track decisions in more formal way here"). The result: `AGENTS.md` is
the one file every agent reads, shrunk from 360 lines (32.6 KB) to about 200 (23.7 KB); area rules
live in twelve path-scoped files under `.claude/rules/`, each named in an area table in `AGENTS.md`;
a thin `CLAUDE.md` imports `AGENTS.md`; ADRs live in `documentation/adr/` with a generated index that
`scripts/generate-adr-index.mts --check` validates; and the history up to this day was reconstructed
into records. Merged into `dev` on 2026-10-22 as PR #245.

## Why

- **Codex is the main implementer and reads only `AGENTS.md`.** It ignores `CLAUDE.md` and
  `.claude/rules/`, and its documentation does not say it follows imports. It also stops adding
  instruction files at 32 KiB combined by default; the old `AGENTS.md` was 142 bytes under that, so
  any growth would have been cut off for Codex without a warning.
- **Claude Code's guidance:** keep the always-loaded file under about 200 lines, move what matters for
  only part of the codebase into path-scoped rules, and note that imports do not reduce context cost.
- **Decisions were being lost.** Rationale lived in PR descriptions, memories and git-ignored plans;
  at least one rule (the "Auto" output language of PR #55) was silently undone weeks later.
- **The copied convention did not fit:** it named another product, Java tooling and paths, a
  `specifications/` folder and a missing index script, and it conflicted with two `AGENTS.md` rules.

## Options considered

### How Claude Code and Codex share the rules

- **A thin `CLAUDE.md` that imports `@AGENTS.md` (chosen).** Works where Claude cannot read
  `AGENTS.md` directly, never loads it twice, and keeps working if someone adds a personal
  `CLAUDE.local.md`; leaves room for Claude-only notes.
- **No `CLAUDE.md` (declined).** Claude Code reads `AGENTS.md` directly today. **Rejected because:** a
  personal `CLAUDE.local.md` would silently switch that off, and Claude-only notes have no home.
- **A `CLAUDE.md` symlink (declined).** **Rejected because:** edit tools refuse to write through a
  symlink, and a Windows checkout gets a one-line file.
- **`CLAUDE.md` as the source with rules duplicated for Codex (declined, inferred).** Two copies
  drift; Codex is the main implementer, so its file must be the source.

### Where area rules live

- **Path-scoped `.claude/rules/*.md`, named in an `AGENTS.md` area table (chosen).** Claude loads a
  rule only when it reads or edits a matching file; Codex follows the table's pointers.
- **Everything in `AGENTS.md` (declined).** **Rejected because:** of the 32 KiB Codex limit and the
  200-line guidance.
- **Skills (declined).** **Rejected because:** skills load on description match and Codex does not load
  them; rules attach to paths deterministically.

### Where plans live

- **The existing git-ignored `docs/plans/` (chosen).** `.gitignore` already excludes every `plans/`
  directory; a plan ends as an ADR or is deleted. Durable TODOs stay in GitHub Issues as `AGENTS.md`
  says.
- **A new git-ignored `specifications/` folder (declined).** **Rejected because:** it duplicates a
  convention the repository already had.
- The maintainer confirmed `docs/plans/` on 2026-10-22: an implemented plan has no value of its own,
  so its lasting content moves into a record or the commit message and the file goes. The local
  plans of the work up to that day (91 files and a folder of review screenshots) were sorted that
  way: what no record held moved into the matching records, and the files were deleted.

### Where sub-threshold reasoning goes

The copied convention sent it to code comments; `AGENTS.md` allows JSDoc on exported APIs only and puts
rationale in the commit message. `AGENTS.md` was kept, with one exception the maintainer allowed on
2026-10-22: a one-line comment at a site may state why that line must stay as it is, when a future
change could silently break a constraint there. Narrative and strategy comments stay out.

### The index

- **Generated from front matter and validated (chosen).** The generator fails on missing or unknown
  fields, a filename date that disagrees with `date:`, invalid values, and `supersedes`/`relates`
  links not mirrored by the named record; `--check` writes nothing.
- **A hand-kept table (declined).** **Rejected because:** it rots and cannot enforce two-way links.
- Index refs first rendered as plain `#n` / `PR #n`, so the index carried no repository owner name.
  The maintainer chose clickable links as the default on 2026-10-22: the repository's own GitHub
  identifiers are exempt from the public-repository rule. `--plain` keeps the plain form; `--links`
  is gone.

### Partial reversals

- **`relates` plus a note in the older record** (the reconstruction's first reading): superseding a
  whole record for one changed rule would hide the rules that still hold.
- **Supersede on any rule change (chosen by the maintainer, 2026-10-22).** A record is marked
  `superseded` as soon as a later decision changes any of its rules, and a short "Superseded in part"
  note at its top names the changed rule and says the rest holds. **The `relates` reading lost
  because:** a reader scanning the index could not tell which records no longer hold as written
  (inferred). The reconstructed records were converted the same day.

## Decision

All the chosen options above, merged as one change. The reconstructed records follow the
convention: one record per line of work, an alternative only if it was really on the table, every
inferred reason marked, and no names, company or production details.

## Key technical details

- `AGENTS.md` keeps what every task needs (public-repository rule, code quality, testing, git rules,
  deployment contracts, CRITICAL blocks) and the area table; the exact globs are in each rule's
  `paths:`.
- Path-scoped rules match paths relative to the checkout that holds them: a session started in the
  main checkout that edits files in another worktree does not load them (noted in `CLAUDE.md`).
- `scripts/generate-adr-index.mts` runs with `node` 22.18 or later (type stripping), no dependencies;
  `src/tests/adr-index.test.ts` covers it. `pnpm adr:index` and `pnpm adr:index:check` wrap it, and
  CI's lint job runs `--check`.
- The PR review persona (`.claude/agents/pr-reviewer.md`) now reads the area rules for the changed
  paths.

## Verification

Headless Claude Code sessions in the worktree loaded `AGENTS.md` and the `CLAUDE.md` notes at start
and a rule file only after reading a matching file. Generator: 11 tests in
`src/tests/adr-index.test.ts` at merge, 12 after the default-links change; `--check` passes on the 50
reconstructed records. Biome and `tsc` clean. CI (lint, type check, test, build, CodeQL) was green on
the merged head.

## Consequences & open follow-ups

- Settled by the maintainer on 2026-10-22: constraint comments allowed; the local `docs/plans/` files
  mined and deleted; PRs into `dev` are merged with merge commits (squash optional), matching
  practice; `--check` runs in CI; index refs are links; partial reversals supersede; the sandbox e2e
  and demo stacks may be started for browser checks without asking; the unused `task` and `triage`
  labels stay out; the PR template was deleted (the upgrade-steps rule stays in `AGENTS.md`); the
  hosted invariants, the `riffado/ops` pointer and the Read-tool rule stay as they are.
- Records for work in flight carry `status: proposed` and empty `prs` until their PRs merge.

## Related work

- [2026-10-12-calver-releases-from-dev](2026-10-12-calver-releases-from-dev.md): introduced the PR
  review bot whose persona now reads the area rules.

## Timeline

- **2026-10-22**: restructure and ADR convention requested; built; history reconstructed into
  records.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
- **2026-10-22**: merged as PR #245, after fixing two generator issues CodeQL flagged (a title ending
  in a backslash broke its table cell; an existence check before each file read was a race).
- **2026-10-22**: follow-up: the maintainer answered the open questions (see *Consequences*); rules,
  CI, the generator and the records updated; local plans deleted.
