---
title: Meeting agendas are co-edited plans absorbed by recordings, with safe attachment and manual Calendar export
date: 2026-10-27
updated: 2026-10-28 13:25
status: superseded
kind: feature
issues: []
prs: [293]
areas: [src/lib/meetings, src/db/queries/meetings.ts, src/db/queries/folder-participants.ts, src/db/schema.ts, src/app/api/meetings, src/app/api/v1/recorder, src/lib/mcp/tools/meetings.ts, src/lib/export/meetings.ts, src/lib/integrations/google]
supersedes: []
superseded-by: [2026-10-28-agendas-use-all-folder-placements]
relates: [2026-10-27-shared-folders-are-two-way, 2026-10-12-calendar-meet-speaker-candidates, 2026-10-22-calendar-speaker-guesses-in-automatic-runs, 2026-10-07-tasks-from-summaries, 2026-10-22-meeting-recorder-banner, 2026-10-07-backup-scope]
---

# Meeting agendas are co-edited plans absorbed by recordings, with safe attachment and manual Calendar export

A meeting is its own item with encrypted discussion points and a frozen list of task references.
Its recording absorbs the agenda, hides the standalone item and keeps its stable link as a redirect.
The implementation includes the editor, Chrome side panel, AI suggestions, summary/keyterm/Learn
context, permissions, attachment, Calendar export, recorder APIs and MCP. It is awaiting integration.

**Superseded in part:** [Multi-folder agenda filing](2026-10-28-agendas-use-all-folder-placements.md) changes the single-folder preparation and attachment behavior, and freezing automatic preparation across filing changes. The remaining rules still hold.

## Why

Preparing a discussion needs a place before audio exists. Reusing a recording placeholder would send
an item with no audio into recording-specific processing, retention and public APIs. Shared preparation
also needs point authorship while preserving existing permissions on the real tasks and recordings.
An arriving private recording must never be published simply because its time overlaps a shared agenda.

### Previous state

Items were audio or mail. Google supplied transient roster context to Learn, while folder invitations
shared only direct items owned by the source folder owner. There was no persisted agenda or planned
meeting, no Calendar write grant and no meeting-specific archive payload.

## Options considered

### A separate meeting item (chosen) or a recording placeholder (declined)

A placeholder could reuse the recording list and links. **Rejected because:** absent audio would make
transcription, storage retention and the recording API ambiguous. A separate kind makes those boundaries
explicit, at the cost of auditing every kind consumer and adding attachment/redirect handling.

### Manual Calendar export (chosen) or automatic synchronization (declined)

Automatic synchronization would keep invited people informed without another action. **Rejected because:**
every co-edit would become external publication and a recurring-series edit could affect other meetings.
Export requires a fresh organizer check, incremental write consent and an explicit action on one instance.
It preserves organizer text, replaces only the marked block and sends no attendee update emails.

### Co-editing by visibility (chosen) or author-only editing (declined)

Author-only editing needs fewer conflict rules. **Rejected because:** colleagues who can see the meeting
must contribute their own points and live hints. Point text and structure remain author-controlled;
the meeting author and Organization curators manage all points. Actual task completion uses existing
permissions, and an absorbed agenda is read-only.

### Safe automatic attachment (chosen) or overlap alone (declined)

Overlap alone would attach more recordings without a dialog. **Rejected because:** it could publish a
private recording into a shared folder or reveal a private agenda through an already shared recording.
Automatic attachment counts every visible overlapping agenda and requires exactly one candidate, the
same owner and an existing matching placement or an unshared owner-private folder. Both paths check
exposure: neither agenda nor recording may gain viewers, and a pending Organization placement or person
share prevents automatic attachment. It never files the recording. Explicit attachment requires agenda
edit access and recording ownership and files into the agenda folder with the resulting audience available
to the client. A non-author may attach only when the recording's current audience is contained in the
agenda's audience; otherwise a localized 409 explains the conflict.
Sharing the recording later is the owner's explicit action and carries its absorbed agenda with it.

## Decision

Keep the plan separate until a real recording arrives, then absorb it without inventing transcript
evidence. Planned points, discussed ticks and meeting notes are hints only. Summary integration
reports coverage solely from transcript support and labels agenda context as a plan. Every workflow
continues without Google; Google remains self-host only. Hosted uses the same scoped meeting APIs without
Google consent or provider fallbacks.

## Key technical details

- `requireMeetingAccess` is shared by web, recorder and MCP. Point writes lock the agenda, check point
  versions and reject cycles or trees deeper than three levels. Task lists snapshot once per source
  selection; `snapshot_source_item_id` preserves the actual source when null means automatic selection.
- Attachment runs on recording arrival before transcription. If explicit agenda access was revoked or
  it was absorbed elsewhere after completion, finalization preserves the recording without attaching it. A DB claim marks overdue agendas held;
  the original meeting tombstone preserves redirect and detach behavior. Deleting a recording deletes
  its own agenda; deleting a colleague's attached recording instead restores the author's standalone
  meeting as planned or held under the ordinary time rules. Migrations `0145_parched_rogue.sql`,
  `0146_unusual_sheva_callister.sql` and `0147_numerous_mother_askani.sql` are additive.
- [Two-way shared folders](2026-10-27-shared-folders-are-two-way.md) define general participant-owned filing, replacing this implementation's original explicit-attachment exception. An attached recording remains its owner's data, and acceptance/revocation controls its shared-folder visibility.
- Explicit Organization attachment records a normal intended placement through
  `recordIntendedPlacementInTx`. Publication waits for the ordinary transcription and speaker share gate.
  Colleagues who could see the meeting retain read-only agenda access while the recording is unpublished:
  `attachedRecording: { visible: false }` and `redirectTo: null`, with recording/source IDs and
  transcript outcomes withheld. Once readable, its stable link redirects
  to the recording with the caller's private, Organization or received view.
