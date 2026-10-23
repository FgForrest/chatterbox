# Chatterbox: agent guidelines

Chatterbox (Czech name: Klepna) is an AGPL-3.0 companion app for AI voice recorders, based on upstream [Riffado](https://github.com/riffado/riffado). It syncs recordings (the Plaud Note family today, plus browser meeting recordings and uploads), transcribes and summarizes them through pluggable AI providers, receives mail, and keeps an Organization knowledge base (the Almanac) that AI clients read over MCP. In practice it is a place where a team shares its communication, internal and external: recordings, mail, transcripts, summaries, tasks, and an Almanac of the people and things they involve. Stack: Next.js 16 App Router, TypeScript, Drizzle on Postgres, vitest, Biome, next-intl (`en`, `cs-CZ`).

This file is the entry point for every coding agent. Area rules live in `.claude/rules/`: before you edit files in an area, read the rule file the [area table](#area-rules) names for it. Claude Code loads them by itself; other agents must open them.

## First task

If the user did not give you a concrete task, read this file + `README.md` + `BRANCHING.md`, then ask which area to work on (sync, transcription, AI providers, summaries and tasks, Learn and the Almanac, mail, the Organization and sharing, storage, export and backup, MCP and SSO, UI, settings, onboarding, notifications, the recorder extension, landing).

## The One Rule

Understand what you're changing. Chatterbox is live and in use: people depend on it to access their recordings, transcripts, and storage. If you can't explain what your change does and how it interacts with the rest of the system, don't ship it.

Using AI to write code is fine. Submitting AI-generated code you don't understand is not.

## Public repository

- This repository is public. Never write real people's names (from recordings, screenshots, production data, colleagues), the operating company's name or domain, production hostnames, server paths, ids or content of production records, or private operations content into code, fixtures, tests, docs, ADRs, commit messages, or issue and PR text. Use invented names that keep the property a test needs (`Jitka Dvořáková` for Czech diacritics) and neutral placeholders (`example.com`, `Acme`). Exempt: upstream Riffado attribution, and the repository's own GitHub and image identifiers as they already appear in `package.json` and `docker-compose.yml`.
- Before committing, check the staged diff and the commit message for the real names in the task's evidence, as a separate step whose hit stops the commit.
- Hosted production runbooks live in the private `riffado/ops` repository, not in this public repository. This pointer documents only its existence; do not copy private operational content, production identifiers, customer data, preflight evidence, or incident details into public files, issues, commits, or logs. Secrets belong in the deployment secret manager even when working in the private repository. If a hosted operations task requires that repository and access is unavailable, stop and ask the maintainer.

## Style

- Keep answers short and concise. No fluff or cheerful filler text.
- No emojis in commits, issues, PR comments, or code.
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!").
- Avoid overusing spaced em dashes (` — `), especially in user-facing copy. Prefer a period, comma, colon, parenthetical, or a shorter sentence unless the dash is clearly the best punctuation.
- Preserve upstream Riffado attribution, author names, copyright notices, license text, and historical issue/PR links when renaming product copy.
- The product is Chatterbox in English and Klepna (declined) in Czech copy (`.claude/rules/i18n.md`).

Marketing surfaces (landing page copy, README feature sections) are exempt from this section; they follow product design and `.claude/rules/marketing.md`.

## Code quality

- No `any` types unless absolutely necessary.
- Check `node_modules` for external API type definitions instead of guessing.
- **NEVER use inline imports**: no `await import("./foo")`, no `import("pkg").Type` in type positions. Always top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead.
- Always ask before removing functionality or code that appears to be intentional.
- Refactor freely and do not preserve backward compatibility on internal code unless the user explicitly asks. Internal code APIs are not a contract; only the deploy surface and the hosted surface are (see [Don't break existing deployments](#dont-break-existing-deployments)), and those are sacred.
- No generic arrow functions (`<T,>(x) =>`) in `.tsx`: the next-intl extraction loader in `pnpm build` rewrites them into JSX, and only CI's Build job fails. Use a generic `function`.
- JSDoc on exported APIs only. No narrative or strategy comments in source. Design rationale goes in the commit message, and into a decision record when it clears the bar below. One exception: a one-line comment at a site may state why that line must stay as it is, when a future change could silently break a constraint there (a lock order, a literal a partial index depends on, a deliberate omission).

## Decision records and plans

- **Before starting work**, search `documentation/adr/` for the area (`rg -l "<path or term>" documentation/adr/`) and read the *Consequences & open follow-ups* of every hit. Reversing a recorded decision takes a new record that supersedes it.
- **When work finishes**, write a record only if all three hold: there was a genuine fork, the reasoning outlives the change, and nothing cheaper (commit message, JSDoc) carries it. The default is no record. If it clears the bar, read `.claude/rules/adr.md`, copy `documentation/adr/TEMPLATE.md`, and regenerate the index with `node scripts/generate-adr-index.mts` (`pnpm adr:index`) in the same commit; `--check` (`pnpm adr:index:check`) validates without writing and runs in CI. A later decision that changes even one rule of a record supersedes it.
- Plans and TODOs that need to survive a session belong in GitHub Issues, not in code comments or `plans/*.md`. In-flight working notes (design drafts, briefs, review outputs) live only in `docs/plans/`, which `.gitignore` excludes: never commit them, never treat them as evidence of what shipped, and delete them when the work finalizes. Before deleting, move what has lasting value (the whys, rejected options, measurements) into a record or the commit message; an implemented plan has no value of its own (`.claude/rules/adr.md`, "Plans").

## Commands and tests

- After code changes (not docs): `pnpm format-and-lint:fix && pnpm type-check`. Fix all errors and warnings before committing. Without pnpm on `PATH`, call the binaries in `./node_modules/.bin/` (`biome check . --write`, `tsc --noEmit`, `vitest`).
- When running check/typecheck/test commands, capture the full output: do not pipe through `| tail`, `| head`, or otherwise truncate. Hidden errors are the whole problem these commands are supposed to surface.
- **NEVER run without user instruction:** `pnpm dev`, `pnpm build`, `pnpm db:migrate`, `pnpm db:generate`, `docker compose up`, any release command. One exception: the disposable sandbox e2e and demo stacks (`docker-compose.e2e*.yml`, alone or with `docs/user-guide/demo/docker-compose.demo.yml`) may be started for browser checks without asking. `docker compose up` of the real stack (`docker-compose.yml`, with or without `docker-compose.dev.yml`) stays forbidden without an instruction.
- Tests: `pnpm test` (vitest, from the repository root). Database integration tests (`*.integration.test.ts`) run when `TEST_DATABASE_URL` points at a Postgres, which must be localhost unless `ALLOW_REMOTE_TEST_DATABASE_URL=true`; CI runs them against Postgres 16. Keycloak tests (`*.keycloak.integration.test.ts`) also need `KEYCLOAK_TEST_ISSUER`, and CI has no Keycloak: run them yourself when you touch SSO, MCP or authorization code. The live Plaud test is opt-in (`.claude/rules/plaud-and-sync.md`).
- If you create or modify a test file, run it and iterate until it passes.
- Before pushing, run the tests your change reaches, not the whole suite: `pnpm vitest run --changed origin/dev` (or `pnpm vitest related <changed files> --run`), plus the integration tests of the area you touched. CI runs the whole suite on every push; a PR is not ready until its Test job is green, and a red Test job is yours to fix. Run the whole suite locally when a change reaches tests outside the import graph: `src/db/schema.ts` and migrations, `messages/*.json`, shared test helpers and fixtures, or `vitest.config.ts`.
- Regression tests for a specific bug go at `src/tests/regressions/<issue-number>-<short-slug>.test.ts`.
- CI and the image build use Node 22.20 and production runs the app under Bun 1.4. When you touch `fetch`, streams or other runtime APIs, run their tests under Node 22 as well.

## **CRITICAL** Tool usage rules **CRITICAL**

- NEVER use `sed`/`cat` to read a file or a range of a file. Always use the Read tool (use offset + limit for ranged reads).
- You MUST read every file you modify in full before editing.

## **CRITICAL** Git rules **CRITICAL**

Multiple agents may work on the same worktree simultaneously (subagents, parallel sessions). These rules prevent destroying other agents' work and prevent destructive mistakes even in single-agent use.

### Committing

- **ONLY commit files YOU changed in THIS session.** Track which files you created, modified or deleted during the session.
- NEVER commit unless the user asks.
- Before committing, run `git status` and verify you are only staging YOUR files.
- ALWAYS use `git add <specific-file-paths>` listing only files you modified.
- It is always fine to include matching `src/db/migrations/*.sql` and `src/db/migrations/meta/*` files alongside the `src/db/schema.ts` change that produced them: they are generated artifacts of your edit, not other agents' work.
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR; GitHub closes it when the commit reaches `dev`, the default branch.
- Commit prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `perf:`, `docs:` (Conventional-Commits-ish). PRs into `dev` are merged with a merge commit, which keeps the branch's commits; squashing is optional.

### Forbidden Git operations

These can destroy work:

- `git reset --hard` and `git checkout .`: destroy uncommitted changes
- `git clean -fd`: deletes untracked files
- `git stash`: stashes ALL changes, including other agents' work
- `git add -A` / `git add .`: stage other agents' uncommitted work
- `git commit --no-verify`: bypasses required checks, never allowed
- `git push --force` / `--force-with-lease`: never allowed, also not after a rebase

### Safe workflow

```bash
git status                                   # 1. check status first
git add src/lib/storage/s3-storage.ts        # 2. add ONLY your specific files
git add src/tests/storage/s3-storage.test.ts
git commit -m "fix(storage): correct S3 content-type fallback"   # 3. commit
git pull --rebase && git push                # 4. pull --rebase if needed, NEVER reset/checkout
```

### Branches, PRs and conflicts

- `dev` is the **integration branch** and the default branch: feature branches open PRs into it, and it may be broken at any commit. `main` is the **release branch**: it only receives `dev` merges, and every push to it is a release (`YYYY.N`). Never push or merge to `main` unless the user asks for a release. See [BRANCHING.md](BRANCHING.md).
- Analyze PRs without pulling locally first. If the user approves: create a feature branch, pull the PR, rebase on `dev`, apply adjustments, commit, merge into `dev`, push, close the PR, and leave a comment in the user's tone.
- Open a PR when the user asks you to. A direct request is sufficient authorization; no separate confirmation is needed. Otherwise, work in feature branches until everything matches the user's requirements, then open a PR into `dev`.
- Rebase conflicts: resolve conflicts in YOUR files only. If a conflict is in a file you didn't modify, abort and ask the user.
- If user instructions conflict with these rules, ask for explicit confirmation before executing. Only then override. A direct request to open a PR follows the PR workflow above and needs no further confirmation.

## GitHub issues, PRs and releases

- Always read all comments, not just the body: `gh issue view <number> --json title,body,comments,labels,state`.
- There are no issue templates. An internal work item has three blocks: **Context** (why + current state), **Acceptance Criteria** (concrete verifiable outcomes), **Relevant files** (optional pointers). Title prefixes match commit prefixes. Labels: `bug`, `enhancement`, `documentation`, `question`, `good first issue`, `help wanted`, and `duplicate` / `invalid` / `wontfix` to close; don't invent ad-hoc labels.
- Comments: write multi-line comments to a temp file and use `gh issue comment --body-file` / `gh pr comment --body-file`, never `--body` in shell for multi-line markdown. Preview the exact text before posting. Post exactly one final comment unless the user asks for more; if a comment is malformed, delete it and repost one corrected version. Tone: concise, technical, in the user's voice.
- **A PR title is a release-note line.** Release notes are generated by GitHub from the titles of the PRs merged since the previous release. Conventional prefix plus the change as a reader of the release sees it: `fix(sync): stop stalling on HTTP 429`, not `address review` or `WIP`. `CHANGELOG.md` keeps the history from before calendar versioning and is no longer updated; do not add entries to it.
- **A breaking change says so.** Schema drops, env var renames, `docker-compose.yml` structure changes: `!` after the prefix (`feat!:`, `fix(storage)!:`) and the migration note in the PR description. After the release, the maintainer copies that note into the release text.
- **Footprint, not business model.** A hosted-only feature that still ships a table or an env var to every image is described by what appears (table, migration numbers, env vars) and that it is inert without its flag, not by how the hosted product works.
- Every push to `main` is a release: `release.yml` computes `YYYY.N`, builds the images, then tags and publishes the GitHub release. Agents never push or merge to `main` on their own; a release happens when the maintainer merges `dev` into `main`.

## Don't break existing deployments

Chatterbox ships in two production modes from the same codebase: **self-host** (`IS_HOSTED` unset or false; AGPL, `docker compose up`, owned by the user; the default path) and **hosted** (`IS_HOSTED=true`; the multi-tenant service upstream Riffado operates, with live paying users; `.claude/rules/hosted.md`). The **deploy surface** (DB schema, env vars, `docker-compose.yml` structure, the release assets `docker-compose.yml` and `env.example`) is a contract for self-host. The **hosted surface** (the external API at `/api/v1/*`, webhook payloads, token format, and API behavior under load) is a contract for hosted customers. Internal code is not a contract for either.

- **Schema changes are additive by default.** Dropping columns or tables requires a user-impact assessment and a migration plan (`.claude/rules/database.md`).
- **Env var renames need deprecation**, and **`docker-compose.yml` is a user contract**: breaking structural changes need a migration note in the PR description (`.claude/rules/deploy-surface.md`).
- A PR that changes `docker-compose.yml`, env vars or deploy steps has an **Upgrading an existing installation** section, saying "none required" when that is so.
- **Breaking changes ship with loud logging and a migration note in the release.** Never silently.
- **Never gate features behind `IS_HOSTED` in a way that breaks self-host.** Hosted-only branches degrade cleanly to the self-host path, not crash or silently disable functionality self-hosters expect.

Ask: *"If this goes wrong, how many users notice, and how fast can they recover?"* and answer it for **both** modes.

## Product invariants

- **Self-host is first-class.** If it won't run in `docker compose up`, it doesn't ship. The privacy and compliance audience literally cannot use it otherwise.
- **Local-AI path must keep working.** Transformers.js (browser) and Ollama/LM Studio (local server) are the privacy-critical path. Don't regress them for "better" cloud-provider features.
- **No vendor lock-in inside Chatterbox either.** Storage pluggable (local / S3-compatible). AI providers pluggable (any OpenAI-compatible). Don't hardcode to one; don't add a "default cloud" fallback that silently leaks data.
- **Export parity is non-negotiable.** Full backup (one-archive export → restore elsewhere) is the proof users can leave. Every recording, transcript, summary must round-trip. Do not ship features that can't be backed up.
- **Never claim compliance we don't own.** HIPAA, SOC2, attorney-client privilege: the claim belongs to the user's AI provider and their self-host setup, not to Chatterbox.
- **Multi-process safe.** No in-memory locks as the only correctness mechanism. Background workers (started in-process from `src/instrumentation.ts`) claim work at the DB level (`SELECT … FOR UPDATE SKIP LOCKED`, see `src/db/queries/async-jobs.ts`) or move to a dedicated process. In-memory `running` flags are advisory only.
- **Multi-tenant safe and fair.** One user's data, quota, retries, or failures must not affect another user's experience. Background queues (webhook delivery, transcription, sync) use per-user concurrency caps or fair-share claim queries so one slow or abusive user cannot starve others. Exception by decision: summary and Learn jobs claim oldest first while pipeline jobs claim per user (`documentation/adr/2026-09-13-durable-job-queue.md`); do not change that without a new decision.

## Product principles

In priority order when in doubt:

1. **Performance above all else.** Optimistic updates on writes. Data-loader patterns + link prewarm on hover. No JS or data waterfalls. Minimize blocking onboarding states.
2. **Good defaults.** Less config is best. Sensible sync intervals, retention, storage paths. Auto-detect Plaud region via `-302` redirect. Default to browser transcription when no AI provider configured.
3. **Convenience.** Shareable URLs share-ready by default. Homepage → latest recording ≤ 4 clicks. Re-auth flows are modals, not full onboarding resets.
4. **Security.** AES-256-GCM for all stored tokens. A caller check on every user-scoped query (see below). Be thoughtful about "public" endpoints. Path-traversal protection in local storage, range-header validation on audio streaming.

## Code conventions

- Route handlers live under `src/app/api/`, one `route.ts` per endpoint.
- Database access via Drizzle. Fluent Drizzle queries (`db.select().from(...).where(...)`) may live inline in route handlers and feature `lib/` files. **Raw-SQL queries (anything calling `db.execute(sql\`...\`)` or holding a full `SELECT`/`INSERT`/`UPDATE`/`DELETE` inside a `sql\`\`` template) MUST live in `src/db/queries/`** and be imported by feature code. Inline `sql\`\`` *expression fragments* embedded inside Drizzle's fluent builder (`set: { col: sql\`col + 1\` }`, `where(sql\`json @> ...\`)`, `orderBy(sql\`...\`)`) stay where they're used.
- When you write or touch any `sql\`\`` template: every interpolated value must be a `${...}` placeholder (param-bound, never string-concatenated); every `Date` value must be `.toISOString()` and cast (`${iso}::timestamp` for `timestamp` columns, `::timestamptz` only when the column is `timestamptz`); user-supplied `ILIKE` patterns must escape `%` and `_` with `escape '\\'`; sort columns and identifiers come from a fixed allowlist, never from user input.
- Environment variables are validated via Zod in `src/lib/env.ts`. Add new vars there and access them via the validated `env` object (adding one: `.claude/rules/deploy-surface.md`). **Never `process.env.X` directly in feature code**; `NODE_ENV` and build-time `NEXT_PUBLIC_*` constants are the exceptions. Mode checks read `env.IS_HOSTED`.
- Storage and AI providers are pluggable: don't branch on storage type outside `src/lib/storage/factory.ts`, don't hardcode OpenAI-specific behavior, never branch on provider name in feature code.

## **CRITICAL** User-scoped queries **CRITICAL**

Every query that touches user-scoped data **MUST** filter by the caller: `where(eq(table.userId, session.user.id))` for private rows, or the shared visibility helpers for data shared with the Organization (`requireRecordingAccess()` in `src/lib/sharing/access.ts`, `visibleOwnerCondition()` in `src/lib/knowledge/org-people.ts`, `taskVisible()` in `src/db/queries/task-visibility.ts`). Trusting route params or body fields without this check is a security bug: an attacker can read or modify other users' recordings, transcriptions, tokens, and AI keys.

This is not optional, not "I'll add it later," not "it's an internal endpoint." Every query. Every time.

## **CRITICAL** Encryption at rest **CRITICAL**

These secrets go through `src/lib/encryption.ts` (AES-256-GCM) before hitting the DB: Plaud bearer tokens (`plaudConnections.bearerToken`), AI API keys (`apiCredentials.apiKey`), SMTP credentials, S3 credentials. Decrypt only at the moment of HTTP request construction. Never log decrypted values. Never return them in API responses.

User content (recording titles, transcripts, summaries, mail, Almanac entries, tasks) is stored through `encryptText()` / `encryptJsonField()` in `src/lib/encryption/fields.ts`. New columns that hold user text use them too, and plaintext content never reaches logs, errors or analytics.

## **CRITICAL** Database migrations **CRITICAL**

Never hand-write migration SQL and never hand-edit `src/db/migrations/meta/*`: edit `src/db/schema.ts`, then generate with `pnpm db:generate` once the user allows it. Full rules: `.claude/rules/database.md`.

## Area rules

Before you edit files matching a pattern below, read the rule file. Claude Code loads it when it opens a matching file; everyone else opens it by hand.

| Paths | Rule file | Covers |
|---|---|---|
| `src/db/**`, `drizzle.config.ts` | `.claude/rules/database.md` | migrations, schema additivity, raw SQL |
| `src/lib/plaud/**`, `src/lib/sync/**`, `src/app/api/plaud/**` | `.claude/rules/plaud-and-sync.md` | Plaud API gotchas, real-account sync testing |
| `src/lib/env.ts`, `.env.example`, `docker-compose*.yml`, `Dockerfile`, `mail-receiver/**`, `agent-bridge/**`, `content/docs/self-hosting/**` | `.claude/rules/deploy-surface.md` | adding env vars, renames, upgrade notes, runtimes |
| `src/lib/hosted/**`, `src/app/(hosted)/**`, `src/app/api/v1/**`, `src/lib/webhooks/**`, billing, entitlements, rate limiting | `.claude/rules/hosted.md` | `IS_HOSTED`, egress, API tokens, `/api/v1`, Mynah |
| `src/lib/ai/**`, `src/lib/transcription/**` | `.claude/rules/ai-providers.md` | provider defaults, selection precedence, adding a provider |
| `src/lib/storage/**` | `.claude/rules/storage.md` | adding a storage adapter |
| `src/lib/notifications/**` | `.claude/rules/notifications.md` | adding a notification backend |
| `messages/**`, `src/**/*.tsx`, `content/docs/**`, `extensions/recorder/_locales/**` | `.claude/rules/i18n.md` | strings and extraction, Klepna, product naming, docs twins |
| `src/components/**`, `src/app/**/*.tsx`, `src/hooks/**`, `src/app/globals.css` | `.claude/rules/ui.md` | server components, toasts, shared widget bodies, Organization colour |
| `src/components/landing/**`, `src/app/page.tsx`, legal and changelog pages, `README.md` | `.claude/rules/marketing.md` | positioning, audiences, marketing-vs-product gap |
| `extensions/**`, `src/app/api/v1/recorder/**`, `src/app/api/v1/recording-sessions/**` | `.claude/rules/recorder-extension.md` | compatibility with released servers, Store releases |
| `documentation/adr/**` | `.claude/rules/adr.md` | decision records, plans |

The exact globs are in each file's `paths:` front matter.

## Pointers

- [README.md](README.md): product overview + self-host install
- [CONTRIBUTING.md](CONTRIBUTING.md): contributor workflow
- [BRANCHING.md](BRANCHING.md): branching and release model
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): local setup, the disposable E2E Docker stack
- [content/docs/](content/docs/): user guide, self-hosting, guides and reference (served at `/docs`)
- [documentation/adr/](documentation/adr/README.md): decision records
- [CHANGELOG.md](CHANGELOG.md): version history before calendar versioning (releases since: GitHub Releases)
- [SECURITY.md](SECURITY.md): vulnerability disclosure
