---
paths:
  - "src/db/**"
  - "drizzle.config.ts"
---

# Database schema and migrations

## Migrations (CRITICAL)

- Always edit `src/db/schema.ts` first, then run `pnpm db:generate` to produce the migration. Running
  it needs the user's go-ahead, like the other commands `AGENTS.md` lists; without it, stop after
  the schema edit and say that the migration still has to be generated.
- **NEVER hand-write migration SQL files.** Drizzle tracks migrations via snapshot files in
  `src/db/migrations/meta/`; hand-written files don't generate snapshots, which causes future
  `db:generate` runs to re-emit already-applied columns. That's silent history corruption.
- The same applies to rebases, conflict resolution, and renumbering: rerun `pnpm db:generate`
  against the rebased schema. Never hand-edit `meta/_journal.json` or `meta/*_snapshot.json`, and
  never delete or consolidate migrations drizzle-kit has already produced, even unreleased ones.
  Stacked migrations within one release (e.g. add-then-drop) ship as two files.
- If drizzle-kit generates SQL that re-adds columns that already exist, meta snapshots are out of
  sync with reality. **Fix the drift, don't hand-edit around it.** Migrations `0010`-`0012` are
  historical examples of this drift; `0013` onward are clean.
- Matching `src/db/migrations/*.sql` and `src/db/migrations/meta/*` files may be committed alongside
  the `src/db/schema.ts` change that produced them (see the Git rules in `AGENTS.md`).
- Containers apply migrations on start (`docker-entrypoint.sh` runs `migrate-idempotent.js`), so a
  migration reaches every self-hosted install on its next `docker compose up`.

## Schema changes

- **Additive by default.** Dropping columns or tables requires a user-impact assessment and a
  migration plan, and ships as a breaking change (`!` in the PR title, migration note in the PR
  description). See "Don't break existing deployments" in `AGENTS.md`.
- A change to `schema.ts` or a migration reaches tests outside the import graph: run the whole
  suite locally (`AGENTS.md` § Testing).
- New user-scoped tables carry `userId` and every query on them filters by the caller; new content
  columns that hold user text are encrypted (`AGENTS.md` CRITICAL blocks).

## Queries

- Raw SQL (`db.execute(sql\`...\`)` or a full statement inside a `sql\`\`` template) lives in
  `src/db/queries/`; the placeholder, date-cast, `ILIKE` and allowlist rules are in `AGENTS.md` §
  Code conventions.
- Background work claims rows with `FOR UPDATE SKIP LOCKED` (see `src/db/queries/async-jobs.ts`);
  never rely on an in-memory flag for correctness.
