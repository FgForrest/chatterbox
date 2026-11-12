---
title: The recorder panel accompanies a meeting while preparation stays in the web app, and Join binds the tab before matching
date: 2026-11-10
updated: 2026-11-11 20:42
status: superseded
kind: fix
issues: [386]
prs: []
areas: [extensions/recorder, src/lib/integrations/google/meet-code.ts, src/app/meetings/[id]/route.ts, src/app/api/v1/recorder/agendas]
supersedes: [2026-10-27-meeting-agendas, 2026-11-08-recorder-live-agendas]
superseded-by: [2026-11-11-recorder-panel-recording-block]
relates: []
---

# The recorder panel accompanies a meeting while preparation stays in the web app, and Join binds the tab before matching

Extension 0.9.7 keeps the panel focused on meeting review and recording. Agenda preparation,
point title editing and task dropping remain in the web app. Join in Meet associates its new tab
with the supplied agenda, event end and validated room identity before any automatic match.
The manifest version remains 0.9.7 because that version has not been uploaded to the Store.

**Superseded in part:** [Recorder panel recording block](2026-11-11-recorder-panel-recording-block.md)
puts the complete popup recording block first, retains Record this tab away from meetings, replaces
chooser/Back navigation with inline rows and Cancel, and keeps colleague presence inside the complete
block, and adds room discovery, short-lived open-panel presence and owner-only sharing. Preparation,
notes, permissions, live updates and Join tab binding rules still hold.

## Why

Google redirects some account-scoped joins from `/<code>` to `/meet/<code>`. Independent parsers
lost the room identity, so the recorder offered Join inside the call, missed its agenda and left
the panel on the old tab. Preparation forms and duplicated headers also competed with live review.
A failed request could look like an empty list, encouraging the user to abandon an existing agenda.

### Previous state

The panel offered Preparation and Live modes, editable point titles, adding points, Done/Drop task
buttons, an attachment bar and several navigation actions. Join opened a tab and rediscovered its
agenda by URL. Panels were enabled per tab, without a manifest default, to avoid appearing everywhere.

## Options considered

- **Open a per-tab panel from the extension page after creating the Join tab (chosen).**
  Chrome for Testing 158.0.8127.18 retained page activation through awaited `tabs.create`,
  `setOptions({tabId})` and `open({tabId})`: all 16 required page cases passed, including
  added delays of 100 ms, 1 second and 4 seconds. Opening was reached in 21–27 ms from the
  panel and 11 ms from the popup without added delay. The popup must create its tab inactive,
  open its panel and only then activate the tab; active creation destroys the popup before
  its continuation. Activation survived 4,007–4,026 ms and expired by 6 seconds. Switching
  back restored the same old panel document, independently of the new panel.
- **Open a window-wide panel before creating the tab (declined).** It can be opened before
  asynchronous work, avoiding dependence on activation surviving tab creation.
  **Rejected because:** it introduces a second panel lifecycle, window ownership, shared context,
  startup reconciliation and cleanup races, while page activation already supports per-tab panels.
  Revisit only if Chrome stops preserving page activation across the short local Join sequence.
- **Open the new tab's panel from the service worker (declined).** Centralizes Join handling.
  **Rejected because:** all seven measured worker controls failed with the user-gesture error,
  including messages from real page clicks. The earlier measurement tested this worker path,
  not the page continuation. Notification Join therefore creates and binds the tab only;
  the toolbar icon opens its agenda through the ordinary per-tab route.
- **Keep preparation controls in the panel (declined).** Allows preparing without switching to the
  web app. **Rejected because:** it duplicates the web editor in the limited meeting sidebar and
  hides the checklist and audio meters. The approved design assigns preparation to the web app.

## Decision

Use one column at all widths, with the agenda title, planned time and Change agenda in its header.
Away from a meeting, show the plan read-only, its matching Calendar Join offer, target folder and
screen/app recording action. On the meeting, points and tasks use checkboxes under the existing
permissions. Notes open through Note and non-empty notes remain visible. Recording shows elapsed
time, both level meters, folder and Stop and save. After Stop, show segment progress and read-only
coverage. Drop is available in the web app only.

