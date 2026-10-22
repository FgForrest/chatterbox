---
paths:
  - "src/lib/env.ts"
  - ".env.example"
  - "docker-compose*.yml"
  - "Dockerfile"
  - "docker-entrypoint.sh"
  - "mail-receiver/**"
  - "agent-bridge/**"
  - "content/docs/self-hosting/**"
---

# Deploy surface: env vars, compose, images

The deploy surface (DB schema, env vars, `docker-compose.yml` structure, the release assets
`docker-compose.yml` and `env.example`) is a contract with every self-hosted install. The principles
are in `AGENTS.md` ("Don't break existing deployments"); this file is the checklist.

## Adding an env var

1. Add it to the Zod schema in `src/lib/env.ts` and to its explicit read in `readEnvInput()` (the
   return type makes `tsc` fail when the read is missing). Feature code reads it from the validated
   `env` object, never `process.env`.
2. Document it in `.env.example`, commented out with its default.
3. Pass it through in `docker-compose.yml` under the `environment:` of every service that reads it,
   as `NAME: ${NAME:-<default>}`. Compose interpolates `.env` for `${VAR}` but does not inject a
   variable into the container unless it is listed, so a variable missing here silently does
   nothing in a container. Keep every entry of an `environment:` block at one indentation
   (`src/tests/regressions/compose-environment-indent.test.ts`).
4. Describe it in `content/docs/self-hosting/environment-variables.mdx` and its `.cs-CZ.mdx` twin.
5. Say in the PR description what an existing install must add (see below).

## Renames and removals

- **Env var renames need deprecation.** Keep the old name working for at least one release cycle,
  log a deprecation warning, and document both in the PR description. A variable only
  `docker-compose.yml` interpolates (an image tag pin such as `CHATTERBOX_VERSION`, which still
  accepts `RIFFADO_VERSION`) never reaches the app, so there is nothing to log from: the migration
  note in the PR description and release is its deprecation warning.
- **`docker-compose.yml` is a user contract.** Breaking structural changes need a migration note in
  the PR description and `!` in the PR title.

## Upgrade notes in the PR

A PR that changes `docker-compose.yml`, env vars or deploy steps carries an **Upgrading an existing
installation** section: what to change on an existing install (required versus optional), whether
migrations run on start, user-visible effects, and rollback. Say "none required" explicitly when
nothing is needed. Operators copy their compose files and upgrade from these notes; a new variable
they do not add does nothing.

## Images and runtimes

- The app image builds with Node 22.20 (deps stage) and runs Next standalone under **Bun 1.4**
  (`oven/bun`), and runs migrations on start (`docker-entrypoint.sh`). CI uses Node 22.20 too.
  Streaming code that stays flat under Node can still buffer under Bun: measure memory under Bun
  when you change how request or response bodies stream.
- Release images: `docker.yml` (app) and `mail-receiver.yml`, both called by `release.yml` on a push
  to `main` and by pushes to `dev` (`:dev` tags). See `BRANCHING.md`.
- Optional services sit behind compose profiles (`agent-bridge`, `mail`, `learn`); a change to one
  must not make the default profile require it.
- Operators build the agent bridge from source (`docker compose --profile agent-bridge up -d --build
  agent-bridge`, see `agent-bridge/README.md`), so a change under `agent-bridge/` reaches nobody
  until they rebuild it: say so in the upgrade section.
