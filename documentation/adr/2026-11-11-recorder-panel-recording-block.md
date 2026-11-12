---
title: Recorder panels keep capture first and share agendas through short-lived room presence
date: 2026-11-11
updated: 2026-11-11 22:24
status: proposed
kind: fix
issues: [403]
prs: []
areas: [extensions/recorder, src/lib/meetings/rooms.ts, src/db/queries/recorder-rooms.ts, src/lib/recording-sessions, src/app/api/v1/recorder, src/db/schema.ts]
supersedes: [2026-11-10-recorder-meeting-companion]
superseded-by: []
relates: [2026-11-08-recorder-live-agendas, 2026-10-27-meeting-agendas, 2026-11-08-meeting-agendas-shared-with-people]
---

# Recorder panels keep capture first and share agendas through short-lived room presence

Extension 0.9.9 starts the side panel with the same recording widget as the popup.
The Agenda section below owns the title, checklist, chooser and agenda errors. A colleague's
recording adds a notice inside the idle block without replacing its controls. On supporting servers,
Meet rooms also discover visible manually selected agendas, expose a restricted marker without
content, and let the author invite eligible people whose panels are open in that room.

## Why

On an ordinary tab, Choose agenda opened a panel that hid Record this tab even though the popup
offered it. A separate chooser and Back action also left an empty Meeting agenda heading.
Recording availability must follow the source tab and Chrome's capture permission, independently
of agenda matching, selection and failures. Calendar-only matching also kept manually chosen plans
from colleagues, and forgotten sharing forced the owner out of the meeting to the web app.
A meeting URL alone cannot grant agenda access or justify disclosing another person's activity.

### Previous state

The panel put the agenda title first, hid direct capture away from recognized meetings, and hid
recording controls behind Record as well when a colleague recorded. Its agenda chooser replaced
the content below the header and put No agenda outside the list. Only Calendar event matches found
Meet agendas; live recording presence required agenda visibility, and invitations were handled on the web.

## Options considered

- **Keep the complete shared recording block first (chosen).** The idle controls, recording
  meters and finalization remain reachable while the section below changes. The cost is vertical
  space in a narrow panel.
- **Keep the compact meeting-dependent controls and Record as well reveal (declined).** Saves
  space for the checklist. **Rejected because:** moving from the popup to its agenda panel removes
  the action the user was about to use, and colleague presence adds another step before recording.
- **Keep a separate chooser with Back (declined).** Gives the list a dedicated view.
  **Rejected because:** agenda navigation obscures the previous selection and competes with the
  recording surface. Inline rows and Cancel preserve that context without an Apply step.

- **Open-panel presence and owner-only invitations (chosen).** Names are useful to the person
  who can share the plan; three-minute expiry bounds stale disclosure without collecting all open tabs.
  This needs a small derivative table, heartbeats and a per-user database write cap.
- **Use an owner’s panel declaration alone to authorize the people list (declined).**
  **Rejected because:** an unrelated agenda and a guessed room code could enumerate other users’
  activity. Even an empty recording session accepts a caller-declared room code, so it cannot
  establish that relationship either. Require the agenda’s own server-read Calendar event.
- **Presence for every open Meet tab (declined).** Finds more eligible colleagues without a panel click.
  **Rejected because:** the approved boundary is an explicitly open recorder panel; an unused browser tab
  must not announce its holder to an agenda author.
- **Reveal the author or recorder beside a restricted marker (declined).** Helps colleagues ask for access.
  **Rejected because:** knowing the room code grants only the existence marker. Names and content require
  agenda visibility or a receiver's explicit pending invitation.
- **Web-only invitation acceptance (declined).** Reuses the existing web screen with fewer extension states.
  **Rejected because:** it forces meeting participants away from the panel despite recorder-token endpoints
  being able to reuse the same consent, folder ownership and optimistic-version checks.

## Decision

Mount `lib/recording-controls.js` first in `agenda/agenda.html`, including both idle recording
buttons on ordinary tabs. Keep the next-meeting offer inside that block with the popup's content.
The panel has no page header. Its Agenda section shows the selected title and time or No agenda,
with Change agenda or Choose agenda on the right.

Expand the chooser inside that section as one framed list. Agenda rows come first, then No agenda;
all current choices carry Selected and a filled radio. Clicking selects and collapses; Cancel
restores the previous view without sending a selection. An empty time window keeps the No agenda row.
Load errors stay inside the Agenda section. Preparation and task dropping remain in the web app;
away views are read-only, meeting/capture views retain checkboxes, and after Stop only discussed
coverage remains. Notes, live collaboration, capture consent and server capability gates retain
their existing rules.

