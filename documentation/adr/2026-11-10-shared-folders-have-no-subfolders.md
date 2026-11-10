---
title: Person-shared folders are leaves while existing subfolders remain explicitly unshared
date: 2026-11-10
updated: 2026-11-10 11:46
status: accepted
kind: fix
issues: [381]
prs: []
areas: [src/lib/folders, src/lib/sharing/folder-shares.ts, src/components/dashboard/folder-tree.tsx, src/components/sharing, src/types/folder.ts]
supersedes: [2026-10-22-person-to-person-sharing]
superseded-by: []
relates: []
---

# Person-shared folders are leaves while existing subfolders remain explicitly unshared

The maintainer accepted rulings 4 and 15 of #381 on 2026-11-10. A private folder with a pending or accepted person invitation cannot gain subfolders. Inviting people requires a folder without subfolders. Existing children remain intact and the owner's tree marks them as not shared.

## Why

Person sharing grants access only to direct items. An owner could file an item into a subfolder believing that the receiver's tree included it, although receivers never saw that subfolder or its items. Restricted Organization folders in #381 follow the same leaf rule; their enforcement belongs to the parallel restricted-folder work.

### Previous state

Owners could create children inside a shared folder, move folders into it, and invite people to a folder with children. Receivers could not create children. Direct-only access was correct but the two trees suggested different audiences.

## Options considered

### Retain subfolders and explain direct-only sharing (declined)

This preserves arbitrary owner organization without restructuring folders.
**Rejected because:** the folder hierarchy still implies inherited sharing and lets owners place new items outside the intended audience without noticing. Revisit only if sharing becomes recursive under a separate visibility decision.

### Make shared folders leaves and retain existing children (chosen)

Block new children and invitations to folders with children. Preserve existing data and label its unshared children. This prevents new ambiguity without moving or deleting users' folders on deployment.

## Decision

A pending or accepted invitation makes a person-shared folder a leaf. Declined, removed and canceled invitations do not. Once the last active invitation ends, children are permitted again. Existing children remain usable, renameable and movable out; reordering existing siblings adds no child and remains allowed. Their direct items remain private unless independently shared.

Mark only direct children of a shared folder as `insideSharedFolder`. Deeper descendants keep their existing presentation. Organization folders retain their current behavior in this change.

## Key technical details

- `person-shared-leaf.ts` supplies one guard each for `createFolder` and `moveFolder`; `inviteToFolder`, sharing GET and archive invitation restore use one child-presence check counting both direct `recording_folders` children and the caller's own received attachments beneath the folder. All queries retain owner scoping. Both leaf guards use the same deployment visibility gate as `sharedFolderIds`, leaving retained invitations and attachments inert in local or hosted mode.
- Private creation and invitations take `lockPrivateFolderTree` before checking. Moves retain their Organization-tree lock, then private-tree lock. Invitations acquire the private-tree lock before source-folder and invitation row locks. The private-tree lock writes the owner's user row, invalidating stale serializable move snapshots. `moveFolder` retries its entire serializable transaction on SQLSTATE `40001` through the existing deadlock retry helper, with at most three attempts, re-reading access, version and leaf state each time. Exhausted serialization retries return HTTP 409 `CONFLICT` with `retryable: true`. Other affected folder and invitation transactions use read committed and need no serialization retry.
- HTTP 409 codes `SHARED_FOLDER_HAS_NO_SUBFOLDERS` and `FOLDER_HAS_SUBFOLDERS` distinguish container refusal from invitation refusal. Clients localize both. Sharing GET adds a child-presence boolean so every owner dialog, including nested audience management, can disable inviting before people are selected.
- Shared destinations are excluded from folder move and creation pickers. Item filing remains available. Existing owner children, including received attachment nodes, receive a muted label and explanatory tooltip. Independently invited children retain their own share icon and omit the unshared label. Attachment contents never inherit access through the parent.
- Archive invitation restoration uses the same private-tree lock and reports `has_subfolders` when a new invitation would target a folder with children. Existing archive structures and metadata remain readable; move children elsewhere before restoring those invitations.
- Received-folder attachment acceptance and movement take the receiver's private-tree lock before the source-folder and invitation rows, and refuse a shared destination. Existing attachments remain navigable.
- No schema, migration, environment, deployment or archive format changes are needed.

## Verification

The extended `folder-shares.integration.test.ts` contains 115 PostgreSQL cases and covers both active invitation states, creation and move refusals, invitation and reinvitation refusals, the last-invitation transition, retained legacy children and concurrent create/move versus invite transactions. UI tests cover blocked inviting, disabled subfolder actions, destination filtering, localized errors and legacy labels. Exact command results and counts are recorded in the implementation report outside the repository.

## Consequences & open follow-ups

Shared self-host installations gain an explicit tree constraint without changing existing content or access. A false refusal affects folder organization; ending the last invitation or moving a child out is sufficient to recover. Hosted and local-only deployments keep person sharing disabled and their normal folders unchanged. Rollback needs no migration or data repair in either mode. Restricted Organization enforcement remains #381 part 2.

## Related work

- [Person-to-person sharing](2026-10-22-person-to-person-sharing.md) is superseded only in allowing subfolders beneath person-shared private folders. Accepted consent, direct-only visibility, participation, private-tree names, knowledge isolation and export ownership remain in force.
