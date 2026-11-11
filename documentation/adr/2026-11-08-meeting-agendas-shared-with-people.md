---
title: Agendas share co-editing through accepted person invitations while recordings require separate consent
date: 2026-11-08
updated: 2026-11-11 20:42
status: proposed
kind: feature
issues: [329]
prs: [348]
areas: [src/lib/meetings, src/lib/sharing, src/db/queries/meetings.ts, src/db/queries/meeting-shares.ts, src/components/meetings, src/components/sharing, src/lib/export]
supersedes: [2026-10-28-agendas-use-all-folder-placements, 2026-10-27-meeting-agendas]
superseded-by: []
relates: [2026-10-22-person-to-person-sharing, 2026-10-27-shared-folders-are-two-way, 2026-10-31-share-acceptance-with-existing-folder-access, 2026-11-11-recorder-panel-recording-block]
---

# Agendas share co-editing through accepted person invitations while recordings require separate consent

Private agenda authors can invite colleagues through the existing versioned person-share lifecycle.
An accepted receiver co-edits the plan and files it in their own private tree. Recording access, task
access and provider use remain independent. This implementation is prepared for review, without a schema change.

## Why

A team needs to prepare an agenda before deciding which person will record the discussion. Requiring a
shared folder forces unrelated filing and audience changes. Treating agenda access as recording consent
would expose transcripts and summaries that the recording owner has never chosen to share.

### Previous state

Person invitations accepted only recordings and mail. Agendas reached colleagues through folders or the
Organization. Absorption hid the original item from invitation mutations, and a non-author recording
attachment failed if one private agenda folder was unavailable to the recording owner.

## Options considered

The maintainer approved option a for D1–D7. The alternatives retain the following real advantages,
but do not satisfy the required collaboration and consent boundaries.

| Decision | Chosen (a) | Rejected options and reasons |
|---|---|---|
| D1 | Accepted receivers co-edit their own points, ticks, notes and hints; author and Organization curator management stays separate. AI uses caller-visible placement profiles and the caller's providers; private defaults belong to the caller. | **b: Read-only.** Simpler permissions, but prevents the invited colleague from preparing and running the agenda. Revisit if invitations become a viewing-only product. |
| D2 | Ordinary acceptance requires a receiver-owned private folder; accepted shared-folder paths retain one-click acceptance and optional extra filing. | **b: Always one click without a folder.** Fewer interactions, but loses the receiver's chosen place in their tree and contradicts ordinary invitation acceptance. Revisit with a distinct received library. |
| D3 | Omit unreadable review tasks and counts; disclose the hidden count to the author and offer ordinary source-recording invitations when they own it. | **b: Reveal referenced tasks.** Gives a complete review, but agenda sharing cannot grant rights over private evidence. **c: Hide silently.** Avoids disclosure UI, but leaves authors believing invitees see their review. Revisit only with explicit task-sharing consent. |
| D4 | Explicit web attachment offers recording invitations, on by default only after the selected pair’s offer loads; either explicit choice suppresses the owner banner. Arrival never shares automatically and shows a dismissible owner banner. Pending and accepted agenda shares survive absorption. | **b: Recording follows live.** Convenient, but silently exposes evidence under a different owner's control. **c: Nothing automatic.** Preserves privacy, but leaves invitees without a disclosed next step or recording invitation shortcut. Revisit with a new recording-consent model. |
| D5 | A pending or accepted direct agenda invitation prevents automatic attachment. | **b: Attach whenever current audiences fit.** More automatic matches, but pending consent and independent agenda invitations must remain a deliberate attachment boundary. Revisit only if the agenda/recording consent distinction changes. |
| D6 | An accepted receiver may attach their own recording subject to audience containment. File only into agenda folders the attacher may file into, skipping unavailable folders. | **b: Author-only attachment.** Simpler filing and ownership, but prevents the participant who actually records from contributing their recording. Revisit if recording ownership can be explicitly transferred. |
| D7 | Revocation or inactivity ends access immediately; contributions retain their author attribution and remain manageable by the agenda author. | **b: Delete receiver points.** Removes departed participants' content, but silently destroys the team's prepared plan and discussion record. Revisit only with an explicit content-erasure policy. |

## Decision

Implement D1–D7 using existing item-share rows and locks. The agenda link is
`/dashboard?meeting=<meetingItemId>`. Its teal frame remains; plum metadata identifies person sharing
and the Organization retains its blue mark. Only the author invites to a private standalone agenda.
Absorbed agendas allow share management, with new invitations directed to the recording instead.

Every folder chooser in the web app uses `FolderCombobox`, preserving the recording categorization
autocomplete, keyboard behavior and creation flow. Parent-folder choices use the same component.

## Key technical details

- `meeting-shares.ts` grants direct agenda visibility independently of the general audio/mail
  `receivedItemCondition`. Lists and folder filters retain the original agenda for every original audience,
  including the author, when the recording is hidden. Recording identity and outcomes stay redacted.
  Reminders and recorder matching exclude absorbed agendas, including Calendar snapshot refresh.
