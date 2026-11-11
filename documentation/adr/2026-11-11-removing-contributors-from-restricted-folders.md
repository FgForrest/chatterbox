---
title: Remove restricted-folder contributors without unfiling their items and preserve owner exit
date: 2026-11-11
updated: 2026-11-11 13:17
status: accepted
kind: fix
issues: [381]
prs: [396]
areas: [src/lib/folders, src/lib/pipeline, src/lib/mail/detail.ts, src/lib/meetings, src/app/api/recordings, src/components/sharing]
supersedes: [2026-11-10-restricted-organization-folders]
superseded-by: []
relates: []
---

# Remove restricted-folder contributors without unfiling their items and preserve owner exit

Managers and curators may remove anyone from a restricted folder's audience. Their items stay withheld in the folder and remain readable by its audience and curators. The removed owner retains full owner access and may take their own placements out without access to the folder.

## Why

Protecting contributors from removal blocked ordinary audience management, such as someone leaving a client team. It did not protect their own content access: ownership already gives that access independently of audience membership. The remaining risk is that the removed owner no longer sees who reads their item. The maintainer accepts this because a manager or curator decided the removal and the owner can still withdraw the placement.

### Previous state

Release 2026.33 refused removal of anyone with placements using HTTP 409 `RESTRICTED_FOLDER_MEMBER_OWNS_ITEMS`. Unfile and move resolved the source as a fileable folder, so an owner outside its audience could not exit. Placement projections also hid the owner's restricted filing.

## Options considered

### Allow removal and retain owner exit (chosen)

Audience management remains independent of item ownership. Items stay available to the remaining audience, and owners control whether their own items remain there. The owner loses audience identities while outside it.

### Keep contributors in the audience (declined)

This keeps contributor visibility into the audience and requires no owner-exit exception.

**Rejected because:** a manager cannot remove someone leaving a team until that person relocates every contribution, even though ownership already preserves their content access. Revisit only if the product adopts a different ownership contract.

## Decision

Allow managers and curators to remove any audience member after rechecking authority under the Organization tree lock. Removal never unfiles or releases items. Owners outside the audience can unfile or move only their own source placements; destinations still require filing access. The audience dialog confirms removal of a contributor and explains retained visibility and owner exit.

## Key technical details

- `src/lib/folders/restricted-folders.ts` retains `ownsItems` for confirmation and removes the contributor refusal. Suspension continues retaining membership rows; explicit removal deletes the row.
- `src/lib/folders/folders.ts` rechecks both item and placement ownership under the tree lock for inaccessible sources. Batch categorization can retain an existing locked placement or remove it, without granting new filing access.
- Owner item, mail and agenda projections disclose only the owner's placement and public folder metadata. Counts, other items and audience identities remain protected. The reader response still marks the item restricted and readable by curators; the header explains folder-audience visibility without names.
- Mail recipient eligibility, deferred capture fallback, owner share gates on lift, task and agenda source visibility, owner retention, access requests and personal-archive restore keep their existing rules.

## Verification

`src/tests/sharing/restricted-folders.integration.test.ts` adds 17 PostgreSQL cases for removal, owner read/edit, public placement projection, owner exit, filing refusals, source rechecks, categorization/lift races, lift, tasks/agendas, mail/capture, retention/restore and suspension. All 108 core cases pass. The 53-case `src/tests/folders/restricted-folders-ui.test.tsx` suite covers manager/curator confirmation, cancellation, successful self-removal and the removed owner's header. The final focused selection passes 753 tests across 50 files with PostgreSQL and Keycloak enabled, without test or hook timeout overrides. Full outputs and broader check results are in the implementation report outside the repository.

## Consequences & open follow-ups

Shared self-host users may manage an audience while retaining prior contributions. An owner can withdraw their placement immediately, but cannot recall prior downloads. A faulty owner exception could expose or mutate another owner's placement; paired ownership checks and destination authorization constrain that risk. Hosted has no restricted Organization audience surface and retains its owner filing behavior. Neither mode needs a migration or deployment change. Application rollback requires no data conversion, but reintroduces the former owner's inability to exit inaccessible placements.

## Related work

- [Restricted Organization folders](2026-11-10-restricted-organization-folders.md): supersedes rule 3's contributor-removal refusal and rule 1's concealment of the owner's own placement. Other rules, including owner retention and publication gates, remain in force.

## Timeline

- **2026-11-11**: maintainer reverses contributor protection and requires owner exit as part of issue #381 part 3. Implemented in PR #396.
