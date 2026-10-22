---
title: Own tasks share the task table, follows stay personal, and assignees merge with explicit disclosure
date: 2026-10-22
updated: 2026-10-23 01:40
status: accepted
kind: feature
issues: [253]
prs: []
areas: [src/lib/tasks, src/lib/folders, src/components/tasks, src/app/api/tasks, src/lib/mcp/tools/tasks.ts, src/lib/export, src/db/schema.ts]
supersedes: []
superseded-by: []
relates: [2026-10-07-tasks-from-summaries, 2026-10-07-external-mcp-server]
---

# Own tasks share the task table, follows stay personal, and assignees merge with explicit disclosure

The Tasks page is also the assignee's working list. It carries own tasks, personal follows,
one note per task, and merges by the assignee. The same permissions govern the app and external
MCP tools. The maintainer approved these forks in the task-desk design and implementation brief
for issue #253; the brief takes precedence over the design.

## Why

A reminder did not have a home unless someone attached it to a recording or mail. Following another
person's task required keeping its source open. Assignees could finish work but could not explain
its outcome or consolidate duplicate assignments across meetings. Private content, shared content,
archives and MCP must agree on visibility, including after unsharing or a merge.

### Previous state

Every task had an item. Mine matched the assignee's email; Tracked showed the other tasks of the
owner's items, and all shared tasks for curators. Merges required owner or curator rights and kept
the target's text. External MCP writes changed status and assignee only.

## Options considered

| Fork | Chosen | Rejected because |
| --- | --- | --- |
| Own-task storage | Existing `recording_tasks`, nullable item with a source check | A separate table would require unions and cross-table merges in every list, search, MCP and backup path. A hidden notebook item would enter the library, folders, search and item retention. |
| Own-task filing | One optional private folder on the task | Several placements like items would add a second placement model to a single line item and complicate its filter and row. A private task uses only its author's private tree; Organization filing would imply sharing that own tasks never permit. |
| Lists | Mine and one Followed tab, automatic owner follows and a curator filter | Three separate lists would split the same tracking work across tabs. Replacing automatic tracking with explicit follows alone would discard the owner's existing list. |
| Note writer | Everyone who can mark the task done | Assignee-only writing would exclude owners and curators who can already resolve the work. A discussion thread adds conversation and history where one current outcome note is wanted. |
| Text length | 2,000 characters for all task text and the one note | Keeping 500 characters would truncate useful manual reminders and merged commitments. A separate own-task limit would make identical edits behave differently across sources. |
| Badge | Existing assignment and routed-proposal counting; no own-task or follow-change count | Counting one's own reminders creates news about one's own action; counting follow changes turns the assignment badge into an activity feed. |
| Merge visibility | Always keep the Organization task; explicitly confirm private disclosure | Keeping the requested private target could hide shared work. Refusing every private-to-shared merge prevents consolidating a private reminder even when its author deliberately agrees to disclose it. |

## Decision

Use one task model with an explicit own-task source and one Followed tab. An own task is visible
only to its author, has no item or assignee person, and is always assigned to that author. It does
not enter item retention or deletion, and cannot be shared or reassigned.

An own task may be filed in one folder of its author's Private tree. The folder is orientation
only and never grants visibility. Private folder filters include filed own tasks and subfolders;
the Private root and All folders include unfiled own tasks, while Organization folders exclude
them. Followed retains its item-folder filter, including for an explicitly followed own task.
Recording and mail tasks continue to follow their item's folders. Folder item counts do
not include tasks. Deletion or a move outside Private clears the reference in the same transaction.

Follows and explicit unfollows are personal preferences. Visibility is rechecked on every list and
detail read; a follow survives withdrawal but never grants access. Curators can separately select
all shared tasks. `tracked` remains an alias for `followed`.

A note replaces the previous note, is encrypted like task text, and records its writer and time.
Everyone who can close the task can write it. Notes enter search, MCP and backups, but never summary
prompts. Task and note lengths are both 2,000 characters; an overlong merge is refused without
truncating content.

Assignees may merge their own open assignments across items and own tasks. Owner and curator rights
remain available. Accepted-task merges append kept text first, then the other text on a new line;
notes follow the same order, and the earlier non-null date wins. The Organization task always
remains. A server preview and an explicit confirmation protect private text joining a shared task.
Merges are irreversible and retain links, followers, pending proposals and cross-owner notices.

