---
title: Items are filed before anything is processed, and a processing profile is a recipe with one automatic switch per step
date: 2026-10-19
updated: 2026-10-22 17:00
status: accepted
kind: feature
issues: []
prs: [134, 135, 138, 139, 140, 141, 145, 156, 159]
areas: [src/lib/pipeline, src/lib/profiles, src/components/pipeline, src/hooks/use-item-processing.ts, src/lib/tasks, src/lib/recordings/title-after-summary.ts, src/lib/folders/permissions.ts, src/db/schema.ts]
supersedes: []
superseded-by: []
relates: [2026-09-13-durable-job-queue, 2026-10-22-pipeline-steps-settle-their-jobs, 2026-10-19-provider-defaults-and-no-fallback, 2026-10-07-tasks-from-summaries, 2026-10-02-almanac-guided-transcript-correction, 2026-09-23-shared-organization-scope, 2026-10-14-identity-provider-authorization, 2026-10-22-summary-reads-the-preferred-transcript]
---

# Items are filed before anything is processed, and a processing profile is a recipe with one automatic switch per step

Every recording and mail now goes through one declared pipeline: Categorize, Transcribe (recordings
only), Learn, Summary, Task review, and Share when an Organization folder is intended. A new item
waits, with no timeout, until its owner files it into a folder; no paid step runs before that. The
folder decides two things: which earlier tasks the summary may match against, and which processing
profile runs. A profile is a recipe of steps, each with one "Run automatically" switch; a manual run
may use any profile. Personal and Organization profiles exist side by side, Organization providers
let members process without keys of their own, and one task can collect mentions from every
recording and mail filed in the same folders. The item detail became a wizard: a one-row workflow
strip under the title, categorization as its first inline step, and widgets that open as the
workflow reaches them. The campaign ran from a proposal on 2026-10-14 to the last fixes after first
real use, merged on 2026-10-19.

## Why

- **Processing had no declared shape.** It started from four places (transcription completion,
  browser transcription, the Plaud import in sync, mail ingest), was steered by per-user switches
  per step, knew nothing about folders, and had no step that expected a person, although human
  review happened throughout.
- **Task matching was weak.** A summary saw only tasks assigned to confirmed speakers, at most 30,
  from recordings only; mail summaries received no candidates and tasks on mail were never
  candidates.
- **The maintainer wanted folder-scoped tasks.** Filing is required so that earlier tasks opened in
  recordings and mails of the same folder and its subfolders can be found. Without a folder there is
  no scope to match against.
- **Constraints that shaped it:**
  - on the Organization view of a shared item, prompts come from the Organization while the
    provider and multi-pass settings came from whoever clicked and paid, so one profile could not
    serve both owners;
  - filing into an Organization folder *was* sharing, and sharing was refused while Learn or task
    review was open, so a naive "Learn waits for the folder" deadlocks;
  - the queue keeps one live job per subject, so a trigger that arrives while the driver runs can be
    dropped (see [durable job queue](../2026-09-13-durable-job-queue.md));
  - webhooks and `/api/v1` are a contract, and self-host must keep working with one `docker compose up`.

### Previous state

Automatic transcription, summary, title, topics and Learn ran as soon as an item arrived, steered by
account switches (`auto_transcribe`, `auto_summarize`, `auto_generate_title`, `auto_detect_topics`,
`auto_learn`, `mail_auto_process`). Summary templates were chosen in Settings. Plaud action items
became task proposals at sync. The item detail filed items and reviewed Learn and tasks in dialogs.
This was acceptable while one person processed their own recordings; it stopped being acceptable
once tasks had to span items and an Organization had to pay for members.

## Decisions taken

The proposal went through three rounds on 2026-10-14 (a critical review of the maintainer's first
draft, a second version with his answers, an external critical review of that, then a third version
with decisions D1 to D20). D21 followed on 2026-10-15. The rest were taken while building and
after first use.

