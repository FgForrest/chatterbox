---
title: Curators manage existing Organization Almanac entries; their new entries stay private
date: 2026-10-21
updated: 2026-10-22 22:30
status: accepted
kind: fix
issues: []
prs: [222]
areas: [src/lib/authz/curator.ts, src/lib/knowledge/people.ts, src/lib/knowledge/entities.ts, src/lib/knowledge/vocabulary.ts, src/db/queries/almanac-import.ts, src/app/(app)/almanac]
supersedes: [2026-09-23-shared-organization-scope]
superseded-by: []
relates: [2026-10-01-almanac-and-new-records, 2026-10-22-organization-almanac-grows-on-share, 2026-10-14-identity-provider-authorization, 2026-10-22-almanac-curator-desk]
---

# Curators manage existing Organization Almanac entries; their new entries stay private

Organization curators can rename, retype, describe, merge and erase existing Organization people
and things, set their e-mail, manage their nicknames and manual facts, and manage Organization
vocabulary types and suggested phrases, exactly as the organization account could. A curator's
*new* people, things and list imports still go to the curator's own private Almanac. Shipped in
PR #222.

## Why

Since PR #53 every Almanac write compared the actor with the account that owns the row, so only
the organization account could change Organization entries. Under single sign-on with
identity-provider authorization (`AUTHZ_MODE=idp`, PR #131) nobody signs in as that account, so
nobody could merge duplicates in the Organization Almanac. It surfaced as two Organization records
for the same person, one with and one without an e-mail: tasks assigned to the record without an
e-mail reached nobody, and the maintainer, holding the curator capability, saw no "Merge into"
action.

### Previous state

Curators (`org.curate`) already acted for the Organization on shared recordings: the writer rule
let them change a shared recording's content (PR #131). The Almanac pages and APIs did not: the
organization account alone managed Organization people, things and vocabulary, as decided in
[2026-09-23-shared-organization-scope](2026-09-23-shared-organization-scope/README.md).

## Options considered

### Option A: sign in as the organization account to curate (declined)

The first answer given to the maintainer: open the person as the organization account and merge.

- **Pros:** no code change.
- **Cons:** under SSO the account may have no usable login; curation through one shared login is
  not attributable to a person.
- **Rejected because:** with identity-provider authorization nobody signs in as the organization
  account, so the Organization Almanac could not be cleaned up at all.

### Option B: curators manage existing entries and also create Organization entries (declined)

The first implementation put a curator's new people, things and imports straight into the
Organization Almanac, as the organization account's had been.

- **Pros:** one place for a curator's work; no second step to make a record shared.
- **Cons:** a private contact a curator adds becomes visible to every member.
- **Rejected because:** no private contact may become visible to the whole Organization by accident
  (the maintainer's choice).

### Option C: curators manage existing entries; new entries stay private (chosen)

- **Pros:** the clean-up problem is solved; curators keep a private Almanac like everyone else.
- **Cons:** a curator cannot add an Organization person directly; Organization people still arise
  only from sharing and from naming speakers on the Organization view.

## Decision

**Chosen: Option C** (maintainer, 2026-10-21). Who counts as a curator is unchanged: `org.curate`
with identity-provider authorization, the organization account in local mode. Every write re-checks
it at the moment it takes effect, so a revoked capability stops working at once.

## Key technical details

- **Curator check:** `actsForOrganization` and `userCuratesOrganizationNow` in
  `src/lib/authz/curator.ts`; the second re-reads the actor's current verified access for work that
  runs later.
- **Unchanged guards:** other members' private entries still answer 404 to a curator; an Organization
  person or thing never merges into a private one (403, the reverse still works); members get 403 on
  Organization entries.
- **Organization types** are created only from the Organization vocabulary page; a curator switches
  between the Organization's vocabulary and their own.
- **Learn review queue:** a curator sees their own reviews plus the Organization's.
- The raw advisory-lock query for imports moved to `src/db/queries/almanac-import.ts`.
- No schema, env or compose change; without an Organization (`isOrgScopeEnabled()` false) nothing
  changes.

## Verification

`src/tests/knowledge/curator-almanac.integration.test.ts` covers curators and members, private
scopes, a revoked capability, local mode and concurrent imports, and (after review) the 404 and 403
guards for things as for people. `src/tests/almanac/curator-pages.test.tsx` covers which controls
each page shows, including Organization facts and nicknames. Locally the changed-test selection ran
2,125 tests, all passing (one timeout passed on rerun).

## Consequences & open follow-ups

- The next day the Organization Almanac was opened wider: a member's confirmed Learn findings become
  Organization knowledge on share ([2026-10-22-organization-almanac-grows-on-share](2026-10-22-organization-almanac-grows-on-share.md), PR #248). That
  makes curator tooling, not just curator rights, necessary: duplicate detection and per-folder
  knowledge views are tracked in issue #240.
- Organization people still cannot be created directly by anyone but the organization account.

## Related work

- [2026-10-01-almanac-and-new-records](2026-10-01-almanac-and-new-records.md): the Almanac and how new records arise.
- [2026-10-14-identity-provider-authorization](2026-10-14-identity-provider-authorization.md): introduced `org.curate`, which made the
  organization-account-only rule unusable.
- [2026-10-22-organization-almanac-grows-on-share](2026-10-22-organization-almanac-grows-on-share.md): widens what reaches the Organization Almanac,
  relying on these curator rights to clean up.
- [2026-09-23-shared-organization-scope](2026-09-23-shared-organization-scope/README.md): the Organization scope whose curator rule this record widens, superseding that rule.
- [2026-10-22-almanac-curator-desk](2026-10-22-almanac-curator-desk.md): the duplicate queue and folder knowledge view built on these curator rights.

## Timeline

- **2026-10-21**: duplicate Organization records found unmergeable by a curator; curator management
  built; the maintainer chose private new entries; PR #222 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
