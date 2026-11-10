---
title: Recorder agendas use scoped Meet join links, PostgreSQL live invalidations and encrypted CRDT text with materialized archive fields
date: 2026-11-08
updated: 2026-11-10 18:05
status: superseded
kind: feature
issues: []
prs: [356]
areas: [src/lib/meetings, src/db/queries/agenda-events.ts, src/db/schema.ts, src/lib/recording-sessions, src/app/api/v1/recorder, src/components/meetings, extensions/recorder]
supersedes: [2026-10-27-meeting-agendas, 2026-10-22-meeting-recorder-banner]
superseded-by: [2026-11-10-recorder-meeting-companion]
relates: []
---

# Recorder agendas use scoped Meet join links, PostgreSQL live invalidations and encrypted CRDT text with materialized archive fields

Agendas gain live invalidations and character-level text merging in the web editor and recorder API.
The recorder can request the caller's next primary-calendar Meet event and announce the agenda of an
active recording. PR #356 includes the server, web editor, recorder extension 0.9.2 and additive
migration `0157_recorder_live_agendas.sql`.

**Superseded in part:** [Recorder meeting companion](2026-11-10-recorder-meeting-companion.md)
keeps preparation, point title editing and task dropping in the web app. The recorder panel becomes
one live checklist with notes behind a link and one agenda chooser. Join binds the new tab to its
agenda before automatic matching and opens that tab's panel from the extension page; popup Join
keeps the new tab inactive until its panel is open. Calendar notification Join binds the tab only.
The collaboration, attachment, permissions and remaining rules still hold.

## Why

Shared preparation and live note-taking need concurrent edits without replacing another participant's
text. Recorder users also need an agenda to remain reachable after recording starts and need to join
the next meeting through the Google account connected to the app. These changes must preserve released
recorder clients, independent recording consent, encryption and operation across several app processes.

### Previous state

Agendas used fifteen-second polling and whole-field versioned replacements. Meet codes stayed on the
server, and a meeting banner could arm the toolbar icon for immediate capture. Recording sessions
learned their explicit agenda choice only at completion. Recorder matching answered from the cached
Calendar snapshot before an asynchronous refresh, so an empty or outdated cache could hide a matching plan.

## Options considered

- **PostgreSQL NOTIFY and SSE (chosen).** Reuses the event transport and requires no new service.
  Notifications contain agenda IDs and cursors only; clients refetch through normal authorization.
- **WebSockets (declined).** Bidirectional delivery would suit text collaboration, but requires a new
  connection lifecycle and cross-process distribution path. **Rejected because:** the existing database
  event mechanism already supplies cross-process fan-out, and HTTP updates provide the required merge
  serialization. Revisit if the product needs a bidirectional presence protocol.
- **Whole-field replacements (retained for legacy clients).** Simple, versioned and appropriate for
  ticks and structural operations. **Rejected for collaborative text because:** they make simultaneous
  note writers resolve conflicts manually or overwrite each other.
- **Client-created Yjs seeds (declined).** Avoids an initial server read. **Rejected because:** two
  editors independently inserting the same starting text create duplicate content when merged.

## Decision

Use server-seeded Yjs documents for point text, point notes and reviewed-task agenda notes. The server
holds the agenda lock before initializing or locking a document, applying an update and materializing
its text in the existing encrypted column. Point-author and agenda-management permissions still govern
point text; visible editors can co-edit notes. Absorbed agendas remain read-only. Ticks, point structure,
membership and real task status retain discrete operations and their existing permission boundaries.

Allow a Meet join URL only for a timed, non-cancelled primary-calendar event that the caller organizes
or attends and has not declined. The recorder key belongs to that same caller. Build the URL from a
validated room code, setting `authuser` to the connected Google email, never an account index or an
unvalidated event URL. Google availability and hosted-mode boundaries remain unchanged.

For agenda tabs, the extension's toolbar icon toggles the agenda panel; recording starts from
its controls. The keyboard shortcut retains start/stop behavior, and the separate fallback window
remains. The extension detects server capabilities and keeps agenda reminders and recording controls
available on released servers. Notifications default to meeting start; users can select an earlier lead.

## Key technical details

- Recorder config advertises `agendas`, `nextMeeting`, `agendaLive`, `agendaText: 1` and `sessionAgenda`.
  New behavior is capability-gated by clients. Session creation previously ignored unknown top-level
  fields rather than rejecting them, but clients must still send the optional new `agendaId` only
  when `sessionAgenda` is advertised.
- Creation and open-session PATCH validate agenda edit access and store `metadata.liveAgendaId`.
  This is presence, not completion intent. `metadata.agendaId` is unchanged: a completion string is
  an explicit selection, null is explicit none, and omission preserves automatic attachment rules.
  `recordingBy` discloses names and a `self` boolean only to agenda viewers, for open or completing
  sessions started within twelve hours. It grants no access to audio or session identifiers.