| Date | Decision | Why | Detail |
|------|----------|-----|--------|
| 2026-10-14 | Filing comes before any paid step; items wait for it with no timeout (D1). Mail to a folder address, uploads into a folder and recorder or v1 sessions with `folderId` skip the wait; "Transcribe now" works before filing | Folders define the task scope. The maintainer prefers a declared human step to implicit automation: processing already needed people, and the old pipeline left that undefined | [Filing](#filing-and-intended-placements) |
| 2026-10-14 | Filing into an Organization folder records an *intended* placement: Learn and task review run on the owner's private view, and the share executes when the share gate passes (D4). Cancelling the only intended placement leaves the item processed and unfiled | Breaks the deadlock between "Learn waits for the folder" and "sharing waits for Learn" | |
| 2026-10-14 | Personal and Organization profiles; Organization profiles are edited by curators (`org.curate`, or the Organization account without an IdP); a member may have no personal profiles (D5) | One profile mixed two owners on the Organization view | |
| 2026-10-14 | Organization providers: the Organization defines keys, members use them, the Organization pays. They are managed under `access.manage`, every change is audited, and calls are capped per member per hour (D6) | Whoever sets a provider's base URL decides where every member's content goes, which is an administrator's right, not a curator's | The v3 rule that members reach them only through profile pins was replaced on 2026-10-17 by [provider defaults](../2026-10-19-provider-defaults-and-no-fallback.md) |
| 2026-10-14 | Mail waits for Learn as recordings do (D8). After 3 days without a review the summary proceeds, but the open review still blocks the share; nothing is applied because time ran out (D9) | One rule for both channels; a timeout must not apply unreviewed findings | |
| 2026-10-14 | Learn stays self-hosted only; for hosted mode, pick whatever is least work (D12) | The maintainer: hosted is not a priority for him, so the route that means less work wins | |
| 2026-10-14 | One task spans items: a task lives while one of its mentions lives (D10). Candidates come from the folder scope, ranked, the best 40 in the single summary call, with no extra matching call (D2, D11) | Revises "tasks die with the summary" and "speaker-matched, at most 30" from [tasks from summaries](../2026-10-07-tasks-from-summaries.md) | [Tasks](#tasks-across-items) |
| 2026-10-14 | Task rights on shared items: the home item's owner and curators edit and drop, the assignee also closes; tasks on private items stay owner-only (D15) | "Relying everything on curator wouldn't work." Revises the 2026-10-07 rule that only the Organization account edits tasks of a shared recording | |
| 2026-10-14, 2026-10-16 | Strong task matches were to be preselected suggestions, never auto-linked (D18). After the evaluation, no suggested match is pre-ticked; only new tasks are | Pre-ticked matches were 46.7 % precise against a 95 % target | [task-matching-evaluation.md](task-matching-evaluation.md) |
| 2026-10-15 | A profile is a recipe: one "Run automatically" switch per step, manual runs may use any profile. A folder's default per channel is Inherit, a profile, or "Nothing automatic"; without a folder default the owner's default for that channel applies; the owner chooses only when placements conflict (D21) | The maintainer's own proposal: two switches per step and seeded "Automatic"/"Manual" profiles read as profile types, and the v3 rule made people pick a profile on every filing into a folder without a default | |
| 2026-10-15 | The manual summary picker starts on the item's profile and remembers a different pick per browser, with no account setting | He prefers fewer settings | |
| 2026-10-16 | The item detail is a wizard while the workflow runs: a one-row strip that never wraps, inline categorization, widgets that open in order; one widget body serves inline and dialog frames | The maintainer rejected the merged dialog-based detail: "clear state communication is the key" | PR #135 |
| 2026-10-16 | A "Nothing automatic" item's workflow ends at categorization; filed into an Organization folder it waits for an explicit Share now | Nothing after filing runs by itself, so there is no wizard to show | |
| 2026-10-16 | The dashboard's first load opens only the person's own items; an Organization item opens from the list or a link | A new member landing on the newest Organization item sees "a random recording from his point of view" | |
| 2026-10-16 | Members create subfolders inside existing Organization folders and file into them; creating top-level Organization folders, renaming, moving, reordering, deleting and changing a folder mail address are curator-only, enforced by the server (403) | Before, only the UI hid these actions; the server checked only that the scope was enabled | PR #135 |
| 2026-10-18 | A manual Transcribe, Summarize, Learn or Detect topics never opens a dialog; the button and the strip show the run, and a dialog opens only on an explicit click. Replaces "dialogs for re-runs" of 2026-10-16 | In first real use, dialogs popped up when a card was toggled or a step was started by hand | PR #156 |
| 2026-10-18 | Re-transcription needs an explicit confirmation and `retranscribe: true`; the route joins an active job and refuses to replace an item's own transcript otherwise | In first real use one item was transcribed three times, paid, by clicks on the transcript card while a server job ran | PR #156 |
| 2026-10-18 | The title is generated automatically exactly once, from the first completed summary, and never overwritten automatically; the manual regenerate icon uses the summary, else the transcript | In first real use one item changed its title four to six times while it was processed | PR #159 |

### Filing and intended placements

The profile is resolved once, at categorization: the folder's default for the item's channel, else
the nearest ancestor's, else the owner's channel default. Later changes to folder defaults do not
reassign items already filed. Categorization never targets the Private or Organization root.
Several placements are allowed; the task scope is their union, each with its subfolders.

### Tasks across items

A task has an identity, a visibility (follows its home item), an authority (the home item's owner)
and mentions (one per item that spoke about it). The home moves only when the home item is deleted
or withdrawn from the Organization, never because retention removed a summary. Each task field
(status, deadline, assignee) keeps the time of the statement that last set it, and a proposal is
offered only when its statement is newer. A change the reviewer may not apply is routed to someone
who may, and re-checked on apply. Drop ("no longer needed") and reassignment ("handed to someone
else") shipped as extensions; a "reopen" outcome did not.

## Rejected outright

| Option | Rejected because | Revisit if |
|--------|------------------|------------|
| Process unfiled items automatically, or put a timeout on filing | Folders scope task matching; without one there is nothing to match against. A stall is a declared human step; "Transcribe now" and folder addresses cover what must not wait | People leave items unfiled long enough to lose value |
| Link strong task matches automatically (the first draft) | No measured precision; the evaluation later put pre-ticked matches at 46.7 % | An evaluation on real data reaches the 95 % target |
| Preselect a match when the model picked exactly one candidate (D18 as written) | 14 of 30 pre-ticked matches were right at K = 40; the best stricter filter on recorded values reached 61.5 % | Same |
| A stricter matching instruction | Match precision rose from 29.3 % to 60.0 %, but match recall fell from 28.4 % to 18.9 %, 7 of 17 pre-ticked matches were still wrong, and chronology checks fell from 7/8 to 2/8 | A model that follows it without losing recall |
| Retrieve candidates per mention instead of per item | Candidate recall fell from 38.2 % to 8.9 % (a candidate-free summary emitted no mention for 50 of 144 items), and it needs a second call | Mentions come from a step that reliably extracts them |
| K = 20 or K = 60 earlier-task candidates | K = 20 loses candidate recall, K = 60 loses 2.1 points of match recall; 40 is the smallest K within two points of the best on both, at the existing prompt size | Real `bge-m3` embedding numbers (the evaluation used word overlap and two stand-in models) |
| A separate task-extraction or matching call | Kept from 2026-10-07: proposals come from the summary call and its multi-pass merge, so tasks cost no extra provider call | Matching quality requires a dedicated pass and the cost is accepted |
| Profile types ("Automatic" and "Manual"), or an "on" and an "automatic" switch per step | Read as two kinds of profile; a profile could also block a step run by hand, which nobody needed | |
| Learn on hosted for users without an Organization | Raised by the external review as useful; out of scope because hosted is not a priority and it is more work | Hosted demand appears |
| A "reopen" task outcome | Needs completed tasks among the candidates; nobody had reported needing it | Users report tasks that come back |
| Curators managing Organization provider keys | The base URL decides where members' content goes; curators choose among providers in Organization profiles instead | |
| The merged dialog-based item detail ("File it", "Change folders", review dialogs) | It did not tell the person which phase the item was in or whose turn it was | |
| Dialogs for steps run again after the workflow finished | Popped up on toggles and manual starts; replaced on 2026-10-18 | |
| A new automatic title after every summary, or after every new transcript | The latter was offered on 2026-10-18 and lost to "once, never overwrite": every regeneration renamed an item the person had already seen | |
| Open the newest Organization item for a member with no own items | Shows a stranger's recording on first load | |
| Organization folders changeable by any member (the server as it was), or by curators only | Any member could restructure or delete the shared tree, which the UI already hid from them (inferred); curators only would stop members organizing their work under existing Organization folders (inferred) | |

## Key technical details

- **Driver:** one job kind, `pipeline.advance` (`src/lib/pipeline/advance-job.ts`, `driver.ts`,
  `trigger.ts`, `plan.ts`). Every trigger increments `item_processing.requested_generation` in the
  same transaction as the change that caused it and enqueues the driver; the driver loops until
  `processed_generation` catches up. This is what makes a trigger dropped by the one-live-job index
  safe. Steps fence their output against the inputs they read (content revision, profile revision,
  scope fingerprint); provider calls stay at least once, as before.
- **`item_processing` holds one row per item and view** (private, Organization). How its steps
  settle their jobs was redesigned later in
  [pipeline steps settle their jobs](../2026-10-22-pipeline-steps-settle-their-jobs.md).
- **Profiles:** `src/lib/profiles/resolve.ts`, `default-rule.ts`. Every save creates an immutable,
  encrypted revision in `processing_profile_revisions`; each run records the revision it started
  with, so an edit affects only phases not yet started. "Nothing automatic" is `manual_only` on
  folder defaults and items.
- **Looks like a bug, is not:** intended Organization placements of *every* item kind live in
  `mail_pending_shares`. Its columns carry nothing mail-specific, so the table was reused rather
  than renamed.
- **Organization providers** are credentials owned by the Organization account, with
  `api_credentials.disabled_at`, an `admin_audit_log` entry per change, the payer recorded as the
  Organization and the actor as user, and `ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR` (default 60)
  reserved atomically across processes. Each multi-pass pass and retry counts.
- **Tasks:** `TASK_CANDIDATE_LIMIT = 40` in `src/lib/tasks/ranking.ts`; mentions, chronology and
  routing in `src/lib/tasks/mentions.ts`, `chronology.ts`, `routing.ts`. With tasks off in a profile,
  nothing produces task changes, multi-pass and Plaud included.
- **Title:** the summary job titles the item and records it in `summary.steps.title`
  (`src/lib/pipeline/title-step.ts`, `src/lib/recordings/title-after-summary.ts`). The planner no
  longer queues `title.generate`; jobs queued before the upgrade drain without touching titles. A
  hand-edited title, or a profile with automatic titles off, settles it for good. An item without an
  automatic summary keeps its original name until someone regenerates it.
- **UI:** `src/components/pipeline/workflow-widget.tsx` renders every step body inline or in a dialog
  with the same header and footer; bodies never branch on the frame, and their tests run once per
  frame (`describe.each(["inline", "dialog"])`). `src/lib/pipeline/workflow-status.ts` and
  `workflow-widgets.ts` derive the strip and widget states as pure functions.
  `src/hooks/use-item-processing.ts` refetches after the person's own action and compares phase
  records only, because the first differing reply often differed for an unrelated reason (PR #145).
- **Organization folder permissions:** `src/lib/folders/permissions.ts` and `folders.ts`. "Curator"
  is the Organization account without an IdP and `org.curate` with IdP authorization.
- **Contract changes (PR #134, breaking):** `transcription.completed` no longer carries a freshly
  generated title (it follows as `recording.updated`); items waiting to be filed send their
  webhooks later; automatic steps over `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` are deferred instead of
  dropped. Additive: `folderId` on `POST /api/v1/recording-sessions`, `processing { phase, state }`
  on v1 reads, `GET /api/v1/recorder/folders`.
- **Rollback is a database restore.** The previous image starts on the upgraded database but
  misreads settled task proposals as pending, and accepting one applies an obsolete change.

## Verification

- PR #134: 4,580 tests passed, 98 skipped; an independent adversarial review per stage, whose
  Stage 4 round found cross-member leaks through routed proposals and merge notices, a share blocked
  for ever, and "Transcribe again" deleting accepted tasks, all fixed before merge. Migrations
  0112 to 0128 ran in 655 ms on a small test database; upgrade and rollback were checked on an image
  of `dev`.
- Task-matching evaluation: 156 synthetic Czech and English items (75 recordings, 81 mails, 208
  tasks, open backlogs of 70 to 96 tasks per Organization), K in {20, 40, 60}, plus two follow-up
  experiments. Numbers in [task-matching-evaluation.md](task-matching-evaluation.md).
- PR #135: 4,741 tests; browser checks of every state at 1440, 390 and 360 px, light and dark.
  PR #145: 3,739 unit and 4,914 database tests.
- Tests to start from: `src/tests/pipeline/characterization.test.ts` (today's behaviour pinned
  before the driver took over), `plan.test.ts`, `advance-job.integration.test.ts`,
  `trigger.integration.test.ts`, `workflow-widget.test.tsx`, `use-item-processing.test.tsx`;
  `src/tests/profiles/default-rule.test.ts`, `org-provider-rate-limit.integration.test.ts`;
  `src/tests/tasks/candidates.integration.test.ts`, `ranking.test.ts`;
  `src/tests/folders/folder-permissions.integration.test.ts`;
  `src/tests/recordings/title-after-summary.test.ts`, `generated-title.integration.test.ts`;
  `src/tests/transcription-job-route.test.ts`; `src/tests/dashboard/workstation-empty-upload.test.tsx`.

## Consequences & open follow-ups

- **Pending from PR #134:** the pilot of the task merge rules on real data (D15), including the
  refusal to merge an Organization task into a private one; acceptance of the evaluation; `bge-m3`
  numbers, which the evaluation could not download.
- **Changed by later records:** Organization providers became members' defaults
  ([provider defaults](../2026-10-19-provider-defaults-and-no-fallback.md)). The share gate's task
  rule (only unreviewed proposals block the share) was removed by
  [tasks accepted automatically](../2026-10-21-tasks-accepted-automatically.md), and sharing stayed
  ungated when [the owner's task review came back](../2026-10-22-owner-reviews-tasks-sharing-ungated.md).
  Step bookkeeping had two sources of truth, which
  [pipeline steps settle their jobs](../2026-10-22-pipeline-steps-settle-their-jobs.md) replaced.
- **Self-host behaviour change:** a new account must create a folder before anything is processed,
  and a headless v1 client that opens sessions without `folderId` produces recordings that wait.
- **Hosted:** no Learn; hosted users get the pipeline without it.
- **Matching quality is low** (38.2 % of referenced tasks reach the 40 candidates); the review UI
  compensates by never pre-ticking a match and by "Merge into an earlier task", which searches every
  open task in scope.

## Related work

- [2026-09-13-durable-job-queue](../2026-09-13-durable-job-queue.md): the driver and steps are jobs on
  that queue, and the one-live-job index is why triggers carry request counters.
- [2026-10-22-pipeline-steps-settle-their-jobs](../2026-10-22-pipeline-steps-settle-their-jobs.md):
  the redesign of how steps and jobs agree, after shared items exposed drift.
- [2026-10-19-provider-defaults-and-no-fallback](../2026-10-19-provider-defaults-and-no-fallback.md):
  replaced this campaign's pins-only rule for Organization providers.
- [2026-10-07-tasks-from-summaries](../2026-10-07-tasks-from-summaries.md): the task model this
  campaign generalized across items and folders.
- [2026-10-02-almanac-guided-transcript-correction](../2026-10-02-almanac-guided-transcript-correction.md): processing profiles now carry the correction-pass setting.
- [2026-09-23-shared-organization-scope](../2026-09-23-shared-organization-scope/README.md): the Organization scope whose folder-editing rule this work narrowed.
- [2026-10-14-identity-provider-authorization](../2026-10-14-identity-provider-authorization.md): defines `access.manage` and `org.curate`, which gate Organization providers and profiles.
- [2026-10-22-summary-reads-the-preferred-transcript](../2026-10-22-summary-reads-the-preferred-transcript.md): made summaries and titles read the transcript a profile chooses, Plaud's included.

## Supporting material

- [task-matching-evaluation.md](task-matching-evaluation.md): the numbers behind K = 40 and "no
  suggested match is pre-ticked". The synthetic dataset and harness live outside the repository and
  cannot be regenerated from it.

## Timeline

- **2026-10-14**: first draft reviewed (sharing deadlock, two profile owners, missing channels);
  second version with the maintainer's answers; external critical review; third version with
  D1 to D20; implementation started.
- **2026-10-15**: D21, a profile is a recipe; task-matching evaluation run.
- **2026-10-16**: PR #134 merged; the maintainer rejected the item detail and asked for an inline
  wizard; rulings on "Nothing automatic", the first load and Organization folder permissions.
- **2026-10-17**: PR #135 merged and released in 2026.4; follow-ups PR #138 (strip refresh, Learn
  states), PR #139 (only own pre-profile templates), PR #140 (one native select), PR #141
  (transcription provider in the profile's Basic tab) merged; Organization provider defaults ruled.
- **2026-10-18**: PR #145 (revalidation compares phases) merged; first real use of the workflow;
  PR #156 (readable strip, no accidental re-transcription, no popups on manual runs) merged; title
  and manual-run rulings.
- **2026-10-19**: PR #159 (honest Learn status, one automatic title, explicit content language)
  merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
