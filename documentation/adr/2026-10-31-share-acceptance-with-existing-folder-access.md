---
title: Item invitations acknowledge existing folder access and require extra filing only by choice
date: 2026-10-31
updated: 2026-10-31 18:00
status: accepted
kind: fix
issues: []
prs: []
areas: [src/lib/sharing/person-shares.ts, src/db/queries/item-shares.ts, src/db/queries/item-folder-audience.ts, src/components/sharing, src/components/dashboard/recording-row.tsx]
supersedes: []
superseded-by: []
relates: [2026-10-22-person-to-person-sharing, 2026-10-27-shared-folders-are-two-way]
---

# Item invitations acknowledge existing folder access and require extra filing only by choice

The maintainer accepted R1a–R4a on 2026-10-31. Folder participation and direct invitations remain
independent access paths. Their presentation explains that distinction and avoids creating an
extra filing merely to accept an item the receiver already reads.

## Why

An owner could invite an existing folder participant because the item sharing controls counted
only direct invitations. Accepting that invitation required a receiver-owned filing, so the item
appeared in two places without the receiver having chosen an additional place.

### Previous state

Copy-link controls could say only the owner could open an item already visible through a shared
folder. Acceptance used a bare folder picker. Nullable direct filing existed in the schema but
acceptance and re-filing required a folder even when another accepted path already supplied one.

## Options considered

| Ruling | Chosen (a) | Alternative (b) and rejection reason |
|---|---|---|
| R1 | Show existing and pending folder audiences; skip redundant direct invitations | Allow a direct invitation with a warning. **Rejected because:** it still creates the unnecessary invitation that led to accidental duplicate filing. Revisit only if independently inviting current folder participants becomes a product requirement. |
| R2 | Explicit one-click acceptance without filing when an accepted folder path exists | Auto-accept the invitation. **Rejected because:** folder membership does not express consent to retaining the separate direct share. Revisit only with a new consent rule. |
| R3 | Ordinary invitations still require an own private folder, with an explanation | Make filing optional for every invitation. **Rejected because:** ordinary acceptance must still give the receiver a chosen place in their tree. Revisit only if a received library without filing becomes an intended destination. |
| R4 | Show an explicitly chosen direct filing alongside folder paths and allow unfiling it | Hide direct filing while a folder path exists. **Rejected because:** this hides the receiver's deliberate placement and makes its later reappearance surprising. Revisit only if placements cease to represent the receiver's choices. |

## Decision

Use R1a–R4a. Owners can always copy item links. Folder audiences include the foreign folder owner
and active pending or accepted folder receivers, under the item owner's own folder or attachment
name. Header and link counts deduplicate people; sharing groups preserve each path, including
legacy direct overlaps. Only the folder owner can manage its invitations.

Receivers learn only their own accepted folder paths and their local names. Accepting or unfiling
without a folder rechecks those paths inside the direct-share transaction after its existing locks.
Without one, the existing private-folder requirement remains. No invitation is auto-accepted.
Removing a direct share explains any remaining folder access and keeps the readable row visible.

## Key technical details

- `item-folder-audience.ts` supplies the same audience relation used by outgoing item markers and
  invitation suppression. The receiver query reuses the live folder placement predicate family.
- `ReceivedItemDialog` is the single body for recording/email acceptance and later filing. Ordinary
  acceptance, existing-folder acceptance and extra filing reuse the searchable folder list.
- `restore-shares.ts`, Organization publication, receiver rights, processing ownership and export
  scope retain their existing behavior. No schema, migration, environment or deployment change is needed.

## Verification

The focused PostgreSQL suite `src/tests/sharing/share-acceptance.integration.test.ts` passes 19
cases covering both item kinds, own and foreign folders, accepted/pending/inactive recipients,
invitation suppression, local names, ownership isolation, revoked paths and unfiling.
The two sharing UI suites pass 76 cases, including one-click acceptance, both dialog variants for
recordings and mail, owner groups, distinct link counts, unfiling and retained row visibility.

## Consequences & open follow-ups

In shared self-host mode, a wrong audience or path predicate could misstate access or permit a
folder-free filing change. Existing ownership checks remain, and ending an invitation or unfiling
removes its live path. Accepted direct access deliberately survives later removal from a folder.
Previously downloaded content cannot be recalled. Hosted and local-only deployments keep person
sharing disabled; neither mode needs data conversion or a deployment change to roll back.

## Related work

- [Person-to-person sharing](2026-10-22-person-to-person-sharing.md): this adds audience disclosure
  and acceptance choices without reversing a stated rule of that record. Accepted consent,
  independent direct filing, private-tree names and export isolation remain.
- [Two-way shared folders](2026-10-27-shared-folders-are-two-way.md): audience and accepted paths
  include participant-owned contributions and the source folder owner. Its participation,
  revocation and ownership rules remain.

## Timeline

- **2026-10-31**: maintainer accepted R1a–R4a; implementation and regression tests prepared for review.
