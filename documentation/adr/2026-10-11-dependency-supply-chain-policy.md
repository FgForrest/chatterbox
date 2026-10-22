---
title: Production dependencies come from well-known publishers or our own code, and installs wait seven days and refuse provenance downgrades
date: 2026-10-11
updated: 2026-10-22 16:00
status: accepted
kind: process
issues: []
prs: [10, 99, 112, 113, 115]
areas: [pnpm-workspace.yaml, package.json, .github/workflows/ci.yml, .github/dependabot.yml, scripts/snowball-stemmers.sh, src/lib/knowledge/stemming/snowball, src/lib/notifications/email-components.tsx, src/lib/transcription/gemini-transcribe.ts, src/components/app-progress.tsx]
supersedes: []
superseded-by: []
relates: [2026-10-01-name-matching-across-word-forms, 2026-10-11-inbound-mail]
---

# Production dependencies come from well-known publishers or our own code, and installs wait seven days and refuse provenance downgrades

On 2026-10-11 the maintainer audited the production dependencies for packages that do not come from
well-known sources, and gave each one of three outcomes: port it into our code, build it from the
official upstream source, or drop it. The same line set the install-time trust policy: pnpm refuses
any release younger than seven days (`minimumReleaseAge: 10080`) and any release published with
weaker provenance than its predecessors (`trustPolicy: no-downgrade`), and CI reports
`pnpm audit --prod` without failing the build. PR #113 carried most of it; PRs #99, #112 and #115
cleared the advisories around it, and PR #10 had earlier applied the same waiting idea to GitHub
Actions.

## Why

- **The threat is a future release, not today's code.** The maintainer's rule was to avoid a
  malicious version slipping in later from an untrusted publisher. Small or single-maintainer
  packages are that risk; supply-chain safety ranks above convenience.
- **Advisories arrived through packages nobody chose.** After PR #99's refresh (audit 59 to 18),
  14 of the 18 remaining alerts, including the only critical one, came through
  `@xenova/transformers`, last released in May 2024 and unfixable from outside.
- **Dependabot lags.** Advisories for an upload parser published on 2026-10-08 had no alert three
  days later, so the repository cannot rely on alerts alone.
- **Constraints:** the local-AI path (in-browser transcription) must keep working
  (`AGENTS.md`, core invariants), and stemming output feeds the Almanac's name matching.

## Options considered

Each package was weighed with an estimate of work, packages removed and safety gain. The
alternatives below were on the table; the outcome column is what shipped.

