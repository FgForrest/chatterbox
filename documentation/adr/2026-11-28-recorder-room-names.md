---
title: Live meeting recorders share their names with Organization members in the same room
date: 2026-11-28
updated: 2026-11-28 20:13
status: accepted
kind: feature
issues: [462]
prs: []
areas: [extensions/recorder, src/lib/meetings/room-key.ts, src/db/queries/recorder-rooms.ts, src/db/queries/recording-session-leases.ts, src/app/api/v1/recorder]
supersedes: [2026-11-08-recorder-live-agendas, 2026-11-11-recorder-panel-recording-block]
superseded-by: []
relates: []
---

# Live meeting recorders share their names with Organization members in the same room

On a self-hosted server with an Organization, the recorder popup and side panel show the names
of colleagues currently recording the meeting tab. The notice appears in the idle recording controls.

## Why

Colleagues deciding whether to record need to know who is capturing the meeting now. Ad hoc meetings
and non-Meet providers need the same indication as scheduled Meet calls.

### Previous state

The live-agenda API disclosed recorder names to agenda viewers. A meeting without a shared agenda
gave colleagues no indication through the recorder.

## Options considered

### Room identity from the tab address

An authenticated Organization member can look up any supported exact room. The extension looks up
the active tab and the response contains only display names. A guessed room identifier can also
match because the server relies on the caller-declared room.

### Agenda or Calendar visibility

The server can check the viewer's relationship to the agenda or event. This approach was declined
because it leaves ad hoc meetings without an indication and depends on Calendar linkage for meeting
providers where there is no such integration.

## Decision

Use the tab's validated room identity as the lookup key. Scope all reads and writes to self-hosted
Organization mode and authenticate them with the recorder credential. Project active colleagues'
display names once per person. Keep the reader's own account outside that projection.

## Key technical details

- The server advertises `features.roomRecorders: 1` to enable the calls. The extension
  validates provider-specific URL shapes and sends the room identifier in the request body.
  The server stores a keyed room hash. Meet uses the same hash as agenda matching.
- A host-confirmed tab capture refreshes its capture lease every 20 seconds while it has a server
  session. Leases expire after 60 seconds. Persisted revisions order renewals, moves, clears
  and terminal ends. Chrome's source picker does not establish a room identity.
- The lookup accepts one exact room per POST. It allows 48 requests per minute per account across
  recorder keys and 480 per IP. The response includes the earliest lease expiry and its remaining
  lifetime on the server clock. The worker counts elapsed lookup time against that lifetime, caps
  the cache at 30 seconds, and scopes results to the tab, room and current pairing. Stop uses a best-effort end call, and server completion and
  discard clear presence as part of the session transition.

## Verification

Seventeen positive URL fixtures match the extension canonicalizer and server validator, including
the existing Meet agenda key. Worker tests cover 20-second renewal throttling, revision order,
terminal refusal, Stop, stale lookups and backoff. Chrome for Testing 159 captured eight mock-server
views in the native popup and side panel with one and three names in both themes. PostgreSQL tests
cover lease ordering, terminal clearing and the name projection; the Keycloak recorder suite covers
withdrawn access on the lease and lookup routes.

## Consequences & open follow-ups

Eligible Organization members who know or correctly guess an exact meeting room can learn a live
recorder's name. Rate limits bound lookup volume. In-flight leases expire after interruption and
viewer caches expire by the earliest lease deadline in the response. The legacy and hosted recorder paths
use their standard configuration capability checks. The server schema changes are additive.

Verify real Teams and Webex invite-to-in-call redirects before accepting alternate URL forms for
the same room.

## Related work

- [Recorder live agendas](2026-11-08-recorder-live-agendas.md) is superseded for the audience of live
  recorder names. Its agenda API still governs access to the agenda and its recorder list.
- [Recorder panel recording block](2026-11-11-recorder-panel-recording-block.md) is superseded for
  live names discovered by room. Its agenda visibility and Calendar-based invitation rules govern
  the agenda section.

## Timeline

- **2026-11-28** The maintainer approved name-only visibility by room.
