---
title: Every push to main is a calendar-versioned release (YYYY.N); dev is the integration branch
date: 2026-10-12
updated: 2026-10-22 17:00
status: accepted
kind: process
issues: []
prs: [119, 120]
areas: [BRANCHING.md, .github/workflows/release.yml, .github/workflows/docker.yml, .github/workflows/mail-receiver.yml, .github/workflows/pr-review.yml, .claude/agents/pr-reviewer.md, src/lib/version.ts, content/docs/self-hosting/install.mdx]
supersedes: []
superseded-by: []
relates: [2026-10-22-agent-instructions-and-decision-records]
---

# Every push to main is a calendar-versioned release (YYYY.N); dev is the integration branch

The fork moved from a rolling `main` to two branches: `dev` integrates feature PRs (and is the
default branch), and `main` only receives merges from `dev`, each of which is a release numbered
`YYYY.N` (2026.1, 2026.2, …, 2027.1). `release.yml` computes the number, builds the app and
mail-receiver images, and only then tags and publishes a GitHub release with generated notes and the
deploy files attached. The same line removed upstream's one-line installer and added a Claude Code
review of every PR into `dev`. The maintainer chose this from a numbered list of options on
2026-10-12; PR #119 shipped it and its merge produced release 2026.1.

## Why

- **Deployments should run releases, not a branch.** A deployment pinned to `latest` needs real
  releases; before, every push to `main` published only `:dev`.
- **The fork had no releases of its own.** `package.json` still carried upstream's `0.6.4`, the
  update badge compared against upstream's semver tags, and releasing was a manual two-phase script
  (`scripts/release.ts`) that bumped `package.json`, rewrote `CHANGELOG.md` and opened a release PR,
  after which a pushed tag was meant to trigger the builds.
- **GitHub constraints:** a tag pushed with `GITHUB_TOKEN` starts no other workflow, and CI cannot
  push a version-bump commit to a protected `main`.

### Previous state

`main` was the integration branch; feature PRs merged there and every push built `:dev`. Releases
were drafted from a `## [X.Y.Z]` section in `CHANGELOG.md`, and the release failed without one.

## Options considered

| Question | Chosen | Rejected alternative | Rejected because |
|----------|--------|----------------------|------------------|
| Branch model | `dev` integrates, `main` releases on every push | Keep `main` as the rolling integration branch | Deployments should run numbered releases, and a rolling `main` only ever published `:dev` |
| Version scheme | `YYYY.N`, a number that counts up per calendar year | Semantic versioning | The maintainer wanted no major/minor distinction, only a number that increases with each release; a breaking change is marked in the PR title instead |
| Format | `2026.1`, no zero padding, no `v` prefix | `2026.01` | A busy year in which every merge to `main` releases can pass 99 |
| Release mechanics | One workflow that computes the version, builds, then tags and publishes | Keep the two-phase script with tag-triggered builds | A tag pushed by the workflow's own token cannot start the build workflows, and a version bump cannot be pushed to protected `main`, so the version comes from the build instead of `package.json` |
| Release notes | Generated from the titles of the PRs merged since the previous release | Curated in `CHANGELOG.md` | With automatic releases, a curated entry would have to be written in every `dev` to `main` PR. `CHANGELOG.md` keeps the pre-CalVer history and is frozen |
| Update badge | Compares with the fork's own latest release (CalVer) | Remove the badge | Comparing against upstream's semver tags meant nothing for the fork's own scheme, while checking the fork's releases was a small change that keeps self-hosters told about updates (inferred) |
| Docs-only pushes to `main` | Release too | Skip them | Simplicity: every push to `main` is a release, without exceptions |
| Upstream's one-line installer | Removed (PR #120) | Leave it untouched (the initial recommendation) | It served upstream's riffado.com, so its script, routes and links pointed at another project's releases and only confused; the fork deploys from the compose file and env template attached to each release |

## Decision

**Chosen: the combination in the table.** A release is a merge, not a ritual: merging `dev` into
`main` is the only release action, the version is computed rather than committed, and a failed
build releases nothing. The installer went because it contradicted that model. The maintainer also
asked for an AI review of PRs into `dev` in the same round; it was added alongside rather than
chosen over an alternative.

## Key technical details

- **`release.yml`**, on push to `main`, one run at a time: compute the next number from the current
  year's tags; build both images through the reusable `docker.yml` and `mail-receiver.yml` (amd64
  and arm64, tagged `:<version>` and `:latest`); only when both pass, tag the merge commit and
  publish the release with generated notes plus `docker-compose.yml` and `env.example`. A re-run
  takes the same number; a re-run on an already released commit does nothing.
- **The version is a build argument** (`APP_VERSION`, exposed as `NEXT_PUBLIC_APP_VERSION`) read by
  `src/lib/version.ts`: footer, `/api/health` and bug reports. Images built from `dev` show
  `dev-<commit>`.
- **The release assets are the deploy surface** (`AGENTS.md`): `docker-compose.yml` and
  `env.example` as attached to a release, no longer an installer script.
- **A PR title is a release-note line**, and a breaking change carries `!` with its migration note in
  the PR description, copied into the release text afterwards (`BRANCHING.md`, `AGENTS.md`).
- **`ENV HOSTNAME=0.0.0.0` in the runtime image** looks redundant but is not: Docker sets `HOSTNAME`
  to the container id, so the standalone server listened on the container address only and the
  `localhost` healthcheck never passed. Host exposure is still decided by `ports:`.
- **The installer removal kept the `install_script_hits` table**, so no migration had to drop it;
  `/install.sh` and `/<version>/install.sh` now return 404.
- **AI review:** `.github/workflows/pr-review.yml` runs Claude Code with the persona in
  `.claude/agents/pr-reviewer.md` on PRs into `dev`, including `ready_for_review` (a draft marked
  ready fires only that event). It re-reviews every push.

## Verification

- `src/tests/version.test.ts`; actionlint clean on every changed workflow; 2833 tests passed on
  PR #119 and 2826 on PR #120 (the difference is the deleted install-hit test).
- The workflows themselves could not run before merge. The merge of PR #119 was their first run and
  published release 2026.1 the same day.

## Consequences & open follow-ups

- **Feature PRs target `dev`; nothing is pushed to `main` except a release.** Hotfixes go through
  `dev` too, unless `dev` holds work that must not ship, in which case a branch from `main` is merged
  back into `dev` afterwards (`BRANCHING.md`).
- **`dev` may be broken at any commit**; deployments pull `:latest` or a pinned release.
- **The review needs repository-level setup** that lives outside the code: the `ANTHROPIC_API_KEY`
  secret visible to the repository and the Claude GitHub App installed on it.
- **`CHANGELOG.md` is frozen**; adding entries to it is wrong from 2026.1 on.

## Related work

- [2026-10-22-agent-instructions-and-decision-records](2026-10-22-agent-instructions-and-decision-records.md): restructured the agent rules the review bot reads and added the ADR convention.

## Timeline

- **2026-10-12**: options put to the maintainer as a numbered list and answered; calendar-versioned
  release pipeline with the AI review (PR #119) merged, release 2026.1 published, `dev` created and
  made the default branch; one-line installer removed (PR #120).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