Bind a Meet room to agendas explicitly selected in a fresh open panel or an open/completing recording started
within twelve hours, in addition to Calendar matching. Project each candidate through current agenda
visibility. Automatically discovered or followed selections publish presence without an agenda ID,
so followers cannot keep obsolete bindings alive. Explicit Join and the current recording’s agenda
take precedence over automatic room matching. Track whether ambiguity opened the chooser
automatically: keep polling and reconcile it when matching resolves to one agenda. A chooser
opened by the user and explicit selections retain their existing behavior. Only viewers receive IDs, titles and recording names. Other callers receive only
`restricted: true`; their own pending invitations separately disclose the title, time and sharer's name.

Only the author receives the room people list, and only for rooms tied to the agenda’s own
server-read Google Calendar event. The Calendar link, read through the agenda owner’s connected
Google account, is the relationship the server trusts. Recording sessions, presence and any other
caller-declared room code never qualify. Without that event and its Meet room, the list is empty
and the share card stays hidden. Filter eligible people by the
web’s active-recipient rule and each person’s current agenda access. Co-editors cannot share through this surface. Pending rows remain
until acceptance grants access. Panel acceptance uses the existing private-folder requirement;
an independent accepted folder path retains optional extra filing. It never shares a recording or
private task evidence. The owner card works before and during recording; all actions retain the
complete recording block above it. Share with all captures the agenda and recipients at click time
for every batch; a panel switch triggers refresh without applying pending state to another agenda.
Pending invitations show the invitation and acceptance hint without a restricted heading.

## Key technical details

- `mountRecordingControls` accepts the panel's idle notice and moves it into the cloned popup body.
  The panel does not duplicate recording or recovery implementations.
- Agenda selection retains `select-agenda`, explicit null and `canChooseRecordingAgenda` semantics.
  `agendaRooms: 1` adds independent support detection. Without it, no session room code, presence,
  people list, invitation or restricted UI is used; existing Calendar matching and panel layout remain.
- `room-key.ts` validates through the existing Meet extractor and derives a dedicated HMAC key through
  the existing domain-separated lookup helper. New session metadata and presence rows store only
  HMAC-SHA256 room hashes, never the plain code. Existing encrypted Calendar snapshots stay server-side.
- `recorder-rooms.ts` projects authorized IDs separately from the restricted marker. Presence writes
  lock the caller's user row, skip refreshes within twenty seconds across all rooms, and return retry
  timing. The separate `written_at` timestamp preserves the write cap; pruning retains rows until
  the cap also expires. Panels send on opening, selection changes and every sixty seconds. Closing
  the panel or leaving the meeting stops updates; presence expires from matching and people lists
  within about three minutes of the last update, including after crashes. The extension sends no
  DELETE on leave. Hourly housekeeping deletes stale rows.
- Recorder routes use the existing authenticated, scoped and rate-limited gate. Invites reuse
  `inviteToItem`, responses reuse `changePersonShare`. Content-free agenda events after panel sharing
  invalidate viewers; fifteen-second room polling discovers new invitations and bindings without a stream.
- Generated additive migration `0161_recorder_room_presence.sql` creates `recorder_room_presence` and its indexes
  with a separate `written_at` throttle timestamp in both deployment modes. No environment variable, compose or audio encryption protocol changes occur.
  This derivative presence is not agenda content and does not change export/restore membership.

## Verification

Part 1's recorder/regression suites passed 2,122 tests, with 1,015 skipped, across 175 passing files.
Its full unit suite passed 9,261 tests, with 3,750 skipped, across 732 passing files. Panel and shared
widget tests cover ordinary-tab recording, No agenda, inline selection, Cancel, empty choices,
Selected on No agenda, restoring a recording agenda from the popup, read-only views after Stop,
and colleague presence. Biome, TypeScript and message catalog checks pass.

Chrome for Testing 158.0.8127.18, invoked through CDP's toolbar action, then real mouse clicks
on popup Choose agenda and panel Record this tab, returned a stream ID for an ordinary HTTPS tab.
Tab audio measured about -23 dB, two encrypted chunks uploaded to a local invented-data fixture,
and Stop requested completion. No desktop picker window or share dialog opened. The environment
had no microphone device; its existing warning appeared while tab audio continued. A control
using only programmatic `chrome.action.openPopup()` opened the popup without granting capture
permission, including before opening the panel; it took the existing picker fallback.

