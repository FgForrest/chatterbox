---
title: Person-shared folders accept every participant's own items while processing and exports follow ownership
date: 2026-10-27
updated: 2026-10-27 18:22
status: proposed
kind: feature
issues: []
prs: [293]
areas: [src/db/queries/folder-participants.ts, src/db/queries/item-shares.ts, src/lib/folders, src/lib/sharing/folder-shares.ts, src/lib/meetings, src/lib/pipeline, src/lib/profiles, src/lib/export, src/components/recordings, src/app/api/v1/recorder/folders, extensions/recorder/popup]
supersedes: [2026-10-22-person-to-person-sharing]
superseded-by: []
relates: [2026-10-27-meeting-agendas, 2026-10-07-backup-scope]
---

# Person-shared folders accept every participant's own items while processing and exports follow ownership

An accepted folder invitation creates a place for cooperation: every participant can contribute recordings,
mail and meeting agendas. Each item stays with its author. Reading the shared folder grants no authority
to process another participant's recording, use their providers, change their mail or export their library.
The maintainer accepted the ruling on 2026-10-27; this implementation is awaiting integration.

## Why

A folder shared for preparing and recording a meeting needs contributions from everyone involved.
The earlier read-only role protected processing profiles, exports and bulk egress. Those protections
must follow item ownership rather than prevent a colleague from contributing an independently owned item.

### Previous state

Direct contents ordinarily belonged to the folder owner. Receivers could read and close tasks assigned
to their primary email, with a separate attachment for naming and filing the folder in their private tree.
Meeting agendas introduced a narrow exception for explicitly attached co-editor recordings. That exception
is replaced by general participant membership.

## Options considered

### Keep one-way folders and the explicit agenda exception (declined)

This keeps existing ownership assumptions simple and requires no general filing changes.
**Rejected because:** it cannot support uploading mail or recordings and preparing agendas together,
as the maintainer requires. It also leaves ordinary and agenda-created assignments with different access rules.

### Allow participant-owned assignments and retain ownership boundaries (chosen)

This reuses assignment rows and live visibility predicates. It requires checking participants under the
same folder lock as revocation, and keeping display trees distinct from export trees. It preserves
existing provider, knowledge and archive isolation without another content copy or schema change.

## Decision

1. **Participants:** the folder owner and active receivers of accepted invitations participate. Pending,
   declined and removed receivers do not. Only direct contents count; no subfolder inherits the share.
2. **Filing:** participants may upload or file their own recordings, mail and meetings into the source
   folder. The assignment belongs to the item owner and references the source folder. Filing rechecks
   participation after locking that folder, which serializes against revocation and deletion.
3. **Visibility and rights:** participants read each other's contributions through the existing Received
   predicates, once per item. The item owner keeps owner rights. Others keep receiver rights, including
   closing/reopening tasks assigned by primary email. Existing Organization-role precedence is unchanged.
4. **Processing:** an item's owner runs it using their selected profiles and providers. A private folder's
   profile applies only to its owner's items. Other participants' placements resolve as unfiled for profile
   selection; an explicitly configured or inherited Organization profile remains the contributor's normal
   account choice. No colleague's private profile or provider is selected by filing there.
5. **Exports, backups and knowledge:** personal folder exports and archive collectors include only their
   requesting owner's items. Display assignments may include contributions; export assignments cannot.
   Neither accepted access nor filing promotes knowledge or supplies another participant's Learn/Almanac feed.
6. **Unfiling:** an item owner may unfile their item. The source folder owner may unfile any contribution,
   returning it to its owner's unfiled library without deleting or editing its content. Other participants
   cannot unfile it. Standalone meeting unfiling uses a dedicated folder mutation route; absorbed agendas
   retain their read-only lifecycle.
7. **Leaving:** share removal by either party deletes that receiver's assignments in the folder. Folder
   deletion cascades assignments while preserving every contributor's items. Other access paths still apply.
   Existing share-change events refresh the owner, departing receiver and affected participants.
8. **Further sharing:** only the folder owner invites others to the folder. Receiver filing of individual
   direct shares into their own private tree remains separate and cannot re-share those items.
