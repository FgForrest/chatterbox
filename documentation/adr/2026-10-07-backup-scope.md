---
title: Backups and exports carry one scope, chosen by the account, personal or Organization, never both
date: 2026-10-07
updated: 2026-10-22 22:00
status: accepted
kind: feature
issues: []
prs: [89]
areas: [src/lib/export/archive-scope.ts, src/lib/export/resolve-archive-scope.ts, src/lib/export/build-archive.ts, src/lib/export/document-sidecars.ts, src/app/api/backup]
supersedes: []
superseded-by: []
relates: [2026-10-22-person-to-person-sharing, 2026-09-23-shared-organization-scope, 2026-10-07-tasks-from-summaries]
---

# Backups and exports carry one scope, chosen by the account, personal or Organization, never both

A backup archive is either personal or Organization, and the account decides which: the
organization account gets the Organization's shared content, every other account its own. No
request parameter or picker selects a scope. A recording its owner shared appears in both
archives: the owner's without colleagues' contributions, the Organization's with the full
Organization overlay. The same "only what the owner made" rule applies to every owner-scoped
egress. Shipped in PR #89.

## Why

The maintainer's requirement (2026-10-07): a user must not be able to obtain another user's content
through backup or export, and the personal and Organization parts must be "either / or" for
security. Since PR #53 a shared recording is one recording that colleagues and the Organization
annotate: corrections, Organization people and entities, facts, Learn runs. The archive builder
read by owner, so an owner's backup of a shared recording would carry what colleagues and curators
wrote on it, and the organization account had no archive of the shared library at all.

### Previous state

One archive builder, keyed on the requesting user. Download protection was already ownership of
the export job (`getExportJobForUser`). Webhook payloads carried a truncated preview of the stored
transcript without any correction overlay.

## Options considered

The design went through one question per fork, each answered by the maintainer.

### Where a shared recording goes

- **Both, filtered (chosen).** The owner's backup keeps it, stripped of what others authored; the
  Organization backup has it with the full overlay. The owner never loses their own recording from
  their backup.
- **Organization only while shared (declined).** Strictest separation. **Rejected because:** the
  owner could not back up their own recording while it is shared.
- **Personal only (declined).** Recordings always follow ownership; the Organization backup carries
  only knowledge. **Rejected because:** an Organization backup could not reproduce the shared
  library.

### Organization people and entities the owner's rows reference

- **Full if the owner created them, otherwise a name-only stub (chosen).** A stub is id, name and
  `organization: true`, so a restore can re-link the speaker.
- **Name-only stub for all (declined; it was the recommendation).** **Rejected because:** the
  maintainer wanted people the owner created to export in full; no further reason was recorded.
- **Drop them (declined).** **Rejected because:** attributions would export with a bare speaker label
  and no way to re-link (inferred from the option's description).

### Download protection

Offered: re-authentication before download, a passphrase-encrypted ZIP (would need a stored key or
no scheduled backups), encryption at rest with a server key (protects a storage leak, not a database
plus key compromise), and an audit log with e-mail notice. **All declined:** the maintainer asked for
ownership only, a personal archive downloadable by its owner and an Organization archive by the
organization account; no reason beyond that was recorded. A revisit would have to accept the costs
named in parentheses.

### Other forks

- **Members' per-recording Markdown and audio downloads of shared recordings stay (chosen).** They are
  viewing aids for content the member can already see; the rule targets bulk backup and export.
  Declined: owner and Organization account only; Markdown but no audio.
- **One builder parameterized by a server-resolved scope (chosen)** over a separate Organization
  builder, so one predicate module decides membership for every collector.
- **Transcript and summary rows of a shared recording count as the owner's** even when a colleague's
  Organization-view run produced them (chosen). Declined: omit others' runs, which needs a producer
  column on those rows.
- **The Organization archive names each recording's owner** (id, name, e-mail). The maintainer added
  name and e-mail to the proposed owner id.
- **The owner-authored correction rule applies to every owner-scoped egress** (backup, `/api/export`,
  personal folder exports, `/api/v1/recordings/:id/transcript`), not only to backups. Declined: backup
  and exports only, leaving v1 and webhooks as they were.

## Decision

**Scope follows the account.** The drivers were the "either / or" requirement and that no path may
hand out a colleague's work: one server-resolved scope and one predicate module make every
collector answer the same question. A scope picker would have reintroduced the choice the
requirement removes.

## Key technical details

- **Scope:** `src/lib/export/archive-scope.ts` (pure predicates, `ArchiveScope` is `personal` or
  `organization`) and `src/lib/export/resolve-archive-scope.ts` (account lookup, kept apart so the
  builder does not import env). The organization account on an instance without a visible
  Organization gets 409.
- **Personal archive:** own recordings including shared ones; on shared recordings only corrections
  with `createdByUserId` = owner; Organization people or entities in full only when the owner created
  them, else a stub; `confirmedByUserId` only when it is the owner; facts of the owner's scope only;
  Private folder tree only.
- **Organization archive:** every live shared recording with its owner's id, name and e-mail; the full
  Organization overlay and knowledge; the Organization folder tree; no AI usage, nobody's private
  recordings or notes.
- **Webhooks stay unchanged:** their payload has no correction overlay to filter.
- **Format:** `manifest.json` gains `scope`, format `2.1`. No schema change. Personal folder exports
  containing shared recordings rewrote those documents once, because their corrections changed.
- **Tasks follow their recording, never their assignee** (PR #92, same day): a task assigned to a
  member on a colleague's shared recording is in the Organization's backup, not the member's.
- No restore exists; "backup" here means export only.

## Verification

`src/tests/export/archive-scope.integration.test.ts` builds the personal archives of two users and
the Organization archive, plants strings only another account holds, and scans every archive file
for them; reintroducing the old correction rule fails it. It also checks cross-account downloads in
every direction (404) and, since PR #92, tasks, proposals and follow-ups. PR #89: full suite with
Postgres, 2894 passed and 16 skipped (opt-in live tests).

## Consequences & open follow-ups

- Members keep downloading shared recordings one by one; that is accepted, not a leak.
- Archives are not encrypted and downloads need no re-authentication; whoever holds the account holds
  the archive.
- Archive restore was out of scope and still does not exist.

## Related work

- [Person-to-person sharing](2026-10-22-person-to-person-sharing.md): adds accepted receivers without publishing items or knowledge to the Organization; receiver archives still exclude those items.

- [2026-09-23-shared-organization-scope](2026-09-23-shared-organization-scope/README.md): defines the personal and Organization scopes split here.
- [2026-10-07-tasks-from-summaries](2026-10-07-tasks-from-summaries.md): tasks joined the archives under the same rules the same day.

## Timeline

- **2026-10-07**: requirement raised, forks decided one by one, implemented, PR #89 merged; PR #92
  added tasks under the same rules.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
