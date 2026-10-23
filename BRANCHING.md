# Branching & Release Model

Integration happens on `dev`; every push to `main` is a release. Deployments
run releases, not branches.

## Branches

| Branch | What it is | Who uses it |
|--------|------------|-------------|
| `dev` | Integration branch and the repository's default branch. Feature branches open PRs here, merged with a merge commit as they land (squashing is optional). May be broken at any commit. Every push publishes the `:dev` images. | Contributors, CI, the AI review |
| `main` | Release branch. Receives only merges from `dev`; every push to it is a release. | The release workflow, deployments via `:latest` |
| `feature/*`, `fix/*`, etc. | Short-lived branches with PRs into `dev`. | Contributors |

**`dev` is not a deployment target.** Production pulls `:latest` or a pinned
release.

## Versions

Releases use calendar versioning, `YYYY.N`: the year, then a number that
counts up from 1 with each release of that year (`2026.1`, `2026.2`, ... and
`2027.1` after New Year). There is no major/minor distinction; a breaking
change is marked in its PR title and the release notes instead. Tags carry
no `v` prefix.

## Releasing

Open a PR from `dev` into `main` and merge it. `release.yml` then:

1. computes the next version from the current year's tags,
2. builds the app image (`docker.yml`) and the mail receiver image
   (`mail-receiver.yml`) for amd64 and arm64, tagged `:<version>` and
   `:latest` on `ghcr.io/<owner>/<repository>` and
   `ghcr.io/<owner>/<repository>-mail-receiver`,
3. only when both builds pass, creates the git tag on the merge commit and
   publishes the GitHub release, with notes generated from the pull
   requests merged since the previous release and `docker-compose.yml` +
   `env.example` attached.

A failed build releases nothing; re-running the workflow takes the same
number. A re-run on a commit that is already released does nothing.

The version is baked into the image (`APP_VERSION` build argument): the
footer, `/api/health` and bug reports show it, and the footer's update
badge compares it with the repository's latest release. Images built from
`dev` show `dev-<commit>`.

### Release notes

The notes are the titles of the merged pull requests, so a PR title should
read as a line of release notes (see `AGENTS.md`). For a breaking change,
copy the migration note from its PR description into the release text after
the release is published.

## Hotfixes

Fix on `dev`, then merge `dev` into `main` as usual: there is no separate
release line. If `dev` holds unrelated work that must not ship yet, branch
from `main`, open the fix as a PR into `main`, and merge it back into `dev`
afterwards.
