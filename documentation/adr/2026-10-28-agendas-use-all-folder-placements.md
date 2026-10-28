---
title: Agenda filing uses recording transactions and every placement contributes audience and preparation context
date: 2026-10-28
updated: 2026-10-28 17:25
status: proposed
kind: feature
issues: []
prs: [293, 302]
areas: [src/lib/folders/folders.ts, src/lib/meetings, src/db/queries/agenda-suggestions.ts, src/app/api/recordings, src/components/meetings]
supersedes: [2026-10-27-meeting-agendas, 2026-10-27-shared-folders-are-two-way]
superseded-by: []
relates: []
---

# Agenda filing uses recording transactions and every placement contributes audience and preparation context

Standalone agendas can be filed into several folders, moved and unfiled through the recording filing routes.
Every valid placement contributes to visibility and preparation. The maintainer accepted this ruling on
2026-10-28; implementation is awaiting integration.

## Why

An agenda shared across cooperating groups must appear in each group's folder. Picking one folder for
preparation or attachment can omit a group's activity or give an arriving recording a larger audience.
Folder participation, revocation and Organization publication already have transactional rules that
must apply consistently to recordings and agendas.

### Previous state

Agendas started in one folder and used a dedicated unfiling mutation. General filing helpers already
accepted the meeting kind, but recording routes excluded it. Suggestions, attachment and automatic
task selection consumed one folder even though placements and archives supported lists.

## Options considered

### Retain a primary folder and use a separate agenda mutation API (declined)

This limits changes to preparation and keeps its old snapshot behavior.
**Rejected because:** the maintainer requires recording-like multi-folder filing, and a primary folder
would leave second-folder viewers and activity out of attachment disclosure and preparation.

### Reuse filing transactions and resolve the union (chosen)

This keeps ownership and revocation checks in one place. Preparation must deduplicate repeated sources
and evaluate each folder's previous-meeting cutoff independently.

## Decision

Use recording filing helpers and locks, including participant-owned contributions and Organization
moves. Plans use the helper's existing meeting branch without audio publication prerequisites: an
agenda has no transcript or speakers to review. Recording share gates continue to apply to recordings.

Planned agendas reconsider automatic task selection and offer carry-over after an author filing change.
Collaborative filing does not regenerate another author's private preparation context.
Explicitly selected task sources and live or held task snapshots remain fixed. Review entries with notes
survive a filing-induced automatic source change. Carry-over retains
accepted and dismissed lineage so filing again does not offer the same point twice. Points and notes
stay with the agenda when its audience narrows.

## Key technical details

- The filing route uses the agenda access boundary for the meeting kind. It does not widen the
  recording processing APIs' kind allowlist. Absorbed agendas remain read-only.
- `meetingItemAudienceInTx` already unions placements. Automatic attachment requires matching audiences
  in both directions and never files a recording. Matching locks the agenda before reading its audience,
  serializing with filing changes. Explicit attachment considers every agenda placement;
  Organization placements remain intended publication subject to the recording's ordinary gate.
- Suggestion inputs combine folder-specific activity windows and deduplicate item and task IDs.
  Calendar series ranking counts distinct visible recordings across the actual agenda placements.
  Settings resolve that context through agenda access; creation still validates its filing target.
- Recorder agenda responses keep their existing fields. `folders` already holds a list; `folderPath`
  deterministically chooses the folder with the smallest ID. No extension update is required.
- Archive collection and restore already use folder lists. Personal archives retain only the owner's
  placements and do not recreate another person's invitations. No additional migration is needed.

## Verification

`src/tests/meetings/multiple-folders.integration.test.ts` passes 14 PostgreSQL cases covering
second-folder co-editing, narrowing, moves, participant filing, last unfiling, both automatic attachment
paths, concurrent filing versus attachment, explicit multi-folder attachment, deduplicated suggestions, automatic task sources, review-note preservation, preparation ownership, Calendar context, carry-over and backup restoration.
`src/tests/meetings/agenda-folders.test.tsx` passes 3 cases covering the shared chips, source selection, local received
folder names and absorbed agenda controls. Existing meetings, folders, sharing, recorder, MCP and export
suites and the meeting-review regression remain required.

## Consequences & open follow-ups

Incorrect visibility filtering can expose a plan to shared self-host members; unfiling or revocation
removes subsequent access but cannot recall previous reads. Hosted has no person-sharing surface;
ownership and kind boundaries still apply to its filing routes. Both modes retain content in the
owner's library when the last placement is removed. No deployment configuration changes are required.

## Related work

- [Meeting agendas](2026-10-27-meeting-agendas.md) is superseded only for its single-folder preparation
  and attachment behavior and freezing automatic preparation across filing changes. Plan/evidence,
  Calendar consent, author management and absorbed-agenda lifecycle rules remain in force.
- [Two-way shared folders](2026-10-27-shared-folders-are-two-way.md) is superseded only for its dedicated
  standalone agenda unfiling route. That route remains a compatibility entry point delegating to the
  general helper; participation, ownership, revocation, processing and export rules still hold.

## Timeline

- **2026-10-28**: maintainer required multi-folder agendas and recording-like filing; implementation
  and regressions prepared for review.
