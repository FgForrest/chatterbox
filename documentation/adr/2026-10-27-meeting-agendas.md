---
title: Meeting agendas are co-edited plans absorbed by recordings, with safe attachment and manual Calendar export
date: 2026-10-27
updated: 2026-10-27 10:15
status: partially-implemented
kind: feature
issues: []
prs: []
areas: [src/lib/meetings, src/db/queries/meetings.ts, src/db/queries/meeting-folder-access.ts, src/db/schema.ts, src/app/api/meetings, src/app/api/v1/recorder, src/lib/mcp/tools/meetings.ts, src/lib/export/meetings.ts, src/lib/integrations/google]
supersedes: [2026-10-22-person-to-person-sharing, 2026-10-19-processing-profiles-and-workflow]
superseded-by: []
relates: [2026-10-12-calendar-meet-speaker-candidates, 2026-10-22-calendar-speaker-guesses-in-automatic-runs, 2026-10-07-tasks-from-summaries, 2026-10-22-meeting-recorder-banner, 2026-10-07-backup-scope]
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
private recording into a shared folder. Automatic attachment requires one same-owner overlapping
candidate and an existing matching placement or an unshared owner-private folder. It never files the
recording. Explicit attachment requires agenda edit access and recording ownership and files into the
agenda folder with the resulting audience available to the client.

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
  its attached agenda. Migrations `0144_parched_rogue.sql` and `0145_unusual_sheva_callister.sql` are additive.
- An explicitly attached colleague-owned recording is the narrow exception to same-owner folder
  membership. `meeting-folder-access.ts` validates the attached agenda and its original placement;
  accepted receivers lose access immediately on revocation. The recording remains its owner's data.
- Explicit Organization attachment is publication consent before transcription: the common Organization
  filing helper validates the live agenda placement and publishes existing confirmed knowledge without
  waiting for speaker review. Ordinary filing retains its gate. Requiring a transcript here would
  prevent the recorder's explicit agenda selection from attaching before transcription, contrary to
  the approved arrival contract.
- Calendar event and recurring-series IDs persist on recordings. Attendee addresses remain transient;
  server matching never returns a Meet room code. Calendar export defaults to excluding tasks and
  excludes assignee and live notes. Both English and Czech block markers are recognized.
- Archives use the existing server-resolved scope and include standalone and absorbed agendas.
  The meeting restore endpoint accepts validated item/folder/task mappings; it creates no accounts,
  invitations or automatic external sharing. Suggestions can be regenerated and are omitted.
- Read-only MCP tools carry `readOnlyHint`; agenda writes use the existing `tasks:write` role.
  The recorder capability and optional completion metadata are additive for older extensions.

## Verification

`src/tests/meetings/meetings.integration.test.ts` exercises 20 PostgreSQL cases, including concurrent
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
- The two new migration numbers follow the branch's existing 0143; another branch merging first may
  require regeneration. No environment variable, compose or deployment-step change is required.

## Related work

- [Processing profiles and workflow](2026-10-19-processing-profiles-and-workflow/README.md): superseded only for review-gated publication on the explicit agenda-attachment path. The recording owner and an editable agenda are both required; ordinary arrivals retain intended placements.

- [Person-to-person sharing](2026-10-22-person-to-person-sharing.md): superseded only for same-owner
  direct-folder membership when a co-editor explicitly attaches their own recording. Ordinary receiver
  rights and invitation revocation remain unchanged.
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
