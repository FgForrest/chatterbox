---
title: Meeting agendas are co-edited plans absorbed by recordings, with safe attachment and manual Calendar export
date: 2026-10-27
updated: 2026-10-27 14:30
status: partially-implemented
kind: feature
issues: []
prs: []
areas: [src/lib/meetings, src/db/queries/meetings.ts, src/db/queries/folder-participants.ts, src/db/schema.ts, src/app/api/meetings, src/app/api/v1/recorder, src/lib/mcp/tools/meetings.ts, src/lib/export/meetings.ts, src/lib/integrations/google]
supersedes: []
superseded-by: []
relates: [2026-10-27-shared-folders-are-two-way, 2026-10-12-calendar-meet-speaker-candidates, 2026-10-22-calendar-speaker-guesses-in-automatic-runs, 2026-10-07-tasks-from-summaries, 2026-10-22-meeting-recorder-banner, 2026-10-07-backup-scope]
---

# Meeting agendas are co-edited plans absorbed by recordings, with safe attachment and manual Calendar export

A meeting is its own item with encrypted discussion points and a frozen list of task references.
Its recording absorbs the agenda, hides the standalone item and keeps its stable link as a redirect.
The server foundation implements permissions, attachment, Calendar access, exports, recorder APIs and MCP.
The editor, extension side panel and model integration remain separate work.

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
same owner and an existing matching placement or an unshared owner-private folder. Without the matching
placement, the recording must have no Organization placement or intent, person shares or shared-folder
placement. It never files the recording. Explicit attachment requires agenda edit access and recording
ownership and files into the agenda folder with the resulting audience available to the client.
Sharing the recording later is the owner's explicit action and carries its absorbed agenda with it.

## Decision

Keep the plan separate until a real recording arrives, then absorb it without inventing transcript
evidence. Planned points, discussed ticks and meeting notes are hints only. A future summary integration
must report coverage solely from transcript support and label agenda context as a plan. Every workflow
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
  meeting as planned or held under the ordinary time rules. Migrations `0144_parched_rogue.sql`,
  `0145_unusual_sheva_callister.sql` and `0146_numerous_mother_askani.sql` are additive.
- [Two-way shared folders](2026-10-27-shared-folders-are-two-way.md) define general participant-owned filing, replacing this implementation's original explicit-attachment exception. An attached recording remains its owner's data, and acceptance/revocation controls its shared-folder visibility.
- Explicit Organization attachment records a normal intended placement through
  `recordIntendedPlacementInTx`. Publication waits for the ordinary transcription and speaker share gate.
  Colleagues who could see the meeting retain read-only agenda access while the recording is unpublished:
  `attachedRecording: { visible: false }` and `redirectTo: null`. Once readable, its stable link redirects
  to the recording with the caller's private, Organization or received view.
- Calendar event and recurring-series IDs fill only empty recording columns. Detach clears identifiers
  only when equal to the agenda's values and removes attach-created filing in someone else's folder.
  Event context is encrypted in `calendar_snapshot`; a conditional `calendar_refreshed_at` update claims
  one lazy refresh per ten-minute TTL across processes. Detail and recorder matching read that snapshot;
  Meet codes stay server-only. Calendar export always reads fresh, defaults to excluding tasks, and
  excludes assignee and live notes. Both English and Czech block markers are recognized.
- Archives use the existing server-resolved scope and include standalone and absorbed agendas.
  The meeting restore endpoint accepts validated item/folder/task mappings; it creates no accounts,
  invitations or automatic external sharing. Suggestions can be regenerated and are omitted.
- Read-only MCP tools carry `readOnlyHint`; agenda writes use the existing `tasks:write` role.
  Task review and task counts require `tasks:read`; service callers cannot prepare or edit agendas.
  The recorder capability and optional completion metadata are additive for older extensions. An
  unavailable selected agenda never blocks completion: the response adds
  `agenda: { attached: false, reason: "unavailable" }`. Requests without `agendaId` keep their response shape.

## Verification

`src/tests/meetings/meetings.integration.test.ts` exercises 48 PostgreSQL cases, including concurrent
creation and housekeeping, access and revocation, safe attachment, point conflicts, snapshot stability,
carry-over and archive restoration. Eleven model cases pin tree depth, grouping and overlap; six
Calendar cases cover bounded pagination, recurring instances, organizer refusal and conditional writes.
Recorder and MCP tests cover authentication, role boundaries, capability discovery, completion metadata
and mail-role filtering. Existing task, sharing, export, Google, recorder and MCP suites are also run.

## Consequences & open follow-ups

- This is the server foundation. UI, Chrome side panel, summary/keyterm/Learn agenda context and the
  AI suggestions job body are deferred to their implementation runs. The durable suggestions kind
  returns an explicit unavailable error until that body exists.
- Browser verification must settle notification-click side-panel opening and its window fallback.
  Live Google verification must check recurring-series IDs for non-organizer invitees. Time-only
  matching on Zoom and Teams and summary coverage leakage require evaluation.
- The meeting migration numbers follow the branch's existing 0143; another branch merging first may
  require regeneration. No environment variable, compose or deployment-step change is required.

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
  implemented in the working tree for review, with the remaining feature runs pending.
