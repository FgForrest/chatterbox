---
title: Private recordings and mail reach colleagues only through accepted invitations, separately from Organization sharing
date: 2026-10-22
updated: 2026-10-22 23:46
status: partially-implemented
kind: feature
issues: [260]
prs: [262]
areas: [src/lib/sharing, src/db/queries/item-shares.ts, src/db/queries/task-visibility.ts, src/components/sharing, src/lib/mcp, src/lib/export, src/db/schema.ts]
supersedes: [2026-10-07-tasks-from-summaries]
superseded-by: []
relates: [2026-09-23-shared-organization-scope, 2026-10-07-backup-scope]
---

# Private recordings and mail reach colleagues only through accepted invitations, separately from Organization sharing

An owner can invite specific colleagues to a private recording or mail item. Acceptance grants reading and completion of tasks assigned to the receiver, without publishing anything to the Organization or the receiver's Almanac. One record covers two PRs: this first part handles individual items; live folder shares follow in #260.

## Why

Filing into the Organization is deliberately broad: everyone can read the item, curators can change it, and confirmed knowledge may be promoted. Owners also need to let selected colleagues read an item while keeping that boundary intact. Existing folder assignments control processing and exports, so treating a receiver's filing as an ordinary assignment would change the owner's pipeline and permit unintended bulk egress.

### Previous state

Only the owner or the Organization could see an item. Colleagues received tasks only through Organization sharing. Copying a private URL gave another user no access. There was no per-user invitation state or received library.

## Options considered

The maintainer chose option a for all sixteen design decisions on 2026-10-22. Rejection reasons below explain the constraints those choices preserve; where the design recorded only the choice, the reason is inferred from that constraint.

| # | Chosen (a) | Declined (b) and rejection reason |
|---|---|---|
| 1 | Organization members, searched by name or email, on self-host with the Organization scope | Any instance account by exact email in both modes. Rejected because hosted has no Organization membership boundary and name lookup is part of the approved colleague picker. |
| 2 | Live folder sharing in PR 2 | A snapshot of present items. Rejected because a shared folder must continue to represent its current contents. |
| 3 | Mail and recordings share the same invitation model | Hide mail in shared folders. Rejected because the library is one pile of both kinds, with the same receiver rights. |
| 4 | Existing single-item audio, transcript and summary downloads remain; receiver bulk archives exclude received content | App-only playback and reading. Rejected because downloads are a reading aid already available for readable content; export ownership remains the bulk boundary. |
| 5 | Only the owner shares further or publishes into the Organization | Receivers may re-share to people. Rejected because the owner must control who receives their private content. |
| 6 | Corner notice, waiting-list count and opt-in notification email | App notifications only. Rejected because existing email notification preferences must also cover invitations without sending unsolicited mail. |
| 7 | Declined and removed states stay visible, the owner can invite again, no expiry | Declines are final and waiting invitations expire after thirty days. Rejected because an owner and receiver may reconsider without a timer revoking a pending invitation. |
| 8 | Primary-email assignees see received tasks in Mine and can close or reopen; other actions remain refused | Receivers act on no tasks. Rejected because the recording is shared so the colleague can carry out their assigned work. Task notes are outside PR 1 because #253 is not on the integration branch. |
| 9 | Receiver MCP tools can read the same accepted content, subject to content permissions | Keep MCP to own and Organization items. Rejected because an AI client must reflect the user's readable pile; MCP writes stay limited to closing assigned tasks. |
| 10 | No knowledge promotion, no receiver Learn or Almanac feed | Make confirmed facts visible to receivers. Rejected because an item invitation does not share the owner's private knowledge records. |
| 11 | Later Organization sharing preserves direct shares and receiver filing; Organization roles apply while shared, and receiver rights resume after withdrawal | End person shares once everyone can read through the Organization. Rejected because it would discard the receiver's filing and independent consent. |
| 12 | Hide all owner folder names in PR 1; only the receiver's filing is shown | Show every owner placement read-only. Rejected because folder names can disclose unrelated private context. PR 2 may reveal only the folder explicitly shared. |
| 13 | Plum token with incoming/outgoing folder arrows and UserPlus | Reuse the existing folder icon with a person badge and no new colour. Rejected because person sharing must remain distinguishable from Private and Organization. |
| 14 | Two PRs, one decision record | One PR for items and folders together. Rejected because live folder membership adds an independent lifecycle and deserves its own review. |
| 15 | Show the owner's confirmed speaker names as plain text | Name only Organization people and leave private speakers as labels. Rejected because it would make the receiver's transcript less useful while names can be shown without exposing person IDs, aliases, facts or cards. |
| 16 | Accepted items appear and count in Recent; pending items remain in the waiting list | Show received items only in their filing folder. Rejected because Recent must match the pile the receiver can read. |