9. **Meetings:** every participant can author an agenda and all participants co-edit it; manage stays with
   the author (existing Organization curator rules still apply). Explicit attachment requires one's own
   recording and files it into the agenda folder under the same participant lock. Automatic attachment
   still requires the same owner, a unique overlap and its existing placement/privacy checks.
10. **Arrivals:** content-free notifications reach the folder owner and accepted fellow participants,
    excluding the arriving item's owner. Pending invitations do not receive arrival notifications.
11. **One general predicate:** participant membership replaces both the agenda-specific folder ownership
    exception and the separate agenda-author recording subquery. One's own items never become Received.
12. **Pickers:** upload, move/add and meeting pickers include received folders under the receiver's attachment
    name and person-share icon. Recorder folders return canonical source IDs with the attachment name/path
    and an optional shared marker. Released extensions continue to use the existing response fields;
    updated extensions accept old responses without the marker.

The old profile concern is answered by limiting folder-default resolution to the item's own private tree
or the existing Organization scope. The export and bulk-egress concerns are answered by strict owner
assignment filters on personal export trees and the existing archive predicates. Reading a contribution
still permits today's individual viewing downloads, without bulk export or private knowledge access.

## Key technical details

- `folder-participants.ts` and `item-shares.ts` define live membership and received visibility. Predicate
  composition preserves deduplication in search, tasks, MCP and dashboard loaders.
- `lockCategorizableFolderInTx` takes the source folder row lock before rechecking the invitation. Share
  removal already locks the same row before changing share state and unfiling contributions. Receiver
  attachment IDs are resolved at filing boundaries; storage assignments always use source folder IDs.
- `listFolderOrganization` includes participants' assignments for navigation. Personal archive and folder
  export trees explicitly filter assignment ownership. Existing profile resolution excludes foreign
  private folder defaults. No new billing, provider or knowledge-promotion path is introduced.
- An owner archive omits foreign folder placements. A standalone agenda with no archived folder IDs
  restores unfiled, preserving its content without inventing a folder or restoring another person's share.
  Deferred recordings also remain unfiled if their invitation ends before the final filing lock.
- Existing filing in the Organization root and hosted legacy Public root remains supported; upload and
  meeting creation still require non-root folders. MCP folder discovery retains the received-item
  `read_only` marker and adds `can_file_own_items` for human callers.
- No schema, environment-variable, Compose or deployment-step change is required. Hosted and local-only
  deployments retain their sharing gate; the recorder response change is additive in both modes.

## Verification

`src/tests/sharing/folder-shares.integration.test.ts` has 82 PostgreSQL cases covering participant contributions of both kinds,
accepted-state checks, picker and recorder lookup, receiver rights, source-folder locks, revocation races,
owner unfiling, profiles, export/archive exclusion, agenda creation/co-edit/attachment and same-owner auto-attach.
`src/tests/folders/shared-folder-pickers.test.tsx` and `src/tests/recorder/shared-folder-picker.test.js` cover
ten picker cases, including the additive marker and older server responses. The route classification
inventory includes meeting folder mutations. The existing meeting and person-share regressions remain required.

## Consequences & open follow-ups

- Individual downloads already made cannot be recalled. Revocation prevents subsequent reads and removes
  contributions from the shared folder, without deleting the contributors' libraries.
- In shared self-host mode, an incorrect participant predicate could expose a folder's direct contents;
  revocation or unfiling immediately removes that path. Content remains recoverable in its owner's library.
  Hosted has no person-sharing surface, so the changed folder rules stay inert there. No migration is needed
  to roll back either deployment mode.

## Related work

- [Person-to-person sharing](2026-10-22-person-to-person-sharing.md) is superseded only for receivers'
  read-only folder role and the rule tying assignments to the folder owner. Acceptance, private-tree
  attachment metadata, receiver item rights, knowledge isolation and export ownership stay in force.
- [Meeting agendas](2026-10-27-meeting-agendas.md) supplied the explicit recording exception. Its attachment,
  automatic matching, author management and absorbed-agenda rules survive under general folder participation.
- [Backup scope](2026-10-07-backup-scope.md) continues to define personal and Organization egress membership;
  participation supplies read access rather than ownership of another person's content.

## Timeline

- **2026-10-27**: maintainer ruled shared folders cooperative; implementation and PostgreSQL regressions
  prepared for review without schema changes.
