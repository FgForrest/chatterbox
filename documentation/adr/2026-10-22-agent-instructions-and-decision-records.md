---
title: AGENTS.md stays the single source of agent rules, area rules move to path-scoped files, and decisions are recorded as ADRs with a generated, checked index
date: 2026-10-22
updated: 2026-10-22 17:00
status: proposed
kind: process
issues: []
prs: []
areas: [AGENTS.md, CLAUDE.md, .claude/rules, .claude/agents/pr-reviewer.md, documentation/adr, scripts/generate-adr-index.mts, src/tests/adr-index.test.ts]
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
into records. Built on 2026-10-22 on a branch, awaiting the maintainer's review.

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

### Where sub-threshold reasoning goes

The copied convention sent it to code comments; `AGENTS.md` allows JSDoc on exported APIs only and puts
rationale in the commit message. `AGENTS.md` was kept; whether one-line constraint comments should be
allowed is an open question for the maintainer.

### The index

- **Generated from front matter and validated (chosen).** The generator fails on missing or unknown
  fields, a filename date that disagrees with `date:`, invalid values, and `supersedes`/`relates`
  links not mirrored by the named record; `--check` writes nothing.
- **A hand-kept table (declined).** **Rejected because:** it rots and cannot enforce two-way links.
- Index refs render as plain `#n` / `PR #n`; links to the repository URL are opt-in (`--links`),
  so the generated index carries no repository owner name.

## Decision

All the chosen options above, proposed as one change. The reconstructed records follow the
convention: one record per line of work, an alternative only if it was really on the table, every
inferred reason marked, and no names, company or production details.

## Key technical details

- `AGENTS.md` keeps what every task needs (public-repository rule, code quality, testing, git rules,
  deployment contracts, CRITICAL blocks) and the area table; the exact globs are in each rule's
  `paths:`.
- Path-scoped rules match paths relative to the checkout that holds them: a session started in the
  main checkout that edits files in another worktree does not load them (noted in `CLAUDE.md`).
- `scripts/generate-adr-index.mts` runs with `node` 22.18 or later (type stripping), no dependencies;
  `src/tests/adr-index.test.ts` covers it.
- The PR review persona (`.claude/agents/pr-reviewer.md`) now reads the area rules for the changed
  paths.

## Verification

Headless Claude Code sessions in the worktree loaded `AGENTS.md` and the `CLAUDE.md` notes at start
and a rule file only after reading a matching file. Generator: 11 tests; `--check` passes on the
reconstructed records. Biome and `tsc` clean.

## Consequences & open follow-ups

- Open for the maintainer: constraint comments; deleting the local `docs/plans/` files once mined; the
  squash-merge rule versus merge commits in practice; running `--check` in CI.
- Records for work in flight carry `status: proposed` and empty `prs` until their PRs merge.

## Related work

- [2026-10-12-calver-releases-from-dev](2026-10-12-calver-releases-from-dev.md): introduced the PR
  review bot whose persona now reads the area rules.

## Timeline

- **2026-10-22**: restructure and ADR convention requested; built on a branch; history reconstructed
  into records.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