Three implementation alternatives were also rejected:

- **Reuse Organization visibility predicates.** Rejected because those predicates expose items to every member, Learn and curator writes. `receivedItemCondition` and `taskReceived` are separate from `sharedItemCondition` and `taskRecordingShared`; `taskEditable` remains unchanged.
- **Reuse processing folder assignments for receiver filing.** Rejected because assignments belong to the item owner, select processing profiles and drive exports. `item_shares.filing_folder_id` points only to a receiver-owned private folder and becomes null when it is deleted.
- **Treat a receiver as a private owner or Organization reader.** Rejected because existing clients assume either case permits some processing controls. The third `received` view and explicit receiver write refusals keep those controls out of the UI and reject forged requests.

## Decision

Use versioned direct invitations with pending, accepted, declined and removed states, stored once per item and receiver. Acceptance is required before reading. Invitations and filing never alter Organization membership, processing profiles, knowledge or export ownership. Preserve one set of owner content, and resolve receiver read access separately at every entry point. While the item is Organization-shared, Organization permissions take precedence over an accepted person share. The accepted marker and receiver filing remain independent; after withdrawal, receiver-only permissions apply again.

## Key technical details

- `src/db/schema.ts` adds `item_shares`; generated migration `0138_useful_omega_flight.sql` is additive. Item, owner and receiver deletion cascade. Nullable `folder_share_id` reserves the origin of future inherited rows; only direct rows have the item/receiver uniqueness constraint.
- `src/lib/sharing/person-shares.ts` locks the item before its share row and checks state/version. Folder filing validates the receiver's ownership under lock. Accepted shares alone grant read access.
- `src/lib/sharing/access.ts`, mail access and `writer.ts` distinguish receiver reads from content writes. Tasks use separate visibility/list/close predicates. Background task viewers exclude received content so it cannot enter Learn or summary candidate prompts.
- `src/lib/events/personal.ts` carries content-free share events across processes. Optional email is best effort and times out; a failing notifier never rolls back a share.
- `src/lib/export/item-shares.ts` serializes the owner's direct share list, without receiver filing. After content import, `/api/shares/restore` accepts old-to-new item IDs, verifies target ownership and matches existing receivers by email. Active shares become pending, while missing, inactive and already-present shares are reported as skipped. No general archive importer existed before this change and this endpoint restores share metadata only.
- Hosted and non-Organization deployments answer 404 on sharing routes and show no new UI. No environment variable or deployment structure changes.

## Verification

`src/tests/sharing/person-shares.integration.test.ts` has 41 PostgreSQL tests and exercises invitation states, cancellation and acceptance races, filing isolation, cascades, mode gates, both item kinds, task rights, search, MCP and archive share restoration. Its route inventory covers all 32 item write methods and fails when a new method lacks a receiver decision. Eighteen focused UI tests cover the owner dialog, copy-link explanations, invitation acceptance, received heading/banner and task controls. One dashboard-loader regression in `src/tests/dashboard/onboarding-page.test.tsx` checks that Organization publication preserves the Organization entry and the separate received copy with receiver filing. Review regressions cover member and curator permissions before and after acceptance and withdrawal for both item kinds, private correction meanings, inactive recipients, masked invitations, restore refusals and neutral copy-link states after failed loads. Final check counts are recorded in the PR description.

## Consequences & open follow-ups

- PR 2 for #260 adds live folder shares, including their membership updates and receiver naming. The reserved origin column must not make a direct-share revoke accidentally revoke inherited access.
- Receiver downloads cannot be recalled; removing access prevents subsequent reads.
- General archive import remains separate work. The share restore endpoint is available for importers and reports skipped entries rather than creating accounts or silently granting access.

## Related work

- [Shared Organization scope](2026-09-23-shared-organization-scope/README.md): defines the broad shared scope that person shares must never widen.
- [Tasks from summaries](2026-10-07-tasks-from-summaries.md): superseded only in its rule that colleagues receive tasks solely through the Organization; task ownership and other lifecycle rules remain.
- [Backup scope](2026-10-07-backup-scope.md): received content remains outside the receiver's archive and folder exports.

## Timeline

- **2026-10-22**: all sixteen design choices accepted; individual recording and mail sharing implemented for PR 1, with folder sharing reserved for PR 2.