## Key technical details

- Own tasks survive item, summary, mail-retention and erase cleanup, including after absorbing an item task; only their author drops them.

- `src/lib/tasks/access.ts` and `src/db/queries/task-visibility.ts` distinguish item predicates from
  row predicates that include own tasks. Item-only queries must not accidentally reference an
  unjoined task table. Own-task list joins are left joins.
- Migration `0138_safe_hellcat.sql` is generated by drizzle-kit: nullable `recording_id`,
  source/item and personal-assignee checks, encrypted note columns with attribution, and
  `task_followers` / `task_unfollows`. The migration is the same for self-host and hosted.
- The same migration adds nullable `folder_id` with `ON DELETE SET NULL`,
  a folder filter index and a check that only personal tasks carry a folder. Filing, restore,
  folder moves and deletion serialize per author before task locks; the serialization row write
  also invalidates a serializable folder move's stale snapshot. Cross-owner folder moves are
  refused by the existing app; moves to a hosted Public tree clear the whole subtree's references.
- Merge locks retain item-before-task ordering, and own tasks lock their rows. Task versions are
  checked after locking. Moved proposals receive the kept task's resulting version.
- Personal archives carry `tasks/personal.json` and `tasks/follows.json`; notes remain in item task
  files. Organization archives exclude own tasks and members' preferences. The task importer
  re-encrypts extracted files and requires referenced items and people to exist already.
  Own-task `folderId` maps through the importer's `{id, restoredId}` folder mapping after folder
  restoration; absent mappings become null and targets must be in the caller's Private tree.
- `tasks:read` and `tasks:write` remain the external roles. `create_task`, `follow_task` and
  `merge_tasks` join the existing tools; merge is annotated destructive. Organization service
  clients cannot create own tasks or follow. Mail-note redaction requires `mail:read` too.

## Verification

- `src/tests/regressions/253-assignee-tasks.integration.test.ts`: 48 PostgreSQL tests covering
  privacy, role permissions, follows across withdrawal, notes, limits, merge preview and versions,
  badge, MCP and archive round trips, including ZIP entries.
- `src/tests/regressions/253-own-task-folders.integration.test.ts`: 30 PostgreSQL tests covering
  filing, refusals, subtree filters, privacy, folder deletion/moves, concurrent filing, MCP,
  app search, archive mapping and ZIP parity.
- `src/tests/regressions/253-assignee-tasks-ui.test.tsx`: 26 interaction and layout tests covering
  add focus, context-menu shortcuts, long press, notes, follows, pointer media rules and merge
  disclosure preview.
  Ten folder cases cover the add pill's defaults and search, row buttons, loading, clearing,
  optimistic versioned writes and hover/focus/touch visibility.
- Existing task, MCP, search, export and playback tests remain part of the full-suite check.

## Consequences & open follow-ups

- A task no longer necessarily has an item. New joins, filters, exports and deletion code must
  preserve own tasks and their author-only visibility.
- Every future path that changes folder ownership or makes a private folder public must clear
  own-task folder references in its transaction. A folder never grants access to an own task.
- The earlier external MCP write restriction is partially replaced: text, due dates, own-task
  creation, notes, follows and merges are now permitted under task permissions. Human review of
  proposed tasks stays app-only. The earlier record remains accepted for the rest of its decisions.
- There is no general archive restore UI in this checkout. Task restoration accepts extracted
  task arrays after item/person restoration; missing external follow targets are skipped.
- Self-host and hosted use the same permissions and tables. A bad own-task edit affects its author;
  a confirmed shared merge affects everyone who sees the kept task and requires a backup to undo.
  Version conflicts and overlong results refuse the transaction without losing either task.

## Related work

- [Tasks from summaries](2026-10-07-tasks-from-summaries.md): the task lifecycle and assignment model,
  extended here with tasks without items.
- [External MCP server](2026-10-07-external-mcp-server.md): the same identity, roles and row-scoping
  contract, with a broader task write surface.

## Timeline

- **2026-10-22**: maintainer accepted the task-desk design and brief; implemented for issue #253.