Dark/light captures cover all eight requested states in the native side panel and in the same
extension document at 400 px. The 400 px recording/progress states use fixture state; the native
recording capture follows the real recording flow. No Chrome APIs or extension messaging were mocked.

Part 2's final focused run passes 151 tests: 74 PostgreSQL integration tests and 77 extension unit
tests. The new room suite covers session hashes, visibility, expiry, caller boundaries, author-only
sharing, pending invitations, folder ownership and content-free agenda events. Heartbeat, card,
routing and panel tests cover capability degradation and stale navigation responses.

Full database-backed verification covers 9,377 unit and 3,497 integration tests, with 201 skipped.
The four-worker run had a thirty-second timeout in the own-task Private-root case and a
thirty-second housekeeping disposal-hook timeout; both affected files pass all twenty tests
when rerun serially. The task stack did not identify which awaited database operation timed out.

The same Chrome version exercises native-panel Share and Accept through real extension messaging
against a local invented-data API. Twelve dark/light screenshots cover the owner card before and
after sharing, the owner card during recording, restricted access, an invitation and the accepted
colleague agenda. The during-recording state is seeded; this check does not replace the real capture
flow verified in part 1. Biome, TypeScript, message catalogs and the decision-record index pass.

Fix round 1 added sixteen regression cases for dummy-agenda probing, then-current owner recording bindings,
batched sharing across a panel switch, explicit selection provenance, two-panel following beyond
presence expiry, Join precedence and leave/refresh serialization. The room PostgreSQL suite passes
35 tests. The final whole suite with two workers passes 12,890 tests with 201 skipped and no failures;
the recorder scope accounts for 1,262 passing tests across 81 files. Initial focused failures in
chooser retention and route-field expectations were corrected, and both affected files passed
individual reruns before the successful full run. Chrome rechecks owner and invitation states in
both themes, including the acceptance hint and a measured 16 px microphone-warning gap.

Fix round 3 replaces session-based people-list authorization with the agenda’s own Calendar link.
The empty-session dummy-agenda regression refuses people and invitations; Calendar tests cover
a missing Meet room, a removed event and conflicting session/presence rooms. The two-panel test
now includes a throttled heartbeat, temporary A+B matches and automatic recovery to B. Automatic
chooser tests also cover initial ambiguity and preserve manual choosers and explicit selections.
The room suite passes 37 tests; the focused recorder/room run passes 781 tests across 39 files.
The whole suite with two workers passes 12,896 tests with 201 skipped, across 933 passing and
14 skipped files, with no failures. Biome, TypeScript, message catalogs, the ADR index and
whitespace checks pass. Closing or leaving stops updates; expiry takes about three minutes.

## Consequences & open follow-ups

Both modes receive an additive presence table and use the same scoped recorder APIs; existing audio
and content remain recoverable. Self-host Organization mode permits person sharing; hosted and local-only
modes keep that surface unavailable while room matching still respects current item visibility.
A faulty projection could disclose a private plan or activity; correcting it prevents later reads but
cannot recall earlier responses. A heartbeat failure delays discovery until retry and never blocks capture.
Room identity is a matching key, not proof of meeting attendance or an authorization credential.
Secret rotation changes the derived room keys, so older room bindings no longer match; fresh panels
and sessions restore discovery. Presence lasts three minutes in reads, with stale physical rows removed
hourly. Rolling back the application leaves an unused additive table and requires no data conversion.
Chrome Web Store submission and authenticated meeting checks remain release checks.

## Related work

- [Recorder meeting companion](2026-11-10-recorder-meeting-companion.md) is superseded only for
  header placement, away-tab recording availability, chooser navigation and colleague recording reveal.
  Its web-only preparation, notes, permissions, live updates and Join tab binding rules still hold.
- [Recorder live agendas](2026-11-08-recorder-live-agendas.md) supplies capability gates, viewer-only
  recording names, session selection and content-free events. Room presence adds a separate open-panel boundary.
- [Meeting agendas](2026-10-27-meeting-agendas.md) keeps raw Calendar Meet data server-side, the common
  access boundary, plan/evidence distinction and attachment rules. Room hashes add no general Meet disclosure.
- [Agendas shared with people](2026-11-08-meeting-agendas-shared-with-people.md) supplies accepted co-editing,
  private filing, independent recording consent and hosted/local-only gates, reused by recorder endpoints.

## Timeline

- **2026-11-11**: maintainer approved the complete recording block, inline agenda chooser and
  colleague notice for extension 0.9.9; implemented as issue #403 part 1.
- **2026-11-11**: owner-only panel presence, restricted markers and in-panel invitation acceptance
  implemented as part 2 under the same decision.
