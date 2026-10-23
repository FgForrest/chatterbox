---
title: Work that must outlive its process runs from a generic Postgres job table, not inside the request
date: 2026-09-13
updated: 2026-10-22 22:30
status: accepted
kind: infrastructure
issues: []
prs: [17, 18, 19, 20, 23]
areas: [src/lib/jobs, src/db/queries/async-jobs.ts, src/lib/summary, src/app/api/jobs, content/docs/reference/architecture.mdx]
supersedes: []
superseded-by: []
relates: [2026-10-19-processing-profiles-and-workflow, 2026-10-22-pipeline-steps-settle-their-jobs, 2026-09-30-learn]
---

# Work that must outlive its process runs from a generic Postgres job table, not inside the request

Summaries used to be generated inside the HTTP request that asked for them, so a restart part-way
through lost the work. PR #20 moved that work onto `async_jobs`, a durable queue in the existing
Postgres database drained by a generic worker in `src/lib/jobs/`. Workers claim rows with
`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, heartbeat while they run, and any
instance reclaims a job whose heartbeat stopped. The table is not summary-shaped: a `kind` selects a
handler from a registry, and every later long-running feature (Learn, topics, titles, transcription,
exports, the processing pipeline) became a handler on it rather than another table and worker.
Multi-pass summarization, shipped the same day, was the first user and the reason it hurt.

## Why

- **Unattended work vanished.** A manual summary lost to a restart is tolerable: the user is
  watching and clicks again. The automatic path is not: one sync can queue a dozen summaries with
  nobody watching, and an upgrade restart mid-generation left a recording that silently never got
  one.
- **Multi-pass made runs long.** A multi-pass summary is several provider calls plus a merge, which
  takes minutes, so the window in which a restart hits a run grew accordingly.
- **The maintainer asked for it directly**, and wanted the same abstraction for the planned
  knowledge-base construction (which later became Learn).
- **Constraints:** hosted runs several app processes against one Postgres, so an in-memory flag
  cannot be the correctness mechanism (`AGENTS.md`, hosted invariants). Self-host must keep working
  with one `docker compose up`. The container runs `exec bun server.js` as PID 1.

### Previous state

Summaries ran in the POST handler, and auto-summarize ran inline in the transcription pipeline. The
closest existing pattern was the export worker (`export_jobs`), which claims its rows but waits out
a 3.5-hour ceiling before it treats a job as dead, because elapsed time is all it has.

### Context: multi-pass summarization, the first user

PRs #17/#18, #19 and #23 run the summary prompt several times in parallel and merge the results.
The point is recall, not accuracy: independent passes omit different things. It is off by default,
with a separate opt-in for automatic summaries, because a sync multiplies every summary by the pass
count. Two choices from that line are worth keeping:

- **The fan-out lives in `src/lib/summary/generate-summary.ts`, not behind an OpenAI-compatible
  proxy.** An external prior-art project put it in a shim because it could not change the app; in
  the app it works with every configured provider, is testable without a network, is a per-user
  setting instead of a deployment-wide env var, and can report progress, which a proxy cannot.
- **The merge runs on the same model as the passes, with no setting.** A cheaper merge model would
  give the last word on every summary to a weaker model than the passes it combines.

A degraded run (a pass rejected or unparseable) still returns a summary; PR #19 persists its
provenance (`multi-pass · 2/3`) and PR #23 logs why each pass dropped out without quoting it.

## Options considered

### Option A: a generic durable job table in Postgres with heartbeat reclaim (chosen)

`async_jobs` rows carry `kind`, `subject_id`, `priority` and their own attempt budget. A registry
maps kinds to handlers. Claims use `FOR UPDATE SKIP LOCKED`; a claimed job is heartbeated and
reclaimed by any instance when the heartbeat stops.

- **Pros:** survives restarts and OOM kills without asking anything of the dying process; safe with
  several processes by construction; no new service for self-hosters; the next feature is a handler
  file plus one registration line.
- **Cons:** reclaim re-runs a handler from the start, so an interrupted multi-pass run pays for its
  passes again; job rows are not encrypted, which constrains what handlers may write to them.

### Option B: keep running the work inside the request or process (declined)

- **Pros:** nothing to build; the streaming UX already worked.
- **Cons:** any restart, deploy or crash loses in-flight work.
- **Rejected because:** the automatic path has no one to notice the loss, and nothing recorded that
  a summary had been attempted. Worth revisiting only if summaries stop being triggered without a
  user waiting on them.

### Option C: reuse the `export_jobs` pattern, an elapsed-time ceiling (declined)

- **Pros:** already existed and was understood.
- **Cons:** cannot tell "crashed" from "slow", so it must wait out the longest plausible run.
- **Rejected because:** a killed container's summary would wait hours to be retried. A missed
  heartbeat says "crashed" directly, so reclaim happens in about two minutes.

### Option D: a summary-specific table and worker (declined)

- **Pros:** simpler schema for the one known user.
- **Cons:** every later long-running feature needs its own table, worker, and claim and retry
  semantics.
- **Rejected because:** the knowledge-base work was already planned, and claim and retry logic is
  exactly what is easy to get subtly wrong more than once.

## Decision

**Chosen: Option A.** It is the only option that keeps unattended work across restarts while
staying correct with several app processes and adding nothing to the self-host deployment. The
heartbeat makes recovery fast without a shutdown hook, which matters because the process is PID 1
and can be OOM-killed. Revisit if jobs stop being safe to re-run from the beginning (inferred: the
whole recovery model depends on it).

## Key technical details

- **Entry points:** `src/lib/jobs/worker.ts` (generic worker), `src/lib/jobs/registry.ts` and
  `handlers.ts` (seventeen kinds registered today), `src/db/queries/async-jobs.ts` (claim,
  heartbeat, fail, reclaim SQL), `src/app/api/jobs/[id]` (a job for its owner), and the
  "Durable jobs" and "Multi-process safety" sections of `content/docs/reference/architecture.mdx`.
- **Claim per kind**, so each kind carries its own concurrency: the summary handler runs one job at
  a time because three parallel passes already saturate the agent bridge.
- **One live job per subject:** a partial unique index over `(kind, subject_id)` for live rows makes
  a double-clicked button one job. An application-level check-then-insert cannot be atomic against
  a racing request.
- **Heartbeat every 12 s, stale after 120 s** (`src/lib/jobs/timing.ts`). Every write a worker makes
  is scoped to a random `claim_token`, so a stalled process cannot corrupt a job reclaimed from it.
- **Attempts are counted at claim time**, not on failure. A job that kills its host never reaches a
  failure path; counting on failure would let it crash the container forever.
- **Retries at two scales, from an allowlist** (`src/lib/jobs/retryable.ts`): one rate-limited pass
  is retried in place (3 attempts, about 1.5 s to 15 s, jittered) so the passes that succeeded are
  not paid for twice; the job as a whole backs off from 30 s to 10 minutes. An allowlist rather
  than a denylist, because a permissive default would make every new error code cost three provider
  calls.
- **Job rows are not encrypted.** `payload`, `progress`, `result` and `last_error` hold identifiers,
  counts, provenance and mapped user-safe messages only. Content goes to its own encrypted home.
  This is the invariant a new handler most easily breaks.
- **No `SIGTERM` handler, on purpose.** One was written and removed: installing a listener removes
  the runtime's default exit, so a mistake makes the PID 1 container ignore `SIGTERM` and be
  `SIGKILL`ed on every deploy. The heartbeat already delivers recovery. `releaseInFlightJobs()`
  stays for a caller that can shut down safely; its JSDoc carries the reasoning.
- **Both summary paths go through the queue.** The JSON path waits for the job and returns
  `202 {jobId, status}` if it outlives the wait; running JSON inline would let a manual summary race
  a queued one on the same recording. The streaming path sends a `queued` event with the job id
  first, so a client whose stream broke resumes by polling `GET /api/jobs/{id}`.
- **Claim indexes (PR #94):** partial indexes serve the claim (`status = 'pending'`), the stale
  reclaim and the active-job lookup. Status lists in claims are SQL literals: postgres-js prepares
  statements, and a partial index whose predicate compares with a bind parameter cannot serve a
  generic plan. Rewriting them as parameters silently loses the index. The same PR replaced the old
  200-row prune with an hourly housekeeping job (`src/lib/jobs/housekeeping.ts`) that runs off the
  claim path and deletes finished jobs after a day.

## Verification

- `src/tests/jobs/async-jobs.integration.test.ts`: 32 integration tests at merge, gated on
  `TEST_DATABASE_URL`. They cover what mocks cannot: `SKIP LOCKED` under concurrent claims, the
  partial unique index, the branches of `failJobAttempt` where retry and bury differ by one case, and
  the heartbeat reclaim arithmetic. The PR #20 description says they had not been run (no Postgres
  in the sandbox); the maintainer's notes record the whole file passing on 2026-09-22.
- Two bugs were caught before merge. Writing the tests found `InvalidJobPayloadError` documented as
  permanent but classified as retryable. The last commit of PR #20 fixed a `case` over bare
  literals in `failJobAttempt` that resolved to `text`, which Postgres will not assign to an enum
  column: every failure threw `42804`, so a failing job stayed `processing`, was reclaimed two
  minutes later and re-ran indefinitely at full provider cost. Its commit message credits a run
  against a real database; mocks do not type-check SQL.
- PR #20: 1225 tests passing, up from 1116. Unit coverage in `src/tests/jobs/` (`worker`,
  `backoff`, `retryable`, `registry`, `housekeeping`) and `src/tests/summary/` (`multi-pass`,
  `pass-outcomes`, which feeds a pass a fake acquisition price and asserts the logged outcomes do not
  contain it).
- PR #94 bench (400k recordings, 1,500 users): job claim 10 ms before, 0.06 ms after.

## Consequences & open follow-ups

- Every later long-running feature is a handler on this queue; seventeen kinds are registered.
- **Per-user fairness covers only the pipeline kinds, by decision.** `claimDueJobs` skips users who
  already have a `pipeline.advance` or `pipeline.action` job processing (PR #134); every other kind,
  summaries and Learn runs included, claims oldest first, so one user's backlog can delay everyone
  else's. The fairness invariant in `AGENTS.md` asks for fair-share claims on background queues; the
  maintainer decided on 2026-10-22 that summaries and Learn runs keep claiming oldest first while
  pipeline jobs keep their per-user claim. Do not add a per-user claim to those kinds without a new
  decision. Revisit if one user's backlog measurably delays other users' summaries or Learn runs.
- **Reclaim re-runs from the start:** a multi-pass summary interrupted in its last pass pays for all
  passes again.
- **The background sync worker claims nothing.** PR #20 found that the architecture doc claimed
  otherwise: `claimUsersForSync` is a plain `SELECT`, so two app processes can sync one user at once.
  That costs duplicate Plaud calls, not duplicate data (imports dedupe on the Plaud id). The doc now
  says what each worker relies on; the sync worker is still the one to change if that waste matters.
- **Multi-pass through the agent bridge:** `BRIDGE_MAX_CONCURRENCY` must be at least the pass count
  or the passes run serially, and the bridge drops `max_tokens`, so the merge's higher ceiling is
  inert there.

## Related work

- [2026-10-19-processing-profiles-and-workflow](2026-10-19-processing-profiles-and-workflow/README.md):
  the processing pipeline runs as `pipeline.advance` and `pipeline.action` jobs on this queue and
  added the per-user claim.
- [2026-10-22-pipeline-steps-settle-their-jobs](2026-10-22-pipeline-steps-settle-their-jobs.md):
  pipeline steps settle their job rows and fence superseded claims, building on the claim-token
  scoping recorded here.
- [2026-09-30-learn](2026-09-30-learn/README.md): Learn runs as jobs on this queue; the planned knowledge base was why the job table was made generic.

## Timeline

- **2026-09-13**: multi-pass summarization merged (PR #17 landed on a stale stacked base and was
  re-opened as PR #18); provenance badge and live progress (PR #19); durable job queue with
  summarization as its first user (PR #20, including the failure-status cast); multi-pass
  degradation diagnostics (PR #23).
- **2026-09-22**: the 32 queue integration tests recorded as passing against Postgres.
- **2026-10-07**: partial claim indexes and hourly housekeeping (PR #94).
- **2026-10-16**: per-user claim for the pipeline kinds (PR #134).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
- **2026-10-22**: oldest-first claiming for summaries and Learn runs kept by the maintainer.
