---
title: Active creators may restrict their Organization folders alongside curators
date: 2026-11-11
updated: 2026-11-11 21:40
status: accepted
kind: feature
issues: [404]
prs: []
areas: [src/lib/folders, src/db/queries/folder-restriction-contacts.ts, src/components/sharing, src/components/dashboard/folder-tree.tsx]
supersedes: [2026-11-10-restricted-organization-folders]
superseded-by: []
relates: []
---

# Active creators may restrict their Organization folders alongside curators

A current curator or the creator of a custom Organization leaf may restrict it. Creators must remain active Organization members with `use`. Every reader sees the Restrict action; callers without authority get a contacts dialog listing current curators and the eligible creator, with email links and no duplicate creator.

## Why

Members could not find the restriction action or learn whom to ask. The person who set up a folder is a natural owner of its audience. Restriction also withdraws other people's content from the Organization, so creator authority must be explicit and checked at the same locked boundary as curator authority.

### Previous state

Rule 5 permitted only current curators to restrict an existing open leaf. Creators could manage a folder created as restricted but could not restrict their own existing open folder. The action was visible only to curators.

## Options considered

### Permit curators and active creators (chosen)

Creators may manage the audience of the folders they established, while other members can discover the action and contact someone with authority. This broadens who can trigger withdrawal.

### Retain curator-only restriction and add contacts (declined)

This preserves the narrower authority boundary and helps members find curators.

**Rejected because:** creators still cannot choose the audience of folders they set up, requiring curator intervention for that ordinary ownership decision. Revisit only if the product removes creator responsibility for folder audiences.

## Decision

Permit a current curator or an active creator with `use` to restrict an open custom Organization leaf, including retry of an in-progress restriction. The restricting creator becomes an audience manager, including when retrying a curator-started transition that omitted them or included them only as a member. A retry keeps the transition epoch and existing audience. Other members receive HTTP 403 from preview and mutation APIs. Lifting remains limited to a current curator or an active audience manager with `use`; creation attribution alone grants no lift authority.

Restriction keeps its existing withdrawal behavior: item owners join the audience, placements become withheld, and items losing their last open Organization placement follow normal withdrawal. Another open placement preserves normal Organization sharing. Earlier Almanac promotions remain. The existing preview explains these consequences before applying the change.

The menu and header offer Restrict to every reader when the Organization is writable. Curators and eligible creators open the existing preview dialog; others see contacts, administrator guidance when no curator can be listed, and instructions for creating a new restricted subfolder. Unknown, inactive and stale creators are omitted; a creator who is also a curator appears once. Contacts use one stored authorization snapshot, with the same verification-age limit as holder access. Reading contacts never verifies people through the identity provider or writes access state; stale curators are omitted before the 50-contact cap. Local mode keeps its Organization-account contact.

## Key technical details

- `src/lib/folders/restricted-folders.ts` checks creator attribution and the existing active recipient predicate, including membership and `use`, before restriction. It repeats the check with the transaction executor under the Organization tree lock before any state change or job creation. Curator checks keep their existing locked path.
- Identity-provider verification happens before locking. Locked creator checks read stored verified holder access and current recipient eligibility without calling the provider or reserving another connection.
- `src/lib/folders/restriction.ts` computes `canRestrict` for each caller in folder tree payloads using batched creator lookup. Discovery reuses its existing holder verification; informational flags use stored recipient eligibility. The client routes to preview or contacts using that flag.
- The restriction-authorized preview includes the current transition audience, so a creator outside a curator-started audience can load and submit Retry. Ordinary audience reads retain their existing authorization. Under the tree lock, restriction and retry insert the eligible acting creator as manager or promote their existing member row without replacing the audience.
- Leaf rules, Organization writable checks, withdrawal, export revocation, durable per-item recovery, lifting, retention and archive behavior remain unchanged. No schema or deployment change is needed.

## Verification

The final area run passes **394 tests**, including: `404-creator-restriction.integration.test.ts` has **28 PostgreSQL cases** for creator/curator/member authority, manager insertion, withdrawal, preflight and locked eligibility loss, retry epochs, caller flags, leaf/writable checks and unchanged lift rules. `404-restriction-contacts.integration.test.ts` passes **26 PostgreSQL cases**, including inactive/stale creator omission, a 50-stale-candidate read with zero verifier calls and zero access writes, and the verification-age boundary. `404-restriction-contacts.test.tsx` passes **32 UI cases** across tree and header variants, including member contacts and creator/curator preview routing and completed retry loading/submission from both UI entry points. Curator-started retry cases cover creator promotion and insertion while preserving the epoch and audience.

`restricted-folders.keycloak.integration.test.ts` passes **6 cases** against a disposable realm, including creator restriction after expired verification with a one-connection pool, non-creator refusal, creator loss of `use` or active membership, and existing curator reads/transitions. `src/tests/recorder/folders-route.test.ts` passes **25 database cases**, including its single holder-verification invariant, and the authorization inventory guards pass **3 cases**. These runs use Node 22.

## Consequences & open follow-ups

Shared self-host creators can now withdraw their folder's items from the Organization. A mistaken restriction affects its readers; an authorized lift restores passing placements through the existing publication gate, with failing items retained as pending shares. Content remains in its owners' libraries. Incorrect authority could permit unauthorized withdrawal, so tests cover membership and `use` loss before and after preflight. Hosted has no Organization-folder restriction surface and keeps its existing owner filing behavior. Rollback requires no data conversion in either mode.

## Related work

- [Restricted Organization folders](2026-11-10-restricted-organization-folders.md): supersedes rule 5's curator-only restriction and the corresponding technical authority requirement in part. All withdrawal, lifting, leaf and publication rules remain in force.

## Timeline

- **2026-11-11**: maintainer accepts creator restriction authority and member-visible discovery in issue #404.
