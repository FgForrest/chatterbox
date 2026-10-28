---
title: Curators export Organization folder subtrees through their own connections
date: 2026-10-28
updated: 2026-10-28 12:40
status: accepted
kind: feature
issues: []
prs: []
areas: [src/lib/folder-exports, src/components/dashboard/folder-settings-panel.tsx, src/components/dashboard/folder-export-actions.tsx]
supersedes: [2026-10-07-backup-scope]
superseded-by: []
relates: []
---

# Curators export Organization folder subtrees through their own connections

Current Organization curators and the Organization account may configure exports on Organization
folders. The writer owns the configuration and supplies their own connection; the content is the
same Organization subtree the Organization account would export, including colleagues' shared
items and Organization document overlays. Other members see the exports and their writers without
controls. This is a narrow exception to account-selected export scope, accepted by the maintainer
on 2026-10-28.

## Why

Under identity-provider authorization, curators work under their own identities. Requiring an
Organization-account connection prevents them from configuring exports themselves. Letting their
personal export scope follow them instead would silently omit colleagues' content from a shared
folder export.

The target cannot be limited to shared drives either. In the maintainer's Workspace the folder the
whole company uses is a person's My Drive folder shared with the domain, not a shared drive: a
Picker restricted to shared drives lists nothing, and the folder appears only as the curator's own.
Writing through the curator's connection into any folder they can pick is what reaches it.

### Previous state

Configurations, credentials, job ownership and content scope all followed one user id. Only the
Organization account could configure an Organization folder export. Other members and curators saw
“Managed by the Organization account” instead of export controls.

## Options considered

### Organization-account-only exports (declined)

- **Pros:** one connection controlled centrally; Organization copies stay in its destination.
- **Cons:** curators cannot configure exports under their own identities.
- **Rejected because:** the maintainer explicitly wants curators to configure these exports with
  their own Google connections. Revisit only if that ownership policy changes.

### Curator-owned exports with Organization content (chosen)

- **Pros:** attributable configuration and credentials; curators choose the same target kinds as
  for personal folders, including folders in My Drive; the existing Organization resolver keeps
  shared content consistent.
- **Cons:** the Organization cannot recall copies already written into a person's Drive.

## Decision

The configuration's writer and its content context are separate. Every current curator may add an
Organization folder export, edit only their own target, and remove anyone's export on that folder.
Removing configuration never deletes exported files. Members may inspect the list and writers.

**Accepted trade-off:** Organization content written to a curator's own Google Drive stays with
that person after they leave the Organization. Revoking their role, leaving, or deactivating their
account prevents subsequent runs; it cannot recall files already exported. There is no restriction
to shared drives. Existing deployment-level Google integration and target availability stay in force.

Check the writer's current access at planning, materialization and reconciliation, before provider
operations. Curators see a localized stopped reason when the writer no longer qualifies. A queued
artifact must still belong to the export subtree when materialized.

Personal folder exports and one-archive exports/backups keep their prior scope rules. Neither
`/api/export` nor the archive worker gains a scope choice or curator exception.

## Key technical details

- `src/lib/folder-exports/scope.ts` resolves the folder through the shared read-access helper and
  uses `userCuratesOrganizationNow` for the writer. Configuration, provider settings, jobs and node
  ledgers remain keyed by writer; Google token lookup continues using that writer.
- Planner and materializer use the existing Organization-account tree, shared-content predicates
  and document options with the resolved content context. There is no second content resolver.
- Organization changes enqueue all configurations on its tree under their respective writers.
- Scope and stopped state are derived from the folder and verified access. No schema, environment
  variable, Compose or deployment-step change is needed.

## Verification

`src/tests/folder-exports/curator-exports.integration.test.ts` covers real PostgreSQL configuration
routes, writer credentials, My Drive, subtree exclusion, Organization corrections, removal without
Drive operations, role revocation, departure, deactivation, queued placement changes, and unchanged
Organization-account and personal behavior. Panel tests in
`src/tests/folders/folder-settings-export.test.tsx` cover curator controls, member writer lists and
stopped exports. The focused export/panel run passed 33 tests across 3 files; the required folders,
export, sharing, Organization, i18n and folder-export selections passed 806 tests across 61 files.
Both used Node 22 and PostgreSQL with file parallelism disabled. Biome, TypeScript and the ADR index
check passed; Drizzle reported no schema changes. The final changed selection passed 5,425 tests
(402 files; 82 tests and 7 files skipped); the final full suite passed 9,322 tests (768 files;
104 tests and 12 files skipped). Live Keycloak checks were skipped because no test issuer was
configured. The nine new PostgreSQL cases also passed after the unnamed-writer email fallback
assertion was added.

## Consequences & open follow-ups

A wrong shared-content predicate could expose Organization content to a configured destination on
shared self-host installations. Revocation or removal stops future writes but cannot recover prior
copies; this is the accepted trade-off. Without identity-provider authorization the only curator
is the Organization account, so plain self-host installations behave as before. Application
rollback needs no data migration in either mode. Archive scope
continues following the account.

## Related work

- [Account-selected backup scope](2026-10-07-backup-scope.md) is superseded only for curator-owned
  folder exports of Organization folders. All archive and other personal-egress rules remain in force.

## Timeline

- **2026-10-28**: maintainer accepted curator-owned connections, Organization subtree content and
  retained copies after departure; implementation and tests added.