- Suggestions keep only caller-visible Organization and participating shared-folder placements.
  An unfiled or author-private-filed agenda uses the caller's private default, never the author's.
  Provider execution always belongs to the caller.
- `person-shares.ts` retains item-before-share locking and optimistic versions. Only an absorbed
  agenda's tombstone keeps invitation listing, acceptance and removal live; deletion ends shares.
- `meetings/person-sharing.ts` filters each receiver against recording and task access. The attach flag
  calls ordinary invitations after the attach transaction commits. Invitations require that the recording
  is attached to this agenda; task-source invitations use the ordinary item-sharing endpoint.
  Skips are reported and never undo attachment. Automatic matching locks the agenda item before its
  final direct-invitation check and holds that lock through absorption. Only the author and accepted
  direct receivers learn who the direct receivers are: a shared-folder or Organization viewer who
  attaches a recording gets no invitation offer and invites nobody.
- A receiver-owned recording retains the non-author audience-containment check. Filing rechecks folder
  participation under its normal lock. Detach revives the original plan and its independent invitations.
- Recording invitation shortcuts use only the receiver's accepted agenda filing. Banner dismissal is
  browser-local, keyed by account and recording, without new persistent server state.
- The author's archive serializes agenda shares without receiver filing. Meeting restore returns the
  item ID mapping for `/api/shares/restore`; restored invitations require acceptance again. Receiver
  archives and folder exports exclude received standalone agendas. Personal archives retain the original
  live-owned-anchor rule: a recording owner's archive includes its absorbed agenda regardless of authorship.
  An author's agenda attached to somebody else's recording additionally exports as a standalone plan,
  without that recording's IDs or summary outcomes. An own trashed anchor is excluded, so every exported
  recording reference can round-trip with the recording.
- Hosted, non-Organization deployments and the Organization account have no person-sharing surface.
  Recorder responses stay additive and MCP uses existing tools and `tasks:write` permissions.

## Verification

`src/tests/sharing/meeting-shares.integration.test.ts` covers invitation consent, co-editing,
revocation, independent paths, task privacy, absorption, recording invitations, automatic attachment,
receiver-owned recording filing, caller providers, reminders, recorder/MCP access and archive restore.
Sharing UI tests cover all three accepted item kinds and the agenda header, task disclosure and invitation
shortcut. Meeting UI tests cover both attachment variants and browser-local banner dismissal.
Round-3 regressions cover undisclosed attachment invitations, attached-recording identity, concurrent first
invitations, every original audience's hidden-recording lists, recorder match/refresh exclusion, caller-visible
placement profiles, both archive owners and trash, Czech rendered copy, disclosure query scope and remembered
attachment privacy. Initial regression runs reproduced 21 failures plus 3 Czech-copy failures before fixes.
The final focused Node 22 run passes 153 tests across five files. The complete Node 22 suite, with PostgreSQL,
three workers and a 60-second hook timeout, passes 10,784 tests across 838 files; 122 tests in 12 files are
skipped, with no failures. Full-run source hashes confirm that no source changed during validation.

## Consequences & open follow-ups

On shared self-host instances, an incorrect visibility predicate could disclose a private plan or recording.
Revocation stops later reads, but cannot recall downloads. Recording invitations remain independently
revocable and attachment failures leave both original items intact. Hosted and local-only deployments
keep direct sharing disabled. Neither mode needs data conversion or deployment configuration changes;
rollback requires no migration. Browser-local dismissal does not follow users between devices.

## Related work

- [Recorder panel recording block and room sharing](2026-11-11-recorder-panel-recording-block.md) adds capability-gated room discovery, short-lived panel presence and owner-only invitations, retaining agenda visibility and existing acceptance rules.

- [All agenda placements](2026-10-28-agendas-use-all-folder-placements.md) is superseded only for mandatory
  attachment filing into every agenda folder. Unavailable attacher folders are now skipped; the placement
  union still defines agenda visibility and preparation.
- [Meeting agendas](2026-10-27-meeting-agendas.md) is superseded for reminders limited to authors/editors/Calendar
  invitees and extends absorbed-agenda backup membership beyond the live owned anchor. Accepted direct receivers
  also receive reminders and keep independent absorbed invitations. The recording owner retains the absorbed
  agenda in backup; the original author additionally retains a standalone plan when somebody else owns the recording.
  Plan/evidence separation, author management, audience containment and Calendar export remain.
- [Person sharing](2026-10-22-person-to-person-sharing.md) supplies consent, revocation and mode gates;
  agenda co-editing is specific to plans and does not widen recording or mail receiver writes.
- [Two-way shared folders](2026-10-27-shared-folders-are-two-way.md) supplies participation locks and
  contributor ownership; shared-folder paths remain independent of direct agenda invitations.
- [Acceptance with existing access](2026-10-31-share-acceptance-with-existing-folder-access.md) supplies
  folder-path disclosure, one-click overlapping acceptance and deliberate extra filing, reused for agendas.

## Timeline

- **2026-11-08**: D1–D7 and the shared autocomplete approved; implementation and validation prepared for review.
- **2026-11-08**: PR #348 review: direct receivers disclosed only to the author and accepted receivers.