- Calendar event and recurring-series IDs fill only empty recording columns. Detach clears identifiers
  only when equal to the agenda's values and removes attach-created filing in someone else's folder.
  Event context is encrypted in `calendar_snapshot`; a conditional `calendar_refreshed_at` update claims
  one lazy refresh per ten-minute TTL across processes. Detail and recorder matching read that snapshot;
  Meet codes stay server-only. Point edits retain participating user IDs in the existing snapshot
  envelope, independently of the encrypted event cache; refreshing or relinking preserves them.
  Recorder reminders are limited to authors, editors or invitees whose connected Google email
  matches a stored attendee. Reminder filtering never refreshes Calendar. Calendar export always reads fresh, defaults to excluding tasks, and
  excludes assignee and live notes. Both English and Czech block markers are recognized.
- Archives use the existing server-resolved scope and include standalone and absorbed agendas.
  The meeting restore endpoint accepts validated item/folder/task mappings; it creates no accounts,
  invitations or automatic external sharing. Suggestions can be regenerated and are omitted.
- Read-only MCP tools carry `readOnlyHint`; agenda writes use the existing `tasks:write` role.
  Task review and task counts require `tasks:read`; service callers cannot prepare or edit agendas.
  Recorder keys with `recordings:write` also read visible agendas, add live points,
  change discussed ticks and notes, and change tasks allowed by the holder's existing task permissions.
  Already-issued keys gain these agenda read and edit powers. They cannot read recordings or their
  summary-derived agenda outcomes, task-source titles/IDs or summary IDs. The recorder route projects
  its own payload independently of the holder's broader web permissions. The recorder capability and
  optional completion metadata are additive for older extensions. An
  unavailable selected agenda never blocks completion: the response adds
  `agenda: { attached: false, reason: "unavailable" }`. Requests without `agendaId` keep their response shape.

- Summary commits retain the attachment lock and reconcile outcomes against current point IDs rather
  than rejecting unrelated agenda-version changes. Private and Organization summary runs update the
  same owner-scoped summary row, the one all recording viewers read. Missing `agendaOutcome` preserves
  prior coverage; detach clears it. Learn includes only point text authored by the recording owner;
  notes have no recorded author and are omitted. Summary and spelling context retain their normal scope.
- MCP callers without mail access receive no suggestions sourced from mail items or mail-evidence tasks,
  including merged mail notes. Accepted points persist source item/task IDs; editing their text and later
  carry-over preserve that lineage. Archives retain it and restore remaps imported source IDs while keeping
  missing sources restrictive.

## Verification

`src/tests/meetings/meetings.integration.test.ts` exercises 48 PostgreSQL cases, including concurrent
creation and housekeeping, access and revocation, safe attachment, point conflicts, snapshot stability,
carry-over and archive restoration. Eleven model cases pin tree depth, grouping and overlap; six
Calendar cases cover bounded pagination, recurring instances, organizer refusal and conditional writes.
Recorder and MCP tests cover authentication, role boundaries, capability discovery, completion metadata
and mail-role filtering. Existing task, sharing, export, Google, recorder and MCP suites are also run.

## Consequences & open follow-ups

- Live browser checks remain: notification-click side-panel opening and its window fallback, and
  time-only matching on Zoom and Teams.
- Live Google checks remain for recurring-series IDs returned to non-organizer invitees.
- Model coverage quality remains to be evaluated, especially whether planned points without transcript
  support are incorrectly classified as covered.
- Migration `0148_agenda_review_indexes.sql` adds six foreign-key indexes and tightens the time check;
  the service already rejects an end without a start. No environment variable, compose or deployment-step
  change is required. Migration `0149_agenda_point_sources.sql` adds nullable ID-only point provenance
  in both deployment modes; older images ignore the column. Earlier meeting migrations remain separate
  generated artifacts.
- A privacy-filter regression can reveal content to shared self-host members; corrected filtering stops
  subsequent reads but cannot recall prior responses. Hosted has no person-sharing surface, while recorder
  and MCP capability filtering applies in both modes. The indexes require no data conversion; a failed
  attachment rolls back without moving or deleting either item.

## Related work

- [Two-way shared folders](2026-10-27-shared-folders-are-two-way.md): owns the partial supersession of person-to-person sharing. General participant-owned filing replaces the narrow explicit-attachment exception; receiver item rights and invitation revocation remain unchanged.
- [Calendar speaker candidates](2026-10-12-calendar-meet-speaker-candidates.md) and
  [automatic roster guesses](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md): reuse the Google
  connection, transient roster and overlap rule; an agenda remains a plan rather than speaker evidence.
- [Tasks from summaries](2026-10-07-tasks-from-summaries.md): frozen agenda references preserve real task
  identity, review ownership and existing completion permissions.
- [Meeting recorder banner](2026-10-22-meeting-recorder-banner.md): the capability and API payloads support
  the later side panel without changing released recorder clients.
- [Backup scope](2026-10-07-backup-scope.md): personal and Organization membership continues to follow the
  anchor item; agenda task references do not transfer ownership of the real tasks.

## Timeline

- **2026-10-27**: maintainer approved the design and attachment safety boundary; server foundation
  implemented in the working tree, then completed with editor, recorder and model integration. PR review
  fixes add explicit capability filtering, audience checks and concurrency regressions; live checks remain.