- `src/db/queries/agenda-events.ts` publishes mutation invalidations in the transaction. One LISTEN
  per process fans out by agenda ID. Both SSE routes recheck credentials, visibility and a database
  lease every 25 seconds. Six live leases per user are shared across processes and expire after
  75 seconds, recovering capacity after a process failure. Polling remains a recovery path.
- Web SSE uses the session; recorder SSE uses the Authorization header. Keys never go in URLs.
  Frames contain only `type: "agenda"` and a cursor. Notifications contain only `agendaId` and a cursor.
- `/api/meetings/:id/text` and `/api/v1/recorder/agendas/:id/text` share GET and POST semantics.
  GET takes `field`; POST takes `{ field, update: base64, stateVector?: base64 }`. Responses contain
  `{ field, update, stateVector, version, materializedVersion }`. Document version and materialized
  point/task-reference version are independent; a follow-up discrete edit uses the latter after flushing. Field keys are
  `point:<id>:text`, `point:<id>:note` and `task:<taskId>:note`. An initial GET is mandatory.
- `agenda_text_docs.state` stores encrypted base64 Yjs state through field-encryption helpers. New
  attribution columns are nullable. Text updates are limited to 64 KiB, stored state to 1 MiB, and
  materialized fields to their existing 2,000-character single-line limits. Non-text roots, rich
  formatting, embeds and unresolved updates are refused. Plain PATCHes replace within the same
  document history, and deleting points removes their derivative documents.
- Archives continue exporting materialized plain text, never Yjs state or stream leases. Restored
  agendas rebuild their documents from those columns on first fetch. Undo and CRDT history are
  derivative collaboration state, not archive content.
- `src/lib/meetings/text-sync.ts` has no React or Next imports. It fetches the server seed before
  accepting input, applies minimal local differences, preserves relative-position selections and
  input scroll, defers remote application during composition, and resyncs after reconnection.
- Lists and recorder matches put own agendas first and expose `own`. Matching resolves Calendar
  context in the response rather than relying on a later poll to discover a missing room code.

## Verification

On Node 22.22.2, `src/tests/recorder` and `src/tests/meetings` pass 1,038 tests across 69 files with
PostgreSQL, including the eighteen `live-agendas.integration.test.ts` cases for seeding, concurrent
merges, materialization, legacy writes, privacy, revocation, leases, session choices and notifications.

The focused options, panel-label, stream-reconnect, web-live and polling suites pass 41 tests across
five files. They cover released-server lead settings, distinct English/Czech navigation labels,
bounded stream backoff with polling and cleanup, focused-field carets and save-then-indent versions.
Formatting and TypeScript checks pass.

## Consequences & open follow-ups

Both deployment modes receive additive migration `0157_recorder_live_agendas.sql` without new environment
variables or compose configuration. A text-merge failure rolls back the document and materialized column
together. Older images ignore the derivative tables and new columns;
their text writes cannot maintain existing Yjs history, so the next document read reconciles any
divergence against the materialized field under the agenda lock before collaborative editing resumes.

In shared self-host mode, a visibility regression could expose a plan or a recorder's presence to the
wrong colleague; revocation closes streams on the next access check and immediately refuses content
reads and writes. Previously downloaded content cannot be recalled. Hosted keeps Google and person
sharing unavailable while using the same owner-scoped text and stream boundaries. A broken SSE path
delays changes until polling, and a broken merge affects the attempted field rather than losing the
stored plan. Exported materialized text remains recoverable independently of collaboration state.

Extension 0.9.2 includes icon routing, shared controls, capability detection, session linking,
next-event notifications, recording attribution and the shared text binding. Agenda matching includes
held meetings, preserves selection during recording and keeps the agenda reachable after an empty match.
The maintainer's real-click Google and Chrome checks remain: account-scoped Meet joins, toolbar/panel
recording, notification clicks and the fallback window. The Chrome Web Store release is pending.

## Related work

- [Meeting agendas](2026-10-27-meeting-agendas.md) is superseded only for server-only Meet codes and
  polling/whole-field-only collaboration. The scoped recorder join link is the exception; other
  clients receive no room code. Plan/evidence separation, author management, sharing, attachment
  consent, Calendar export and backup scope remain in force.
- [Meeting recorder banner](2026-10-22-meeting-recorder-banner.md) is superseded only for the
  one-click recording rule on agenda tabs: icon clicks toggle the panel there. Other tabs, keyboard
  recording, opt-in site access, notification fallback and capture consent retain their previous rules.

## Timeline

- **2026-11-08**: maintainer accepted scoped Meet joins, agenda-panel icon behavior, PostgreSQL live
  events and Yjs text collaboration. PR #356 implements the server, web editor, extension 0.9.2 and
  migration 0157; real-click checks and the Store release remain.