Keep SSE invalidation, server-seeded CRDT note bindings, polling, first-edit linking, version checks
and conflict messages. Change agenda carries an explicit recording choice, including No agenda.
Default participant text stays in Options; popup and panel retain operator and user custom notices.
A missing legacy default flag is inferred only from the exact known default text.

## Key technical details

- `lib/meet-code.js` supplies the extension's validated room identity for both paths; the server
  extractor accepts both too. Content scripts and the banner use the existing platform registry.
- `lib/join-meeting.js` stores the tab binding only in session storage, scoped to the paired server
  and credential identity. The room code survives redirects and account-query changes; leaving
  the room, closing the tab or the event-end alarm clears the binding and its tab context.
  Publication is serialized with tab removal and checks that the tab still exists in that room.
  Other room openings keep ordinary matching. No manifest default panel or permission is added.
- `lib/join-meeting-page.js` opens the per-tab panel from the page click. Side-panel Join opens
  before the worker publishes its context; the page listens for the later storage change. Popup Join
  awaits publication before opening, then activates the tab. Refused or missing panel APIs use the
  existing separate agenda-window fallback, with binding and icon routing preserved. The worker
  performs fallback activation and window creation so closing a popup cannot interrupt recovery.
- User-visible matching has a ten-second deadline; background routing retains its one-second bound.
  Errors are not cached as successful empty matches and the panel offers Retry independently of capture.
- Existing recorder endpoints and capability gates remain. The existing task status PATCH additionally
  accepts `open`, using the same task permission/version checks. A released server that refuses reopening
  leaves the saved task intact and shows the existing error; no new endpoint or response field is required.
- Stable meeting links return a relative 307 Location with `private, no-store`, independent of the
  container bind address. No schema, environment or deployment configuration changes are required.

## Verification

The Meet path regression covers eight valid URL variants and nine invalid/non-room URLs across
platform detection, agenda matching, notification-room checks, recording identity and server extraction.
Join tests cover redirect persistence, lifecycle cleanup and pairing isolation. Panel tests retain
concurrent note/caret, version, conflict and stream/polling coverage alongside the new states.
Chrome captures cover away, meeting-idle, recording, after-stop, agenda choice, load error and popup
states in both color schemes with an invented local API fixture.

Chrome for Testing 158.0.8127.18 with the unpacked extension passed both implemented Join paths
using real CDP mouse clicks and local API/Meet fixtures: panel-page Join and popup Join opened the
agenda on the active new tab, switching back preserved the original panel document, the binding
survived a navigation to `/meet/<code>?authuser=1`, and closing the tab removed its binding,
context and route. Per-tab options stayed independent, no default panel was registered, and no
browser exceptions occurred. Chrome APIs, extension messaging and storage were not mocked.

On Node 24.22.2 and Node 22.22.2, the recorder and regression suites pass 1,969 tests with 833 skipped
across 198 files (163 passed, 35 skipped). Tests cover all three Join paths, closed/navigated tabs,
serialized publication/removal, a delayed automatic match, panel refusal/missing APIs, fallback
and pairing/end cleanup. Biome, TypeScript and the generated ADR index checks pass.

## Consequences & open follow-ups

Both self-host and hosted keep their existing user-scoped agenda/task APIs and encrypted audio recovery.
A bad tab binding could select the wrong agenda until the user changes it; bindings are pairing-scoped,
expire with the event, and completion still applies server-side attachment authorization. A panel load
failure affects review while recording and upload remain available. Hosted continues without Google
joins; self-host Google joins use the existing connected account. Rollback needs no data migration.
Native permission dialogs, authenticated Google calls and Chrome Web Store submission remain release
checks; the local fake-server browser pass does not claim to cover them.

## Related work

- [Meeting agendas](2026-10-27-meeting-agendas.md) is superseded only for recorder-panel preparation,
  title editing and Drop controls. The web editor, plan/evidence distinction, sharing, attachment and
  export rules remain in force.
- [Recorder live agendas](2026-11-08-recorder-live-agendas.md) is superseded only for the panel's
  preparation/editing surface and Join publication before automatic matching. Capabilities, collaboration, encryption,
  presence and the scoped Calendar data boundary remain in force.

## Timeline

- **2026-11-10**: the maintainer approved the meeting-companion design and required all changes in
  unreleased extension 0.9.7. Follow-up Chrome measurements selected per-tab panels opened from
  the extension page, with an inactive new tab in the popup.