| Package | Outcome | Rejected alternative | Rejected because |
|---------|---------|----------------------|------------------|
| `snowball-stemmers` | Official Snowball 3.1.1 JavaScript, generated from snowballstem.org's sha256-pinned source and vendored in `src/lib/knowledge/stemming/snowball`; `scripts/snowball-stemmers.sh` rebuilds and checks it | Copy the package's single generated file into the repository | It is about 23,000 lines (19,000 for the languages used) that nobody would review: the same trust as the package, only frozen |
| Slovene stemmer | Dropped: Slovene names match without stemming, as English does | Copy only the old package's Slovene stemmer next to the official ones | Its source is not Snowball's, and neither Snowball nor the project the in-house Czech, Slovak, Polish and Romanian stemmers were ported from (see `NOTICE`) has one |
| `react-email` packages (deprecated) | The 14 components used ported into `src/lib/notifications/email-components.tsx` (MIT, credited in `NOTICE`) | Keep the dependency | About 31 packages for components that only emit table markup with inline styles; the port was gated on byte-identical HTML |
| `@google/generative-ai` (deprecated) | Plain `fetch` to Gemini's REST `generateContent`, key in the `x-goog-api-key` header only; retired models dropped | Google's successor `@google/genai`; Gemini's OpenAI-compatible endpoint through the `openai` package | The successor brings `protobufjs`, `ws` and Google's auth library, more than before. The compatible endpoint has no `/audio/transcriptions`, only `chat.completions` with `input_audio` (checked in documentation only, no live call, by the maintainer's choice) |
| `sanitize-html` | DOMPurify in the browser (PR #110, inbound mail) | Our own allowlist sanitizer on `htmlparser2` | A sanitizer is the classic attack surface, and we would be the only ones looking for its bugs. DOMPurify comes from a security firm and uses the browser's own parser, which removes the server-versus-browser parsing mismatch most bypasses exploit |
| `radix-ui` (all-in-one) | Replaced by the three `@radix-ui/*` parts the UI imports | Write our own dialogs, selects and menus | Weeks of work, and the value of Radix is focus handling, keyboard navigation and accessibility, where a rewrite brings bugs |
| `@xenova/transformers` | `@huggingface/transformers` 4.3.0, its maintained successor (PR #112) | Drop in-browser transcription | It is the privacy-critical local-AI path. Dropping it was the agreed fallback only if the migration failed |
| `@bprogress/next` | Our own progress bar (`src/components/app-progress.tsx`) | Drop the progress bar | It works, so it was ported rather than removed |
| `undici`, `react-hook-form` | Dropped | | Unused |
| `@esbuild-kit/esm-loader` under `drizzle-kit` | Removed with a pnpm override (PR #115) | Upgrade `drizzle-kit`; wait for Dependabot | The latest `drizzle-kit` still lists the loader, and its range caps esbuild at 0.18, so Dependabot's security update could never apply. `drizzle-kit` never imports it |

Kept deliberately: the mail and authentication packages, `postgres` and `drizzle-orm`, `archiver`
(a bug in hand-written ZIP code would silently corrupt backups), `react-markdown`, the AWS SDK,
`openai`, Next.js and React, and small dependency-free packages from known sources (`nanoid`,
`clsx`, `date-fns` and similar), where porting gains next to nothing.

## Decision

**Chosen: per-package triage plus an install-time policy.** The triage removes the publishers the
rule worries about; the policy covers the ones that stay, because a compromised publish is usually
caught and yanked within days and nothing here needs a release the day it ships. Install rules in
`pnpm-workspace.yaml`:

- `minimumReleaseAge: 10080` (seven days, raised from one day). Exclusions are pinned to single
  versions.
- `trustPolicy: no-downgrade`: a release with weaker provenance than earlier versions is refused.
- `allowBuilds` lists every package allowed to run an install script; `onnxruntime-node` is
  `false`, so the postinstall that downloads native binaries never runs.

CI gets an `Audit (report only)` job (`.github/workflows/ci.yml`) that writes `pnpm audit --prod`
into the job summary and never fails the run; the advisories left at the time had no reachable path
and would otherwise have failed every build (inferred). Dependabot applies a cooldown to GitHub
Actions bumps (`.github/dependabot.yml`: 3 days for a patch, 7 for a minor, 30 for a major), which
acts earlier than pnpm's guard: the PR is never opened.

A fix that cannot wait a week is handled by a pinned exclusion, never by lowering the age for
everything.

## Key technical details

- **Adding a dependency:** prefer an official or well-known publisher, or a small port of our own.
- **An urgent fix younger than seven days** goes into `minimumReleaseAgeExclude` as an exact version,
  and comes out again once it has aged. A too-young transitive package can often be avoided without
  an exclusion by choosing an older version that still satisfies the range.
- **`pnpm audit --fix update` writes exclusions and narrows devDependency ranges** as a side effect;
  revert both, the lockfile resolves the same without them. Exact-version overrides go stale and
  can pin a vulnerable version in place (PR #99 found `postcss` and `js-yaml` held that way).
- **Stems are computed at lookup and never stored**, so changing stemmers needs no migration. Rebuild
  them only with `scripts/snowball-stemmers.sh`.
- **The transformers WASM runtime is still fetched at run time from a CDN**, pinned to the
  installed `onnxruntime-web` version, as before the migration.

## Verification

- PR #99: `pnpm audit` 59 to 18 (critical 2 to 1, high 38 to 10). PR #112: 18 to 4, nothing left in
  the transformers subtree. PR #113: production audit at 2 advisories, both unreachable (an MCP SDK
  OAuth client the app does not use, and an esbuild development server).
- PR #113: 9 direct dependencies removed and 3 added from the same Radix project; the lockfile went
  from 1062 to 901 packages with no package added or changed. Full suite with Postgres: 3470 passed.
- Email port: the HTML of all 18 templates in two languages was snapshotted before the port
  (`src/tests/email/templates-html.test.ts`, `src/tests/email/__snapshots__/`); all 36 snapshots
  stayed byte for byte.
- Stemmers: `scripts/snowball-stemmers.sh --check` confirms the committed files are Snowball 3.1.1's;
  stemming tests ran on Node 24, Node 22 and Bun 1.4 (`src/tests/knowledge/stemming/`). On
  Snowball's own vocabularies the share of words whose stem changed: Dutch 46% (a new Dutch
  algorithm), Turkish 10%, Italian 6%, French 4%, German 3.5%, Swedish 2%, others under 1%.
- `pnpm install --frozen-lockfile` passes under the new policy; PR #115's override passes it too and
  `drizzle-kit check` still loads the config.

## Consequences & open follow-ups

- **Name matching changed for some languages** where Snowball 3.x stems differently, and Slovene is
  no longer stemmed.
- **Gemini credentials on retired models** open with the model in the Custom field and keep working
  for as long as Google serves it; one with no model moves to the new default.
- **Merges can trip the policy.** If a lockfile from another branch fails the trust policy during a
  merge, exclude the package for that one install and remove the exclusion again.
- **The audit job reports, it does not gate.** Someone has to read the job summary; Dependabot and
  the alert APIs remain the other inputs.

## Related work

- [2026-10-01-name-matching-across-word-forms](2026-10-01-name-matching-across-word-forms.md): the
  Almanac's word-form matching runs on the stemmers this record moved to the official Snowball
  source.
- [2026-10-11-inbound-mail](2026-10-11-inbound-mail/README.md): the switch from sanitize-html to DOMPurify was ruled in this audit and shipped with the mail work.

## Timeline

- **2026-09-13**: Dependabot cooldown for GitHub Actions bumps (PR #10).
- **2026-10-07**: security refresh of Next.js, nodemailer and the transitive tree (PR #99).
- **2026-10-11**: production dependency audit and the maintainer's per-package rulings; in-browser
  transcription moved to `@huggingface/transformers` (PR #112); fewer dependencies, official
  sources, seven-day release age and trust policy, report-only audit job (PR #113); dead
  `drizzle-kit` loader removed (PR #115).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
